import { execFile } from "node:child_process";
import { lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { canonicalRepo } from "./repo.js";

// Everything in this module takes values from a signed job and runs git on the owner's machine, so every input is
// treated as hostile until validated. Git always runs through execFile with an argument array (never a shell), with
// `--` before user-derived positionals, a scrubbed environment, and `-c` overrides that disable hooks, fsmonitor,
// submodule recursion and every transport except https.

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 16 * 1024 * 1024;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BRANCH_CHARS = /^[A-Za-z0-9._/-]{1,255}$/;
const RESULT_BRANCH = /^hoistline\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Owner environment variables git needs for the owner's own credentials; everything else is dropped.
const ENV_KEEP = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
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
];
// Transports pinned explicitly, because `protocol.<name>.allow` in the owner's config would beat `protocol.allow`.
const BLOCKED_PROTOCOLS = ["ext", "fd", "file", "git", "ssh", "http"];

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

function scrubbedEnv(): NodeJS.ProcessEnv {
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
  ];
  return config.flatMap((c) => ["-c", c]);
}

/** Runs git with the hardened flags and environment. Internal; exported for tests. */
export async function runGit(args: string[], opts: GitRunOptions): Promise<{ stdout: string; stderr: string }> {
  const cacheDir = resolve(opts.cacheDir);
  await mkdir(hooksDir(cacheDir), { recursive: true });
  const argv = [...hardeningFlags(cacheDir, opts.allowFileProtocol === true), ...args];
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      argv,
      {
        cwd: opts.cwd ?? cacheDir,
        env: scrubbedEnv(),
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const reason = error.killed ? " (timed out)" : "";
          reject(new GitError(`git ${args[0]} failed${reason}`, stderr));
        } else {
          resolvePromise({ stdout, stderr });
        }
      },
    );
  });
}

// Per-repo async mutex: concurrent jobs on one repo must not fetch into, or add worktrees to, the mirror at once.
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

export type PrepareOptions = {
  /** Test hook: maps the canonical repo to a remote URL. Defaults to the GitHub https URL. */
  remoteFor?: (canonical: string) => string;
  /** Test hook: permits the file transport. Never set outside tests. */
  allowFileProtocol?: boolean;
  timeoutMs?: number;
};

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
  const remote = (opts.remoteFor ?? defaultRemote)(canonical);
  const git = (args: string[]) =>
    runGit(args, { cacheDir: cache, allowFileProtocol: opts.allowFileProtocol, timeoutMs: opts.timeoutMs });

  return withRepoLock(mirror, async () => {
    if (!(await exists(join(mirror, "HEAD")))) {
      await mkdir(dirname(mirror), { recursive: true });
      await git(["init", "--quiet", "--bare", "--", mirror]);
    }
    // Re-pin the remote every time so nothing left in the mirror's config can redirect the fetch or the push.
    await git(["-C", mirror, "config", "--replace-all", "remote.origin.url", remote]);

    const reused =
      (await exists(dir)) ||
      (await git(["-C", mirror, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(
        () => true,
        () => false,
      ));
    if (reused) throw new Error(`job id "${id}" was already used on this machine; refusing to reuse its worktree`);

    try {
      await git(["-C", mirror, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--", "origin",
        `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    } catch (err) {
      throw new GitError(`could not fetch base branch "${base}" of ${canonical}`, (err as GitError).stderr);
    }

    await mkdir(dirname(dir), { recursive: true });
    try {
      await git(["-C", mirror, "worktree", "add", "--quiet", "--no-track", "-b", branch, "--", dir,
        `refs/remotes/origin/${base}`]);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      await git(["-C", mirror, "worktree", "prune"]).catch(() => undefined);
      throw err;
    }
    return { dir, branch };
  });
}

/**
 * Pushes the worktree's `hoistline/<jobId>` branch to the same branch on origin. Never forces, never pushes tags,
 * and refuses any branch other than the one the worktree at `<cacheDir>/work/<jobId>` was created on.
 */
export async function pushBranch(
  dir: string,
  branch: string,
  opts: { allowFileProtocol?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const worktree = resolve(dir);
  const jobId = basename(worktree);
  const cache = dirname(dirname(worktree));
  if (
    typeof branch !== "string" ||
    !RESULT_BRANCH.test(branch) ||
    basename(dirname(worktree)) !== "work" ||
    !JOB_ID.test(jobId) ||
    branch !== `hoistline/${jobId}`
  ) {
    throw new Error(`refusing to push branch ${JSON.stringify(branch)} from ${worktree}`);
  }
  const stat = await lstat(worktree).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`refusing to push from ${worktree}: not a worktree directory`);
  const git = (args: string[]) =>
    runGit(args, { cacheDir: cache, cwd: worktree, allowFileProtocol: opts.allowFileProtocol, timeoutMs: opts.timeoutMs });

  const head = await git(["symbolic-ref", "--quiet", "HEAD"]).then(
    (r) => r.stdout.trim(),
    () => "",
  );
  if (head !== `refs/heads/${branch}`) {
    throw new Error(`refusing to push ${JSON.stringify(branch)}: the worktree is not on that branch`);
  }
  const ref = `refs/heads/${branch}`;
  await git(["push", "--quiet", "--no-verify", "--no-follow-tags", "origin", "--", `${ref}:${ref}`]);
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
  if (!dir.startsWith(workRoot + sep)) throw new Error(`refusing to remove ${dir}: outside ${workRoot}`);

  const stat = await lstat(dir).catch(() => null);
  if (stat && !stat.isDirectory()) {
    // A symlink (or anything else) here could point outside the cache; never follow it.
    throw new Error(`refusing to remove ${dir}: not a plain directory`);
  }
  if (stat) await rm(dir, { recursive: true, force: true });
  const mirror = mirrorPath(cache, canonical);
  if (await exists(join(mirror, "HEAD"))) {
    await withRepoLock(mirror, () => runGit(["-C", mirror, "worktree", "prune"], { cacheDir: cache }));
  }
}
