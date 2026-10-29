import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { JobSpec } from "@hoistline/protocol";
import { buildCommand } from "./template.js";

/** The runner's executable was not found on PATH. */
export class RunnerNotInstalledError extends Error {
  constructor(readonly file: string) {
    super(`runner_not_installed: ${file}`);
    this.name = "RunnerNotInstalledError";
  }
}

/** The OS refused to start the runner for a reason other than a missing executable (EACCES, E2BIG, a NUL, ...). */
export class RunnerSpawnError extends Error {
  constructor(reason: string, cause: unknown) {
    super(`runner_spawn_failed: ${reason}`, { cause });
    this.name = "RunnerSpawnError";
  }
}

export type RunJobOptions = {
  /** Maximum runtime before the runner is killed and the result is exit code 124. Default 60 minutes. */
  timeoutMs?: number;
  /** On abort or timeout: time between SIGTERM and SIGKILL to the process group. Default 1.5 s. */
  termGraceMs?: number;
  /**
   * After the runner exits: time between SIGTERM and SIGKILL to whatever is left in its process group. Default
   * min(termGraceMs, 1 s).
   */
  postExitGraceMs?: number;
  /** After the process group is gone, how long to wait for the output pipes to close before closing them. Default 5 s. */
  killGraceMs?: number;
};

export type RunJobResult = {
  /** The exit code; 128 + the signal number when killed by a signal; 124 on timeout. */
  exitCode: number;
  /** The maximum runtime was reached and the runner was killed. */
  timedOut?: boolean;
  /** The abort signal fired (or was already aborted, in which case nothing ran and exitCode is 130). */
  aborted?: boolean;
  /** How many onOutput calls threw. Those exceptions are swallowed so a bad callback cannot hang or crash a job. */
  outputErrors?: number;
};

export type OutputStream = "stdout" | "stderr";

const MAX_CHUNK_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TERM_GRACE_MS = 1500;
const DEFAULT_KILL_GRACE_MS = 5000;
/** After the post-exit SIGKILL, how long to wait for the group to disappear before giving up on it. */
const REAP_WAIT_MS = 1000;
const REAP_POLL_MS = 25;
const TIMEOUT_EXIT_CODE = 124;
const ABORTED_BEFORE_START_EXIT_CODE = 130;
const windows = process.platform === "win32";

/**
 * The runner's environment: the owner's own (the CLIs need their logins), minus every GIT_* variable (the agent's
 * git pinning, an inherited GIT_DIR) and every HOISTLINE_* variable. Case-insensitive, for Windows.
 */
function runnerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("GIT_") || upper.startsWith("HOISTLINE_")) continue;
    env[key] = value;
  }
  return env;
}

/** Calls deliver with pieces of text of at most 16 KiB of UTF-8 each, never splitting a character. */
function emitChunks(text: string, deliver: (chunk: string) => void): void {
  if (text.length === 0) return;
  // One UTF-16 code unit is at most 3 UTF-8 bytes (a surrogate pair is 2 units and 4 bytes).
  if (text.length * 3 <= MAX_CHUNK_BYTES) return deliver(text);
  const bytes = Buffer.from(text, "utf8");
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + MAX_CHUNK_BYTES, bytes.length);
    // Back up off UTF-8 continuation bytes so the cut falls between characters.
    while (end < bytes.length && end > start && ((bytes[end] as number) & 0xc0) === 0x80) end--;
    deliver(bytes.toString("utf8", start, end));
    start = end;
  }
}

/** Sends a signal to the whole process group led by pid. Returns false once the group no longer exists. */
function signalGroup(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, sig);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Windows has no process groups: taskkill /T walks the tree (best effort once the root has exited). */
function taskkillTree(pid: number): void {
  execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
}

function exitCodeOf(code: number | null, sig: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (sig !== null) return 128 + (constants.signals[sig] ?? 0);
  return 1;
}

/**
 * Runs one job's runner in the real path of `dir` and streams its output. Resolves with the exit code; a nonzero
 * exit, a signal, an abort or a timeout is a value, never an exception. When the runner exits, everything left in
 * its process group is stopped (SIGTERM, then SIGKILL) before the promise resolves. Throws
 * RunnerNotInstalledError when the CLI is not on PATH, PromptTooLargeError (from the adapter) for a prompt the CLI
 * cannot take, RunnerSpawnError for any other failure to start, and a plain Error for a `dir` that is not a
 * directory.
 *
 * runJob keeps no output: every chunk goes to onOutput and nowhere else, so the caller must enforce any size cap
 * (such as the task_result cap) on what it keeps.
 */
export async function runJob(
  spec: JobSpec,
  dir: string,
  onOutput: (chunk: string, stream: OutputStream) => void,
  signal: AbortSignal,
  opts: RunJobOptions = {},
): Promise<RunJobResult> {
  if (signal.aborted) return { exitCode: ABORTED_BEFORE_START_EXIT_CODE, aborted: true };
  // Resolve symlinks once, so the runner's cwd and its workspace flag name the same real directory. Node reports a
  // missing cwd as ENOENT too; checking here keeps that from being mistaken for a missing runner.
  const real = await realpath(dir).catch(() => null);
  const info = real === null ? null : await stat(real).catch(() => null);
  if (real === null || !info?.isDirectory()) throw new Error(`working directory ${dir} is not a directory`);
  const cmd = buildCommand(spec, { cwd: real });
  if (signal.aborted) return { exitCode: ABORTED_BEFORE_START_EXIT_CODE, aborted: true };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const termGraceMs = opts.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const postExitGraceMs = opts.postExitGraceMs ?? Math.min(termGraceMs, 1000);
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(cmd.file, cmd.args, {
      cwd: real,
      env: runnerEnv(),
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: cmd.verbatimArgs === true,
      // Its own process group on POSIX, so a kill reaches everything the runner started (unless it left the group).
      detached: !windows,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    // spawn throws synchronously for arguments it cannot pass at all (for example a NUL character).
    throw new RunnerSpawnError((err as NodeJS.ErrnoException).code ?? (err as Error).message, err);
  }

  return new Promise<RunJobResult>((resolve, reject) => {
    let settled = false;
    let stopped: "aborted" | "timedOut" | null = null;
    let exited: { code: number | null; sig: NodeJS.Signals | null } | null = null;
    let closed = false;
    let pipesDestroyed = false;
    let groupDone = false;
    let outputErrors = 0;
    let pipeGrace: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;
    let reapKilledAt: number | null = null;
    let reapDeadline = 0;

    const sink = (stream: OutputStream) => {
      const decoder = new StringDecoder("utf8");
      const deliver = (chunk: string) => {
        try {
          onOutput(chunk, stream);
        } catch {
          outputErrors++;
        }
      };
      return {
        write: (buf: Buffer) => emitChunks(decoder.write(buf), deliver),
        end: () => emitChunks(decoder.end(), deliver),
      };
    };
    const out = sink("stdout");
    const err = sink("stderr");
    child.stdout.on("data", (b: Buffer) => out.write(b));
    child.stderr.on("data", (b: Buffer) => err.write(b));

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(pipeGrace);
      clearTimeout(reapTimer);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled || exited === null || !groupDone || !(closed || pipesDestroyed)) return;
      cleanup();
      out.end();
      err.end();
      const result: RunJobResult = {
        exitCode: stopped === "timedOut" ? TIMEOUT_EXIT_CODE : exitCodeOf(exited.code, exited.sig),
      };
      if (stopped === "timedOut") result.timedOut = true;
      if (stopped === "aborted") result.aborted = true;
      if (outputErrors > 0) result.outputErrors = outputErrors;
      resolve(result);
    };
    const destroyPipes = () => {
      clearTimeout(pipeGrace);
      child.stdout.destroy();
      child.stderr.destroy();
      pipesDestroyed = true;
      finish();
    };
    const groupGone = () => {
      if (settled) return;
      groupDone = true;
      clearTimeout(reapTimer);
      // Something outside the group (a descendant in a new session) can still hold the pipes, and then "close" never
      // comes. Stop waiting for it after a bounded grace; an abort or timeout stops waiting at once.
      if (stopped !== null) return destroyPipes();
      pipeGrace = setTimeout(destroyPipes, killGraceMs);
      finish();
    };
    // After the leader exits: SIGTERM what is left of the group, SIGKILL it after postExitGraceMs (at once after an
    // abort or timeout), and wait until the group is gone, at most REAP_WAIT_MS after the SIGKILL.
    const reapStep = () => {
      if (settled || groupDone || child.pid === undefined) return;
      if (!signalGroup(child.pid, 0)) return groupGone();
      const now = Date.now();
      if (reapKilledAt === null && (now >= reapDeadline || stopped !== null)) {
        signalGroup(child.pid, "SIGKILL");
        reapKilledAt = now;
      } else if (reapKilledAt !== null && now - reapKilledAt >= REAP_WAIT_MS) {
        return groupGone();
      }
      reapTimer = setTimeout(reapStep, REAP_POLL_MS);
    };
    const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
      if (exited !== null) return;
      exited = { code, sig };
      if (child.pid === undefined) return groupGone();
      if (windows) {
        taskkillTree(child.pid);
        return groupGone();
      }
      if (!signalGroup(child.pid, "SIGTERM")) return groupGone();
      reapDeadline = Date.now() + postExitGraceMs;
      reapStep();
    };

    const stop = (why: "aborted" | "timedOut") => {
      if (settled || stopped !== null) return;
      stopped = why;
      if (exited === null) {
        if (child.pid === undefined) return;
        if (windows) return taskkillTree(child.pid);
        signalGroup(child.pid, "SIGTERM");
        const pid = child.pid;
        // Runs even if the leader exits first: a descendant in the group may ignore SIGTERM.
        setTimeout(() => signalGroup(pid, "SIGKILL"), termGraceMs).unref();
      } else if (!groupDone) {
        // Leader gone, group still being stopped: escalate to SIGKILL now.
        clearTimeout(reapTimer);
        reapStep();
      } else {
        // Only the pipes are left, held by something outside the group: stop waiting for them.
        destroyPipes();
      }
    };
    const onAbort = () => stop("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop("timedOut"), timeoutMs);

    child.on("error", (e: NodeJS.ErrnoException) => {
      // Only a failure to start rejects; anything after that is reported through exit/close.
      if (settled || child.pid !== undefined) return;
      cleanup();
      reject(e.code === "ENOENT" ? new RunnerNotInstalledError(cmd.file) : new RunnerSpawnError(e.code ?? e.message, e));
    });
    child.on("exit", onExit);
    child.on("close", (code, sig) => {
      closed = true;
      onExit(code, sig);
      finish();
    });

    // EPIPE when the runner exits without reading its stdin is not an error of the job.
    child.stdin.on("error", () => undefined);
    child.stdin.end(cmd.stdin ?? "");
  });
}
