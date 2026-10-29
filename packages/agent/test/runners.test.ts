import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JobSpec } from "@hoistline/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROMPT_DELIMITER,
  PromptTooLargeError,
  RUNNER_PREAMBLE,
  RunnerNotInstalledError,
  RunnerSpawnError,
  buildCommand,
  registerBuiltinRunners,
  registerRunner,
  runJob as realRunJob,
} from "../src/index.js";
import { findRunnerCLIs } from "./path-guard.js";
import { buildTestTemplateFor } from "../src/runners/build-test.js";
import { _resetRunnersForTests } from "../src/runners/template.js";

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));
const HOSTILE = 'a b "c" $(touch /tmp/pwned); -y';
const posix = process.platform !== "win32";

type Record = { argv: string[]; stdin: string; cwd: string; env: NodeJS.ProcessEnv; pid: number };

let root: string;
let bin: string;
let work: string;
let recordFile: string;
let pidsFile: string;
let savedEnv: NodeJS.ProcessEnv;
const strays: number[] = [];

function spec(over: Partial<JobSpec> = {}): JobSpec {
  return { jobId: "job1", runner: "muse", repo: "owner/name", baseBranch: "main", prompt: "do the thing", ...over };
}

function wrapped(prompt: string): string {
  return RUNNER_PREAMBLE + PROMPT_DELIMITER + prompt;
}

function record(): Record {
  return JSON.parse(readFileSync(recordFile, "utf8")) as Record;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

type Chunk = { chunk: string; stream: "stdout" | "stderr" };
function collector(): { chunks: Chunk[]; onOutput: (chunk: string, stream: "stdout" | "stderr") => void } {
  const chunks: Chunk[] = [];
  return { chunks, onOutput: (chunk, stream) => chunks.push({ chunk, stream }) };
}

const never = () => new AbortController().signal;

/**
 * Every job a test starts, so afterEach can stop and await the ones still running BEFORE it restores the
 * environment: a job left behind by a failed or timed-out test must never spawn with a restored PATH.
 */
const pending: Promise<unknown>[] = [];
let teardown = new AbortController();
const runJob: typeof realRunJob = (s, dir, onOutput, signal, opts) => {
  const p = realRunJob(s, dir, onOutput, AbortSignal.any([signal, teardown.signal]), opts);
  pending.push(p);
  return p;
};

/**
 * A build-test command whose background node process ignores SIGTERM, writes its pid to ./bgpid once the handler is
 * installed, and (unless redirected) keeps the job's stdout open. The leader waits for bgpid, then exits.
 */
function bgIgnoringTerm(redirect: boolean): string {
  const script = "process.on('SIGTERM',()=>{});require('fs').writeFileSync('bgpid',String(process.pid));setInterval(()=>{},1000)";
  return (
    `"${process.execPath}" -e "${script}"${redirect ? " >/dev/null 2>&1" : ""} & ` +
    "while [ ! -s bgpid ]; do sleep 0.05; done; echo leader-done"
  );
}

beforeEach(() => {
  savedEnv = { ...process.env };
  root = realpathSync(mkdtempSync(join(tmpdir(), "hoistline-runners-")));
  bin = join(root, "bin");
  work = join(root, "work");
  mkdirSync(bin);
  mkdirSync(work);
  recordFile = join(root, "record.json");
  pidsFile = join(root, "pids.json");
  for (const name of ["muse", "codex"]) {
    const shim = join(bin, name);
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  // The fake CLIs first, then only the system directories (sh, sleep, touch). Never the owner's PATH: the real
  // muse and codex live there, and execvp keeps searching PATH after a non-executable match (EACCES), so a broken
  // shim would otherwise start a real, paid model run.
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  // The fake bin is under the OS temp dir and so exempt; anything else naming a runner CLI fails the test.
  expect(findRunnerCLIs(process.env.PATH)).toEqual([]);
  teardown = new AbortController();
  process.env.FAKECLI_RECORD = recordFile;
  process.env.FAKECLI_PIDS = pidsFile;
  delete process.env.FAKECLI_MODE;
  _resetRunnersForTests();
  registerBuiltinRunners();
});

afterEach(async () => {
  teardown.abort();
  await Promise.allSettled(pending.splice(0));
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});

const PROMPTS: [string, string][] = [
  ["hostile shell text", HOSTILE],
  ["leading dash", "-y --dangerously-bypass-approvals-and-sandbox"],
  ["double dash", "--"],
  ["newlines", "line one\nline two\r\n\ttabbed\n"],
  ["100,000 chars", "x".repeat(100_000)],
  ["non-ASCII", "héllo 漢字 🙂 ‮ evil"],
];

describe.skipIf(!posix)("muse template", () => {
  it("runs muse exec headless with the sandbox on and the wrapped prompt after --", async () => {
    const res = await runJob(spec(), work, () => undefined, never());
    expect(res.exitCode).toBe(0);
    const r = record();
    expect(r.argv).toEqual([
      "exec",
      "--json",
      "--approval-mode",
      "never",
      "--disable-request-user-input",
      "--workspace",
      work,
      "--",
      wrapped("do the thing"),
    ]);
    expect(r.stdin).toBe("");
    expect(r.cwd).toBe(work);
  });

  it("passes the model as its own argument after --model", async () => {
    await runJob(spec({ model: "muse-spark-1.3" }), work, () => undefined, never());
    const argv = record().argv;
    const i = argv.indexOf("--model");
    expect(argv[i + 1]).toBe("muse-spark-1.3");
    expect(i).toBeLessThan(argv.indexOf("--"));
  });

  it.each(PROMPTS)("delivers a %s prompt byte-exact as the one argument after --", async (_n, prompt) => {
    await runJob(spec({ prompt }), work, () => undefined, never());
    const argv = record().argv;
    expect(argv.at(-2)).toBe("--");
    expect(argv.at(-1)).toBe(wrapped(prompt));
    expect(argv.at(-1)!.startsWith(RUNNER_PREAMBLE)).toBe(true);
    expect(argv.at(-1)!.slice((RUNNER_PREAMBLE + PROMPT_DELIMITER).length)).toBe(prompt);
  });

  it("never evaluates shell syntax in the prompt", async () => {
    const marker = join(root, "pwned");
    const prompt = `a b "c" $(touch ${marker}); \`touch ${marker}\` -y`;
    await runJob(spec({ prompt }), work, () => undefined, never());
    await runJob(spec({ runner: "codex", prompt }), work, () => undefined, never());
    expect(existsSync(marker)).toBe(false);
  });

  it("never passes command", async () => {
    await runJob(spec({ command: "rm -rf /" }), work, () => undefined, never());
    expect(record().argv.join("\n")).not.toContain("rm -rf");
  });

  it("refuses to build without an absolute working directory", () => {
    expect(() => buildCommand(spec())).toThrow(/working directory/);
    expect(() => buildCommand(spec(), { cwd: "relative" })).toThrow(/working directory/);
  });
});

describe.skipIf(!posix)("codex template", () => {
  it("runs codex exec in its workspace-write sandbox scoped to the worktree, prompt on stdin", async () => {
    const res = await runJob(spec({ runner: "codex" }), work, () => undefined, never());
    expect(res.exitCode).toBe(0);
    const r = record();
    expect(r.argv).toEqual([
      "exec",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "workspace-write",
      "-C",
      work,
      "-",
    ]);
    expect(r.stdin).toBe(wrapped("do the thing"));
    expect(r.argv).not.toContain("--add-dir");
    expect(r.argv.join(" ")).not.toMatch(/dangerously|danger-full-access|yolo/);
  });

  it("passes the model as its own argument after --model", async () => {
    await runJob(spec({ runner: "codex", model: "gpt-6.1-sol" }), work, () => undefined, never());
    const argv = record().argv;
    expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-6.1-sol");
    expect(argv.at(-1)).toBe("-");
  });

  it.each(PROMPTS)("delivers a %s prompt byte-exact on stdin", async (_n, prompt) => {
    await runJob(spec({ runner: "codex", prompt }), work, () => undefined, never());
    const r = record();
    expect(r.stdin).toBe(wrapped(prompt));
    expect(r.argv).toEqual(["exec", "--json", "--ignore-user-config", "--ignore-rules", "--sandbox", "workspace-write", "-C", work, "-"]);
  });

  it("never passes command", async () => {
    await runJob(spec({ runner: "codex", command: "rm -rf /" }), work, () => undefined, never());
    const r = record();
    expect(r.argv.join("\n") + r.stdin).not.toContain("rm -rf");
  });
});

describe("preamble", () => {
  it("tells the CLI to stay in the directory and leave git alone", () => {
    expect(RUNNER_PREAMBLE).toMatch(/current directory/i);
    expect(RUNNER_PREAMBLE).toMatch(/commit/);
    expect(RUNNER_PREAMBLE).toMatch(/push/);
    expect(RUNNER_PREAMBLE).toMatch(/config/);
    expect(PROMPT_DELIMITER).toContain("\n");
  });
});

describe.skipIf(!posix)("runJob", () => {
  it("drops GIT_* and HOISTLINE_* from the child's environment and keeps the rest", async () => {
    process.env.GIT_DIR = "/somewhere";
    process.env.GIT_COMMON_DIR = "/elsewhere";
    process.env.git_lower = "x";
    process.env.HOISTLINE_TOKEN = "secret";
    process.env.ORDINARY_VAR = "kept";
    await runJob(spec(), work, () => undefined, never());
    const env = record().env;
    expect(Object.keys(env).filter((k) => /^(GIT_|HOISTLINE_)/i.test(k))).toEqual([]);
    expect(env.ORDINARY_VAR).toBe("kept");
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
  });

  it("streams output in chunks of at most 16 KiB", async () => {
    process.env.FAKECLI_MODE = "big";
    process.env.FAKECLI_MB = "4";
    const { chunks, onOutput } = collector();
    const res = await runJob(spec(), work, onOutput, never());
    expect(res.exitCode).toBe(0);
    const out = chunks.filter((c) => c.stream === "stdout");
    expect(out.length).toBeGreaterThanOrEqual(256);
    expect(Math.max(...out.map((c) => Buffer.byteLength(c.chunk)))).toBeLessThanOrEqual(16 * 1024);
    expect(out.map((c) => c.chunk).join("")).toBe("x".repeat(4 * 1024 * 1024));
    expect(chunks.filter((c) => c.stream === "stderr").map((c) => c.chunk).join("")).toBe("done\n");
  });

  it("splits multi-byte output without breaking characters", async () => {
    process.env.FAKECLI_MODE = "bigutf8";
    process.env.FAKECLI_MB = "2";
    const { chunks, onOutput } = collector();
    await runJob(spec(), work, onOutput, never());
    const out = chunks.filter((c) => c.stream === "stdout");
    expect(Math.max(...out.map((c) => Buffer.byteLength(c.chunk)))).toBeLessThanOrEqual(16 * 1024);
    expect(out.every((c) => !c.chunk.includes("�"))).toBe(true);
    expect(out.map((c) => c.chunk).join("")).toBe("é漢🙂a".repeat(1024 * 1024 / 10).repeat(2));
  });

  it("returns a nonzero exit as a value", async () => {
    process.env.FAKECLI_MODE = "exit";
    process.env.FAKECLI_CODE = "3";
    await expect(runJob(spec(), work, () => undefined, never())).resolves.toEqual({ exitCode: 3 });
  });

  it("returns a signal exit as 128 + the signal number", async () => {
    process.env.FAKECLI_MODE = "signal";
    await expect(runJob(spec(), work, () => undefined, never())).resolves.toEqual({ exitCode: 143 });
  });

  it("throws RunnerNotInstalledError when the CLI is missing", async () => {
    process.env.PATH = join(root, "empty");
    const err = await runJob(spec(), work, () => undefined, never()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerNotInstalledError);
    expect((err as Error).message).toBe("runner_not_installed: muse");
  });

  it("does not report a missing working directory as a missing runner", async () => {
    const err = await runJob(spec(), join(root, "nope"), () => undefined, never()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RunnerNotInstalledError);
  });

  it("spawns nothing for a signal that is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await runJob(spec(), work, () => undefined, ac.signal);
    expect(res.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(pidsFile)).toBe(false);
    expect(existsSync(recordFile)).toBe(false);
  });

  it("kills the whole process group on abort, including children that ignore SIGTERM", async () => {
    process.env.FAKECLI_MODE = "ignoreterm";
    const ac = new AbortController();
    const p = runJob(spec(), work, () => undefined, ac.signal, { termGraceMs: 500 });
    await waitFor(() => existsSync(recordFile));
    const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { pid: number; child: number };
    strays.push(pids.pid, pids.child);
    const t0 = Date.now();
    ac.abort();
    const res = await p;
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(res.aborted).toBe(true);
    expect(res.exitCode).toBe(137);
    await waitFor(() => !alive(pids.pid) && !alive(pids.child), 2000);
  });

  it("stops a SIGTERM-honoring runner promptly on abort", async () => {
    process.env.FAKECLI_MODE = "sleep";
    const ac = new AbortController();
    const p = runJob(spec(), work, () => undefined, ac.signal);
    await waitFor(() => existsSync(recordFile));
    const t0 = Date.now();
    ac.abort();
    const res = await p;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res).toEqual({ exitCode: 143, aborted: true });
  });

  it("sends no SIGKILL after it resolves when an abort stopped the runner", async () => {
    process.env.FAKECLI_MODE = "sleep";
    const ac = new AbortController();
    let resolved = false;
    const late: unknown[][] = [];
    const kill = process.kill.bind(process);
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (resolved && (sig === "SIGKILL" || sig === 9)) late.push([pid, sig]);
      return kill(pid, sig);
    });
    try {
      const p = runJob(spec(), work, () => undefined, ac.signal, { termGraceMs: 300 });
      await waitFor(() => existsSync(recordFile));
      ac.abort();
      const res = await p;
      resolved = true;
      expect(res).toEqual({ exitCode: 143, aborted: true });
      // Well past termGraceMs: a leftover timer would have fired by now.
      await new Promise((r) => setTimeout(r, 900));
      expect(late).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("times out with exit code 124", async () => {
    process.env.FAKECLI_MODE = "sleep";
    const res = await runJob(spec(), work, () => undefined, never(), { timeoutMs: 300 });
    expect(res).toEqual({ exitCode: 124, timedOut: true });
  });

  it("survives an onOutput callback that throws", async () => {
    process.env.FAKECLI_MODE = "big";
    process.env.FAKECLI_MB = "1";
    let calls = 0;
    const res = await runJob(
      spec(),
      work,
      () => {
        calls++;
        throw new Error("boom");
      },
      never(),
    );
    expect(res.exitCode).toBe(0);
    expect(res.outputErrors).toBe(calls);
    expect(calls).toBeGreaterThan(1);
  });

  // A descendant in a NEW session (setsid) cannot be reached by the group kill; only its pipes are closed.
  it("does not hang on an escaped descendant that holds the pipes", async () => {
    process.env.FAKECLI_MODE = "escape";
    const p = runJob(spec(), work, () => undefined, never(), { killGraceMs: 300 });
    await waitFor(() => existsSync(pidsFile));
    const t0 = Date.now();
    const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { pid: number; child: number };
    strays.push(pids.child);
    const res = await p;
    expect(res.exitCode).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("kills a background process left in the runner's group before resolving", async () => {
    const command = "sleep 30 & echo $! > bgpid; echo leader-done";
    const res = await runJob(spec({ runner: "build-test", command }), work, () => undefined, never(), {
      killGraceMs: 500,
    });
    const bg = Number(readFileSync(join(work, "bgpid"), "utf8"));
    strays.push(bg);
    expect(res).toEqual({ exitCode: 0 });
    expect(alive(bg)).toBe(false);
  });

  it("SIGKILLs a background process that ignores SIGTERM after the post-exit grace", async () => {
    const command =
      bgIgnoringTerm(true);
    const res = await runJob(spec({ runner: "build-test", command }), work, () => undefined, never(), {
      postExitGraceMs: 300,
    });
    const bg = Number(readFileSync(join(work, "bgpid"), "utf8"));
    strays.push(bg);
    expect(res).toEqual({ exitCode: 0 });
    expect(alive(bg)).toBe(false);
  });

  it("honors an abort that arrives during the post-exit group kill", async () => {
    // The background process keeps stdout open and ignores SIGTERM, so the job is still waiting after the leader
    // exits; with long graces only the abort can end it quickly.
    const command =
      bgIgnoringTerm(false);
    const ac = new AbortController();
    let out = "";
    const p = runJob(spec({ runner: "build-test", command }), work, (c) => (out += c), ac.signal, {
      termGraceMs: 10_000,
      postExitGraceMs: 10_000,
      killGraceMs: 10_000,
    });
    await waitFor(() => out.includes("leader-done") && existsSync(join(work, "bgpid")));
    await new Promise((r) => setTimeout(r, 200));
    const bg = Number(readFileSync(join(work, "bgpid"), "utf8"));
    strays.push(bg);
    const t0 = Date.now();
    ac.abort();
    const res = await p;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(res).toEqual({ exitCode: 0, aborted: true });
    expect(alive(bg)).toBe(false);
  }, 30_000);

  it("honors a timeout that arrives during the post-exit group kill", async () => {
    const command =
      bgIgnoringTerm(false);
    const res = await runJob(spec({ runner: "build-test", command }), work, () => undefined, never(), {
      timeoutMs: 3000,
      termGraceMs: 10_000,
      postExitGraceMs: 10_000,
      killGraceMs: 10_000,
    });
    strays.push(Number(readFileSync(join(work, "bgpid"), "utf8")));
    expect(res).toEqual({ exitCode: 124, timedOut: true });
  }, 30_000);

  it("runs in the real path of a symlinked directory", async () => {
    const link = join(root, "link");
    symlinkSync(work, link);
    await runJob(spec(), link, () => undefined, never());
    const r = record();
    expect(r.cwd).toBe(work);
    expect(r.argv[r.argv.indexOf("--workspace") + 1]).toBe(work);
  });

  it("refuses a Muse prompt too large for one argument and spawns nothing", async () => {
    const prompt = "漢".repeat(100_000);
    const err = await runJob(spec({ prompt }), work, () => undefined, never()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PromptTooLargeError);
    const bytes = Buffer.byteLength(wrapped(prompt));
    expect((err as Error).message).toBe(`prompt_too_large: ${bytes} bytes exceeds the 122880 byte limit for muse`);
    expect(existsSync(pidsFile)).toBe(false);
  });

  it("delivers the same large prompt to Codex on stdin", async () => {
    const prompt = "漢".repeat(100_000);
    const res = await runJob(spec({ runner: "codex", prompt }), work, () => undefined, never());
    expect(res.exitCode).toBe(0);
    expect(record().stdin).toBe(wrapped(prompt));
  });

  it("turns a synchronous spawn failure (NUL in an argument) into RunnerSpawnError", async () => {
    const err = await runJob(spec({ prompt: "a\0b" }), work, () => undefined, never()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerSpawnError);
    expect((err as Error).message).toBe("runner_spawn_failed: ERR_INVALID_ARG_VALUE");
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(existsSync(pidsFile)).toBe(false);
  });

  it("turns an asynchronous non-ENOENT spawn failure into RunnerSpawnError", async () => {
    chmodSync(join(bin, "muse"), 0o644);
    // Only the fake bin: execvp keeps searching PATH after a non-executable match, so no other directory may follow.
    process.env.PATH = bin;
    const err = await runJob(spec(), work, () => undefined, never()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerSpawnError);
    expect((err as Error).message).toBe("runner_spawn_failed: EACCES");
    expect((err as Error).cause).toBeInstanceOf(Error);
  });
});

describe.skipIf(!posix)("build-test runner", () => {
  it("runs the command through sh -c as one argument", () => {
    const cmd = buildCommand(spec({ runner: "build-test", command: "echo hi" }), { cwd: work });
    expect(cmd).toEqual({ file: "sh", args: ["-c", "echo hi"] });
  });

  it("executes echo in the worktree", async () => {
    const { chunks, onOutput } = collector();
    const res = await runJob(spec({ runner: "build-test", command: "echo hi; pwd" }), work, onOutput, never());
    expect(res.exitCode).toBe(0);
    expect(chunks.map((c) => c.chunk).join("")).toBe(`hi\n${work}\n`);
  });

  it("runs quotes and $() as shell, in the worktree", async () => {
    const command = `touch "marker $(echo one)" && printf '%s' "it's" > 'q file'`;
    const cmd = buildCommand(spec({ runner: "build-test", command }), { cwd: work });
    expect(cmd.args).toEqual(["-c", command]);
    const res = await runJob(spec({ runner: "build-test", command }), work, () => undefined, never());
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(work, "marker one"))).toBe(true);
    expect(readFileSync(join(work, "q file"), "utf8")).toBe("it's");
  });

  it("gets no preamble and no stdin", () => {
    const cmd = buildCommand(spec({ runner: "build-test", command: "true" }), { cwd: work });
    expect(cmd.stdin).toBeUndefined();
  });

  it("requires a command", () => {
    expect(() => buildCommand(spec({ runner: "build-test" }), { cwd: work })).toThrow(/build-test requires a command/);
    expect(() => buildCommand(spec({ runner: "build-test", command: "" }), { cwd: work })).toThrow(
      /build-test requires a command/,
    );
  });
});

describe("build-test templates (pure, every platform)", () => {
  const command = `npm test -- --grep "a b" && echo "it's"`;

  it("POSIX: sh -c with the command as one argument", () => {
    registerRunner("build-test", buildTestTemplateFor("linux"));
    expect(buildCommand(spec({ runner: "build-test", command }), { cwd: "/w" })).toEqual({
      file: "sh",
      args: ["-c", command],
    });
  });

  it("Windows: cmd.exe /d /s /c with the command quoted once and verbatim arguments", () => {
    registerRunner("build-test", buildTestTemplateFor("win32"));
    expect(buildCommand(spec({ runner: "build-test", command }), { cwd: "C:\\w" })).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      verbatimArgs: true,
    });
  });
});

describe("registerBuiltinRunners", () => {
  it("is idempotent and leaves cursor and grok unregistered", () => {
    registerBuiltinRunners();
    registerBuiltinRunners();
    expect(buildCommand(spec(), { cwd: work }).file).toBe("muse");
    expect(buildCommand(spec({ runner: "codex" }), { cwd: work }).file).toBe("codex");
    expect(() => buildCommand(spec({ runner: "cursor" }), { cwd: work })).toThrow(/runner_not_implemented: cursor/);
    expect(() => buildCommand(spec({ runner: "grok" }), { cwd: work })).toThrow(/runner_not_implemented: grok/);
  });
});
