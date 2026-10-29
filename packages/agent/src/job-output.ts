import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { AgentToHub } from "@hoistline/protocol";
import { validateJobId } from "./git.js";
import type { OutputStream } from "./runners/index.js";

const KiB = 1024;
/** Largest `data` of one job.event. */
export const MAX_EVENT_BYTES = 16 * KiB;
/** Output is held at most this long before it is sent... */
export const EVENT_WINDOW_MS = 100;
/** ...or until this much is waiting. */
export const MAX_PENDING_BYTES = 48 * KiB;
/** Default limit on the output streamed as events for one job; the rest only reaches the log and the result tail. */
export const DEFAULT_EVENT_CAP_BYTES = 2 * 1024 * KiB;
export const DEFAULT_LOG_MAX_BYTES = 50 * 1024 * KiB;
export const LOG_RETENTION_MS = 7 * 24 * 3600_000;

export type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/** The longest prefix of `buf` of at most `max` bytes that does not end inside a UTF-8 character. */
function headEnd(buf: Buffer, max: number): number {
  if (buf.length <= max) return buf.length;
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return end;
}

/** The longest suffix of `text` of at most `max` UTF-8 bytes that starts at a character boundary. */
export function utf8Tail(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  let start = buf.length - max;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

/**
 * Streams a job's output as job.event messages: chunks are coalesced over a short window (adjacent chunks of the
 * same stream merge), each event carries at most 16 KiB, and once `capBytes` have been sent nothing more is.
 * Send failures are swallowed: losing live output must never fail the job.
 */
export class EventStreamer {
  private pending: { stream: OutputStream; data: string }[] = [];
  private pendingBytes = 0;
  private sentBytes = 0;
  private timer: unknown = undefined;
  private isCapped = false;
  private closed = false;
  private readonly capBytes: number;

  constructor(
    private readonly jobId: string,
    private readonly send: (msg: AgentToHub) => void,
    private readonly timers: Timers & { capBytes?: number },
  ) {
    this.capBytes = timers.capBytes ?? DEFAULT_EVENT_CAP_BYTES;
  }

  push(chunk: string, stream: OutputStream): void {
    if (this.closed || this.isCapped || chunk.length === 0) return;
    const last = this.pending.at(-1);
    if (last?.stream === stream) last.data += chunk;
    else this.pending.push({ stream, data: chunk });
    this.pendingBytes += Buffer.byteLength(chunk);
    if (this.pendingBytes >= MAX_PENDING_BYTES) this.flush();
    else if (this.timer === undefined) this.timer = this.timers.setTimeout(() => this.flush(), EVENT_WINDOW_MS);
  }

  /** Sends whatever is waiting. */
  flush(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const pending = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const { stream, data } of pending) {
      let buf = Buffer.from(data, "utf8");
      while (buf.length > 0 && !this.isCapped) {
        const room = this.capBytes - this.sentBytes;
        if (room <= 0) {
          this.isCapped = true;
          break;
        }
        const end = headEnd(buf, Math.min(MAX_EVENT_BYTES, room));
        if (end === 0) {
          this.isCapped = true;
          break;
        }
        this.sentBytes += end;
        const piece = buf.subarray(0, end).toString("utf8");
        buf = buf.subarray(end);
        try {
          this.send({ type: "job.event", jobId: this.jobId, stream, data: piece });
        } catch {
          // Not connected: live output is best effort.
        }
      }
    }
  }

  /** True once output was held back because the cap was reached. */
  get capped(): boolean {
    return this.isCapped;
  }

  /** Flushes and stops; later pushes are ignored. */
  close(): void {
    this.flush();
    this.closed = true;
  }
}

/** Keeps the last `maxBytes` of a job's output. */
export class OutputTail {
  private chunks: string[] = [];
  private bytes: number[] = [];
  private total = 0;
  private seen = 0;

  constructor(private readonly maxBytes: number) {}

  /** True once more than `maxBytes` were pushed, so text() is not the whole output. */
  get truncated(): boolean {
    return this.seen > this.maxBytes;
  }

  push(chunk: string): void {
    if (chunk.length === 0) return;
    const n = Buffer.byteLength(chunk);
    this.seen += n;
    this.chunks.push(chunk);
    this.bytes.push(n);
    this.total += n;
    // Drop whole chunks that are no longer needed for the tail.
    while (this.chunks.length > 1 && this.total - this.bytes[0]! >= this.maxBytes) {
      this.total -= this.bytes.shift()!;
      this.chunks.shift();
    }
  }

  text(): string {
    const joined = this.chunks.join("");
    this.chunks = joined ? [joined] : [];
    this.bytes = joined ? [this.total] : [];
    return utf8Tail(joined, this.maxBytes);
  }
}

export type JobLog = { write(chunk: string): void; close(): void };

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Opens `<dir>/<jobId>.log` for a job's full output: a new file (never an existing one or a symlink), mode 0600, in
 * a real directory of mode 0700, capped at `maxBytes`. Logs older than seven days are pruned first. Returns null
 * when the log cannot be opened safely; a job runs the same without one. Never throws.
 */
export function openJobLog(
  dir: string,
  jobId: string,
  opts: { maxBytes?: number; now?: () => number } = {},
): JobLog | null {
  try {
    validateJobId(jobId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    if (process.platform !== "win32") chmodSync(dir, 0o700);
    pruneLogs(dir, (opts.now ?? Date.now)() - LOG_RETENTION_MS);
    const fd = openSync(
      join(dir, `${jobId}.log`),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    const max = opts.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
    let written = 0;
    let open = true;
    const close = () => {
      if (!open) return;
      open = false;
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    };
    return {
      write(chunk: string) {
        if (!open || written >= max) return;
        const buf = Buffer.from(chunk, "utf8");
        const end = headEnd(buf, max - written);
        if (end === 0) return;
        try {
          let off = 0;
          while (off < end) off += writeSync(fd, buf, off, end - off);
          written += end;
        } catch {
          close();
        }
      },
      close,
    };
  } catch {
    return null;
  }
}

function pruneLogs(dir: string, cutoff: number): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
    try {
      const path = join(dir, entry.name);
      const st = lstatSync(path);
      if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(path);
    } catch {
      // Gone already or not ours to remove.
    }
  }
}

/**
 * Keeps `<dir>/*.log` within bounds: logs older than seven days go first, then the oldest logs until the total size
 * is at most `maxTotalBytes`. Logs of the jobs in `keep` (by job id) are never removed, though they count toward the
 * total. Only regular files directly in a real directory are considered. Never throws.
 */
export function enforceLogBudget(
  dir: string,
  opts: { maxTotalBytes: number; now: number; keep: ReadonlySet<string>; retentionMs?: number },
): void {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return;
    const cutoff = opts.now - (opts.retentionMs ?? LOG_RETENTION_MS);
    const logs: { path: string; size: number; mtimeMs: number; kept: boolean }[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
      try {
        const path = join(dir, entry.name);
        const fst = lstatSync(path);
        if (!fst.isFile()) continue;
        logs.push({ path, size: fst.size, mtimeMs: fst.mtimeMs, kept: opts.keep.has(entry.name.slice(0, -4)) });
      } catch {
        // Gone already.
      }
    }
    logs.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = logs.reduce((n, l) => n + l.size, 0);
    for (const log of logs) {
      if (log.kept || (log.mtimeMs >= cutoff && total <= opts.maxTotalBytes)) continue;
      try {
        unlinkSync(log.path);
        total -= log.size;
      } catch {
        // Not ours to remove, or gone already.
      }
    }
  } catch {
    // Missing or unreadable: nothing to enforce.
  }
}
