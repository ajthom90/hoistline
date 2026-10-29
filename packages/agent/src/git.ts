import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { trackProcessGroup } from "./children.js";
import { canonicalRepo } from "./repo.js";

// Everything in this module takes values from a signed job and runs git on the owner's machine, so every input is
// treated as hostile until validated. Git always runs as a child process with an argument array (never a shell),
// with `--` before user-derived positionals, a scrubbed environment, and `-c` overrides that disable hooks,
// fsmonitor, replace refs, the commit-graph, reflogs, submodule recursion and every transport except https.
//
// The runner (an unsandboxed CLI) works in a worktree that shares the mirror's git directory, so it can write
// anything in the mirror (config, hooks, refs, metadata files, symlinks) and it owns the worktree's `.git` file. The
// agent therefore never runs git through the worktree, stores no remote in the mirror, resets the mirror before every
// fetch, worktree add, commit and push, never follows a symlink it did not create, and commits through its own
// fresh index.

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** How long a killed git may take to close its pipes before the call is failed anyway. */
const DEFAULT_KILL_GRACE_MS = 5_000;
/** Upper bound on any small control file the agent reads (gitdir, HEAD, job ownership records). */
const CONTROL_FILE_MAX = 4096;
const MAX_WORKTREE_RECORDS = 10_000;
const MAX_TRACKED_PATHS = 200_000;
/**
 * Per-worktree state a runner can leave in its admin dir that changes what `git commit` records: MERGE_HEAD adds
 * parents, CHERRY_PICK_HEAD supplies the author, the message files supply text. COMMIT_EDITMSG and logs are written
 * by commit and could be symlinks to files outside the cache.
 */
const COMMIT_STATE = [
  "MERGE_HEAD",
  "MERGE_MSG",
  "MERGE_MODE",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "AUTO_MERGE",
  "SQUASH_MSG",
  "sequencer",
  "rebase-merge",
  "rebase-apply",
  "COMMIT_EDITMSG",
  "logs",
];
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

/** The fixed part of a mirror's config; {@link mirrorConfig} adds the probed platform values. */
export const MIRROR_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tbare = true\n";
/** The only values taken from the platform probe: how this filesystem treats case, Unicode, modes and symlinks. */
const PLATFORM_KEYS = ["ignorecase", "precomposeunicode", "filemode", "symlinks"] as const;
type PlatformConfig = Partial<Record<(typeof PLATFORM_KEYS)[number], "true" | "false">>;

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
  /** After a kill, how long to wait for git's pipes to close before failing anyway. */
  killGraceMs?: number;
  /** Variables set on top of the scrubbed environment (the agent's own GIT_DIR / GIT_COMMON_DIR pins). */
  env?: Record<string, string>;
  /** Non-zero exit codes that are results, not failures (for example 1 from `diff --quiet`). */
  okCodes?: number[];
  /** Receives stdout as it arrives instead of buffering it, so output of any size can be processed. */
  onStdout?: (chunk: string) => void;
};

export type GitResult = { stdout: string; stderr: string; code: number };

/** The environment git runs with. Internal; exported for tests. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_KEEP) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  // A runner can plant refs/replace/* (loose or packed) to substitute any object the agent reads.
  env.GIT_NO_REPLACE_OBJECTS = "1";
  return env;
}

function hardeningFlags(hooksPath: string, allowFileProtocol: boolean): string[] {
  const config = [
    "protocol.allow=never",
    ...BLOCKED_PROTOCOLS.map((p) => `protocol.${p}.allow=${p === "file" && allowFileProtocol ? "always" : "never"}`),
    "protocol.https.allow=always",
    // Hooks run even with --no-verify (post-checkout, reference-transaction, prepare-commit-msg), so hooksPath must
    // name a place that cannot hold any: /dev/null, or on Windows a directory created empty for this one call.
    `core.hooksPath=${hooksPath}`,
    // Reflogs are written through whatever is at logs/<ref>, which a runner can make a symlink.
    "core.logAllRefUpdates=false",
    // fetch and commit start auto maintenance, and a detached gc can outlive this call and the repository lock.
    "maintenance.auto=false",
    "gc.auto=0",
    "core.fsmonitor=false",
    "core.sshCommand=false",
    "core.useReplaceRefs=false",
    // A runner can write objects/info/commit-graph; ignore it so it cannot misstate commit parents.
    "core.commitGraph=false",
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
export async function runGit(args: string[], opts: GitRunOptions): Promise<GitResult> {
  const cacheDir = resolve(opts.cacheDir);
  await mkdir(cacheDir, { recursive: true });
  // A fresh directory per call where /dev/null does not exist, so nothing planted earlier can be in it.
  const hooks = process.platform === "win32" ? await mkdtemp(join(cacheDir, "hooks-")) : "/dev/null";
  try {
    return await spawnGit([...hardeningFlags(hooks, opts.allowFileProtocol === true), ...args], args, cacheDir, opts);
  } finally {
    // Best effort: a failed cleanup must not replace git's result or error.
    if (hooks !== "/dev/null") await rm(hooks, { recursive: true, force: true }).catch(() => undefined);
  }
}

function spawnGit(argv: string[], args: string[], cacheDir: string, opts: GitRunOptions): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  // The subcommand, for error messages: the first positional that is not the value of a global option.
  const sub =
    args.find((a, i) => !a.startsWith("-") && !["--git-dir", "--work-tree", "-c", "-C"].includes(args[i - 1] ?? "")) ??
    "";
  return new Promise((resolvePromise, reject) => {
    // Detached on POSIX makes git a process-group leader, so a timeout can kill its helpers too.
    const child = spawn("git", argv, {
      cwd: opts.cwd ?? cacheDir,
      env: { ...scrubbedEnv(), ...opts.env, GIT_NO_REPLACE_OBJECTS: "1" },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failure: string | null = null;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    // Until settled, a forced stop (killTrackedProcessGroups) can SIGKILL git and its helpers at once.
    const untrack = trackProcessGroup(child.pid);
    const settle = (err: GitError | null, result?: GitResult) => {
      if (settled) return;
      settled = true;
      untrack();
      clearTimeout(timer);
      clearTimeout(grace);
      if (err) reject(err);
      else resolvePromise(result as GitResult);
    };
    const fail = (why: string) => {
      if (failure !== null) return;
      failure = why;
      killTree(child.pid);
      // A descendant that left the process group (or a failed taskkill) can keep the pipes open, and then "close"
      // never comes. Give up on it after a bounded wait, so the caller (and the repo lock) is always released.
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle(new GitError(`git ${sub} failed${why}`, stderr));
      }, graceMs);
    };
    const timer = setTimeout(() => fail(" (timed out)"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      if (opts.onStdout) {
        if (failure !== null) return;
        try {
          opts.onStdout(c);
        } catch (err) {
          fail(` (${(err as Error).message})`);
        }
        return;
      }
      stdout += c;
      if (stdout.length > MAX_BUFFER) fail(" (output too large)");
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      stderr += c;
      if (stderr.length > MAX_BUFFER) fail(" (output too large)");
    });
    child.on("error", (err) => settle(new GitError(`git ${sub} failed: ${err.message}`)));
    child.on("close", (code) => {
      if (failure !== null || code === null || (code !== 0 && !opts.okCodes?.includes(code))) {
        // Make sure no helper outlives a failed command.
        if (failure === null) killTree(child.pid);
        settle(new GitError(`git ${sub} failed${failure ?? ""}`, stderr));
      } else {
        settle(null, { stdout, stderr, code });
      }
    });
  });
}

// Async mutexes, keyed by mirror path (concurrent jobs on one repo must not fetch into, add worktrees to, commit in
// or push from the mirror at once) and by job id across the whole cache (two repos must not claim one work dir).
// Lock order: a job lock is always taken before a repo lock.
const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

const jobLockKey = (cache: string, id: string) => `${cache}\0job\0${id}`;

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

/** Creates `path` if missing (its parent must exist), then requires it to be a real directory, not a symlink. */
async function ensureRealDir(path: string): Promise<void> {
  await mkdir(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
  await assertRealDir(path);
}

/**
 * Reads a small control file: only a regular file (never through a symlink, never a FIFO), and only if it is at most
 * `max` bytes. Anything else reads as null.
 */
async function readControlFile(path: string, max = CONTROL_FILE_MAX): Promise<string | null> {
  if (!(await lstatOrNull(path))?.isFile()) return null;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags).catch(() => null);
  if (handle === null) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) return null;
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buf, 0, max + 1, 0);
    return bytesRead > max ? null : buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** The entries of `<mirror>/worktrees`, refusing an unreasonable number of them. */
async function listWorktreeRecords(worktrees: string): Promise<string[]> {
  const entries = await readdir(worktrees);
  if (entries.length > MAX_WORKTREE_RECORDS) throw new Error(`refusing to use ${worktrees}: too many worktree records`);
  return entries;
}

/**
 * Reads the platform values from a fresh repository's config: only {@link PLATFORM_KEYS} in the `[core]` section,
 * and only literal `true` / `false`. Internal; exported for tests.
 */
export function parsePlatformConfig(text: string): PlatformConfig {
  const found: PlatformConfig = {};
  let inCore = false;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]*)\]\s*$/.exec(line);
    if (section) {
      inCore = (section[1] as string).trim().toLowerCase() === "core";
      continue;
    }
    const entry = /^\s*([A-Za-z]+)\s*=\s*(true|false)\s*$/.exec(line);
    if (!inCore || !entry) continue;
    const key = (entry[1] as string).toLowerCase();
    if ((PLATFORM_KEYS as readonly string[]).includes(key)) found[key as keyof PlatformConfig] = entry[2] as "true" | "false";
  }
  // Fixed order, so the template is identical however git wrote the probe's config.
  const ordered: PlatformConfig = {};
  for (const key of PLATFORM_KEYS) if (found[key] !== undefined) ordered[key] = found[key];
  return ordered;
}

const platformProbes = new Map<string, Promise<PlatformConfig>>();

/**
 * How the cache's filesystem behaves, as `git init` detects it (case folding, Unicode precomposition, file modes,
 * symlinks). Probed once per cache dir in a throwaway repository under it, which is removed afterwards.
 * Internal; exported for tests.
 */
export function probePlatformConfig(cacheDir: string): Promise<PlatformConfig> {
  const cache = resolve(cacheDir);
  let probe = platformProbes.get(cache);
  if (probe === undefined) {
    probe = runPlatformProbe(cache);
    platformProbes.set(cache, probe);
    probe.catch(() => platformProbes.delete(cache));
  }
  return probe;
}

async function runPlatformProbe(cache: string): Promise<PlatformConfig> {
  await mkdir(cache, { recursive: true });
  await assertRealDir(cache);
  const dir = await mkdtemp(join(cache, "probe-"));
  try {
    // An empty --template: the owner's init.templateDir could otherwise supply the very values being probed.
    await runGit(["init", "--quiet", "--template=", "--", dir], { cacheDir: cache });
    const text = await readControlFile(join(dir, ".git", "config"), 64 * 1024);
    if (text === null) throw new Error("could not probe the platform's git settings");
    return parsePlatformConfig(text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** @internal Forgets the cached platform probes. Tests only. */
export function _resetPlatformProbeForTests(): void {
  platformProbes.clear();
}

/** The whole of a mirror's config: the fixed template plus the probed platform values. Internal; exported for tests. */
export async function mirrorConfig(cacheDir: string): Promise<string> {
  const platform = await probePlatformConfig(cacheDir);
  return MIRROR_CONFIG + Object.entries(platform).map(([k, v]) => `\t${k} = ${v}\n`).join("");
}

/** The probed platform values as `-c core.<key>=<value>` flags. */
async function platformFlags(cacheDir: string): Promise<string[]> {
  const platform = await probePlatformConfig(cacheDir);
  return Object.entries(platform).flatMap(([k, v]) => ["-c", `core.${k}=${v}`]);
}

/**
 * Undoes anything a runner may have written into the shared git directory, without ever following a symlink: the
 * config is rewritten from a fixed template (no remote, url, include, credential, http, filter or core.* overrides
 * beyond the probed platform values), the hooks directory is recreated empty, and commondir, gitdir,
 * config.worktree, FETCH_HEAD, shallow, logs, info/attributes, info/exclude, info/grafts, refs/replace, the object
 * alternates and every worktrees/<x>/config.worktree and worktrees/<x>/logs are deleted. refs, refs/heads,
 * refs/heads/hoistline, refs/remotes, refs/remotes/origin and objects/pack must be real directories. A targeted list,
 * so a concurrent job's lock files survive.
 */
async function resetMirror(mirror: string, config: string): Promise<void> {
  await assertRealDir(dirname(mirror));
  await assertRealDir(mirror);
  await assertRealDir(join(mirror, "objects"));

  const configPath = join(mirror, "config");
  await removeEntry(configPath);
  await writeFile(configPath, config, { flag: "wx" });
  // shallow (like info/grafts) rewrites ancestry; FETCH_HEAD and logs are written through whatever is in place.
  for (const name of ["commondir", "gitdir", "config.worktree", "FETCH_HEAD", "shallow", "logs"]) {
    await removeEntry(join(mirror, name));
  }
  if (await realDirOrRemove(join(mirror, "info"))) {
    for (const name of ["attributes", "exclude", "grafts"]) await removeEntry(join(mirror, "info", name));
  }
  // Git writes refs and packs through whatever is at these paths, so a symlinked one would put a job branch, a
  // tracking ref or a pack outside the cache. Missing ones are created here as real directories.
  for (const rel of [["refs"], ["refs", "heads"], ["refs", "heads", "hoistline"], ["refs", "remotes"],
    ["refs", "remotes", "origin"], ["objects", "pack"]]) {
    await ensureRealDir(join(mirror, ...rel));
  }
  // Packed replace refs survive this; GIT_NO_REPLACE_OBJECTS and core.useReplaceRefs=false cover those.
  await removeEntry(join(mirror, "refs", "replace"));
  const objectsInfo = join(mirror, "objects", "info");
  if (await realDirOrRemove(objectsInfo)) {
    await removeEntry(join(objectsInfo, "alternates"));
    await removeEntry(join(objectsInfo, "http-alternates"));
  }
  const worktrees = join(mirror, "worktrees");
  if (await realDirOrRemove(worktrees)) {
    for (const entry of await listWorktreeRecords(worktrees)) {
      const admin = join(worktrees, entry);
      if (await realDirOrRemove(admin)) {
        await removeEntry(join(admin, "config.worktree"));
        await removeEntry(join(admin, "logs"));
      }
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
  killGraceMs?: number;
};

type CallOptions = Pick<GitRunOptions, "okCodes" | "onStdout">;
type Git = (args: string[], extra?: CallOptions) => Promise<GitResult>;

/**
 * Git scoped to the mirror. GIT_DIR and GIT_COMMON_DIR are pinned in the environment because git otherwise honors a
 * `commondir` file planted in the mirror and would read another repository's config. Internal; exported for tests.
 */
export function mirrorGit(cache: string, mirror: string, opts: PrepareOptions): Git {
  return (args, extra = {}) =>
    runGit(["--git-dir", mirror, ...args], {
      cacheDir: cache,
      allowFileProtocol: opts.allowFileProtocol,
      timeoutMs: opts.timeoutMs,
      killGraceMs: opts.killGraceMs,
      okCodes: extra.okCodes,
      onStdout: extra.onStdout,
      env: { GIT_DIR: mirror, GIT_COMMON_DIR: mirror },
    });
}

async function branchExists(git: Git, ref: string): Promise<boolean> {
  return git(["show-ref", "--verify", "--quiet", ref]).then(
    () => true,
    () => false,
  );
}

/**
 * The commit a job branch points at. A runner can turn `hoistline/<id>` into a symbolic ref to another job's branch,
 * and committing or pushing through it would act on that branch, so a symbolic ref is refused.
 */
async function jobBranchSha(git: Git, ref: string, verb: string): Promise<string> {
  if ((await git(["symbolic-ref", "-q", ref], { okCodes: [1] })).code === 0) {
    throw new Error(`refusing to ${verb}: ${ref} is a symbolic ref`);
  }
  const res = await git(["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`], { okCodes: [1] });
  const sha = res.stdout.trim();
  if (res.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`refusing to ${verb}: no branch ${ref.slice("refs/heads/".length)}`);
  }
  return sha;
}

/**
 * Checks each directory component of `refs/remotes/origin/<base>` (resetMirror covers refs/remotes/origin itself),
 * because git writes the tracking ref through them. A symlink (or anything but a directory or a regular file) is
 * refused. A regular file is the stale tracking ref of a former base branch (`a` where `a/b` is wanted), and is
 * deleted as a ref, never followed.
 */
async function checkBaseComponents(git: Git, mirror: string, base: string): Promise<void> {
  const parts = base.split("/");
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const path = join(mirror, "refs", "remotes", "origin", ...parts.slice(0, i));
    const stat = await lstatOrNull(path);
    if (!stat) return;
    if (stat.isDirectory()) continue;
    if (!stat.isFile()) throw new Error(`refusing to use ${path}: not a plain directory`);
    await git(["update-ref", "-d", "--no-deref", `refs/remotes/origin/${prefix}`]);
    return;
  }
}

const jobReused = (id: string) =>
  new Error(`job id "${id}" was already used on this machine; refusing to reuse its worktree`);

/** Turns EEXIST into the job-reuse error; rethrows anything else. */
function reuseOnExist(id: string) {
  return (err: NodeJS.ErrnoException): never => {
    throw err.code === "EEXIST" ? jobReused(id) : err;
  };
}

/**
 * Prepares `<cacheDir>/work/<jobId>` as a worktree of the persistent bare mirror `<cacheDir>/repos/<owner>__<name>.git`,
 * on a new branch `hoistline/<jobId>` created from the remote's `baseBranch`. A job id is claimed for one repository
 * by an ownership record `<cacheDir>/jobs/<jobId>`; a job id that already has a record, worktree or branch is refused.
 * On failure only what this call created is removed.
 */
export async function prepareWorktree(
  repo: string,
  baseBranch: string,
  jobId: string,
  cacheDir: string,
  opts: PrepareOptions = {},
): Promise<{ dir: string; branch: string; baseSha: string }> {
  const canonical = validateRepo(repo);
  const base = validateBranch(baseBranch);
  const id = validateJobId(jobId);
  const cache = resolve(cacheDir);
  const mirror = mirrorPath(cache, canonical);
  const dir = join(cache, "work", id);
  const branch = `hoistline/${id}`;
  const url = (opts.remoteFor ?? defaultRemote)(canonical);
  const git = mirrorGit(cache, mirror, opts);
  const config = await mirrorConfig(cache);

  return withLock(jobLockKey(cache, id), () =>
    withLock(mirror, async () => {
      // Every directory git will create things in is checked before git runs: a symlink here would send the mirror,
      // the worktree or a cleanup anywhere on disk. The cache root too: the probe's check is cached per path.
      await assertRealDir(cache);
      for (const name of ["repos", "work", "jobs"]) await ensureRealDir(join(cache, name));
      const mirrorStat = await lstatOrNull(mirror);
      if (mirrorStat && !mirrorStat.isDirectory()) throw new Error(`refusing to use ${mirror}: not a plain directory`);
      if (!(await exists(join(mirror, "HEAD")))) {
        // Pin the formats so the fixed config template always matches the repository on disk.
        await runGit(
          ["-c", "init.defaultObjectFormat=sha1", "-c", "init.defaultRefFormat=files", "init", "--quiet", "--bare",
            "--", mirror],
          { cacheDir: cache, timeoutMs: opts.timeoutMs, killGraceMs: opts.killGraceMs },
        );
      }
      await resetMirror(mirror, config);

      const record = join(cache, "jobs", id);
      if ((await exists(record)) || (await exists(dir)) || (await branchExists(git, `refs/heads/${branch}`))) {
        throw jobReused(id);
      }
      // Exclusive create: the claim on this job id, also against another process using the same cache.
      await writeFile(record, `${canonical}\n`, { flag: "wx" }).catch(reuseOnExist(id));
      let createdDir = false;
      let baseSha: string;
      try {
        await checkBaseComponents(git, mirror, base);
        // A runner can make the fetch destination a symbolic ref to a job branch, which the forced fetch would move.
        await git(["update-ref", "-d", "--no-deref", `refs/remotes/origin/${base}`]);
        try {
          await git(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--", url,
            `+refs/heads/${base}:refs/remotes/origin/${base}`]);
        } catch (err) {
          const e = err as GitError;
          throw new GitError(`could not fetch base branch "${base}" of ${canonical}`, e.stderr || e.message);
        }
        await resetMirror(mirror, config);
        await checkBaseComponents(git, mirror, base);
        // The fetched base commit, by object id, so the worktree starts exactly there.
        baseSha = (
          await git(["rev-parse", "--verify", "--end-of-options", `refs/remotes/origin/${base}^{commit}`])
        ).stdout.trim();
        if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new GitError(`could not resolve base branch "${base}"`);
        // Created here (not by git, which accepts an existing empty directory), so it is known to be this job's.
        await mkdir(dir).catch(reuseOnExist(id));
        createdDir = true;
        await git(["worktree", "add", "--quiet", "--no-track", "-b", branch, "--", dir, baseSha]);
      } catch (err) {
        if (createdDir) await rm(dir, { recursive: true, force: true });
        await unlink(record).catch(() => undefined);
        await git(["worktree", "prune"]).catch(() => undefined);
        throw err;
      }
      return { dir, branch, baseSha };
    }),
  );
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
  const config = await mirrorConfig(cache);

  await withLock(mirror, async () => {
    await assertRealDir(cache);
    if (!(await exists(join(mirror, "HEAD")))) throw new Error(`refusing to push: no branch hoistline/${id}`);
    await resetMirror(mirror, config);
    const sha = await jobBranchSha(git, ref, "push");
    // The validated object id as the source, so nothing the ref name resolves to later can change what is pushed.
    await git(["push", "--quiet", "--no-verify", "--no-follow-tags", "--", url, `${sha}:${ref}`]);
  });
}

/**
 * Removes `<cacheDir>/work/<jobId>` and prunes it from the repo's mirror. The result branch and the job's ownership
 * record stay, so the job id cannot be reused. Never touches anything outside `<cacheDir>/work`, and only removes a
 * directory whose ownership record names this repository.
 */
export async function removeWorktree(repo: string, jobId: string, cacheDir: string): Promise<void> {
  const canonical = validateRepo(repo);
  const id = validateJobId(jobId);
  const cache = resolve(cacheDir);
  const workRoot = join(cache, "work");
  const dir = join(workRoot, id);
  const mirror = mirrorPath(cache, canonical);

  await withLock(jobLockKey(cache, id), async () => {
    const cacheStat = await lstatOrNull(cache);
    if (!cacheStat) return;
    if (!cacheStat.isDirectory()) throw new Error(`refusing to use ${cache}: not a plain directory`);
    const rootStat = await lstatOrNull(workRoot);
    if (rootStat && !rootStat.isDirectory()) {
      // A symlinked work directory could point anywhere; never follow it.
      throw new Error(`refusing to remove ${dir}: ${workRoot} is not a plain directory`);
    }
    const stat = rootStat ? await lstatOrNull(dir) : null;
    if (stat) {
      if (!stat.isDirectory()) throw new Error(`refusing to remove ${dir}: not a plain directory`);
      const realRoot = await realpath(workRoot);
      if (!(await realpath(dir)).startsWith(realRoot + sep)) {
        throw new Error(`refusing to remove ${dir}: outside ${workRoot}`);
      }
      const jobs = join(cache, "jobs");
      const owner = (await lstatOrNull(jobs))?.isDirectory() ? await readControlFile(join(jobs, id)) : null;
      if (owner === null) throw new Error(`refusing to remove ${dir}: no record of the repository that owns it`);
      if (owner.trim() !== canonical) throw new Error(`refusing to remove ${dir}: it belongs to another repository`);
      await rm(dir, { recursive: true, force: true });
    }
    if (await exists(join(mirror, "HEAD"))) {
      const config = await mirrorConfig(cache);
      await withLock(mirror, async () => {
        await resetMirror(mirror, config);
        await mirrorGit(cache, mirror, {})(["worktree", "prune"]);
      });
    }
  });
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
    for (const entry of await listWorktreeRecords(worktrees)) {
      const admin = join(worktrees, entry);
      if (!(await lstatOrNull(admin))?.isDirectory()) continue;
      const gitdir = await readControlFile(join(admin, "gitdir"));
      if (gitdir !== null && expected.has(gitdir.trim())) matches.push(admin);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`refusing to commit: expected one worktree record for ${dir}, found ${matches.length}`);
  }
  const admin = matches[0] as string;
  const head = await readControlFile(join(admin, "HEAD"));
  if (head?.trim() !== `ref: ${ref}`) throw new Error(`refusing to commit: the worktree is not on ${ref}`);
  return admin;
}

/** Feeds NUL-terminated records from streamed output to `onRecord`. */
function nulRecords(onRecord: (record: string) => void): { push: (chunk: string) => void; end: () => void } {
  let partial = "";
  return {
    push(chunk) {
      const parts = (partial + chunk).split("\0");
      partial = parts.pop() ?? "";
      for (const p of parts) onRecord(p);
    },
    end() {
      if (partial !== "") onRecord(partial);
      partial = "";
    },
  };
}

function nestedRepoError(path: string): GitError {
  return new GitError(
    `nested repository at ${path} cannot be committed; remove its .git directory or add it to .gitignore`,
  );
}

/**
 * Directories below `root` (relative, `/`-separated) that hold a `.git` entry, never following symlinks. Stops after
 * 200,000 entries or 100 candidates; it only runs after `add --all` has already failed.
 */
async function findNestedRepos(root: string): Promise<string[]> {
  const found: string[] = [];
  const stack = [""];
  let seen = 0;
  while (stack.length > 0 && found.length < 100) {
    const rel = stack.pop() as string;
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++seen > 200_000) return found;
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.name === ".git") {
        if (rel !== "") found.push(rel);
      } else if (entry.isDirectory()) {
        stack.push(child);
      }
    }
  }
  return found;
}

/**
 * Explains a failed `add --all`: git refuses outright to add a nested repository that has no commit yet, so the
 * first nested repository that is not git-ignored is named. Otherwise (an ignored one cannot be the cause) the
 * original error, with git's message, is rethrown.
 */
async function explainAddFailure(git: Git, root: string, err: unknown): Promise<never> {
  for (const candidate of await findNestedRepos(root)) {
    const res = await git(["check-ignore", "-q", "--", candidate], { okCodes: [1] }).catch(() => null);
    if (res === null) break;
    if (res.code === 1) throw nestedRepoError(candidate);
  }
  throw err;
}

/**
 * Refuses a staged gitlink (mode 160000) that is not already one at HEAD: `add --all` records a nested repository
 * that has commits as an embedded repository, which would push a dangling submodule pointer. Submodule ignore
 * settings (`.gitmodules` `ignore = all`) must not hide it.
 */
async function refuseNewGitlinks(git: Git): Promise<void> {
  let header: string | null = null;
  let found: string | null = null;
  const records = nulRecords((record) => {
    if (header === null) {
      header = record;
      return;
    }
    // Raw record: ":<old mode> <new mode> <old sha> <new sha> <status>" NUL "<path>" (renames are off).
    const [oldMode, newMode] = header.slice(1).split(" ");
    if (found === null && newMode === "160000" && oldMode !== "160000") found = record;
    header = null;
  });
  await git(["diff", "--cached", "--raw", "-z", "--no-renames", "--no-ext-diff", "--ignore-submodules=none"], {
    onStdout: records.push,
  });
  records.end();
  if (found !== null) throw nestedRepoError(found);
}

type DirListing = { exact: Map<string, boolean>; folded: Map<string, string[]> } | null;

/**
 * On a case-insensitive filesystem `add --all` cannot see a case-only rename (README -> readme): the index entry
 * still matches the file. Finds tracked paths whose on-disk spelling differs only in case and restages them under
 * the on-disk name, so the commit records a single rename. Never follows symlinks.
 */
async function stageCaseRenames(git: Git, root: string): Promise<void> {
  const tracked: string[] = [];
  // Staged entries, "<mode> <object> <stage>\t<path>": gitlinks (160000) are never restaged under another name.
  const records = nulRecords((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0 || record.startsWith("160000 ")) return;
    if (tracked.length >= MAX_TRACKED_PATHS) {
      throw new Error(`more than ${MAX_TRACKED_PATHS} tracked paths to check for case-only renames`);
    }
    tracked.push(record.slice(tab + 1));
  });
  await git(["ls-files", "-s", "-z"], { onStdout: records.push });
  records.end();

  const listings = new Map<string, DirListing>();
  const list = async (dir: string): Promise<DirListing> => {
    if (listings.has(dir)) return listings.get(dir) as DirListing;
    let listing: DirListing = null;
    try {
      const exact = new Map<string, boolean>();
      const folded = new Map<string, string[]>();
      for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
        exact.set(e.name, e.isDirectory());
        const key = e.name.toLowerCase();
        folded.set(key, [...(folded.get(key) ?? []), e.name]);
      }
      listing = { exact, folded };
    } catch {
      listing = null;
    }
    listings.set(dir, listing);
    return listing;
  };

  const renames: Array<[string, string]> = [];
  for (const path of tracked) {
    const parts = path.split("/");
    const actual: string[] = [];
    let changed = false;
    for (const [i, part] of parts.entries()) {
      const listing = await list(actual.join("/"));
      if (listing === null) break;
      let name = part;
      if (!listing.exact.has(part)) {
        // Only a pure case difference with exactly one candidate; Unicode normalization is left to git.
        const candidates = listing.folded.get(part.toLowerCase()) ?? [];
        if (candidates.length !== 1) break;
        name = candidates[0] as string;
        changed = true;
      }
      if (i < parts.length - 1 && listing.exact.get(name) !== true) break;
      actual.push(name);
    }
    if (changed && actual.length === parts.length) renames.push([path, actual.join("/")]);
  }
  // Two tracked paths that fold to the same file (A/b and a/B from a case-sensitive checkout) are left alone, as
  // plain git would leave them.
  const targets = new Map<string, number>();
  for (const [, to] of renames) targets.set(to, (targets.get(to) ?? 0) + 1);
  const trackedSet = new Set(tracked);
  const safe = renames.filter(([, to]) => targets.get(to) === 1 && !trackedSet.has(to));

  // Batched to stay well under any command-line length limit; literal pathspecs, so no name is a pattern.
  for (let i = 0; i < safe.length; ) {
    const batch: Array<[string, string]> = [];
    let bytes = 0;
    while (i < safe.length && (batch.length === 0 || bytes < 64 * 1024)) {
      const pair = safe[i++] as [string, string];
      batch.push(pair);
      bytes += pair[0].length + pair[1].length;
    }
    await git(["--literal-pathspecs", "rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...batch.map((r) => r[0])]);
    await git(["--literal-pathspecs", "add", "--force", "--", ...batch.map((r) => r[1])]);
  }
}

/**
 * Commits everything in `<cacheDir>/work/<jobId>` (tracked, modified and untracked files) onto `hoistline/<jobId>`.
 * Git runs against the mirror's own record of the worktree, with no hooks, filters from planted config or signing,
 * and through a fresh index read from the branch's commit, so nothing the runner left in the worktree's own index
 * (staged entries, assume-unchanged or skip-worktree flags) or admin dir (MERGE_HEAD, CHERRY_PICK_HEAD, message
 * files) shapes the commit. Returns `{ committed: false }` when there is nothing to commit (a runner that committed
 * itself leaves its commits on the branch). `tip` is the branch's commit after the call either way; compare it with
 * prepareWorktree's `baseSha` to tell whether the job produced anything.
 */
export async function commitWorktree(
  repo: string,
  jobId: string,
  cacheDir: string,
  opts: PrepareOptions & { message?: string } = {},
): Promise<{ committed: boolean; sha?: string; tip: string }> {
  const canonical = validateRepo(repo);
  const id = validateJobId(jobId);
  const cache = resolve(cacheDir);
  const mirror = mirrorPath(cache, canonical);
  const dir = join(cache, "work", id);
  const ref = `refs/heads/hoistline/${id}`;
  const message = opts.message ?? `hoistline: job ${id}`;
  if (typeof message !== "string" || message.length === 0) throw new Error("invalid commit message");
  const config = await mirrorConfig(cache);
  const platform = await probePlatformConfig(cache);
  const platformArgs = await platformFlags(cache);

  return withLock(mirror, async () => {
    await assertRealDir(cache);
    if (!(await exists(join(mirror, "HEAD")))) throw new Error(`refusing to commit: no mirror for ${canonical}`);
    await resetMirror(mirror, config);
    await assertRealDir(join(cache, "work")).catch(() => {
      throw new Error(`refusing to commit: ${join(cache, "work")} is not a plain directory`);
    });
    if (!(await lstatOrNull(dir))?.isDirectory()) throw new Error(`refusing to commit: no worktree at ${dir}`);
    const mgit = mirrorGit(cache, mirror, opts);
    const head = await jobBranchSha(mgit, ref, "commit");
    const admin = await findAdminDir(mirror, dir, ref);
    for (const name of COMMIT_STATE) await removeEntry(join(admin, name));

    const indexDir = await mkdtemp(join(cache, "index-"));
    try {
      const git: Git = (args, extra = {}) =>
        runGit(["--git-dir", admin, "--work-tree", dir, ...COMMIT_IDENTITY, ...platformArgs, ...args], {
          cacheDir: cache,
          allowFileProtocol: opts.allowFileProtocol,
          timeoutMs: opts.timeoutMs,
          killGraceMs: opts.killGraceMs,
          okCodes: extra.okCodes,
          onStdout: extra.onStdout,
          env: { GIT_DIR: admin, GIT_COMMON_DIR: mirror, GIT_WORK_TREE: dir, GIT_INDEX_FILE: join(indexDir, "index") },
        });
      await git(["read-tree", head]);
      await git(["add", "--all"]).catch((err: unknown) => explainAddFailure(git, dir, err));
      await refuseNewGitlinks(git);
      if (platform.ignorecase === "true") {
        await stageCaseRenames(git, dir);
        await refuseNewGitlinks(git);
      }
      // Exit code only: listing the staged paths could exceed any output buffer.
      const { code } = await git(
        ["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none"],
        { okCodes: [1] },
      );
      if (code === 0) return { committed: false, tip: head };
      await git(["commit", "--quiet", "--no-verify", "-m", message]);
      const sha = (await mgit(["rev-parse", "--verify", "--end-of-options", ref])).stdout.trim();
      return { committed: true, sha, tip: sha };
    } finally {
      await rm(indexDir, { recursive: true, force: true });
    }
  });
}
