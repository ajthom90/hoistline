import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, signJob, type AgentToHub, type JobSpec, type SignedJob } from "@hoistline/protocol";
import { createExecutor, execute, type ExecutorDeps } from "../src/executor.js";
import { museTemplate, registerRunner, type PolicyConfig } from "../src/index.js";

const FIXTURE_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const ID = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false"];
function fx(args: string[], cwd?: string): string {
  return execFileSync("git", [...ID, ...args], { cwd, env: FIXTURE_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const temps: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "hoistline-exec-"));
  temps.push(d);
  return d;
}

const hub = generateKeyPairSync("ed25519");
const MACHINE = "machine-1";
const USER = "user-1";
const TRUSTED: PolicyConfig = { mode: "trusted" };
const KiB = 1024;
const posix = process.platform !== "win32";

let remote: string;
let runnerScript: string;
/** Every spec a fake runner was built from, in order. */
const ran: JobSpec[] = [];

/**
 * The fake runner: a node script driven by the job's prompt, a JSON object:
 * { stdout, stderr, big: {chunk, n}, write: {file: content}, commit, gate: path, sleepMs, exit }.
 */
const RUNNER_SOURCE = `
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [cwd, prompt] = process.argv.slice(2);
const p = JSON.parse(prompt);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (p.stdout) process.stdout.write(p.stdout);
if (p.stderr) process.stderr.write(p.stderr);
if (p.big) for (let i = 0; i < p.big.n; i++) process.stdout.write(p.big.chunk);
for (const [file, content] of Object.entries(p.write ?? {})) writeFileSync(join(cwd, file), content);
if (p.commit) {
  const id = ["-c", "user.name=Runner", "-c", "user.email=r@example.com", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
  execFileSync("git", [...id, "add", "-A"], { cwd });
  execFileSync("git", [...id, "commit", "-q", "-m", "runner commit"], { cwd });
}
while (p.gate && !existsSync(p.gate)) await sleep(20);
if (p.sleepMs) await sleep(p.sleepMs);
// Not process.exit(): on macOS piped stdout is asynchronous and exiting would drop unflushed output.
process.exitCode = p.exit ?? 0;
`;

beforeAll(() => {
  const root = temp();
  remote = join(root, "remote.git");
  const seed = join(root, "seed");
  fx(["init", "-q", "--bare", "-b", "main", remote]);
  fx(["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "README"), "main\n");
  fx(["add", "README"], seed);
  fx(["commit", "-q", "-m", "main"], seed);
  fx(["push", "-q", remote, "main"], seed);

  runnerScript = join(root, "runner.mjs");
  writeFileSync(runnerScript, RUNNER_SOURCE);
  registerRunner("muse", {
    file: process.execPath,
    args: (spec, ctx) => {
      ran.push(spec);
      return [runnerScript, ctx.cwd!, spec.prompt];
    },
  });
  // Executables that cannot run: one missing, one not executable.
  registerRunner("codex", { file: "hoistline-test-missing-cli", args: () => [] });
  const notExecutable = join(root, "not-executable");
  writeFileSync(notExecutable, "#!/bin/sh\n");
  chmodSync(notExecutable, 0o644);
  registerRunner("grok", { file: notExecutable, args: () => [] });
  // The real muse adapter, which refuses an oversized prompt before anything is spawned.
  registerRunner("cursor", museTemplate);
});

afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

let seq = 0;
const newJobId = () => `job${process.pid}x${Date.now().toString(36)}x${++seq}`;

type Script = {
  stdout?: string;
  stderr?: string;
  big?: { chunk: string; n: number };
  write?: Record<string, string>;
  commit?: boolean;
  gate?: string;
  sleepMs?: number;
  exit?: number;
};

function sign(
  script: Script = {},
  spec: Partial<JobSpec> = {},
  opts: { machine?: string; now?: number } = {},
): SignedJob {
  return signJob(
    { jobId: newJobId(), runner: "muse", repo: "owner/name", baseBranch: "main", prompt: JSON.stringify(script), ...spec },
    USER,
    opts.machine ?? MACHINE,
    hub.privateKey,
    opts.now ?? Date.now(),
  );
}

function harness(over: Partial<ExecutorDeps> = {}) {
  const cacheDir = temp();
  const sent: AgentToHub[] = [];
  const remotes: string[] = [];
  const deps: ExecutorDeps = {
    machineId: MACHINE,
    hubPublicKey: hub.publicKey,
    cacheDir,
    loadPolicy: () => TRUSTED,
    send: (msg) => sent.push(msg),
    prepareOptions: {
      remoteFor: (canonical) => {
        remotes.push(canonical);
        return remote;
      },
      allowFileProtocol: true,
    },
    ...over,
  };
  const results = () => sent.filter((m): m is Extract<AgentToHub, { type: "job.result" }> => m.type === "job.result");
  const statuses = () => sent.flatMap((m) => (m.type === "job.event" && m.stream === "status" ? [m.data] : []));
  const stdout = () => sent.flatMap((m) => (m.type === "job.event" && m.stream === "stdout" ? [m.data] : [])).join("");
  return { deps, sent, remotes, cacheDir, results, statuses, stdout, result: () => results()[0] };
}

function remoteBranchSha(branch: string): string | null {
  try {
    return fx(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], remote).trim();
  } catch {
    return null;
  }
}
const remoteFile = (branch: string, file: string) => fx(["show", `refs/heads/${branch}:${file}`], remote);

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const specHashOf = (s: JobSpec) =>
  createHash("sha256")
    .update(
      canonicalJson({
        jobId: s.jobId,
        repo: s.repo,
        runner: s.runner,
        model: s.model,
        command: s.command,
        prompt: s.prompt,
        baseBranch: s.baseBranch,
      }),
    )
    .digest("hex");

const RESTRICTED_DENY: PolicyConfig = { mode: "restricted", repos: ["owner/name"], runners: ["build-test"], onViolation: "deny" };
const RESTRICTED_ASK: PolicyConfig = { ...RESTRICTED_DENY, onViolation: "ask" };

describe("verification and replay", () => {
  function nothingHappened(h: ReturnType<typeof harness>, before: number, jobId: string) {
    expect(ran.length).toBe(before);
    expect(h.remotes).toEqual([]);
    expect(existsSync(join(h.cacheDir, "work"))).toBe(false);
    expect(existsSync(join(h.cacheDir, "seen-jobs", jobId))).toBe(false);
  }

  it("refuses a tampered job: nothing runs, no worktree, no seen marker", async () => {
    const h = harness();
    const signed = sign({ write: { a: "a" } });
    const tampered = { ...signed, spec: { ...signed.spec, prompt: JSON.stringify({ write: { evil: "x" } }) } };
    const before = ran.length;
    await execute(tampered, h.deps);
    expect(h.sent).toEqual([{ type: "job.result", jobId: signed.spec.jobId, status: "failed", reason: "invalid_job" }]);
    nothingHappened(h, before, signed.spec.jobId);
  });

  it("refuses a job signed for another machine, an expired job and one from the future", async () => {
    const before = ran.length;
    for (const signed of [
      sign({}, {}, { machine: "machine-2" }),
      sign({}, {}, { now: Date.now() - 6 * 60_000 }),
      sign({}, {}, { now: Date.now() + 5 * 60_000 }),
    ]) {
      const h = harness();
      await execute(signed, h.deps);
      expect(h.sent).toEqual([{ type: "job.result", jobId: signed.spec.jobId, status: "failed", reason: "invalid_job" }]);
      nothingHappened(h, before, signed.spec.jobId);
    }
  });

  it("says nothing about a refused job whose claimed id is unsafe", async () => {
    const h = harness();
    const signed = sign();
    await execute({ ...signed, spec: { ...signed.spec, jobId: "../x" } }, h.deps);
    await execute({ ...signed, signature: "bogus" , spec: { ...signed.spec, jobId: "a b" } }, h.deps);
    expect(h.sent).toEqual([]);
  });

  it("refuses a replayed job, also from a new executor over the same cache", async () => {
    const h = harness();
    const signed = sign({ write: { "replay.txt": "1" } });
    await execute(signed, h.deps);
    expect(h.result()).toMatchObject({ status: "succeeded" });
    const before = ran.length;
    const again = harness({ cacheDir: h.cacheDir });
    await execute(signed, again.deps);
    expect(again.sent).toEqual([{ type: "job.result", jobId: signed.spec.jobId, status: "failed", reason: "replayed_job" }]);
    expect(ran.length).toBe(before);
  });

  it("rejects an invalid repo or base branch before any git or runner", async () => {
    const before = ran.length;
    for (const spec of [
      { repo: "--upload-pack=x" },
      { repo: "../x" },
      { repo: "owner/name/../../x" },
      { baseBranch: "--upload-pack=x" },
      { baseBranch: "a..b" },
    ]) {
      const h = harness();
      const signed = sign({}, spec);
      await execute(signed, h.deps);
      expect(h.sent, JSON.stringify(spec)).toEqual([
        { type: "job.result", jobId: signed.spec.jobId, status: "failed", reason: "invalid_job" },
      ]);
      expect(h.remotes).toEqual([]);
      expect(existsSync(join(h.cacheDir, "work"))).toBe(false);
    }
    expect(ran.length).toBe(before);
  });

  it("drops a signed job with an unsafe job id without touching anything", async () => {
    const h = harness();
    await execute(sign({}, { jobId: "../x" }), h.deps);
    await execute(sign({}, { jobId: "-rf" }), h.deps);
    expect(h.sent).toEqual([]);
    expect(readdirSync(h.cacheDir)).toEqual([]);
  });
});

describe("policy", () => {
  it("reports a denied job as failed with the policy reason", async () => {
    const h = harness({ loadPolicy: () => RESTRICTED_DENY });
    const before = ran.length;
    const signed = sign();
    await execute(signed, h.deps);
    expect(h.sent).toEqual([
      {
        type: "job.result",
        jobId: signed.spec.jobId,
        status: "failed",
        reason: 'runner rule failed: "muse" is not in the allowed runners',
      },
    ]);
    expect(ran.length).toBe(before);
    expect(h.remotes).toEqual([]);
  });

  it("loads the policy per job, and a missing policy file or a throwing loader denies everything", async () => {
    let policy: PolicyConfig = TRUSTED;
    const h = harness({ loadPolicy: () => policy });
    await execute(sign(), h.deps);
    policy = RESTRICTED_DENY;
    await execute(sign(), h.deps);
    expect(h.results().map((r) => r.status)).toEqual(["succeeded", "failed"]);

    const home = temp();
    const saved = process.env.HOISTLINE_AGENT_HOME;
    process.env.HOISTLINE_AGENT_HOME = home;
    try {
      const rest: ExecutorDeps = { ...harness().deps };
      delete rest.loadPolicy;
      const sent: AgentToHub[] = [];
      await execute(sign(), { ...rest, send: (m) => sent.push(m) });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ status: "failed", reason: expect.stringMatching(/^repo rule failed/) });
    } finally {
      if (saved === undefined) delete process.env.HOISTLINE_AGENT_HOME;
      else process.env.HOISTLINE_AGENT_HOME = saved;
    }

    const throwing = harness({
      loadPolicy: () => {
        throw new Error("boom");
      },
    });
    await execute(sign(), throwing.deps);
    expect(throwing.result()).toMatchObject({ status: "failed" });
  });

  it("asks for approval, then runs exactly the approved spec", async () => {
    const requests: { jobId: string; userId: string; spec: JobSpec; reason: string; specHash: string }[] = [];
    const h = harness({
      loadPolicy: () => RESTRICTED_ASK,
      requestApproval: async (req) => {
        requests.push(req);
        return true;
      },
    });
    const signed = sign({ write: { "approved.txt": "yes" } }, { repo: "https://github.com/Owner/Name.git", model: "m-1" });
    await execute(signed, h.deps);
    expect(h.statuses()).toEqual(["awaiting_approval", "running"]);
    expect(h.result()).toMatchObject({ status: "succeeded", branch: `hoistline/${signed.spec.jobId}` });
    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect(req).toMatchObject({ jobId: signed.spec.jobId, userId: USER });
    expect(req!.reason).toBe('runner rule failed: "muse" is not in the allowed runners');
    expect(req!.spec.repo).toBe("owner/name");
    const executed = ran.at(-1)!;
    expect(executed).toEqual(req!.spec);
    expect(specHashOf(executed)).toBe(req!.specHash);
  });

  it("fails approval_denied when the owner declines, and never runs", async () => {
    const h = harness({ loadPolicy: () => RESTRICTED_ASK, requestApproval: async () => false });
    const before = ran.length;
    const signed = sign();
    await execute(signed, h.deps);
    expect(h.statuses()).toEqual(["awaiting_approval"]);
    expect(h.result()).toEqual({ type: "job.result", jobId: signed.spec.jobId, status: "failed", reason: "approval_denied" });
    expect(ran.length).toBe(before);
  });

  it("denies by default when nobody can approve", async () => {
    const h = harness({ loadPolicy: () => RESTRICTED_ASK });
    await execute(sign(), h.deps);
    expect(h.result()).toMatchObject({ status: "failed", reason: "approval_denied" });
  });

  it("fails approval_timeout when nobody answers in time", async () => {
    const timers: [() => void, number][] = [];
    const h = harness({
      loadPolicy: () => RESTRICTED_ASK,
      requestApproval: () => new Promise<boolean>(() => {}),
      approvalTimeoutMs: 5000,
      setTimeout: (fn, ms) => timers.push([fn, ms]),
      clearTimeout: () => {},
    });
    const done = execute(sign(), h.deps);
    await waitFor(() => timers.length > 0, "approval timer");
    expect(timers[0]![1]).toBe(5000);
    timers[0]![0]();
    await done;
    expect(h.result()).toMatchObject({ status: "failed", reason: "approval_timeout" });
  });
});

describe("running a job", () => {
  it("commits and pushes the runner's changes to hoistline/<jobId> using the canonical repo", async () => {
    const h = harness();
    const signed = sign({ stdout: "working\n", write: { "hello.txt": "hi\n" } }, { repo: "https://github.com/Owner/Name.git" });
    const jobId = signed.spec.jobId;
    await execute(signed, h.deps);
    expect(h.result()).toEqual({
      type: "job.result",
      jobId,
      status: "succeeded",
      exitCode: 0,
      branch: `hoistline/${jobId}`,
      output: "working\n",
    });
    expect(h.statuses()).toEqual(["running"]);
    expect(h.stdout()).toBe("working\n");
    expect(new Set(h.remotes)).toEqual(new Set(["owner/name"]));
    expect(existsSync(join(h.cacheDir, "repos", "owner__name.git"))).toBe(true);
    expect(remoteFile(`hoistline/${jobId}`, "hello.txt")).toBe("hi\n");
    expect(existsSync(join(h.cacheDir, "work", jobId))).toBe(false);
    // The result is the last message.
    expect(h.sent.at(-1)!.type).toBe("job.result");
  });

  it("reports no_changes and pushes nothing when the runner changed nothing", async () => {
    const h = harness();
    const signed = sign({ stdout: "nothing to do" });
    await execute(signed, h.deps);
    expect(h.result()).toEqual({
      type: "job.result",
      jobId: signed.spec.jobId,
      status: "succeeded",
      exitCode: 0,
      reason: "no_changes",
      output: "nothing to do",
    });
    expect(remoteBranchSha(`hoistline/${signed.spec.jobId}`)).toBeNull();
  });

  it("pushes the commits of a runner that committed itself", async () => {
    const h = harness();
    const signed = sign({ write: { "own.txt": "own\n" }, commit: true });
    await execute(signed, h.deps);
    expect(h.result()).toMatchObject({ status: "succeeded", branch: `hoistline/${signed.spec.jobId}` });
    expect(remoteFile(`hoistline/${signed.spec.jobId}`, "own.txt")).toBe("own\n");
  });

  it("fails runner_exit_<code> on a nonzero exit and pushes nothing", async () => {
    const h = harness();
    const signed = sign({ write: { "partial.txt": "x" }, stderr: "boom\n", exit: 3 });
    await execute(signed, h.deps);
    expect(h.result()).toEqual({
      type: "job.result",
      jobId: signed.spec.jobId,
      status: "failed",
      exitCode: 3,
      reason: "runner_exit_3",
      output: "boom\n",
    });
    expect(remoteBranchSha(`hoistline/${signed.spec.jobId}`)).toBeNull();
    expect(existsSync(join(h.cacheDir, "work", signed.spec.jobId))).toBe(false);
  });

  it("fails runner_timeout when the runner runs too long", async () => {
    const h = harness({ runnerTimeoutMs: 300 });
    const signed = sign({ write: { "slow.txt": "x" }, sleepMs: 20_000 });
    await execute(signed, h.deps);
    expect(h.result()).toMatchObject({ status: "failed", reason: "runner_timeout" });
    expect(remoteBranchSha(`hoistline/${signed.spec.jobId}`)).toBeNull();
    expect(existsSync(join(h.cacheDir, "work", signed.spec.jobId))).toBe(false);
  });

  it("reports cancelled when aborted mid-run, and removes the worktree", async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    const signed = sign({ stdout: "started\n", write: { "x.txt": "x" }, sleepMs: 20_000 });
    const done = execute(signed, h.deps);
    await waitFor(() => h.stdout().includes("started"), "runner output");
    controller.abort();
    await done;
    expect(h.result()).toMatchObject({ status: "cancelled" });
    expect(remoteBranchSha(`hoistline/${signed.spec.jobId}`)).toBeNull();
    expect(existsSync(join(h.cacheDir, "work", signed.spec.jobId))).toBe(false);
  });

  it("maps runner start failures to their reasons and still removes the worktree", async () => {
    const cases: [Partial<JobSpec>, RegExp][] = [
      [{ runner: "codex" }, /^runner_not_installed: hoistline-test-missing-cli$/],
      [{ runner: "cursor", prompt: "€".repeat(50_000) }, /^prompt_too_large: /],
    ];
    if (posix) cases.push([{ runner: "grok" }, /^runner_spawn_failed: EACCES$/]);
    for (const [spec, reason] of cases) {
      const h = harness();
      const signed = sign({}, spec);
      await execute(signed, h.deps);
      expect(h.result(), JSON.stringify(spec.runner)).toMatchObject({ status: "failed", reason: expect.stringMatching(reason) });
      expect(existsSync(join(h.cacheDir, "work", signed.spec.jobId))).toBe(false);
    }
  });

  it("never leaks the cache directory in a reason", async () => {
    const h = harness();
    // A file where the work directory should be makes prepareWorktree refuse with a path in its message.
    writeFileSync(join(h.cacheDir, "work"), "");
    const signed = sign();
    await execute(signed, h.deps);
    const reason = h.result()!.reason!;
    expect(reason).toContain("<cache>");
    expect(reason).not.toContain(h.cacheDir);
    expect(reason.length).toBeLessThanOrEqual(500);
    expect(reason).not.toMatch(/[\u0000-\u001f]/);
  });

  it("never lets an exception escape, even when sending fails", async () => {
    const h = harness({
      send: () => {
        throw new Error("not connected");
      },
    });
    await expect(execute(sign({ write: { "a.txt": "a" } }), h.deps)).resolves.toBeUndefined();
    await expect(execute(null as unknown as SignedJob, h.deps)).resolves.toBeUndefined();
  });
});

describe("output", () => {
  it("keeps a 64 KiB tail in the result and the whole output in a private log file", async () => {
    const h = harness({ logDir: join(temp(), "logs") });
    const chunk = `${"z".repeat(1023)}\n`;
    const signed = sign({ big: { chunk, n: 100 }, stdout: "" , write: {} });
    await execute(signed, h.deps);
    const output = h.result()!.output!;
    expect(Buffer.byteLength(output)).toBe(64 * KiB);
    expect(output.endsWith(chunk)).toBe(true);
    const logFile = join(h.deps.logDir!, `${signed.spec.jobId}.log`);
    expect(statSync(logFile).size).toBe(100 * KiB);
    if (posix) expect(statSync(logFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(logFile, "utf8").endsWith(chunk)).toBe(true);
  });

  it("logs to <cacheDir>/logs by default", async () => {
    const h = harness();
    const signed = sign({ stdout: "hello" });
    await execute(signed, h.deps);
    expect(readFileSync(join(h.cacheDir, "logs", `${signed.spec.jobId}.log`), "utf8")).toBe("hello");
  });

  it("stops streaming events at the per-job cap while the job keeps running", async () => {
    const h = harness({ onOutputLimitBytes: 8 * KiB });
    const chunk = `${"q".repeat(1023)}\n`;
    const signed = sign({ big: { chunk, n: 64 }, write: { "after.txt": "done" } });
    await execute(signed, h.deps);
    const streamed = Buffer.byteLength(h.stdout());
    expect(streamed).toBeLessThanOrEqual(8 * KiB);
    expect(h.result()).toMatchObject({ status: "succeeded" });
    expect(Buffer.byteLength(h.result()!.output!)).toBe(64 * KiB);
    for (const m of h.sent) if (m.type === "job.event") expect(Buffer.byteLength(m.data)).toBeLessThanOrEqual(16 * KiB);
  });
});

describe("createExecutor", () => {
  function gatedJob(gate: string, extra: Script = {}) {
    return sign({ gate, ...extra });
  }

  it("runs at most maxConcurrentJobs at once; the rest wait in order and count as running", async () => {
    const h = harness();
    const ex = createExecutor({ ...h.deps, maxConcurrentJobs: 1 });
    const gateDir = temp();
    const a = gatedJob(join(gateDir, "a"), { stdout: "A" });
    const b = gatedJob(join(gateDir, "b"), { stdout: "B" });
    ex.onMessage({ type: "job.assign", job: a });
    ex.onMessage({ type: "job.assign", job: b });
    ex.onMessage({ type: "job.assign", job: a }); // a duplicate is ignored
    expect(ex.runningJobs()).toEqual([a.spec.jobId, b.spec.jobId]);
    await waitFor(() => h.statuses().length === 1, "first job running");
    await new Promise((r) => setTimeout(r, 200));
    expect(h.statuses()).toEqual(["running"]);
    writeFileSync(join(gateDir, "a"), "");
    writeFileSync(join(gateDir, "b"), "");
    await waitFor(() => h.results().length === 2, "both results");
    expect(h.results().map((r) => [r.jobId, r.status])).toEqual([
      [a.spec.jobId, "succeeded"],
      [b.spec.jobId, "succeeded"],
    ]);
    expect(ex.runningJobs()).toEqual([]);
    await ex.close();
  });

  it("cancels a waiting job at once without running it, and ignores unknown cancels", async () => {
    const h = harness();
    const ex = createExecutor({ ...h.deps, maxConcurrentJobs: 1 });
    const gateDir = temp();
    const a = gatedJob(join(gateDir, "a"));
    const b = gatedJob(join(gateDir, "b"), { write: { "b.txt": "b" } });
    ex.onMessage({ type: "job.assign", job: a });
    ex.onMessage({ type: "job.assign", job: b });
    ex.onMessage({ type: "job.cancel", jobId: "unknown-job" });
    ex.onMessage({ type: "job.cancel", jobId: b.spec.jobId });
    await waitFor(() => h.results().length === 1, "cancel result");
    expect(h.results()[0]).toMatchObject({ jobId: b.spec.jobId, status: "cancelled" });
    expect(ex.runningJobs()).toEqual([a.spec.jobId]);
    writeFileSync(join(gateDir, "a"), "");
    await waitFor(() => h.results().length === 2, "a result");
    expect(remoteBranchSha(`hoistline/${b.spec.jobId}`)).toBeNull();
    await ex.close();
  });

  it("cancels a running job on job.cancel", async () => {
    const h = harness();
    const ex = createExecutor(h.deps);
    const a = gatedJob(join(temp(), "never"), { stdout: "started" });
    ex.onMessage({ type: "job.assign", job: a });
    await waitFor(() => h.stdout().includes("started"), "running");
    ex.onMessage({ type: "job.cancel", jobId: a.spec.jobId });
    await waitFor(() => h.results().length === 1, "result");
    expect(h.results()[0]).toMatchObject({ jobId: a.spec.jobId, status: "cancelled" });
    expect(existsSync(join(h.cacheDir, "work", a.spec.jobId))).toBe(false);
    await ex.close();
  });

  it("close() cancels everything and waits for the jobs to settle", async () => {
    const h = harness();
    const ex = createExecutor({ ...h.deps, maxConcurrentJobs: 1 });
    const gateDir = temp();
    const a = gatedJob(join(gateDir, "a"), { stdout: "started" });
    const b = gatedJob(join(gateDir, "b"));
    ex.onMessage({ type: "job.assign", job: a });
    ex.onMessage({ type: "job.assign", job: b });
    await waitFor(() => h.stdout().includes("started"), "running");
    await ex.close();
    expect(h.results().map((r) => r.status).sort()).toEqual(["cancelled", "cancelled"]);
    expect(ex.runningJobs()).toEqual([]);
    expect(existsSync(join(h.cacheDir, "work", a.spec.jobId))).toBe(false);
    ex.onMessage({ type: "job.assign", job: sign() });
    expect(ex.runningJobs()).toEqual([]);
  });

  it("never throws from onMessage", () => {
    const h = harness();
    const ex = createExecutor(h.deps);
    expect(() => ex.onMessage({ type: "job.assign", job: null } as never)).not.toThrow();
    expect(() => ex.onMessage({ type: "tools.list", callId: "c" })).not.toThrow();
    expect(() => ex.onMessage(undefined as never)).not.toThrow();
    return ex.close();
  });
});
