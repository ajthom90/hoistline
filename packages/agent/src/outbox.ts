import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { AgentToHub } from "@hoistline/protocol";
import { validateJobId } from "./git.js";

export type JobResult = Extract<AgentToHub, { type: "job.result" }>;

/** Most results kept waiting for an acknowledgement; past this the oldest is dropped. */
export const OUTBOX_MAX_ENTRIES = 1000;
/** Unacknowledged results older than this are dropped: the hub has long given up on the job. */
export const OUTBOX_RETENTION_MS = 24 * 3600_000;
/** A result is at most ~1 MiB of output plus small fields; anything much larger is not ours. */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const ENTRY = /^(.+)\.json$/;

export type OutboxOptions = {
  maxEntries?: number;
  now?: () => number;
  /** Called for every result dropped without an acknowledgement. */
  onDrop?: (jobId: string, why: "overflow" | "expired") => void;
};

function isJobId(id: string): boolean {
  try {
    validateJobId(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Final job results the hub has not acknowledged yet, one file `<cacheDir>/outbox/<jobId>.json` each (mode 0600, in a
 * real directory of mode 0700, created exclusively and never through a symlink). A result is stored before it is
 * first sent and removed when the hub's job.ack arrives, so a result produced while the hub is unreachable, or lost
 * on the way, is sent again after the next connection, also by a later process.
 *
 * Reads never throw: an outbox that cannot be used is empty. `put` throws when the result cannot be stored.
 */
export class Outbox {
  private readonly dir: string;
  private readonly max: number;
  private readonly now: () => number;
  private readonly onDrop?: OutboxOptions["onDrop"];
  /** jobId -> savedAt, in insertion (oldest first) order. */
  private readonly index = new Map<string, number>();

  constructor(cacheDir: string, opts: OutboxOptions = {}) {
    this.dir = join(cacheDir, "outbox");
    this.max = Math.max(1, opts.maxEntries ?? OUTBOX_MAX_ENTRIES);
    this.now = opts.now ?? Date.now;
    this.onDrop = opts.onDrop;
    this.load();
  }

  /** Stores `result`, replacing an earlier entry for the same job, then drops the oldest past maxEntries. */
  put(result: JobResult): void {
    const jobId = validateJobId(result.jobId);
    this.ensureDir();
    const path = this.path(jobId);
    if (this.index.has(jobId)) this.unlinkQuietly(path);
    const savedAt = this.now();
    const data = Buffer.from(JSON.stringify({ savedAt, result }), "utf8");
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    try {
      let off = 0;
      while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    } catch (err) {
      closeSync(fd);
      this.unlinkQuietly(path);
      throw err;
    }
    closeSync(fd);
    this.index.delete(jobId);
    this.index.set(jobId, savedAt);
    while (this.index.size > this.max) {
      const oldest = this.index.keys().next().value!;
      this.drop(oldest, "overflow");
    }
  }

  has(jobId: string): boolean {
    return this.index.has(jobId);
  }

  /** Job ids with a stored result, oldest first. */
  ids(): string[] {
    return [...this.index.keys()];
  }

  /** The stored results, oldest first. An entry that no longer reads back as a valid result is discarded. */
  entries(): JobResult[] {
    const out: JobResult[] = [];
    for (const jobId of this.ids()) {
      const entry = this.read(jobId);
      if (entry) out.push(entry.result);
      else this.forget(jobId);
    }
    return out;
  }

  remove(jobId: string): void {
    if (this.index.has(jobId)) this.forget(jobId);
  }

  /** Drops results older than 24 hours. */
  prune(): void {
    const cutoff = this.now() - OUTBOX_RETENTION_MS;
    for (const [jobId, savedAt] of [...this.index]) {
      if (savedAt < cutoff) this.drop(jobId, "expired");
    }
  }

  private path(jobId: string): string {
    return join(this.dir, `${jobId}.json`);
  }

  private realDir(): boolean {
    try {
      const st = lstatSync(this.dir);
      return st.isDirectory() && !st.isSymbolicLink();
    } catch {
      return false;
    }
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!this.realDir()) throw new Error(`refusing to use ${this.dir}: not a plain directory`);
    if (process.platform !== "win32") chmodSync(this.dir, 0o700);
  }

  private load(): void {
    if (!this.realDir()) return;
    const found: [string, number][] = [];
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const jobId = ENTRY.exec(name)?.[1];
      if (jobId === undefined || !isJobId(jobId)) continue;
      const entry = this.read(jobId);
      if (entry) found.push([jobId, entry.savedAt]);
      else this.unlinkQuietly(this.path(jobId));
    }
    found.sort((a, b) => a[1] - b[1]);
    for (const [jobId, savedAt] of found) this.index.set(jobId, savedAt);
    this.prune();
    while (this.index.size > this.max) this.drop(this.index.keys().next().value!, "overflow");
  }

  /** Reads and validates one entry; null when it is missing, not a regular file, or not a result for `jobId`. */
  private read(jobId: string): { savedAt: number; result: JobResult } | null {
    let fd: number | undefined;
    try {
      fd = openSync(this.path(jobId), constants.O_RDONLY | O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_ENTRY_BYTES) return null;
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = readSync(fd, buf, off, st.size - off, off);
        if (n === 0) break;
        off += n;
      }
      const parsed = JSON.parse(buf.subarray(0, off).toString("utf8")) as { savedAt?: unknown; result?: unknown };
      const result = AgentToHub.safeParse(parsed?.result);
      if (typeof parsed?.savedAt !== "number" || !Number.isFinite(parsed.savedAt)) return null;
      if (!result.success || result.data.type !== "job.result" || result.data.jobId !== jobId) return null;
      return { savedAt: parsed.savedAt, result: result.data };
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private drop(jobId: string, why: "overflow" | "expired"): void {
    this.forget(jobId);
    try {
      this.onDrop?.(jobId, why);
    } catch {
      // An observer must not break the outbox.
    }
  }

  private forget(jobId: string): void {
    this.index.delete(jobId);
    if (this.realDir()) this.unlinkQuietly(this.path(jobId));
  }

  private unlinkQuietly(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }
}
