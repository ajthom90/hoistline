import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
  const sub = args.find((a, i) => !a.startsWith("-") && !["--git-dir", "-c", "-C"].includes(args[i - 1] ?? "")) ?? "";
  return new Promise((resolvePromise, reject) => {
    // Detached on POSIX makes git a process-group leader, so a timeout can kill its helpers too.
    const child = spawn("git", argv, {
      cwd: opts.cwd ?? cacheDir,
      env: scrubbedEnv(),
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

/**
 * Undoes anything a runner may have written into the shared git directory: the config is rewritten from a fixed
 * template (no remote, url, include, credential, http, filter or core.* overrides), and info/attributes, every
 * config.worktree and every hook are deleted.
 */
async function resetMirror(mirror: string): Promise<void> {
  await writeFile(join(mirror, "config"), MIRROR_CONFIG);
  await rm(join(mirror, "info", "attributes"), { recursive: true, force: true });
  await rm(join(mirror, "config.worktree"), { recursive: true, force: true });
  for (const entry of await readdir(join(mirror, "worktrees")).catch(() => [])) {
    await rm(join(mirror, "worktrees", entry, "config.worktree"), { recursive: true, force: true });
  }
  const hooks = join(mirror, "hooks");
  for (const entry of await readdir(hooks).catch(() => [])) {
    await rm(join(hooks, entry), { recursive: true, force: true });
  }
}

export type PrepareOptions = {
  /** Test hook: maps the canonical repo to a remote URL. Defaults to the GitHub https URL. */
  remoteFor?: (canonical: string) => string;
  /** Test hook: permits the file transport. Never set outside tests. */
  allowFileProtocol?: boolean;
  timeoutMs?: number;
};

function mirrorGit(cache: string, mirror: string, opts: PrepareOptions) {
  return (args: string[]) =>
    runGit(["--git-dir", mirror, ...args], {
      cacheDir: cache,
      allowFileProtocol: opts.allowFileProtocol,
      timeoutMs: opts.timeoutMs,
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
    await withRepoLock(mirror, () => mirrorGit(cache, mirror, {})(["worktree", "prune"]));
  }
}
