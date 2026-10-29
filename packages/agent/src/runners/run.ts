import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
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

export type RunJobOptions = {
  /** Maximum runtime before the runner is killed and the result is exit code 124. Default 60 minutes. */
  timeoutMs?: number;
  /** On abort or timeout: time between SIGTERM and SIGKILL to the process group. Default 2 s. */
  termGraceMs?: number;
  /** After the runner exits, how long to wait for its output pipes to close before closing them. Default 5 s. */
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
const DEFAULT_TERM_GRACE_MS = 2000;
const DEFAULT_KILL_GRACE_MS = 5000;
const TIMEOUT_EXIT_CODE = 124;
const ABORTED_BEFORE_START_EXIT_CODE = 130;

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

/** SIGTERM to the runner's whole process group, then SIGKILL after the grace. Windows: taskkill /T /F. */
function terminate(pid: number | undefined, termGraceMs: number): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // The group is gone.
    }
  };
  signalGroup("SIGTERM");
  // Runs even if the leader exits first: a descendant in the group may ignore SIGTERM.
  setTimeout(() => signalGroup("SIGKILL"), termGraceMs).unref();
}

function exitCodeOf(code: number | null, sig: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (sig !== null) return 128 + (constants.signals[sig] ?? 0);
  return 1;
}

/**
 * Runs one job's runner in `dir` and streams its output. Resolves with the exit code; a nonzero exit, a signal, an
 * abort or a timeout is a value, never an exception. Throws RunnerNotInstalledError when the CLI is not on PATH,
 * and a plain Error for any other failure to start (a missing `dir`, an argument list the OS refuses).
 */
export async function runJob(
  spec: JobSpec,
  dir: string,
  onOutput: (chunk: string, stream: OutputStream) => void,
  signal: AbortSignal,
  opts: RunJobOptions = {},
): Promise<RunJobResult> {
  if (signal.aborted) return { exitCode: ABORTED_BEFORE_START_EXIT_CODE, aborted: true };
  const cmd = buildCommand(spec, { cwd: dir });
  // Node reports a missing cwd as ENOENT too; check it first so it is not mistaken for a missing runner.
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`working directory ${dir} is not a directory`);
  if (signal.aborted) return { exitCode: ABORTED_BEFORE_START_EXIT_CODE, aborted: true };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const termGraceMs = opts.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise<RunJobResult>((resolve, reject) => {
    const child = spawn(cmd.file, cmd.args, {
      cwd: dir,
      env: runnerEnv(),
      shell: false,
      windowsHide: true,
      // Its own process group on POSIX, so an abort or timeout reaches everything the runner started.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    let stopped: "aborted" | "timedOut" | null = null;
    let exited: { code: number | null; sig: NodeJS.Signals | null } | null = null;
    let outputErrors = 0;
    let pipeGrace: NodeJS.Timeout | undefined;

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
      signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      cleanup();
      out.end();
      err.end();
      const result: RunJobResult = {
        exitCode: stopped === "timedOut" ? TIMEOUT_EXIT_CODE : exitCodeOf(exited?.code ?? null, exited?.sig ?? null),
      };
      if (stopped === "timedOut") result.timedOut = true;
      if (stopped === "aborted") result.aborted = true;
      if (outputErrors > 0) result.outputErrors = outputErrors;
      resolve(result);
    };
    const stop = (why: "aborted" | "timedOut") => {
      if (settled || stopped !== null || exited !== null) return;
      stopped = why;
      terminate(child.pid, termGraceMs);
    };
    const onAbort = () => stop("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop("timedOut"), timeoutMs);

    child.on("error", (e: NodeJS.ErrnoException) => {
      // Only a failure to start rejects; anything after that is reported through exit/close.
      if (settled || child.pid !== undefined) return;
      cleanup();
      reject(e.code === "ENOENT" ? new RunnerNotInstalledError(cmd.file) : e);
    });
    child.on("exit", (code, sig) => {
      exited = { code, sig };
      clearTimeout(timer);
      // A descendant that left the process group can hold the pipes open, and then "close" never comes. Stop
      // waiting for it after a bounded grace.
      pipeGrace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish();
      }, killGraceMs);
    });
    child.on("close", (code, sig) => {
      exited ??= { code, sig };
      finish();
    });

    // EPIPE when the runner exits without reading its stdin is not an error of the job.
    child.stdin.on("error", () => undefined);
    child.stdin.end(cmd.stdin ?? "");
  });
}
