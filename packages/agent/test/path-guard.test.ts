import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUNNER_CLI_NAMES, findRunnerCLIs, guardedTestPath } from "./path-guard.js";

const posix = process.platform !== "win32";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hoistline-guard-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function dirWith(name: string, files: Record<string, number>): string {
  const dir = join(root, name);
  mkdirSync(dir);
  for (const [file, mode] of Object.entries(files)) {
    writeFileSync(join(dir, file), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, file), mode);
  }
  return dir;
}

describe.skipIf(!posix)("the agent test PATH guard", () => {
  it("names every runner CLI", () => {
    expect([...RUNNER_CLI_NAMES].sort()).toEqual(["codex", "cursor", "cursor-agent", "grok", "muse"]);
  });

  it("runs the agent tests with only the system directories (and git's) on PATH", () => {
    expect(process.env.PATH).toBe(guardedTestPath());
    const dirs = (process.env.PATH ?? "").split(delimiter);
    expect(dirs.slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
    expect(findRunnerCLIs(process.env.PATH ?? "")).toEqual([]);
  });

  it("finds an executable runner CLI in a directory that is not exempt", () => {
    const dir = dirWith("bin", { muse: 0o755, "cursor-agent": 0o755, other: 0o755 });
    expect(findRunnerCLIs(`/usr/bin${delimiter}${dir}`, { exemptUnder: [] })).toEqual([
      join(dir, "muse"),
      join(dir, "cursor-agent"),
    ]);
  });

  it("finds a symlink to an executable runner CLI", () => {
    const real = dirWith("real", { anything: 0o755 });
    const dir = dirWith("bin", {});
    symlinkSync(join(real, "anything"), join(dir, "codex"));
    expect(findRunnerCLIs(dir, { exemptUnder: [] })).toEqual([join(dir, "codex")]);
  });

  it("ignores a runner name that is not executable", () => {
    const dir = dirWith("bin", { grok: 0o644 });
    expect(findRunnerCLIs(dir, { exemptUnder: [] })).toEqual([]);
  });

  it("exempts directories the tests create under the OS temp dir (the fake CLIs)", () => {
    const dir = dirWith("bin", { muse: 0o755, codex: 0o755 });
    expect(findRunnerCLIs(dir)).toEqual([]);
  });
});
