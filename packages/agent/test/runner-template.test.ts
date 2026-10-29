import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { JobSpec } from "@hoistline/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { buildCommand, registerRunner } from "../src/index.js";
import { _resetRunnersForTests } from "../src/runners/template.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-runner.mjs", import.meta.url));
const HOSTILE = 'a b "c" $(touch /tmp/pwned); -y';

function spec(over: Partial<JobSpec> = {}): JobSpec {
  return { jobId: "job1", runner: "muse", repo: "owner/name", baseBranch: "main", prompt: HOSTILE, ...over };
}

/** Runs the child without a shell, feeds stdin, and parses the fake runner's JSON. */
function run(file: string, args: string[], stdin?: string): Promise<{ argv: string[]; stdin: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`exit ${code}: ${err}`));
      else resolve(JSON.parse(out) as { argv: string[]; stdin: string });
    });
    child.stdin.end(stdin ?? "");
  });
}

// Every test starts from an empty registry with the same two runners: one passes the prompt as a positional after
// `--`, the other via stdin.
beforeEach(() => {
  _resetRunnersForTests();
  registerRunner("muse", { file: process.execPath, args: (s) => [FAKE, "--", s.prompt] });
  registerRunner("codex", { file: process.execPath, args: () => [FAKE], stdin: (s) => s.prompt });
});

const PROMPTS = [
  HOSTILE,
  "plain",
  "it's \"quoted\" and `backticked` and $HOME and ${PATH}",
  "line one\nline two\r\n\ttabbed",
  "-y --dangerously-skip-permissions",
  "--",
  "x".repeat(100_000),
];

describe("buildCommand", () => {
  it("passes the hostile prompt as exactly one argument", () => {
    const cmd = buildCommand(spec());
    expect(cmd.file).toBe(process.execPath);
    expect(cmd.args).toEqual([FAKE, "--", HOSTILE]);
    expect(cmd.stdin).toBeUndefined();
  });

  it("passes the prompt via stdin when the template says so", () => {
    const cmd = buildCommand(spec({ runner: "codex" }));
    expect(cmd.args).toEqual([FAKE]);
    expect(cmd.stdin).toBe(HOSTILE);
  });

  it.each(PROMPTS.map((p) => [p.length > 60 ? `${p.slice(0, 20)}... (${p.length} chars)` : p, p]))(
    "argv runner receives %j unchanged",
    async (_label, prompt) => {
      const cmd = buildCommand(spec({ prompt }));
      const got = await run(cmd.file, cmd.args, cmd.stdin);
      expect(got.argv).toEqual(["--", prompt]);
      expect(got.stdin).toBe("");
    },
  );

  it.each(PROMPTS.map((p) => [p.length > 60 ? `${p.slice(0, 20)}... (${p.length} chars)` : p, p]))(
    "stdin runner receives %j unchanged",
    async (_label, prompt) => {
      const cmd = buildCommand(spec({ runner: "codex", prompt }));
      const got = await run(cmd.file, cmd.args, cmd.stdin);
      expect(got.argv).toEqual([]);
      expect(got.stdin).toBe(prompt);
    },
  );

  it.each(["gpt-5", "claude-opus-4.1", "org/model:tag", "M_1", "a".repeat(100)])("accepts model %j", (model) => {
    expect(() => buildCommand(spec({ model }))).not.toThrow();
  });

  it.each([
    "--evil",
    "-m",
    "a b",
    "",
    "a;b",
    "$(x)",
    "`x`",
    "a\nb",
    "a\0b",
    ".hidden",
    "/abs",
    "a=b",
    "mоdel", // Cyrillic о
    "a".repeat(101),
  ])("rejects model %j", (model) => {
    expect(() => buildCommand(spec({ model }))).toThrow(/model/);
  });

  it("never hands spec.command to a runner other than build-test", () => {
    const seen: (string | undefined)[] = [];
    registerRunner("cursor", {
      file: process.execPath,
      args: (s) => {
        seen.push(s.command);
        return [FAKE, "--", s.prompt];
      },
    });
    const cmd = buildCommand(spec({ runner: "cursor", command: "rm -rf /" }));
    expect(seen).toEqual([undefined]);
    expect(cmd.args).not.toContain("rm -rf /");
  });

  it("hands spec.command to build-test", () => {
    registerRunner("build-test", { file: process.execPath, args: (s) => [FAKE, "--", s.command ?? ""] });
    expect(buildCommand(spec({ runner: "build-test", command: "pnpm test" })).args).toEqual([FAKE, "--", "pnpm test"]);
  });

  it("throws runner_not_implemented for an unregistered runner", () => {
    for (const runner of ["grok", "cursor", "build-test"] as const) {
      expect(() => buildCommand(spec({ runner }))).toThrow(/runner_not_implemented/);
    }
  });

  it("reset clears every registration", () => {
    _resetRunnersForTests();
    expect(() => buildCommand(spec())).toThrow(/runner_not_implemented/);
  });

  it("rejects a template that returns a non-string argument", () => {
    registerRunner("grok", { file: process.execPath, args: () => [FAKE, 1 as unknown as string] });
    expect(() => buildCommand(spec({ runner: "grok" }))).toThrow(/argument/);
  });
});
