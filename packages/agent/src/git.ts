import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { canonicalRepo } from "./repo.js";

// Everything in this module takes values from a signed job and runs git on the owner's machine, so every input is
// treated as hostile until validated. Git always runs as a child process with an argument array (never a shell),
// with `--` before user-derived positionals, a scrubbed environment, and `-c` overrides that disable hooks,
// fsmonitor, submodule recursion and every transport except https.
//
// The runner (an unsandboxed CLI) works in a worktree that shares the mirror's git directory, so it can write the
// mirror's config, info/attributes and hooks, and it owns the worktree's `.git` file. The agent therefore never runs
// git through the worktree, stores no remote in the mirror, and resets the mirror before every fetch, worktree add
// and push.

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 16 * 1024 * 1024;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BRANCH_CHARS = /^[A-Za-z0-9._/-]{1,255}$/;
// Owner environment variables git needs for the owner's own credentials, proxy and CA settings; everything else,
// including every other GIT_* variable, is dropped.
const ENV_KEEP = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "PATHEXT",
  "ComSpec",
  "SystemRoot",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
];
// Transports pinned explicitly, because `protocol.<name>.allow` in the owner's config would beat `protocol.allow`.
const BLOCKED_PROTOCOLS = ["ext", "fd", "file", "git", "ssh", "http"];

/** The whole of a mirror's config. Rewritten before every fetch, worktree add and push. */
export const MIRROR_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tbare = true\n";

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr = "",
  ) {
    super(stderr ? `${message}: ${stderr.trim()}` : message);
    this.name = "GitError";
  }
}

/** Returns the canonical lowercase `owner/name`, or throws. */
export function validateRepo(repo: string): string {
  const canonical = canonicalRepo(repo);
  if (canonical === null) throw new Error(`invalid repository ${JSON.stringify(repo)}: expected owner/name`);
  return canonical;
}

/**
 * Returns `name` if it is a safe branch name, or throws. Stricter than `git check-ref-format --branch`: ASCII
 * letters, digits, `.`, `_`, `/` and `-` only, so it can never look like an option, a revision expression or a path
 * escape.
 */
export function validateBranch(name: string): string {
  const ok =
    typeof name === "string" &&
    BRANCH_CHARS.test(name) &&
    !/^[-/.]/.test(name) &&
    !/[/.]$/.test(name) &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//") &&
    name !== "HEAD" &&
    name.split("/").every((c) => !c.startsWith(".") && !c.endsWith(".lock"));
  if (!ok) throw new Error(`invalid branch name ${JSON.stringify(name)}`);
  return name;
}

/** Returns `id` if it is safe to use as a directory and branch component, or throws. */
export function validateJobId(id: string): string {
  if (typeof id !== "string" || !JOB_ID.test(id)) throw new Error(`invalid job id ${JSON.stringify(id)}`);
  return id;
}

/** The only remote URL used outside tests: derived from the canonical repo, never from job text. */
export function defaultRemote(canonical: string): string {
  return `https://github.com/${canonical}.git`;
}

export type GitRunOptions = {
  cacheDir: string;
  cwd?: string;
  allowFileProtocol?: boolean;
  timeoutMs?: number;
  /** Variables set on top of the scrubbed environment (the agent's own GIT_DIR / GIT_COMMON_DIR pins). */
  env?: Record<string, string>;
};

/** The environment git runs with. Internal; exported for tests. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_KEEP) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function hooksDir(cacheDir: string): string {
  return join(cacheDir, "empty-hooks");
}

function hardeningFlags(cacheDir: string, allowFileProtocol: boolean): string[] {
  const config = [
    "protocol.allow=never",
    ...BLOCKED_PROTOCOLS.map((p) => `protocol.${p}.allow=${p === "file" && allowFileProtocol ? "always" : "never"}`),
    "protocol.https.allow=always",
    `core.hooksPath=${hooksDir(cacheDir)}`,
    "core.fsmonitor=false",
    "core.sshCommand=false",
    "submodule.recurse=false",
    "transfer.fsckObjects=true",
    "fetch.fsckObjects=true",
    // Abort a transfer that stalls below 1 byte/s for 60 s, independently of the overall timeout.
    "http.lowSpeedLimit=1",
    "http.lowSpeedTime=60",
  ];
  return config.flatMap((c) => ["-c", c]);
}

/** Kills the child and everything it started (git spawns helpers such as git-remote-https). */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // No process groups on Windows: taskkill /T walks the child tree.
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Runs git with the hardened flags and environment. Internal; exported for tests. */
export async function runGit(args: string[], opts: GitRunOptions): Promise<{ stdout: string; stderr: string }> {
  const cacheDir = resolve(opts.cacheDir);
  await mkdir(hooksDir(cacheDir), { recursive: true });
  const argv = [...hardeningFlags(cacheDir, opts.allowFileProtocol === true), ...args];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The subcommand, for error messages: the first positional that is not the value of a global option.
  const sub =
    args.find((a, i) => !a.startsWith("-") && !["--git-dir", "--work-tree", "-c", "-C"].includes(args[i - 1] ?? "")) ??
    "";
  return new Promise((resolvePromise, reject) => {
    // Detached on POSIX makes git a process-group leader, so a timeout can kill its helpers too.
    const child = spawn("git", argv, {
      cwd: opts.cwd ?? cacheDir,
      env: { ...scrubbedEnv(), ...opts.env },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failure: string | null = null;
    const fail = (why: string) => {
      if (failure !== null) return;
      failure = why;
      killTree(child.pid);
    };
    const timer = setTimeout(() => fail(" (timed out)"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      stdout += c;
      if (stdout.length > MAX_BUFFER) fail(" (output too large)");
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      stderr += c;
      if (stderr.length > MAX_BUFFER) fail(" (output too large)");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new GitError(`git ${sub} failed: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure !== null || code !== 0) {
        // Make sure no helper outlives a failed command.
        if (failure === null) killTree(child.pid);
        reject(new GitError(`git ${sub} failed${failure ?? ""}`, stderr));
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

// Per-repo async mutex: concurrent jobs on one repo must not fetch into, add worktrees to, or push from the mirror
// at once.
const repoLocks = new Map<string, Promise<unknown>>();

async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  repoLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (repoLocks.get(key) === tail) repoLocks.delete(key);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function mirrorPath(cacheDir: string, canonical: string): string {
  return join(cacheDir, "repos", `${canonical.replace("/", "__")}.git`);
}

function lstatOrNull(path: string) {
  return lstat(path).catch(() => null);
}

/** Removes `path` itself: a file or symlink is unlinked (never followed); a real directory is removed as a tree. */
async function removeEntry(path: string): Promise<void> {
  const stat = await lstatOrNull(path);
  if (!stat) return;
  // fs.rm lstat()s every entry and unlinks symlinks instead of descending into them.
  if (stat.isDirectory()) await rm(path, { recursive: true, force: true });
  else await unlink(path);
}

/** True if `path` is a real directory. Anything else in its place (a symlink, a file) is removed, not followed. */
async function realDirOrRemove(path: string): Promise<boolean> {
  const stat = await lstatOrNull(path);
  if (!stat) return false;
  if (stat.isDirectory()) return true;
  await unlink(path);
  return false;
}

async function assertRealDir(path: string): Promise<void> {
  if (!(await lstatOrNull(path))?.isDirectory()) throw new Error(`refusing to use ${path}: not a plain directory`);
}

/** Reads a small control file only if it is a regular file (never through a symlink). */
async function readRegularFile(path: string): Promise<string | null> {
  if (!(await lstatOrNull(path))?.isFile()) return null;
  return readFile(path, "utf8");
}

/**
 * Undoes anything a runner may have written into the shared git directory, without ever following a symlink: the
 * config is rewritten from a fixed template (no remote, url, include, credential, http, filter or core.* overrides),
 * the hooks directory is recreated empty, and commondir, gitdir, config.worktree, every worktrees/<x>/config.worktree,
 * info/attributes and the object alternates are deleted. A targeted list, so a concurrent job's lock files survive.
 */
async function resetMirror(mirror: string): Promise<void> {
  await assertRealDir(dirname(mirror));
  await assertRealDir(mirror);
  await assertRealDir(join(mirror, "objects"));

  const config = join(mirror, "config");
  await removeEntry(config);
  await writeFile(config, MIRROR_CONFIG, { flag: "wx" });
  for (const name of ["commondir", "gitdir", "config.worktree"]) await removeEntry(join(mirror, name));
  if (await realDirOrRemove(join(mirror, "info"))) await removeEntry(join(mirror, "info", "attributes"));
  const objectsInfo = join(mirror, "objects", "info");
  if (await realDirOrRemove(objectsInfo)) {
    await removeEntry(join(objectsInfo, "alternates"));
    await removeEntry(join(objectsInfo, "http-alternates"));
  }
  const worktrees = join(mirror, "worktrees");
  if (await realDirOrRemove(worktrees)) {
    for (const entry of await readdir(worktrees)) {
      const admin = join(worktrees, entry);
      if (await realDirOrRemove(admin)) await removeEntry(join(admin, "config.worktree"));
    }
  }
  const hooks = join(mirror, "hooks");
  await removeEntry(hooks);
  await mkdir(hooks);
}

export type PrepareOptions = {
  /** Test hook: maps the canonical repo to a remote URL. Defaults to the GitHub https URL. */
  remoteFor?: (canonical: string) => string;
  /** Test hook: permits the file transport. Never set outside tests. */
  allowFileProtocol?: boolean;
  timeoutMs?: number;
};

/**
 * Git scoped to the mirror. GIT_DIR and GIT_COMMON_DIR are pinned in the environment because git otherwise honors a
 * `commondir` file planted in the mirror and would read another repository's config. Internal; exported for tests.
 */
export function mirrorGit(cache: string, mirror: string, opts: PrepareOptions) {
  return (args: string[]) =>
    runGit(["--git-dir", mirror, ...args], {
      cacheDir: cache,
      allowFileProtocol: opts.allowFileProtocol,
      timeoutMs: opts.timeoutMs,
      env: { GIT_DIR: mirror, GIT_COMMON_DIR: mirror },
    });
}

async function branchExists(git: (args: string[]) => Promise<unknown>, ref: string): Promise<boolean> {
  return git(["show-ref", "--verify", "--quiet", ref]).then(
    () => true,
    () => false,
  );
}

/**
 * Prepares `<cacheDir>/work/<jobId>` as a worktree of the persistent bare mirror `<cacheDir>/repos/<owner>__<name>.git`,
 * on a new branch `hoistline/<jobId>` created from the remote's `baseBranch`. A job id that already has a worktree or
 * branch is refused.
 */
export async function prepareWorktree(
  repo: string,
  baseBranch: string,
  jobId: string,
  cacheDir: string,
  opts: PrepareOptions = {},
): Promise<{ dir: string; branch: string }> {
  const canonical = validateRepo(repo);
  const base = validateBranch(baseBranch);
  const id = validateJobId(jobId);
  const cache = resolve(cacheDir);
  const mirror = mirrorPath(cache, canonical);
  const dir = join(cache, "work", id);
  const branch = `hoistline/${id}`;
  const url = (opts.remoteFor ?? defaultRemote)(canonical);
  const git = mirrorGit(cache, mirror, opts);

  return withRepoLock(mirror, async () => {
    if (!(await exists(join(mirror, "HEAD")))) {
      await mkdir(dirname(mirror), { recursive: true });
      await assertRealDir(dirname(mirror));
      // Pin the formats so the fixed config template always matches the repository on disk.
      await runGit(
        ["-c", "init.defaultObjectFormat=sha1", "-c", "init.defaultRefFormat=files", "init", "--quiet", "--bare", "--",
          mirror],
        { cacheDir: cache, timeoutMs: opts.timeoutMs },
      );
    }
    await resetMirror(mirror);

    if ((await exists(dir)) || (await branchExists(git, `refs/heads/${branch}`))) {
      throw new Error(`job id "${id}" was already used on this machine; refusing to reuse its worktree`);
    }

    try {
      await git(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--", url,
        `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    } catch (err) {
      const e = err as GitError;
      throw new GitError(`could not fetch base branch "${base}" of ${canonical}`, e.stderr || e.message);
    }

    await resetMirror(mirror);
    await mkdir(dirname(dir), { recursive: true });
    try {
      await git(["worktree", "add", "--quiet", "--no-track", "-b", branch, "--", dir, `refs/remotes/origin/${base}`]);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      await git(["worktree", "prune"]).catch(() => undefined);
      throw err;
    }
    return { dir, branch };
  });
}

/**
 * Pushes `hoistline/<jobId>` from the repo's mirror to the same branch at the canonical remote URL. Never runs git
 * through the worktree, never forces, never pushes tags, and refuses a job whose branch does not exist.
 */
export async function pushBranch(
  repo: string,
  jobId: string,
  cacheDir: string,
  opts: PrepareOptions = {},
): Promise<void> {
  const canonical = validateRepo(repo);
  const id = validateJobId(jobId);
  const cache = resolve(cacheDir);
  const mirror = mirrorPath(cache, canonical);
  const ref = `refs/heads/hoistline/${id}`;
  const url = (opts.remoteFor ?? defaultRemote)(canonical);
  const git = mirrorGit(cache, mirror, opts);

  await withRepoLock(mirror, async () => {
    if (!(await exists(join(mirror, "HEAD")))) throw new Error(`refusing to push: no branch hoistline/${id}`);
    await resetMirror(mirror);
    if (!(await branchExists(git, ref))) throw new Error(`refusing to push: no branch hoistline/${id}`);
    await git(["push", "--quiet", "--no-verify", "--no-follow-tags", "--", url, `${ref}:${ref}`]);
  });
}

/**
 * Removes `<cacheDir>/work/<jobId>` and prunes it from the repo's mirror. The result branch stays in the mirror, so
 * the job id cannot be reused. Never touches anything outside `<cacheDir>/work`.
 */
export async function removeWorktree(repo: string, jobId: string, cacheDir: string): Promise<void> {
  const canonical = validateRepo(repo);
  const id = validateJobId(jobId);
  const cache = resolve(cacheDir);
  const workRoot = join(cache, "work");
  const dir = join(workRoot, id);

  const rootStat = await lstat(workRoot).catch(() => null);
  if (rootStat && !rootStat.isDirectory()) {
    // A symlinked work directory could point anywhere; never follow it.
    throw new Error(`refusing to remove ${dir}: ${workRoot} is not a plain directory`);
  }
  const stat = rootStat ? await lstat(dir).catch(() => null) : null;
  if (stat) {
    if (!stat.isDirectory()) throw new Error(`refusing to remove ${dir}: not a plain directory`);
    const realRoot = await realpath(workRoot);
    if (!(await realpath(dir)).startsWith(realRoot + sep)) {
      throw new Error(`refusing to remove ${dir}: outside ${workRoot}`);
    }
    await rm(dir, { recursive: true, force: true });
  }
  const mirror = mirrorPath(cache, canonical);
  if (await exists(join(mirror, "HEAD"))) {
    await withRepoLock(mirror, async () => {
      await resetMirror(mirror);
      await mirrorGit(cache, mirror, {})(["worktree", "prune"]);
    });
  }
}

const COMMIT_IDENTITY = [
  "-c",
  "user.name=Hoistline",
  "-c",
  "user.email=hoistline@users.noreply.github.com",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
];

/**
 * Finds the worktree's admin directory `<mirror>/worktrees/<name>` by its `gitdir` file, never through the
 * runner-owned `.git` file in the worktree. Requires exactly one match whose HEAD is `hoistline/<jobId>`.
 */
async function findAdminDir(mirror: string, dir: string, ref: string): Promise<string> {
  const expected = new Set([join(dir, ".git"), join(await realpath(dir), ".git")]);
  const worktrees = join(mirror, "worktrees");
  const matches: string[] = [];
  if ((await lstatOrNull(worktrees))?.isDirectory()) {
    for (const entry of await readdir(worktrees)) {
      const admin = join(worktrees, entry);
      if (!(await lstatOrNull(admin))?.isDirectory()) continue;
      const gitdir = await readRegularFile(join(admin, "gitdir"));
      if (gitdir !== null && expected.has(gitdir.trim())) matches.push(admin);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`refusing to commit: expected one worktree record for ${dir}, found ${matches.length}`);
  }
  const admin = matches[0] as string;
  const head = await readRegularFile(join(admin, "HEAD"));
  if (head?.trim() !== `ref: ${ref}`) throw new Error(`refusing to commit: the worktree is not on ${ref}`);
  return admin;
}

/**
 * Commits everything in `<cacheDir>/work/<jobId>` (tracked, modified and untracked files) onto `hoistline/<jobId>`.
 * Git runs against the mirror's own record of the worktree, with no hooks, filters from planted config or signing.
 * Returns `{ committed: false }` when there is nothing to commit (a runner that committed itself leaves its commits
 * on the branch).
 */
export async function commitWorktree(
  repo: string,
  jobId: string,
  cacheDir: string,
  opts: PrepareOptions & { message?: string } = {},
): Promise<{ committed: boolean; sha?: string }> {
  const canonical = validateRepo(repo);
  const id = validateJobId(jobId);
  const cache = resolve(cacheDir);
  const mirror = mirrorPath(cache, canonical);
  const dir = join(cache, "work", id);
  const ref = `refs/heads/hoistline/${id}`;
  const message = opts.message ?? `hoistline: job ${id}`;
  if (typeof message !== "string" || message.length === 0) throw new Error("invalid commit message");

  return withRepoLock(mirror, async () => {
    if (!(await exists(join(mirror, "HEAD")))) throw new Error(`refusing to commit: no mirror for ${canonical}`);
    await resetMirror(mirror);
    await assertRealDir(join(cache, "work")).catch(() => {
      throw new Error(`refusing to commit: ${join(cache, "work")} is not a plain directory`);
    });
    if (!(await lstatOrNull(dir))?.isDirectory()) throw new Error(`refusing to commit: no worktree at ${dir}`);
    const admin = await findAdminDir(mirror, dir, ref);
    const git = (args: string[]) =>
      runGit(["--git-dir", admin, "--work-tree", dir, ...COMMIT_IDENTITY, ...args], {
        cacheDir: cache,
        allowFileProtocol: opts.allowFileProtocol,
        timeoutMs: opts.timeoutMs,
        env: { GIT_DIR: admin, GIT_COMMON_DIR: mirror, GIT_WORK_TREE: dir },
      });

    await git(["add", "--all"]);
    const staged = await git(["diff", "--cached", "--name-only", "-z"]);
    if (staged.stdout === "") return { committed: false };
    await git(["commit", "--quiet", "--no-verify", "-m", message]);
    const sha = (await mirrorGit(cache, mirror, opts)(["rev-parse", "--verify", "--end-of-options", ref])).stdout.trim();
    return { committed: true, sha };
  });
}
