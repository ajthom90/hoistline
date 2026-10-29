import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareWorktree, pushBranch, removeWorktree, validateBranch, validateJobId, validateRepo } from "../src/index.js";
import { defaultRemote, runGit } from "../src/git.js";

// Fixture git: isolated from the developer's own config so fixtures build the same everywhere.
const FIXTURE_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const ID = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false"];

function fx(args: string[], cwd?: string, env: Record<string, string> = FIXTURE_ENV): string {
  return execFileSync("git", [...ID, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const temps: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "hoistline-git-"));
  temps.push(d);
  return d;
}

let root: string;
let remote: string;
const file = { remoteFor: () => remote, allowFileProtocol: true };

/** Builds a bare "GitHub" remote with branches main and dev, each with a distinct README. */
function makeRemote(dir: string): string {
  const bare = join(dir, "remote.git");
  const work = join(dir, "seed");
  fx(["init", "-q", "--bare", "-b", "main", bare]);
  fx(["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "README"), "main\n");
  fx(["add", "README"], work);
  fx(["commit", "-q", "-m", "main"], work);
  fx(["push", "-q", bare, "main"], work);
  fx(["checkout", "-q", "-b", "dev"], work);
  writeFileSync(join(work, "README"), "dev\n");
  fx(["commit", "-q", "-am", "dev"], work);
  fx(["push", "-q", bare, "dev"], work);
  return bare;
}

function remoteSha(ref: string): string | null {
  try {
    return fx(["rev-parse", "--verify", "-q", ref], remote).trim();
  } catch {
    return null;
  }
}

beforeAll(() => {
  root = temp();
  remote = makeRemote(root);
});

afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("validateRepo", () => {
  it.each([
    ["owner/name", "owner/name"],
    ["Owner/Name.git", "owner/name"],
    ["https://github.com/Owner/Name.git", "owner/name"],
  ])("accepts %j", (input, out) => {
    expect(validateRepo(input)).toBe(out);
  });

  it.each([
    "",
    "--upload-pack=x",
    "--upload-pack=x/y",
    "-o/n",
    "ext::sh -c touch% /tmp/x",
    "git@github.com:o/n.git",
    "ssh://git@github.com/o/n",
    "http://github.com/o/n",
    "https://evil.example/o/n",
    "https://user@github.com/o/n",
    "file:///tmp/x",
    "/tmp/x",
    "../o/n",
    "o/n/x",
    "o/n ",
    "o/n\n",
    "оwner/name", // Cyrillic о
  ])("rejects %j", (input) => {
    expect(() => validateRepo(input)).toThrow(/invalid repository/);
  });
});

describe("validateBranch", () => {
  const accepted = ["main", "dev", "feature/x-1", "release/1.2", "a.b", "hoistline/job_1", "A/B/C", "x".repeat(255)];

  it.each(accepted)("accepts %j", (name) => {
    expect(validateBranch(name)).toBe(name);
  });

  it.each(accepted)("%j is also accepted by git check-ref-format --branch", (name) => {
    expect(fx(["check-ref-format", "--branch", name]).trim()).toBe(name);
  });

  it.each([
    "-x",
    "--upload-pack=x",
    "a/../b",
    "a..b",
    "..",
    "a//b",
    "a/",
    "/a",
    ".a",
    "a/.b",
    "a.",
    "a.lock",
    "a.lock/b",
    "a/b.lock",
    "a b",
    "a\tb",
    "a\nb",
    "a\0b",
    "a~b",
    "a^b",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
    "mаin", // Cyrillic а
    "a∕b", // division slash
    "ｍａｉｎ", // fullwidth
    "x".repeat(256),
    "",
    "@{u}",
    "a@{u}",
    "@",
    "HEAD",
  ])("rejects %j", (name) => {
    expect(() => validateBranch(name)).toThrow(/invalid branch/);
  });
});

describe("validateJobId", () => {
  it.each(["job1", "a", "A_b-1", "0", "a".repeat(64)])("accepts %j", (id) => {
    expect(validateJobId(id)).toBe(id);
  });

  it.each(["", "-a", "_a", "../x", "..", ".", "a/b", "a b", "a.b", "a\n", "ä", "a".repeat(65)])("rejects %j", (id) => {
    expect(() => validateJobId(id)).toThrow(/invalid job id/);
  });
});

describe("defaultRemote", () => {
  it("derives the URL from the canonical repo only", () => {
    expect(defaultRemote("owner/name")).toBe("https://github.com/owner/name.git");
  });
});

describe("prepareWorktree", () => {
  it("creates hoistline/<jobId> from the requested base branch", async () => {
    const cache = temp();
    const seen: string[] = [];
    const ws = await prepareWorktree("https://github.com/Owner/Name.git", "dev", "job1", cache, {
      remoteFor: (c) => {
        seen.push(c);
        return remote;
      },
      allowFileProtocol: true,
    });
    expect(seen).toEqual(["owner/name"]);
    expect(ws).toEqual({ dir: join(cache, "work", "job1"), branch: "hoistline/job1" });
    expect(readFileSync(join(ws.dir, "README"), "utf8")).toBe("dev\n");
    expect(fx(["symbolic-ref", "HEAD"], ws.dir).trim()).toBe("refs/heads/hoistline/job1");
    expect(existsSync(join(cache, "repos", "owner__name.git", "HEAD"))).toBe(true);
    expect(fx(["rev-parse", "HEAD"], ws.dir).trim()).toBe(remoteSha("refs/heads/dev"));

    const main = await prepareWorktree("owner/name", "main", "job2", cache, file);
    expect(readFileSync(join(main.dir, "README"), "utf8")).toBe("main\n");
  });

  it("validates its inputs before touching disk", async () => {
    const cache = temp();
    await expect(prepareWorktree("--upload-pack=x", "main", "j", cache, file)).rejects.toThrow(/invalid repository/);
    await expect(prepareWorktree("o/n", "-x", "j", cache, file)).rejects.toThrow(/invalid branch/);
    await expect(prepareWorktree("o/n", "main", "../j", cache, file)).rejects.toThrow(/invalid job id/);
    expect(existsSync(join(cache, "repos"))).toBe(false);
  });

  it("fails cleanly when the base branch does not exist", async () => {
    const cache = temp();
    await expect(prepareWorktree("o/n", "nope", "job1", cache, file)).rejects.toThrow(/base branch "nope"/);
    expect(existsSync(join(cache, "work", "job1"))).toBe(false);
  });

  it("refuses to reuse a job id", async () => {
    const cache = temp();
    await prepareWorktree("o/n", "main", "job1", cache, file);
    await expect(prepareWorktree("o/n", "main", "job1", cache, file)).rejects.toThrow(/job id "job1" was already used/);
    // Still refused after the worktree is gone, because the branch remains.
    await removeWorktree("o/n", "job1", cache);
    await expect(prepareWorktree("o/n", "main", "job1", cache, file)).rejects.toThrow(/job id "job1" was already used/);
  });

  it("serializes concurrent jobs on the same repo", async () => {
    const cache = temp();
    const ids = ["c1", "c2", "c3", "c4"];
    const results = await Promise.all(ids.map((id) => prepareWorktree("o/n", "main", id, cache, file)));
    expect(results.map((r) => r.branch)).toEqual(ids.map((id) => `hoistline/${id}`));
    for (const r of results) expect(readFileSync(join(r.dir, "README"), "utf8")).toBe("main\n");
  });

  it("refuses the file protocol unless explicitly allowed", async () => {
    const cache = temp();
    await expect(prepareWorktree("o/n", "main", "job1", cache, { remoteFor: () => remote })).rejects.toThrow(
      /transport 'file' not allowed/,
    );
  });

  it("never runs hooks in the mirror", async () => {
    const cache = temp();
    await prepareWorktree("o/n", "main", "first", cache, file);
    const mirror = join(cache, "repos", "o__n.git");
    const marker = join(cache, "hook-ran");
    for (const hook of ["post-checkout", "reference-transaction", "pre-push", "post-index-change"]) {
      const p = join(mirror, "hooks", hook);
      writeFileSync(p, `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
      chmodSync(p, 0o755);
    }
    const ws = await prepareWorktree("o/n", "main", "second", cache, file);
    writeFileSync(join(ws.dir, "new.txt"), "x\n");
    // The worktree shares the mirror's hooks directory, so the fixture's own commit must skip them too.
    fx(["-c", "core.hooksPath=/dev/null", "add", "new.txt"], ws.dir);
    fx(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "x"], ws.dir);
    await pushBranch(ws.dir, ws.branch, { allowFileProtocol: true });
    await removeWorktree("o/n", "second", cache);
    expect(existsSync(marker)).toBe(false);

    // Control: the same hooks do run under plain git, so the assertion above is meaningful.
    fx(["worktree", "add", "-q", "-b", "control", join(cache, "control"), "refs/remotes/origin/main"], mirror);
    expect(readFileSync(marker, "utf8")).toMatch(/post-checkout/);
  });
});

describe("runGit protocol policy", () => {
  it("blocks an ext:: remote even when the owner's global config allows it", async () => {
    const cache = temp();
    const home = temp();
    const marker = join(home, "pwned");
    const url = `ext::sh -c touch% ${marker}`;
    writeFileSync(join(home, ".gitconfig"), "[protocol]\n\tallow = always\n[protocol \"ext\"]\n\tallow = always\n");
    const savedHome = process.env.HOME;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    try {
      await expect(runGit(["ls-remote", "--", url], { cacheDir: cache })).rejects.toThrow(/git ls-remote failed/);
      await expect(runGit(["ls-remote", "--", url], { cacheDir: cache, allowFileProtocol: true })).rejects.toThrow();
    } finally {
      process.env.HOME = savedHome;
      if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
    }
    expect(existsSync(marker)).toBe(false);

    // Control: plain git with ext allowed does run the command.
    try {
      fx(["-c", "protocol.ext.allow=always", "ls-remote", "--", url]);
    } catch {
      // ls-remote fails because touch speaks no git protocol; the side effect is what matters.
    }
    expect(existsSync(marker)).toBe(true);
  });

  it("scrubs the environment of git overrides", async () => {
    const cache = temp();
    const leaked = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "hoistline.probe", GIT_CONFIG_VALUE_0: "leaked" };
    Object.assign(process.env, leaked);
    try {
      // Control: the variables do inject config into a plain child git.
      expect(execFileSync("git", ["config", "--get", "hoistline.probe"], { encoding: "utf8" }).trim()).toBe("leaked");
      await expect(runGit(["config", "--get", "hoistline.probe"], { cacheDir: cache })).rejects.toThrow(
        /git config failed/,
      );
      const { stdout } = await runGit(["config", "--get", "core.fsmonitor"], { cacheDir: cache });
      expect(stdout.trim()).toBe("false");
    } finally {
      for (const k of Object.keys(leaked)) delete process.env[k];
    }
  });
});

describe("pushBranch", () => {
  it("pushes hoistline/<jobId> to the remote and never force-pushes", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "push1", cache, file);
    writeFileSync(join(ws.dir, "out.txt"), "result\n");
    fx(["add", "out.txt"], ws.dir);
    fx(["commit", "-q", "-m", "result"], ws.dir);
    const head = fx(["rev-parse", "HEAD"], ws.dir).trim();
    await pushBranch(ws.dir, ws.branch, { allowFileProtocol: true });
    expect(remoteSha("refs/heads/hoistline/push1")).toBe(head);
    expect(remoteSha("refs/heads/main")).not.toBe(head);

    // Rewrite history; a second push must be rejected rather than forced.
    fx(["reset", "-q", "--hard", "HEAD~1"], ws.dir);
    writeFileSync(join(ws.dir, "other.txt"), "rewritten\n");
    fx(["add", "other.txt"], ws.dir);
    fx(["commit", "-q", "-m", "rewritten"], ws.dir);
    await expect(pushBranch(ws.dir, ws.branch, { allowFileProtocol: true })).rejects.toThrow(/git push failed/);
    expect(remoteSha("refs/heads/hoistline/push1")).toBe(head);
  });

  it("refuses branches that are not this worktree's hoistline/<jobId>", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "push2", cache, file);
    for (const b of ["main", "hoistline/other", "hoistline/../main", "hoistline/push2 ", "--force", "hoistline/"]) {
      await expect(pushBranch(ws.dir, b, { allowFileProtocol: true })).rejects.toThrow(/refusing to push/);
    }
    await expect(pushBranch(join(cache, "elsewhere"), "hoistline/elsewhere")).rejects.toThrow(/refusing to push/);
    expect(remoteSha("refs/heads/hoistline/push2")).toBeNull();
  });

  it("refuses the file protocol unless explicitly allowed", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "push3", cache, file);
    await expect(pushBranch(ws.dir, ws.branch)).rejects.toThrow(/git push failed.*transport 'file' not allowed/s);
    expect(remoteSha("refs/heads/hoistline/push3")).toBeNull();
  });
});

describe("removeWorktree", () => {
  it("removes the worktree and prunes it from the mirror", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "rm1", cache, file);
    writeFileSync(join(ws.dir, "untracked.txt"), "x\n");
    await removeWorktree("o/n", "rm1", cache);
    expect(existsSync(ws.dir)).toBe(false);
    const list = fx(["worktree", "list", "--porcelain"], join(cache, "repos", "o__n.git"));
    expect(list).not.toContain(ws.dir);
  });

  it("is a no-op for a job with no worktree", async () => {
    const cache = temp();
    await prepareWorktree("o/n", "main", "rm2", cache, file);
    await expect(removeWorktree("o/n", "never", cache)).resolves.toBeUndefined();
  });

  it("refuses paths outside cacheDir", async () => {
    const cache = temp();
    const outside = temp();
    writeFileSync(join(outside, "keep.txt"), "keep\n");
    await expect(removeWorktree("o/n", "../../outside", cache)).rejects.toThrow(/invalid job id/);
    await expect(removeWorktree("../o/n", "rm3", cache)).rejects.toThrow(/invalid repository/);
    mkdirSync(join(cache, "work"), { recursive: true });
    symlinkSync(outside, join(cache, "work", "rm3"));
    await expect(removeWorktree("o/n", "rm3", cache)).rejects.toThrow(/refusing to remove/);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
  });
});
