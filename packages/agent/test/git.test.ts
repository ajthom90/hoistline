import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  openSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  commitWorktree,
  GitError,
  prepareWorktree,
  pushBranch,
  removeWorktree,
  validateBranch,
  validateJobId,
  validateRepo,
} from "../src/index.js";
import {
  _resetPlatformProbeForTests,
  defaultRemote,
  MIRROR_CONFIG,
  mirrorConfig,
  mirrorGit,
  parsePlatformConfig,
  probePlatformConfig,
  runGit,
  scrubbedEnv,
} from "../src/git.js";

// Fixture git: isolated from the developer's own config so fixtures build the same everywhere.
const FIXTURE_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const ID = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false"];

/** Plain git, as a runner (or an attacker) would run it. */
function fx(args: string[], cwd?: string, env: Record<string, string> = FIXTURE_ENV): string {
  return execFileSync("git", [...ID, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function fxMaybe(args: string[], cwd?: string): void {
  try {
    fx(args, cwd);
  } catch {
    // Expected for some control runs; only the side effect matters.
  }
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

function emptyBare(): string {
  const bare = join(temp(), "evil.git");
  fx(["init", "-q", "--bare", "-b", "main", bare]);
  return bare;
}

function shaIn(repo: string, ref: string): string | null {
  try {
    return fx(["rev-parse", "--verify", "-q", ref], repo).trim();
  } catch {
    return null;
  }
}
const remoteSha = (ref: string) => shaIn(remote, ref);

function branchesIn(repo: string): string {
  return fx(["for-each-ref", "--format=%(refname)", "refs/heads"], repo).trim();
}

/** A runner's commit in its worktree, ignoring the (possibly poisoned) shared hooks and fsmonitor. */
function runnerCommit(dir: string, name: string): string {
  writeFileSync(join(dir, name), `${name}\n`);
  const safe = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
  fx([...safe, "add", name], dir);
  fx([...safe, "commit", "-q", "-m", name], dir);
  return fx(["rev-parse", "HEAD"], dir).trim();
}

const mirrorOf = (cache: string) => join(cache, "repos", "o__n.git");

/** True when the temp filesystem ignores case (the macOS default). */
function caseInsensitiveFs(): boolean {
  const d = mkdtempSync(join(tmpdir(), "hoistline-case-"));
  try {
    writeFileSync(join(d, "CaseProbe"), "");
    return existsSync(join(d, "caseprobe"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const CASE_INSENSITIVE = caseInsensitiveFs();

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
    const mirror = join(cache, "repos", "owner__name.git");
    expect(existsSync(join(mirror, "HEAD"))).toBe(true);
    expect(fx(["rev-parse", "HEAD"], ws.dir).trim()).toBe(remoteSha("refs/heads/dev"));
    // No remote (or anything else) is stored in the mirror's config.
    expect(readFileSync(join(mirror, "config"), "utf8")).toBe(await mirrorConfig(cache));

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
});

describe("a runner poisoning the shared mirror", () => {
  it("cannot get a hook planted in the mirror run on the next job", async () => {
    const cache = temp();
    const first = await prepareWorktree("o/n", "main", "first", cache, file);
    const mirror = mirrorOf(cache);
    const marker = join(cache, "hook-ran");
    // The runner of job "first" plants hooks in the common git dir and points config at them.
    const hooks = join(mirror, "hooks");
    for (const hook of ["post-checkout", "reference-transaction", "pre-push", "post-index-change"]) {
      const p = join(hooks, hook);
      writeFileSync(p, `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
      chmodSync(p, 0o755);
    }
    const fsmon = join(cache, "fsmonitor.sh");
    writeFileSync(fsmon, `#!/bin/sh\necho fsmonitor >> "${marker}"\n`);
    chmodSync(fsmon, 0o755);
    fx(["config", "core.hooksPath", hooks], first.dir);
    fx(["config", "core.fsmonitor", fsmon], first.dir);

    // Control: plain git in the mirror does run them.
    fx(["--git-dir", mirror, "worktree", "add", "-q", "-b", "control", join(cache, "control"), "refs/remotes/origin/main"]);
    expect(readFileSync(marker, "utf8")).toMatch(/post-checkout/);
    rmSync(marker);

    const ws = await prepareWorktree("o/n", "main", "second", cache, file);
    runnerCommit(ws.dir, "new.txt");
    await pushBranch("o/n", "second", cache, file);
    await removeWorktree("o/n", "second", cache);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(hooks)).toEqual([]);
    expect(readFileSync(join(mirror, "config"), "utf8")).toBe(await mirrorConfig(cache));
  });

  it("cannot get a smudge filter (config plus info/attributes) run by the next prepareWorktree", async () => {
    const cache = temp();
    const first = await prepareWorktree("o/n", "main", "first", cache, file);
    const mirror = mirrorOf(cache);
    const marker = join(cache, "SMUDGE_RAN");
    const evil = emptyBare();
    fx(["config", "filter.p.smudge", `sh -c 'touch ${marker}; cat'`], first.dir);
    const inc = join(cache, "inc.cfg");
    writeFileSync(inc, `[url "${evil}"]\n\tinsteadOf = ${remote}\n`);
    fx(["config", "include.path", inc], first.dir);
    mkdirSync(join(mirror, "info"), { recursive: true });
    writeFileSync(join(mirror, "info", "attributes"), "* filter=p\n");
    writeFileSync(join(mirror, "config.worktree"), `[filter "p"]\n\tsmudge = sh -c 'touch ${marker}; cat'\n`);

    // Control: plain git checkout in the poisoned mirror runs the filter.
    fx(["--git-dir", mirror, "worktree", "add", "-q", "-b", "control", join(cache, "control"), "refs/remotes/origin/main"]);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    // Control: the include redirects a fetch of the canonical URL to the attacker (which has no main).
    expect(() => fx(["--git-dir", mirror, "fetch", "-q", "--", remote, "+refs/heads/main:refs/x/probe"])).toThrow();

    const ws = await prepareWorktree("o/n", "dev", "second", cache, file);
    expect(readFileSync(join(ws.dir, "README"), "utf8")).toBe("dev\n");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(mirror, "info", "attributes"))).toBe(false);
    expect(existsSync(join(mirror, "config.worktree"))).toBe(false);
    expect(readFileSync(join(mirror, "config"), "utf8")).toBe(await mirrorConfig(cache));
  });

  it("cannot redirect the push with pushurl, insteadOf or include.path", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "redir", cache, file);
    const mirror = mirrorOf(cache);
    const evil = emptyBare();
    // The runner, in its worktree, writes to the shared config.
    fx(["config", "remote.origin.url", remote], ws.dir);
    fx(["config", "remote.origin.pushurl", evil], ws.dir);
    fx(["config", `url.${evil}.insteadOf`, remote], ws.dir);
    const inc = join(cache, "inc.cfg");
    writeFileSync(inc, `[url "${evil}"]\n\tpushInsteadOf = ${remote}\n`);
    fx(["config", "include.path", inc], ws.dir);
    const head = runnerCommit(ws.dir, "out.txt");

    // Control: plain git pushing to the canonical URL from the poisoned mirror lands in evil.
    fx(["--git-dir", mirror, "push", "-q", "--", remote, "refs/heads/hoistline/redir:refs/heads/control-probe"]);
    expect(shaIn(evil, "refs/heads/control-probe")).toBe(head);
    expect(remoteSha("refs/heads/control-probe")).toBeNull();

    await pushBranch("o/n", "redir", cache, file);
    expect(remoteSha("refs/heads/hoistline/redir")).toBe(head);
    expect(branchesIn(evil)).toBe("refs/heads/control-probe");
  });

  it("pushes from the mirror even if the runner rewrites the worktree's .git file", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "gitfile", cache, file);
    const head = runnerCommit(ws.dir, "out.txt");
    const evil = emptyBare();
    // An attacker repo with its own hoistline/gitfile and a pushurl to evil.
    const attacker = join(temp(), "attacker");
    fx(["init", "-q", "-b", "hoistline/gitfile", attacker]);
    const bogus = runnerCommit(attacker, "bogus.txt");
    fx(["config", "remote.origin.url", remote], attacker);
    fx(["config", "remote.origin.pushurl", evil], attacker);
    writeFileSync(join(ws.dir, ".git"), `gitdir: ${join(attacker, ".git")}\n`);

    // Control: plain git in the worktree now operates on the attacker's repo.
    expect(fx(["rev-parse", "HEAD"], ws.dir).trim()).toBe(bogus);

    await pushBranch("o/n", "gitfile", cache, file);
    expect(remoteSha("refs/heads/hoistline/gitfile")).toBe(head);
    expect(branchesIn(evil)).toBe("");
  });

  it("resets an existing mirror left behind by a failed fetch", async () => {
    const cache = temp();
    await expect(prepareWorktree("o/n", "nope", "job0", cache, file)).rejects.toThrow(/base branch "nope"/);
    const mirror = mirrorOf(cache);
    expect(existsSync(join(mirror, "HEAD"))).toBe(true);
    const marker = join(cache, "ran");
    writeFileSync(join(mirror, "config"), `${MIRROR_CONFIG}[filter "p"]\n\tsmudge = sh -c 'touch ${marker}; cat'\n`);
    mkdirSync(join(mirror, "info"), { recursive: true });
    writeFileSync(join(mirror, "info", "attributes"), "* filter=p\n");
    const hook = join(mirror, "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(hook, 0o755);

    const ws = await prepareWorktree("o/n", "main", "job1", cache, file);
    expect(readFileSync(join(ws.dir, "README"), "utf8")).toBe("main\n");
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(mirror, "config"), "utf8")).toBe(await mirrorConfig(cache));
  });

  it("removes per-worktree config.worktree files", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "wtcfg", cache, file);
    const planted = join(mirrorOf(cache), "worktrees", "wtcfg", "config.worktree");
    writeFileSync(planted, "[core]\n\tfsmonitor = /bin/false\n");
    runnerCommit(ws.dir, "x.txt");
    await pushBranch("o/n", "wtcfg", cache, file);
    expect(existsSync(planted)).toBe(false);
  });

  /** The runner of `dir` replaces the README blob with INJECTED via plain `git replace`. */
  function plantReplacement(dir: string): void {
    const evilBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: dir,
      input: "INJECTED\n",
      env: FIXTURE_ENV,
      encoding: "utf8",
    }).trim();
    const realBlob = fx(["rev-parse", "HEAD:README"], dir).trim();
    fx(["replace", realBlob, evilBlob], dir);
  }

  function controlCheckout(mirror: string): string {
    const control = join(temp(), "control");
    fx(["--git-dir", mirror, "worktree", "add", "-q", "-b", "control", control, "refs/remotes/origin/main"]);
    return readFileSync(join(control, "README"), "utf8");
  }

  it("cannot substitute objects for the next job through refs/replace", async () => {
    const cache = temp();
    const first = await prepareWorktree("o/n", "main", "first", cache, file);
    const mirror = mirrorOf(cache);
    plantReplacement(first.dir);
    // Control: plain git checks out the injected content.
    expect(controlCheckout(mirror)).toBe("INJECTED\n");

    const ws = await prepareWorktree("o/n", "main", "second", cache, file);
    expect(readFileSync(join(ws.dir, "README"), "utf8")).toBe("main\n");
    expect(existsSync(join(mirror, "refs", "replace"))).toBe(false);
  });

  it("ignores a replace ref the reset cannot see (packed into packed-refs)", async () => {
    const cache = temp();
    const first = await prepareWorktree("o/n", "main", "first", cache, file);
    const mirror = mirrorOf(cache);
    plantReplacement(first.dir);
    fx(["pack-refs", "--all"], first.dir);
    expect(readFileSync(join(mirror, "packed-refs"), "utf8")).toMatch(/refs\/replace\//);
    // Control: plain git still checks out the injected content.
    expect(controlCheckout(mirror)).toBe("INJECTED\n");

    const ws = await prepareWorktree("o/n", "main", "second", cache, file);
    expect(readFileSync(join(ws.dir, "README"), "utf8")).toBe("main\n");
    writeFileSync(join(ws.dir, "x.txt"), "x\n");
    await commitWorktree("o/n", "second", cache, file);
    const show = (path: string) =>
      fx(["--no-replace-objects", "--git-dir", mirror, "show", `refs/heads/hoistline/second:${path}`]);
    expect(show("README")).toBe("main\n");
    expect(show("x.txt")).toBe("x\n");
  });

  it("cannot hide new files from the commit with info/exclude", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "excl", cache, file);
    const mirror = mirrorOf(cache);
    mkdirSync(join(mirror, "info"), { recursive: true });
    writeFileSync(join(mirror, "info", "exclude"), "*\n");
    writeFileSync(join(ws.dir, "new.txt"), "new\n");
    // Control: plain git in the worktree would stage nothing.
    expect(fx(["add", "--all", "--dry-run"], ws.dir)).toBe("");

    const res = await commitWorktree("o/n", "excl", cache, file);
    expect(res.committed).toBe(true);
    expect(fx(["--git-dir", mirror, "show", "refs/heads/hoistline/excl:new.txt"])).toBe("new\n");
    expect(existsSync(join(mirror, "info", "exclude"))).toBe(false);
  });
});

describe("the platform config probe", () => {
  it("parses only core.ignorecase, precomposeunicode, filemode and symlinks, and only boolean values", () => {
    const hostile = [
      "[core]",
      "\trepositoryformatversion = 0",
      "\tfilemode = true",
      "\tbare = false",
      "\tlogallrefupdates = true",
      "\tignorecase = true",
      "\tprecomposeunicode = true",
      "\tsymlinks = $(touch x)",
      "\thooksPath = /evil",
      "\tfsmonitor = /evil",
      '[core "x"]',
      "\tsymlinks = false",
      '[filter "p"]',
      "\tsmudge = evil",
      "\tignorecase = false",
    ].join("\n");
    expect(parsePlatformConfig(hostile)).toEqual({ ignorecase: "true", precomposeunicode: "true", filemode: "true" });
  });

  it("probes once per cache dir in a throwaway repo under the cache and cleans it up", async () => {
    _resetPlatformProbeForTests();
    const cache = temp();
    const probed = await probePlatformConfig(cache);
    for (const [k, v] of Object.entries(probed)) {
      expect(["ignorecase", "precomposeunicode", "filemode", "symlinks"]).toContain(k);
      expect(["true", "false"]).toContain(v);
    }
    if (CASE_INSENSITIVE) expect(probed.ignorecase).toBe("true");
    expect(readdirSync(cache)).toEqual([]);
    // Cached per cache dir: the same dir is not probed again, another dir gets its own probe.
    expect(await probePlatformConfig(cache)).toBe(probed);
    const other = temp();
    const otherProbe = await probePlatformConfig(other);
    expect(otherProbe).not.toBe(probed);
    expect(otherProbe).toEqual(probed);
    expect(readdirSync(other)).toEqual([]);
    const lines = Object.entries(probed).map(([k, v]) => `\t${k} = ${v}\n`);
    expect(await mirrorConfig(cache)).toBe(MIRROR_CONFIG + lines.join(""));
  });

  it("is not steered by the owner's init.templateDir", async () => {
    const home = temp();
    const template = join(home, "template");
    mkdirSync(template);
    writeFileSync(join(template, "config"), "[core]\n\tsymlinks = false\n\tfilemode = false\n");
    writeFileSync(join(home, ".gitconfig"), `[init]\n\ttemplateDir = ${template}\n`);
    const homeEnv = { ...FIXTURE_ENV, HOME: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig") };
    // Control: a plain `git init` with that global config takes the template's values.
    const control = join(temp(), "control");
    fx(["init", "-q", control], undefined, homeEnv);
    expect(readFileSync(join(control, ".git", "config"), "utf8")).toMatch(/symlinks = false/);

    _resetPlatformProbeForTests();
    const cache = temp();
    const probed = await withHome(home, () => probePlatformConfig(cache));
    expect(probed.symlinks).toBeUndefined();
    expect(probed.filemode).toBe("true");
  });
});

/** Runs `fn` with the owner's HOME (and so their global git config) pointed at `home`. */
async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

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
    fxMaybe(["-c", "protocol.ext.allow=always", "ls-remote", "--", url]);
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

  it("keeps the owner's proxy and CA settings and drops every other GIT_* variable", () => {
    const kept = {
      HTTPS_PROXY: "http://proxy:1",
      https_proxy: "http://proxy:2",
      HTTP_PROXY: "http://proxy:3",
      http_proxy: "http://proxy:4",
      NO_PROXY: "localhost",
      no_proxy: "127.0.0.1",
      SSL_CERT_FILE: "/ca.pem",
      SSL_CERT_DIR: "/ca",
      GIT_SSL_CAINFO: "/git-ca.pem",
      GIT_SSL_CAPATH: "/git-ca",
      GIT_ASKPASS: "/askpass",
    };
    const dropped = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "c",
      GIT_CONFIG_PARAMETERS: "'a.b'='c'",
      GIT_DIR: "/x",
      GIT_SSH_COMMAND: "touch /tmp/x",
      GIT_EXEC_PATH: "/x",
      GIT_SSL_NO_VERIFY: "1",
      LD_PRELOAD: "/x.so",
    };
    const saved = { ...process.env };
    Object.assign(process.env, kept, dropped);
    try {
      const env = scrubbedEnv();
      for (const [k, v] of Object.entries(kept)) expect(env[k]).toBe(v);
      for (const k of Object.keys(dropped)) expect(env[k]).toBeUndefined();
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env.GIT_NO_REPLACE_OBJECTS).toBe("1");
    } finally {
      for (const k of [...Object.keys(kept), ...Object.keys(dropped)]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

function processesMatching(needle: string): string[] {
  return execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(needle));
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

describe.skipIf(process.platform === "win32")("network timeouts", () => {
  it("kill a hung fetch and its whole process group", async () => {
    const sockets: Socket[] = [];
    let closed = 0;
    const server = createServer((s) => {
      sockets.push(s);
      s.resume(); // consume the ClientHello so a peer close is observed
      s.on("error", () => undefined);
      s.on("close", () => closed++);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      // Control: a timeout that SIGKILLs only git (what execFile's timeout does) orphans its https helper, which
      // keeps holding the connection.
      const controlUrl = `https://127.0.0.1:${port}/control-${port}.git`;
      await new Promise<void>((r) =>
        execFile(
          "git",
          ["ls-remote", "--", controlUrl],
          { env: FIXTURE_ENV, timeout: 300, killSignal: "SIGKILL" },
          () => r(),
        ),
      );
      await new Promise((r) => setTimeout(r, 300));
      const leftovers = processesMatching(`control-${port}`);
      for (const line of leftovers) process.kill(Number(line.trim().split(/\s+/)[0]), "SIGKILL");
      expect(leftovers.length).toBeGreaterThan(0);

      const cache = temp();
      const url = `https://127.0.0.1:${port}/hung-${port}/o/n.git`;
      const before = sockets.length;
      const start = Date.now();
      await expect(
        prepareWorktree("o/n", "main", "hung", cache, { remoteFor: () => url, timeoutMs: 500 }),
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - start).toBeLessThan(5000);
      expect(sockets.length).toBeGreaterThan(before);
      // The helper that held the connection is gone: the server sees every connection close.
      const ok = await waitFor(() => closed === sockets.length, 3000);
      expect(ok).toBe(true);
      expect(processesMatching(`hung-${port}`)).toEqual([]);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    }
  });
});

describe("pushBranch", () => {
  it("pushes hoistline/<jobId> to the remote and never force-pushes", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "push1", cache, file);
    const head = runnerCommit(ws.dir, "out.txt");
    await pushBranch("o/n", "push1", cache, file);
    expect(remoteSha("refs/heads/hoistline/push1")).toBe(head);
    expect(remoteSha("refs/heads/main")).not.toBe(head);

    // Rewrite history; a second push must be rejected rather than forced.
    fx(["reset", "-q", "--hard", "HEAD~1"], ws.dir);
    runnerCommit(ws.dir, "other.txt");
    await expect(pushBranch("o/n", "push1", cache, file)).rejects.toThrow(/git push failed/);
    expect(remoteSha("refs/heads/hoistline/push1")).toBe(head);
  });

  it("refuses invalid input and jobs that were never prepared", async () => {
    const cache = temp();
    await prepareWorktree("o/n", "main", "push2", cache, file);
    for (const id of ["../push2", "--force", "push2 ", "hoistline/push2", ""]) {
      await expect(pushBranch("o/n", id, cache, file)).rejects.toThrow(/invalid job id/);
    }
    await expect(pushBranch("--upload-pack=x", "push2", cache, file)).rejects.toThrow(/invalid repository/);
    await expect(pushBranch("o/n", "never", cache, file)).rejects.toThrow(/no branch hoistline\/never/);
    await expect(pushBranch("o/other", "push2", temp(), file)).rejects.toThrow(/no branch hoistline\/push2/);
  });

  it("refuses the file protocol unless explicitly allowed", async () => {
    const cache = temp();
    await prepareWorktree("o/n", "main", "push3", cache, file);
    await expect(pushBranch("o/n", "push3", cache, { remoteFor: () => remote })).rejects.toThrow(
      /git push failed.*transport 'file' not allowed/s,
    );
    expect(remoteSha("refs/heads/hoistline/push3")).toBeNull();
  });

  it("serializes with concurrent prepareWorktree calls on the same repo", async () => {
    const cache = temp();
    const pushed = ["s1", "s2", "s3", "s4"];
    const heads: string[] = [];
    for (const id of pushed) {
      const ws = await prepareWorktree("o/n", "main", id, cache, file);
      heads.push(runnerCommit(ws.dir, `${id}.txt`));
    }
    const ops: Promise<unknown>[] = [];
    for (const [i, id] of pushed.entries()) {
      ops.push(pushBranch("o/n", id, cache, file));
      ops.push(prepareWorktree("o/n", i % 2 ? "dev" : "main", `p${i}`, cache, file));
    }
    await Promise.all(ops);
    for (const [i, id] of pushed.entries()) expect(remoteSha(`refs/heads/hoistline/${id}`)).toBe(heads[i]);
  });
});

describe("removeWorktree", () => {
  it("removes the worktree and prunes it from the mirror", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "rm1", cache, file);
    writeFileSync(join(ws.dir, "untracked.txt"), "x\n");
    await removeWorktree("o/n", "rm1", cache);
    expect(existsSync(ws.dir)).toBe(false);
    const list = fx(["worktree", "list", "--porcelain"], mirrorOf(cache));
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

  it("refuses a work directory that is a symlink out of the cache", async () => {
    const cache = temp();
    const outside = temp();
    mkdirSync(join(outside, "rm4"));
    writeFileSync(join(outside, "rm4", "keep.txt"), "keep\n");
    symlinkSync(outside, join(cache, "work"));
    await expect(removeWorktree("o/n", "rm4", cache)).rejects.toThrow(/refusing to remove/);
    expect(readFileSync(join(outside, "rm4", "keep.txt"), "utf8")).toBe("keep\n");
  });
});

/** A bare repo whose config redirects the canonical remote to `evil` and defines a smudge filter writing `marker`. */
function attackerCommonDir(evil: string, marker: string): string {
  const att = join(temp(), "attacker.git");
  fx(["init", "-q", "--bare", "-b", "main", att]);
  writeFileSync(
    join(att, "config"),
    `${MIRROR_CONFIG}[filter "p"]\n\tsmudge = "sh -c 'touch ${marker}; cat'"\n[url "${evil}"]\n\tinsteadOf = ${remote}\n`,
  );
  mkdirSync(join(att, "info"), { recursive: true });
  writeFileSync(join(att, "info", "attributes"), "* filter=p\n");
  return att;
}

/** A bare "evil" remote with a main branch carrying `evilfile` and a .gitattributes naming filter p. */
function evilWithMain(): string {
  const evil = emptyBare();
  const seed = join(temp(), "seed");
  fx(["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "evilfile"), "evil\n");
  writeFileSync(join(seed, ".gitattributes"), "* filter=p\n");
  fx(["add", "evilfile", ".gitattributes"], seed);
  fx(["commit", "-q", "-m", "evil"], seed);
  fx(["push", "-q", evil, "main"], seed);
  return evil;
}

describe("a runner redirecting the mirror's common dir", () => {
  it("cannot make the agent use another repo's config through <mirror>/commondir", async () => {
    const cache = temp();
    await prepareWorktree("o/n", "main", "j1", cache, file);
    const mirror = mirrorOf(cache);
    const marker = join(cache, "SMUDGE_RAN");
    const evil = evilWithMain();
    const att = attackerCommonDir(evil, marker);
    writeFileSync(join(mirror, "commondir"), `${att}\n`);

    // Control: plain git honors the planted commondir: the attacker's config applies and a fetch of the canonical
    // URL is served by evil.
    expect(fx(["--git-dir", mirror, "config", "--list"])).toMatch(/filter\.p\.smudge/);
    fx(["--git-dir", mirror, "fetch", "-q", "--", remote, "+refs/heads/main:refs/x/probe"]);
    expect(shaIn(att, "refs/x/probe")).toBe(shaIn(evil, "refs/heads/main"));

    const ws = await prepareWorktree("o/n", "main", "j2", cache, file);
    expect(readFileSync(join(ws.dir, "README"), "utf8")).toBe("main\n");
    expect(existsSync(join(ws.dir, "evilfile"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(mirror, "commondir"))).toBe(false);
  });

  it("pins GIT_DIR and GIT_COMMON_DIR so a commondir planted after the reset is ignored", async () => {
    const cache = temp();
    await prepareWorktree("o/n", "main", "j1", cache, file);
    const mirror = mirrorOf(cache);
    const att = attackerCommonDir(emptyBare(), join(cache, "m"));
    writeFileSync(join(mirror, "commondir"), `${att}\n`);
    // Control: plain git with --git-dir alone follows the commondir.
    const real = (p: string) => realpathSync(p.trim());
    expect(real(fx(["--git-dir", mirror, "rev-parse", "--git-common-dir"]))).toBe(real(att));
    const git = mirrorGit(cache, mirror, {});
    expect(real((await git(["rev-parse", "--git-common-dir"])).stdout)).toBe(real(mirror));
    expect((await git(["config", "--list"])).stdout).not.toMatch(/filter|url\./);
  });

  it("deletes planted gitdir and object alternates", async () => {
    const cache = temp();
    await prepareWorktree("o/n", "main", "j1", cache, file);
    const mirror = mirrorOf(cache);
    // An object that exists only in the evil repo.
    const evil = evilWithMain();
    const evilSha = shaIn(evil, "refs/heads/main") as string;
    writeFileSync(join(mirror, "objects", "info", "alternates"), `${join(evil, "objects")}\n`);
    writeFileSync(join(mirror, "objects", "info", "http-alternates"), "https://evil.example/objects\n");
    writeFileSync(join(mirror, "gitdir"), "/nowhere/.git\n");
    // Control: plain git sees the borrowed object.
    expect(() => fx(["--git-dir", mirror, "cat-file", "-e", evilSha])).not.toThrow();

    await prepareWorktree("o/n", "main", "j2", cache, file);
    for (const p of ["objects/info/alternates", "objects/info/http-alternates", "gitdir"]) {
      expect(existsSync(join(mirror, p))).toBe(false);
    }
    expect(() => fx(["--git-dir", mirror, "cat-file", "-e", evilSha])).toThrow();
  });

  it("resets the mirror (commondir included) before removeWorktree prunes", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "rm5", cache, file);
    const mirror = mirrorOf(cache);
    const att = attackerCommonDir(emptyBare(), join(cache, "m"));
    writeFileSync(join(mirror, "commondir"), `${att}\n`);
    await removeWorktree("o/n", "rm5", cache);
    expect(existsSync(join(mirror, "commondir"))).toBe(false);
    expect(fx(["--git-dir", mirror, "worktree", "list", "--porcelain"])).not.toContain(ws.dir);
  });
});

describe("the mirror reset never follows symlinks", () => {
  /** A victim directory outside the mirror with one precious file in it (optionally under a subpath). */
  function victimDir(sub = ""): string {
    const v = temp();
    mkdirSync(join(v, sub), { recursive: true });
    writeFileSync(join(v, sub, "precious.txt"), "keep\n");
    return v;
  }

  async function poisoned(plant: (mirror: string) => void): Promise<string> {
    const cache = temp();
    await prepareWorktree("o/n", "main", "j1", cache, file);
    plant(mirrorOf(cache));
    await prepareWorktree("o/n", "main", "j2", cache, file);
    return mirrorOf(cache);
  }

  it("removes a hooks symlink instead of emptying its target", async () => {
    const victim = victimDir();
    // Control: emptying a symlinked directory's entries the naive way destroys the victim.
    const copy = victimDir();
    const link = join(temp(), "hooks");
    symlinkSync(copy, link);
    for (const e of readdirSync(link)) rmSync(join(link, e), { recursive: true, force: true });
    expect(readdirSync(copy)).toEqual([]);

    const mirror = await poisoned((m) => {
      rmSync(join(m, "hooks"), { recursive: true, force: true });
      symlinkSync(victim, join(m, "hooks"));
    });
    expect(readdirSync(victim)).toEqual(["precious.txt"]);
    expect(lstatSync(join(mirror, "hooks")).isDirectory()).toBe(true);
    expect(readdirSync(join(mirror, "hooks"))).toEqual([]);
  });

  it("replaces a config symlink instead of writing through it", async () => {
    const victim = join(temp(), "victim.txt");
    writeFileSync(victim, "precious content\n");
    // Control: a naive write through the link overwrites the victim.
    const copy = join(temp(), "copy.txt");
    writeFileSync(copy, "precious content\n");
    const link = join(temp(), "config");
    symlinkSync(copy, link);
    writeFileSync(link, MIRROR_CONFIG);
    expect(readFileSync(copy, "utf8")).toBe(MIRROR_CONFIG);

    const mirror = await poisoned((m) => {
      rmSync(join(m, "config"));
      symlinkSync(victim, join(m, "config"));
    });
    expect(readFileSync(victim, "utf8")).toBe("precious content\n");
    expect(lstatSync(join(mirror, "config")).isFile()).toBe(true);
    expect(readFileSync(join(mirror, "config"), "utf8")).toBe(await mirrorConfig(temp()));
  });

  it("removes an info symlink instead of deleting attributes through it", async () => {
    const victim = victimDir();
    writeFileSync(join(victim, "attributes"), "victim\n");
    // Control: a naive delete of info/attributes through the link destroys the victim's file.
    const copy = victimDir();
    writeFileSync(join(copy, "attributes"), "victim\n");
    const link = join(temp(), "info");
    symlinkSync(copy, link);
    rmSync(join(link, "attributes"), { force: true });
    expect(existsSync(join(copy, "attributes"))).toBe(false);

    const mirror = await poisoned((m) => {
      rmSync(join(m, "info"), { recursive: true, force: true });
      symlinkSync(victim, join(m, "info"));
    });
    expect(readFileSync(join(victim, "attributes"), "utf8")).toBe("victim\n");
    expect(existsSync(join(victim, "precious.txt"))).toBe(true);
    expect(lstatSync(join(mirror, "info"), { throwIfNoEntry: false })?.isSymbolicLink() ?? false).toBe(false);
  });

  it("unlinks an info/attributes symlink without touching its target", async () => {
    const victim = join(temp(), "victim-attributes");
    writeFileSync(victim, "precious\n");
    const mirror = await poisoned((m) => {
      mkdirSync(join(m, "info"), { recursive: true });
      symlinkSync(victim, join(m, "info", "attributes"));
    });
    expect(readFileSync(victim, "utf8")).toBe("precious\n");
    expect(lstatSync(join(mirror, "info", "attributes"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("removes a worktrees symlink instead of deleting config.worktree through it", async () => {
    const victim = victimDir("x");
    writeFileSync(join(victim, "x", "config.worktree"), "victim\n");
    // Control: the naive per-entry delete reaches through the link.
    const copy = victimDir("x");
    writeFileSync(join(copy, "x", "config.worktree"), "victim\n");
    const link = join(temp(), "worktrees");
    symlinkSync(copy, link);
    for (const e of readdirSync(link)) rmSync(join(link, e, "config.worktree"), { force: true });
    expect(existsSync(join(copy, "x", "config.worktree"))).toBe(false);

    await poisoned((m) => {
      renameSync(join(m, "worktrees"), join(temp(), "saved-worktrees"));
      symlinkSync(victim, join(m, "worktrees"));
    });
    expect(readFileSync(join(victim, "x", "config.worktree"), "utf8")).toBe("victim\n");
    expect(existsSync(join(victim, "x", "precious.txt"))).toBe(true);
  });

  it("removes a worktrees/<entry> symlink instead of deleting config.worktree through it", async () => {
    const victim = victimDir();
    writeFileSync(join(victim, "config.worktree"), "victim\n");
    const mirror = await poisoned((m) => {
      symlinkSync(victim, join(m, "worktrees", "evil"));
    });
    expect(readFileSync(join(victim, "config.worktree"), "utf8")).toBe("victim\n");
    expect(existsSync(join(victim, "precious.txt"))).toBe(true);
    expect(lstatSync(join(mirror, "worktrees", "evil"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("removes an objects/info symlink instead of deleting alternates through it", async () => {
    const victim = victimDir();
    writeFileSync(join(victim, "alternates"), "victim\n");
    await poisoned((m) => {
      rmSync(join(m, "objects", "info"), { recursive: true, force: true });
      symlinkSync(victim, join(m, "objects", "info"));
    });
    expect(readFileSync(join(victim, "alternates"), "utf8")).toBe("victim\n");
    expect(existsSync(join(victim, "precious.txt"))).toBe(true);
  });
});

describe("commitWorktree", () => {
  const log = (mirror: string, ref: string) => fx(["--git-dir", mirror, "log", "--format=%s", ref]).trim().split("\n");
  const show = (mirror: string, ref: string, path: string) => fx(["--git-dir", mirror, "show", `${ref}:${path}`]);
  const adminOf = (mirror: string, id: string) => {
    const name = readdirSync(join(mirror, "worktrees")).find((e) => e.startsWith(id)) as string;
    return join(mirror, "worktrees", name);
  };

  it("commits untracked and modified files on hoistline/<jobId> in the mirror", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "c1", cache, file);
    writeFileSync(join(ws.dir, "README"), "changed\n");
    mkdirSync(join(ws.dir, "sub"));
    writeFileSync(join(ws.dir, "sub", "new.txt"), "new\n");
    const res = await commitWorktree("o/n", "c1", cache, file);
    const mirror = mirrorOf(cache);
    expect(res.committed).toBe(true);
    expect(res.sha).toBe(shaIn(mirror, "refs/heads/hoistline/c1"));
    expect(log(mirror, "refs/heads/hoistline/c1")).toEqual(["hoistline: job c1", "main"]);
    expect(show(mirror, "refs/heads/hoistline/c1", "README")).toBe("changed\n");
    expect(show(mirror, "refs/heads/hoistline/c1", "sub/new.txt")).toBe("new\n");
    const author = fx(["--git-dir", mirror, "log", "-1", "--format=%an <%ae>", "refs/heads/hoistline/c1"]).trim();
    expect(author).toBe("Hoistline <hoistline@users.noreply.github.com>");

    const custom = await prepareWorktree("o/n", "main", "c1b", cache, file);
    writeFileSync(join(custom.dir, "x"), "x\n");
    await commitWorktree("o/n", "c1b", cache, { ...file, message: "-n --amend $(x)" });
    expect(log(mirror, "refs/heads/hoistline/c1b")[0]).toBe("-n --amend $(x)");
  });

  it("returns committed:false when there is nothing to commit", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "c2", cache, file);
    expect(await commitWorktree("o/n", "c2", cache, file)).toEqual({ committed: false });
    // A runner that committed itself: nothing new to commit, and the branch carries its commit.
    const head = runnerCommit(ws.dir, "own.txt");
    expect(await commitWorktree("o/n", "c2", cache, file)).toEqual({ committed: false });
    expect(shaIn(mirrorOf(cache), "refs/heads/hoistline/c2")).toBe(head);
  });

  it("validates its input and refuses a job with no worktree", async () => {
    const cache = temp();
    await prepareWorktree("o/n", "main", "c3", cache, file);
    await expect(commitWorktree("o/n", "../c3", cache, file)).rejects.toThrow(/invalid job id/);
    await expect(commitWorktree("--upload-pack=x", "c3", cache, file)).rejects.toThrow(/invalid repository/);
    await expect(commitWorktree("o/n", "never", cache, file)).rejects.toThrow(/refusing to commit/);
  });

  it("commits to the mirror even if the runner rewrote the worktree's .git file", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "c4", cache, file);
    const attacker = join(temp(), "attacker");
    fx(["init", "-q", "-b", "main", attacker]);
    const attackerHead = runnerCommit(attacker, "a.txt");
    writeFileSync(join(ws.dir, ".git"), `gitdir: ${join(attacker, ".git")}\n`);
    writeFileSync(join(ws.dir, "work.txt"), "work\n");
    // Control: plain git in the worktree now operates on the attacker's repo.
    expect(fx(["rev-parse", "HEAD"], ws.dir).trim()).toBe(attackerHead);

    const res = await commitWorktree("o/n", "c4", cache, file);
    expect(res.committed).toBe(true);
    const mirror = mirrorOf(cache);
    expect(show(mirror, "refs/heads/hoistline/c4", "work.txt")).toBe("work\n");
    expect(fx(["rev-parse", "HEAD"], attacker).trim()).toBe(attackerHead);
    expect(fx(["log", "--format=%H"], attacker).trim()).toBe(attackerHead);
  });

  it("refuses when the admin dir's HEAD was pointed at another branch", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "c5", cache, file);
    writeFileSync(join(ws.dir, "w.txt"), "w\n");
    writeFileSync(join(adminOf(mirrorOf(cache), "c5"), "HEAD"), "ref: refs/heads/hoistline/other\n");
    await expect(commitWorktree("o/n", "c5", cache, file)).rejects.toThrow(/refusing to commit/);
  });

  it("runs no filter, hook or config.worktree planted by the runner", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "c6", cache, file);
    const mirror = mirrorOf(cache);
    const marker = join(cache, "ran");
    const admin = adminOf(mirror, "c6");
    // .gitattributes naming a filter: with no configured command it must be inert.
    writeFileSync(join(ws.dir, ".gitattributes"), "* filter=nocmd\n");
    writeFileSync(join(ws.dir, "data.txt"), "data\n");
    for (const dir of [join(mirror, "hooks"), join(admin, "hooks")]) {
      mkdirSync(dir, { recursive: true });
      for (const hook of ["pre-commit", "commit-msg", "post-commit", "prepare-commit-msg"]) {
        writeFileSync(join(dir, hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
        chmodSync(join(dir, hook), 0o755);
      }
    }
    const filterCmd = `sh -c 'echo clean >> ${marker}; cat'`;
    // The runner defines the filter in the shared config and in its worktree's config.worktree.
    writeFileSync(join(admin, "config.worktree"), `[filter "nocmd"]\n\tclean = ${filterCmd}\n`);
    fx(["config", "filter.nocmd.clean", filterCmd], ws.dir);
    // Control: plain git in a worktree of this mirror runs the planted clean filter and commit hooks.
    const control = join(temp(), "control");
    fx(["--git-dir", mirror, "worktree", "add", "-q", "-b", "control", control, "refs/remotes/origin/main"]);
    writeFileSync(join(control, ".gitattributes"), "* filter=nocmd\n");
    writeFileSync(join(control, "c.txt"), "c\n");
    fx(["add", "-A"], control);
    fx(["commit", "-q", "-m", "control"], control);
    expect(readFileSync(marker, "utf8")).toMatch(/clean[\s\S]*pre-commit/);
    rmSync(marker);

    const res = await commitWorktree("o/n", "c6", cache, file);
    expect(res.committed).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(admin, "config.worktree"))).toBe(false);
    expect(show(mirror, "refs/heads/hoistline/c6", "data.txt")).toBe("data\n");
  });

  it("round-trips commit then push to the remote", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "dev", "c7", cache, file);
    writeFileSync(join(ws.dir, "result.txt"), "result\n");
    const res = await commitWorktree("o/n", "c7", cache, file);
    await pushBranch("o/n", "c7", cache, file);
    expect(remoteSha("refs/heads/hoistline/c7")).toBe(res.sha);
    expect(fx(["show", "refs/heads/hoistline/c7:result.txt"], remote)).toBe("result\n");
    expect(fx(["show", "refs/heads/hoistline/c7:README"], remote)).toBe("dev\n");
  });

  it.skipIf(!CASE_INSENSITIVE)("commits a case-only rename as a single rename", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "c8", cache, file);
    renameSync(join(ws.dir, "README"), join(ws.dir, "readme"));
    const res = await commitWorktree("o/n", "c8", cache, file);
    expect(res.committed).toBe(true);
    const mirror = mirrorOf(cache);
    const ref = "refs/heads/hoistline/c8";
    expect(fx(["--git-dir", mirror, "diff", "--name-status", "-M", `${ref}~1`, ref]).trim()).toBe("R100\tREADME\treadme");
    expect(fx(["--git-dir", mirror, "ls-tree", "--name-only", ref]).trim()).toBe("readme");
  });

  it("checks for staged changes without listing them (a change set larger than any output buffer)", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "c9", cache, file);
    // 20,500 empty files under a ~800-byte directory path: listing their names takes about 17 MB.
    const deep = join(ws.dir, ...["a", "b", "c", "d"].map((c) => c.repeat(200)));
    mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 20_500; i++) writeFileSync(join(deep, `file-${i}`.padEnd(60, "x")), "");
    const res = await commitWorktree("o/n", "c9", cache, file);
    expect(res.committed).toBe(true);
    const ref = "refs/heads/hoistline/c9";
    expect(fx(["--git-dir", mirrorOf(cache), "diff", "--shortstat", `${ref}~1`, ref]).trim()).toBe(
      "20500 files changed, 0 insertions(+), 0 deletions(-)",
    );
  }, 30_000);

  const nestedMessage = (path: string) =>
    `nested repository at ${path} cannot be committed; remove its .git directory or add it to .gitignore`;

  it("refuses a nested repository with commits, naming it, and leaves the branch alone", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "c10", cache, file);
    const lib = join(ws.dir, "vendor", "lib");
    mkdirSync(lib, { recursive: true });
    fx(["init", "-q", "-b", "main", lib]);
    runnerCommit(lib, "code.c");
    writeFileSync(join(ws.dir, "other.txt"), "o\n");
    const err = await commitWorktree("o/n", "c10", cache, file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as Error).message).toBe(nestedMessage("vendor/lib"));
    expect(shaIn(mirrorOf(cache), "refs/heads/hoistline/c10")).toBe(remoteSha("refs/heads/main"));

    // In a job where it is ignored from the start, the rest commits.
    const ok = await prepareWorktree("o/n", "main", "c10b", cache, file);
    mkdirSync(join(ok.dir, "vendor", "lib"), { recursive: true });
    fx(["init", "-q", "-b", "main", join(ok.dir, "vendor", "lib")]);
    runnerCommit(join(ok.dir, "vendor", "lib"), "code.c");
    writeFileSync(join(ok.dir, ".gitignore"), "vendor/\n");
    expect((await commitWorktree("o/n", "c10b", cache, file)).committed).toBe(true);
    expect(fx(["--git-dir", mirrorOf(cache), "ls-tree", "--name-only", "refs/heads/hoistline/c10b"]).trim()).toBe(
      ".gitignore\nREADME",
    );
  });

  it("refuses a nested repository without commits, naming it", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "c11", cache, file);
    const empty = join(ws.dir, "empty");
    mkdirSync(empty);
    fx(["init", "-q", empty]);
    writeFileSync(join(empty, "f"), "f");
    writeFileSync(join(ws.dir, "other.txt"), "o\n");
    const err = await commitWorktree("o/n", "c11", cache, file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as Error).message).toBe(nestedMessage("empty"));
    expect(shaIn(mirrorOf(cache), "refs/heads/hoistline/c11")).toBe(remoteSha("refs/heads/main"));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 4: findings from an independent review, each reproduced with a control run first.

/** The mirror's admin record for worktree `dir`, found by its gitdir file. */
function adminDir(mirror: string, dir: string): string {
  const expected = [join(dir, ".git"), join(realpathSync(dir), ".git")];
  for (const entry of readdirSync(join(mirror, "worktrees"))) {
    const gitdir = join(mirror, "worktrees", entry, "gitdir");
    if (existsSync(gitdir) && expected.includes(readFileSync(gitdir, "utf8").trim())) {
      return join(mirror, "worktrees", entry);
    }
  }
  throw new Error(`no admin dir for ${dir}`);
}

/** Plain git's commit in a worktree (no hooks), with optional extra `-c` flags. */
const plainCommit = (dir: string, msg: string, extra: string[] = []) =>
  fx(["-c", "core.hooksPath=/dev/null", ...extra, "commit", "-q", "-m", msg], dir);

describe("round 4: hooks", () => {
  it("runs no hook planted in the old empty-hooks directory or under a relative hooks path", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "h1", cache, file);
    const mirror = mirrorOf(cache);
    const marker = join(temp(), "hook-ran");
    const plant = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      for (const hook of ["prepare-commit-msg", "post-checkout", "reference-transaction", "post-commit", "pre-push"]) {
        writeFileSync(join(dir, hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
        chmodSync(join(dir, hook), 0o755);
      }
    };
    const old = join(cache, "empty-hooks");
    plant(old);
    // Control: plain git with hooksPath at the old directory runs prepare-commit-msg, even with --no-verify.
    const control = join(temp(), "control");
    fx(["--git-dir", mirror, "worktree", "add", "-q", "-b", "control", control, "refs/remotes/origin/main"]);
    fx(["-c", `core.hooksPath=${old}`, "commit", "-q", "--no-verify", "--allow-empty", "-m", "c"], control);
    expect(readFileSync(marker, "utf8")).toMatch(/prepare-commit-msg/);
    rmSync(marker);
    // Control: a relative hooksPath resolves against git's working directory.
    plant(join(control, "rel-hooks"));
    fx(["-c", "core.hooksPath=rel-hooks", "commit", "-q", "--allow-empty", "-m", "c"], control);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    writeFileSync(join(ws.dir, "x.txt"), "x\n");
    expect((await commitWorktree("o/n", "h1", cache, file)).committed).toBe(true);
    await pushBranch("o/n", "h1", cache, file);
    await prepareWorktree("o/n", "main", "h2", cache, file);
    await removeWorktree("o/n", "h2", cache);
    expect(existsSync(marker)).toBe(false);
    if (process.platform !== "win32") {
      expect((await runGit(["config", "--get", "core.hooksPath"], { cacheDir: cache })).stdout.trim()).toBe("/dev/null");
    }
  });
});

describe("round 4: git metadata symlinks", () => {
  it("never writes through FETCH_HEAD, COMMIT_EDITMSG or reflog symlinks", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "m1", cache, file);
    const mirror = mirrorOf(cache);
    const victim = (name: string) => {
      const p = join(temp(), name);
      writeFileSync(p, "precious\n");
      return p;
    };
    const linkLog = (admin: string, target: string) => {
      mkdirSync(join(admin, "logs"), { recursive: true });
      rmSync(join(admin, "logs", "HEAD"), { force: true });
      symlinkSync(target, join(admin, "logs", "HEAD"));
    };
    // Controls: plain git writes through each link.
    const fetchCopy = victim("fetch");
    rmSync(join(mirror, "FETCH_HEAD"), { force: true });
    symlinkSync(fetchCopy, join(mirror, "FETCH_HEAD"));
    fx(["--git-dir", mirror, "fetch", "-q", "--", remote, "+refs/heads/main:refs/remotes/origin/main"]);
    expect(readFileSync(fetchCopy, "utf8")).not.toBe("precious\n");
    rmSync(join(mirror, "FETCH_HEAD"));
    const control = await prepareWorktree("o/n", "main", "m1ctl", cache, file);
    const controlAdmin = adminDir(mirror, control.dir);
    const msgCopy = victim("msg");
    const logCopy = victim("log");
    symlinkSync(msgCopy, join(controlAdmin, "COMMIT_EDITMSG"));
    linkLog(controlAdmin, logCopy);
    fx(["-c", "core.hooksPath=/dev/null", "-c", "core.logAllRefUpdates=true", "commit", "-q", "--allow-empty", "-m", "c"],
      control.dir);
    expect(readFileSync(msgCopy, "utf8")).toBe("c\n");
    expect(readFileSync(logCopy, "utf8")).not.toBe("precious\n");

    const admin = adminDir(mirror, ws.dir);
    const fetchV = victim("fetch2");
    const msgV = victim("msg2");
    const logV = victim("log2");
    rmSync(join(mirror, "FETCH_HEAD"), { force: true });
    symlinkSync(fetchV, join(mirror, "FETCH_HEAD"));
    symlinkSync(msgV, join(admin, "COMMIT_EDITMSG"));
    linkLog(admin, logV);
    // The runner turns reflogs on in the shared config; the reset rewrites it, but git's default could too.
    fx(["config", "core.logAllRefUpdates", "always"], ws.dir);
    writeFileSync(join(ws.dir, "x.txt"), "x\n");
    expect((await commitWorktree("o/n", "m1", cache, file)).committed).toBe(true);
    rmSync(join(mirror, "FETCH_HEAD"), { force: true });
    symlinkSync(fetchV, join(mirror, "FETCH_HEAD"));
    await prepareWorktree("o/n", "main", "m2", cache, file);
    for (const v of [fetchV, msgV, logV]) expect(readFileSync(v, "utf8")).toBe("precious\n");
  });
});

describe("round 4: cache directories", () => {
  it("refuses a symlinked work directory before creating anything through it", async () => {
    const cache = temp();
    const outside = temp();
    symlinkSync(outside, join(cache, "work"));
    await expect(prepareWorktree("o/n", "main", "d1", cache, file)).rejects.toThrow(/not a plain directory/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a symlinked repos directory or mirror path before git init", async () => {
    for (const where of ["repos", "mirror"]) {
      const cache = temp();
      const outside = temp();
      if (where === "repos") {
        symlinkSync(outside, join(cache, "repos"));
      } else {
        mkdirSync(join(cache, "repos"));
        symlinkSync(outside, mirrorOf(cache));
      }
      await expect(prepareWorktree("o/n", "main", "d2", cache, file)).rejects.toThrow(/not a plain directory/);
      expect(readdirSync(outside)).toEqual([]);
    }
  });

  it("never deletes a job directory it did not create", async () => {
    const cache = temp();
    await prepareWorktree("o/n", "main", "d3a", cache, file);
    // Guard (passes before and after): a pre-existing job dir is refused, never deleted.
    mkdirSync(join(cache, "work", "d3"));
    writeFileSync(join(cache, "work", "d3", "keep"), "k");
    await expect(prepareWorktree("o/n", "main", "d3", cache, file)).rejects.toThrow(/already used/);
    expect(readFileSync(join(cache, "work", "d3", "keep"), "utf8")).toBe("k");
  });
});

describe("round 4: symbolic refs", () => {
  it("refuses to commit or push a job branch that is a symbolic ref to another job's branch", async () => {
    const cache = temp();
    const mirror = mirrorOf(cache);
    const a = await prepareWorktree("o/n", "main", "sa", cache, file);
    const b = await prepareWorktree("o/n", "main", "sb", cache, file);
    const bHead = runnerCommit(b.dir, "b.txt");
    // Control: plain git commits through a symbolic job branch into its target.
    const c = await prepareWorktree("o/n", "main", "sc", cache, file);
    const d = await prepareWorktree("o/n", "main", "sd", cache, file);
    const dHead = runnerCommit(d.dir, "d.txt");
    fx(["--git-dir", mirror, "symbolic-ref", "refs/heads/hoistline/sc", "refs/heads/hoistline/sd"]);
    writeFileSync(join(c.dir, "c.txt"), "c\n");
    fx(["add", "c.txt"], c.dir);
    plainCommit(c.dir, "c");
    expect(shaIn(mirror, "refs/heads/hoistline/sd")).not.toBe(dHead);

    fx(["--git-dir", mirror, "symbolic-ref", "refs/heads/hoistline/sa", "refs/heads/hoistline/sb"]);
    writeFileSync(join(a.dir, "a.txt"), "a\n");
    await expect(commitWorktree("o/n", "sa", cache, file)).rejects.toThrow(/symbolic ref/);
    await expect(pushBranch("o/n", "sa", cache, file)).rejects.toThrow(/symbolic ref/);
    expect(shaIn(mirror, "refs/heads/hoistline/sb")).toBe(bHead);
    expect(remoteSha("refs/heads/hoistline/sa")).toBeNull();
  });

  it("does not let a symbolic fetch destination move another job's branch", async () => {
    const setup = async () => {
      const cache = temp();
      const mirror = mirrorOf(cache);
      const x = await prepareWorktree("o/n", "main", "fx", cache, file);
      const head = runnerCommit(x.dir, "x.txt");
      fx(["--git-dir", mirror, "symbolic-ref", "refs/remotes/origin/main", "refs/heads/hoistline/fx"]);
      return { cache, mirror, head };
    };
    // Control: a plain fetch into the symbolic destination force-moves hoistline/fx.
    const ctl = await setup();
    fx(["--git-dir", ctl.mirror, "fetch", "-q", "--", remote, "+refs/heads/main:refs/remotes/origin/main"]);
    expect(shaIn(ctl.mirror, "refs/heads/hoistline/fx")).toBe(remoteSha("refs/heads/main"));

    const s = await setup();
    const ws = await prepareWorktree("o/n", "main", "fy", s.cache, file);
    expect(shaIn(s.mirror, "refs/heads/hoistline/fx")).toBe(s.head);
    expect(() => fx(["--git-dir", s.mirror, "symbolic-ref", "-q", "refs/remotes/origin/main"])).toThrow();
    expect(readFileSync(join(ws.dir, "README"), "utf8")).toBe("main\n");
  });
});

describe("round 4: job ids across repositories", () => {
  it("lets exactly one of two repos claim a job id, and never deletes the winner's worktree", async () => {
    const cache = temp();
    const results = await Promise.allSettled([
      prepareWorktree("o/a", "main", "same", cache, file),
      prepareWorktree("o/b", "main", "same", cache, file),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(lost.reason)).toMatch(/job id "same" was already used/);
    const dir = join(cache, "work", "same");
    expect(readFileSync(join(dir, "README"), "utf8")).toBe("main\n");
    expect(existsSync(join(dir, ".git"))).toBe(true);

    const [winner, loser] = results[0]?.status === "fulfilled" ? ["o/a", "o/b"] : ["o/b", "o/a"];
    await expect(removeWorktree(loser as string, "same", cache)).rejects.toThrow(/belongs to another repository/);
    expect(existsSync(join(dir, "README"))).toBe(true);
    await removeWorktree(winner as string, "same", cache);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("round 4: submodules", () => {
  it("refuses a nested repository hidden by .gitmodules ignore = all", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "sm1", cache, file);
    const lib = join(ws.dir, "lib");
    mkdirSync(lib);
    fx(["init", "-q", "-b", "main", lib]);
    runnerCommit(lib, "code.c");
    writeFileSync(join(ws.dir, ".gitmodules"), '[submodule "lib"]\n\tpath = lib\n\turl = ./lib\n\tignore = all\n');
    // Control: plain git stages the gitlink, but its default staged diff does not show it.
    const env = { ...FIXTURE_ENV, GIT_INDEX_FILE: join(temp(), "index") };
    fx(["read-tree", "HEAD"], ws.dir, env);
    fx(["add", "--all"], ws.dir, env);
    expect(fx(["ls-files", "-s", "lib"], ws.dir, env)).toMatch(/^160000 /);
    expect(fx(["diff", "--cached", "--raw"], ws.dir, env)).not.toMatch(/\tlib/);

    const err = await commitWorktree("o/n", "sm1", cache, file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as Error).message).toBe(
      "nested repository at lib cannot be committed; remove its .git directory or add it to .gitignore",
    );
    expect(shaIn(mirrorOf(cache), "refs/heads/hoistline/sm1")).toBe(remoteSha("refs/heads/main"));
  });
});

describe("round 4: commit state the runner leaves behind", () => {
  it("does not turn the commit into a merge with a planted MERGE_HEAD", async () => {
    const cache = temp();
    const mirror = mirrorOf(cache);
    const other = await prepareWorktree("o/n", "main", "mo", cache, file);
    const otherHead = runnerCommit(other.dir, "other.txt");
    const parents = (id: string) =>
      fx(["--git-dir", mirror, "log", "-1", "--format=%P", `refs/heads/hoistline/${id}`]).trim().split(" ");
    // Control: plain git pulls another job's commit into the branch (as the only parent here, because it descends
    // from HEAD and commit reduces the parents).
    const ctl = await prepareWorktree("o/n", "main", "mctl", cache, file);
    writeFileSync(join(adminDir(mirror, ctl.dir), "MERGE_HEAD"), `${otherHead}\n`);
    writeFileSync(join(ctl.dir, "c.txt"), "c\n");
    fx(["add", "c.txt"], ctl.dir);
    plainCommit(ctl.dir, "c");
    expect(parents("mctl")).toContain(otherHead);

    const ws = await prepareWorktree("o/n", "main", "mm", cache, file);
    const admin = adminDir(mirror, ws.dir);
    writeFileSync(join(admin, "MERGE_HEAD"), `${otherHead}\n`);
    writeFileSync(join(admin, "MERGE_MSG"), "merge\n");
    writeFileSync(join(ws.dir, "w.txt"), "w\n");
    expect((await commitWorktree("o/n", "mm", cache, file)).committed).toBe(true);
    expect(parents("mm")).toEqual([remoteSha("refs/heads/main")]);
    expect(existsSync(join(admin, "MERGE_HEAD"))).toBe(false);
  });

  it("does not take the author from a planted CHERRY_PICK_HEAD", async () => {
    const cache = temp();
    const mirror = mirrorOf(cache);
    const other = await prepareWorktree("o/n", "main", "co", cache, file);
    writeFileSync(join(other.dir, "o.txt"), "o\n");
    fx(["add", "o.txt"], other.dir);
    plainCommit(other.dir, "o", ["-c", "user.name=Other", "-c", "user.email=other@example.com"]);
    const otherHead = shaIn(mirror, "refs/heads/hoistline/co") as string;
    const author = (id: string) =>
      fx(["--git-dir", mirror, "log", "-1", "--format=%an", `refs/heads/hoistline/${id}`]).trim();
    expect(author("co")).toBe("Other");
    // Control: plain git takes the author from CHERRY_PICK_HEAD.
    const ctl = await prepareWorktree("o/n", "main", "cctl", cache, file);
    writeFileSync(join(adminDir(mirror, ctl.dir), "CHERRY_PICK_HEAD"), `${otherHead}\n`);
    writeFileSync(join(ctl.dir, "c.txt"), "c\n");
    fx(["add", "c.txt"], ctl.dir);
    plainCommit(ctl.dir, "c");
    expect(author("cctl")).toBe("Other");

    const ws = await prepareWorktree("o/n", "main", "cc", cache, file);
    writeFileSync(join(adminDir(mirror, ws.dir), "CHERRY_PICK_HEAD"), `${otherHead}\n`);
    writeFileSync(join(ws.dir, "w.txt"), "w\n");
    await commitWorktree("o/n", "cc", cache, file);
    expect(author("cc")).toBe("Hoistline");
  });

  it("commits edits hidden by assume-unchanged and skip-worktree index flags", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "ix", cache, file);
    runnerCommit(ws.dir, "other.txt");
    fx(["update-index", "--assume-unchanged", "README"], ws.dir);
    fx(["update-index", "--skip-worktree", "other.txt"], ws.dir);
    writeFileSync(join(ws.dir, "README"), "edited\n");
    writeFileSync(join(ws.dir, "other.txt"), "edited too\n");
    // Control: plain git stages nothing.
    fx(["add", "--all"], ws.dir);
    fx(["diff", "--cached", "--quiet"], ws.dir);

    expect((await commitWorktree("o/n", "ix", cache, file)).committed).toBe(true);
    const show = (p: string) => fx(["--git-dir", mirrorOf(cache), "show", `refs/heads/hoistline/ix:${p}`]);
    expect(show("README")).toBe("edited\n");
    expect(show("other.txt")).toBe("edited too\n");
  });
});

describe("round 4: ancestry metadata", () => {
  it("deletes info/grafts and shallow, which rewrite ancestry", async () => {
    const cache = temp();
    await prepareWorktree("o/n", "dev", "g1", cache, file);
    const mirror = mirrorOf(cache);
    const dev = remoteSha("refs/heads/dev") as string;
    const count = () => fx(["--git-dir", mirror, "rev-list", "--count", "refs/remotes/origin/dev"]).trim();
    expect(count()).toBe("2");
    // Controls: each file cuts dev's history to one commit.
    mkdirSync(join(mirror, "info"), { recursive: true });
    writeFileSync(join(mirror, "info", "grafts"), `${dev}\n`);
    expect(count()).toBe("1");
    rmSync(join(mirror, "info", "grafts"));
    writeFileSync(join(mirror, "shallow"), `${dev}\n`);
    expect(count()).toBe("1");
    writeFileSync(join(mirror, "info", "grafts"), `${dev}\n`);

    await prepareWorktree("o/n", "dev", "g2", cache, file);
    expect(existsSync(join(mirror, "info", "grafts"))).toBe(false);
    expect(existsSync(join(mirror, "shallow"))).toBe(false);
    expect(count()).toBe("2");
  });
});

const escapees: string[] = [];
afterAll(() => {
  for (const pidFile of escapees) {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    } catch {
      // Already gone, or never started.
    }
  }
});

describe("round 4: a git call whose descendant escapes the process group", () => {
  it.skipIf(process.platform === "win32")(
    "still rejects after the timeout plus a bounded cleanup deadline, and releases the repo lock",
    async () => {
      const cache = temp();
      const ws = await prepareWorktree("o/n", "main", "t1", cache, file);
      // The owner's global config defines a clean filter that starts a descendant in a new session holding git's
      // stderr, then hangs.
      const home = temp();
      const pidFile = join(home, "pid");
      escapees.push(pidFile);
      const script = join(home, "escape.cjs");
      writeFileSync(
        script,
        `const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: ["ignore", "ignore", "inherit"] });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
c.unref();
setInterval(() => {}, 1000);
`,
      );
      writeFileSync(join(home, ".gitconfig"), `[filter "esc"]\n\tclean = \\"${process.execPath}\\" ${script}\n`);
      writeFileSync(join(ws.dir, ".gitattributes"), "* filter=esc\n");
      writeFileSync(join(ws.dir, "f.txt"), "f\n");

      const started = Date.now();
      const err = await withHome(home, () =>
        commitWorktree("o/n", "t1", cache, { ...file, timeoutMs: 1000, killGraceMs: 500 }),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitError);
      expect((err as Error).message).toMatch(/timed out/);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(existsSync(pidFile)).toBe(true);

      // The repo lock was released: the next operation on the repo runs.
      rmSync(join(ws.dir, ".gitattributes"));
      expect((await commitWorktree("o/n", "t1", cache, file)).committed).toBe(true);
    },
    20_000,
  );
});

describe("round 4: bounded control-file reads", () => {
  it("does not read an oversized worktrees/*/gitdir file", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "b1", cache, file);
    const big = join(mirrorOf(cache), "worktrees", "zz-big");
    mkdirSync(big);
    // A 3 GiB sparse file: reading it whole fails (and would allocate); a bounded read does not.
    const fd = openSync(join(big, "gitdir"), "w");
    ftruncateSync(fd, 3 * 1024 ** 3);
    closeSync(fd);
    writeFileSync(join(ws.dir, "b.txt"), "b\n");
    const started = Date.now();
    expect((await commitWorktree("o/n", "b1", cache, file)).committed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("refuses more than 10,000 worktree records", async () => {
    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "b2", cache, file);
    for (let i = 0; i < 10_001; i++) mkdirSync(join(mirrorOf(cache), "worktrees", `x${i}`));
    writeFileSync(join(ws.dir, "b.txt"), "b\n");
    await expect(commitWorktree("o/n", "b2", cache, file)).rejects.toThrow(/too many worktree records/);
  });
});

describe("round 4: the no-commit nested repository fallback", () => {
  it.skipIf(process.getuid?.() === 0)(
    "reports the original add error when the only nested repository is git-ignored",
    async () => {
      const cache = temp();
      const ws = await prepareWorktree("o/n", "main", "nf", cache, file);
      const inner = join(ws.dir, "ign", "inner");
      mkdirSync(inner, { recursive: true });
      fx(["init", "-q", inner]);
      writeFileSync(join(inner, "f"), "f");
      writeFileSync(join(ws.dir, ".gitignore"), "ign/\n");
      const secret = join(ws.dir, "secret.txt");
      writeFileSync(secret, "s\n");
      chmodSync(secret, 0o000);
      try {
        // Control: plain git's add fails on the unreadable file.
        const env = { ...FIXTURE_ENV, GIT_INDEX_FILE: join(temp(), "index") };
        expect(() => fx(["add", "--all"], ws.dir, env)).toThrow(/Permission denied/);

        const err = await commitWorktree("o/n", "nf", cache, file).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(GitError);
        expect((err as Error).message).toMatch(/git add failed/);
        expect((err as Error).message).toMatch(/Permission denied/);
        expect((err as Error).message).not.toMatch(/nested repository/);
      } finally {
        chmodSync(secret, 0o644);
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Round 5.

/** A bare remote with main plus one branch per name in `extra`, all at the same commit. Returns it and its seed. */
function remoteWith(extra: string[]): { bare: string; seed: string; opts: typeof file } {
  const dir = temp();
  const bare = join(dir, "r.git");
  const seed = join(dir, "seed");
  fx(["init", "-q", "--bare", "-b", "main", bare]);
  fx(["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "README"), "main\n");
  fx(["add", "README"], seed);
  fx(["commit", "-q", "-m", "main"], seed);
  fx(["push", "-q", bare, "main"], seed);
  for (const b of extra) fx(["push", "-q", bare, `HEAD:refs/heads/${b}`], seed);
  return { bare, seed, opts: { remoteFor: () => bare, allowFileProtocol: true } };
}

/** Replaces `<mirror>/<rel>` with a symlink to a fresh, empty victim directory, and returns the victim. */
function linkToVictim(mirror: string, rel: string): string {
  const victim = temp();
  rmSync(join(mirror, rel), { recursive: true, force: true });
  mkdirSync(join(mirror, rel, ".."), { recursive: true });
  symlinkSync(victim, join(mirror, rel));
  return victim;
}

describe("round 5: symlinked ref directories", () => {
  it("refuses a symlinked refs/heads/hoistline", async () => {
    const main = remoteSha("refs/heads/main") as string;
    // Control: plain git writes a job branch into the link's target.
    const ctl = temp();
    await prepareWorktree("o/n", "main", "rh0", ctl, file);
    const ctlVictim = linkToVictim(mirrorOf(ctl), "refs/heads/hoistline");
    fx(["--git-dir", mirrorOf(ctl), "update-ref", "refs/heads/hoistline/j1", main]);
    expect(readdirSync(ctlVictim)).toEqual(["j1"]);

    const cache = temp();
    const ws = await prepareWorktree("o/n", "main", "rh1", cache, file);
    const victim = linkToVictim(mirrorOf(cache), "refs/heads/hoistline");
    await expect(prepareWorktree("o/n", "main", "rh2", cache, file)).rejects.toThrow(/not a plain directory/);
    writeFileSync(join(ws.dir, "x.txt"), "x\n");
    await expect(commitWorktree("o/n", "rh1", cache, file)).rejects.toThrow(/not a plain directory/);
    expect(readdirSync(victim)).toEqual([]);
  });

  it("refuses a symlinked refs/remotes/origin", async () => {
    // Control: a plain fetch writes the tracking ref into the link's target.
    const ctl = temp();
    await prepareWorktree("o/n", "main", "ro0", ctl, file);
    const ctlVictim = linkToVictim(mirrorOf(ctl), "refs/remotes/origin");
    fx(["--git-dir", mirrorOf(ctl), "fetch", "-q", "--", remote, "+refs/heads/main:refs/remotes/origin/main"]);
    expect(readdirSync(ctlVictim)).toEqual(["main"]);

    const cache = temp();
    await prepareWorktree("o/n", "main", "ro1", cache, file);
    const victim = linkToVictim(mirrorOf(cache), "refs/remotes/origin");
    await expect(prepareWorktree("o/n", "main", "ro2", cache, file)).rejects.toThrow(/not a plain directory/);
    expect(readdirSync(victim)).toEqual([]);
  });

  it("refuses a symlinked directory component of the base branch's tracking ref", async () => {
    const r = remoteWith(["rel/one"]);
    // Control: a plain fetch of rel/one writes into the target of a symlinked refs/remotes/origin/rel.
    const ctl = temp();
    await prepareWorktree("o/n", "main", "bc0", ctl, r.opts);
    const ctlVictim = linkToVictim(mirrorOf(ctl), "refs/remotes/origin/rel");
    fx(["--git-dir", mirrorOf(ctl), "fetch", "-q", "--", r.bare, "+refs/heads/rel/one:refs/remotes/origin/rel/one"]);
    expect(readdirSync(ctlVictim)).toEqual(["one"]);

    const cache = temp();
    await prepareWorktree("o/n", "main", "bc1", cache, r.opts);
    const victim = linkToVictim(mirrorOf(cache), "refs/remotes/origin/rel");
    await expect(prepareWorktree("o/n", "rel/one", "bc2", cache, r.opts)).rejects.toThrow(/not a plain directory/);
    expect(readdirSync(victim)).toEqual([]);
  });

  it("replaces a stale tracking ref that is in the way of a new base branch's directory", async () => {
    const r = remoteWith(["rel"]);
    const ctl = temp();
    const cache = temp();
    await prepareWorktree("o/n", "rel", "st0", ctl, r.opts);
    await prepareWorktree("o/n", "rel", "st1", cache, r.opts);
    // The remote's "rel" becomes "rel/one", with new content.
    writeFileSync(join(r.seed, "README"), "rel one\n");
    fx(["commit", "-q", "-am", "rel one"], r.seed);
    fx(["push", "-q", r.bare, ":refs/heads/rel", "HEAD:refs/heads/rel/one"], r.seed);
    // Control: a plain fetch cannot create refs/remotes/origin/rel/one while the file refs/remotes/origin/rel exists.
    expect(() =>
      fx(["--git-dir", mirrorOf(ctl), "fetch", "-q", "--", r.bare, "+refs/heads/rel/one:refs/remotes/origin/rel/one"]),
    ).toThrow();

    const ws = await prepareWorktree("o/n", "rel/one", "st2", cache, r.opts);
    expect(readFileSync(join(ws.dir, "README"), "utf8")).toBe("rel one\n");
  });
});

describe("round 5: automatic maintenance", () => {
  it("pins maintenance.auto=false and gc.auto=0 on every git call", async () => {
    const cache = temp();
    const get = async (key: string) => (await runGit(["config", "--get", key], { cacheDir: cache })).stdout.trim();
    expect(await get("maintenance.auto")).toBe("false");
    expect(await get("gc.auto")).toBe("0");
  });

  it("never runs auto gc after a commit, even when the owner's config asks for it", async () => {
    /** A job whose mirror holds two packs, with one more file in the worktree to commit. */
    const setup = async (id: string) => {
      const cache = temp();
      const ws = await prepareWorktree("o/n", "main", id, cache, file);
      const mirror = mirrorOf(cache);
      const packs = () => readdirSync(join(mirror, "objects", "pack")).filter((n) => n.endsWith(".pack")).length;
      // The fetch left one pack; packing the runner's commit's loose objects adds a second. (No second runner
      // commit: plain git's own auto maintenance would merge the packs again.)
      runnerCommit(ws.dir, "a.txt");
      fx(["--git-dir", mirror, "repack", "-q", "-d"]);
      writeFileSync(join(ws.dir, "c.txt"), "c\n");
      expect(packs()).toBeGreaterThanOrEqual(2);
      return { cache, ws, packs };
    };
    // The gc strategy, because newer git's default auto maintenance does not run gc for this.
    const gcConfig = ["gc.autoPackLimit=1", "gc.autoDetach=false", "maintenance.autoDetach=false", "maintenance.strategy=gc"];
    // Control: plain git's commit runs auto maintenance, and gc consolidates the packs.
    const ctl = await setup("ag0");
    fx(["add", "c.txt"], ctl.ws.dir);
    plainCommit(ctl.ws.dir, "c", gcConfig.flatMap((c) => ["-c", c]));
    expect(ctl.packs()).toBe(1);

    const job = await setup("ag1");
    const before = job.packs();
    const home = temp();
    writeFileSync(
      join(home, ".gitconfig"),
      "[gc]\n\tautoPackLimit = 1\n\tautoDetach = false\n[maintenance]\n\tautoDetach = false\n\tstrategy = gc\n",
    );
    const res = await withHome(home, () => commitWorktree("o/n", "ag1", job.cache, file));
    expect(res.committed).toBe(true);
    expect(job.packs()).toBe(before);
  });
});

describe("round 5: the cache root", () => {
  it("refuses a cache root that was replaced by a symlink", async () => {
    const parent = temp();
    const cache = join(parent, "cache");
    mkdirSync(cache);
    await prepareWorktree("o/n", "main", "k1", cache, file);
    const moved = join(parent, "moved");
    renameSync(cache, moved);
    symlinkSync(moved, cache);
    writeFileSync(join(moved, "work", "k1", "x.txt"), "x\n");

    await expect(prepareWorktree("o/n", "main", "k2", cache, file)).rejects.toThrow(/not a plain directory/);
    await expect(commitWorktree("o/n", "k1", cache, file)).rejects.toThrow(/not a plain directory/);
    await expect(pushBranch("o/n", "k1", cache, file)).rejects.toThrow(/not a plain directory/);
    await expect(removeWorktree("o/n", "k1", cache)).rejects.toThrow(/not a plain directory/);
    expect(existsSync(join(moved, "work", "k1", "README"))).toBe(true);
    expect(existsSync(join(moved, "work", "k2"))).toBe(false);
    expect(remoteSha("refs/heads/hoistline/k1")).toBeNull();
  });
});
