import { timingSafeEqual } from "node:crypto";
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
import { dirname, join } from "node:path";
import { JobSpecSchema, type JobSpec } from "@hoistline/protocol";
import { z } from "zod";
import { specHash as hashOfSpec, type ApprovalRequest } from "./executor.js";
import { validateJobId } from "./git.js";

/*
 * The local approval queue. A job the policy marks `ask` writes `<dir>/pending/<jobId>.json` and waits for
 * `<dir>/decisions/<jobId>.json`, which `hoistline-agent approvals approve|deny` writes.
 *
 * Threat model: approval is local to the owner's OS account. Any process running as that user can write a decision,
 * and that is by definition the owner (such a process can also edit the policy file). Everything else is refused:
 * files are created 0600 in 0700 directories, symbolic links are never followed, reads are bounded and strictly
 * validated, and an approval counts only for the exact spec it names (its full sha256 spec hash).
 */

export type PendingApproval = {
  jobId: string;
  userId: string;
  /** Exactly what runs if approved. */
  spec: JobSpec;
  /** Why the policy asked. */
  reason: string;
  specHash: string;
  createdAt: number;
};

export type ApprovalDecision = "approve" | "deny";

export type ApprovalQueue = {
  /** The executor's `requestApproval`. Resolves true only for an approval of this exact spec. Never throws. */
  requestApproval(req: ApprovalRequest): Promise<boolean>;
  /** Valid pending requests, oldest first. Invalid files are removed. */
  list(): PendingApproval[];
  show(jobId: string): PendingApproval | null;
  /** Records the owner's answer. Throws for an unknown job, a hash other than the request's, or a second answer. */
  decide(jobId: string, decision: ApprovalDecision, specHash: string): void;
  /** Removes decisions older than an hour and orphaned pending requests older than a day. */
  prune(): void;
  /** Every waiting request resolves false and its files are removed; later requests resolve false. */
  close(): void;
};

export type ApprovalQueueOptions = {
  /** `<agentHome>/approvals`. */
  dir: string;
  now?: () => number;
  /** Default 500 ms. */
  pollIntervalMs?: number;
  /** How long a request waits for an answer. Default one hour. */
  ttlMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Called with every error requestApproval swallows. */
  onError?: (err: unknown) => void;
};

const MAX_PENDING_BYTES = 64 * 1024;
const MAX_DECISION_BYTES = 4 * 1024;
const DEFAULT_TTL_MS = 3600_000;
const DECISION_MAX_AGE_MS = 3600_000;
const PENDING_MAX_AGE_MS = 24 * 3600_000;
/** Timestamps this far in the future are invalid (they would never be pruned). */
const CLOCK_SKEW_MS = 60_000;

const HASH = /^[0-9a-f]{64}$/;
const JobIdSchema = z.string().refine((id) => isJobId(id), "invalid job id");

const PendingSchema = z
  .object({
    jobId: JobIdSchema,
    userId: z.string().min(1).max(200),
    spec: JobSpecSchema,
    reason: z.string().max(10_000),
    specHash: z.string().regex(HASH),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

const DecisionSchema = z
  .object({
    jobId: JobIdSchema,
    decision: z.enum(["approve", "deny"]),
    specHash: z.string().regex(HASH),
    decidedAt: z.number().int().nonnegative(),
  })
  .strict();
type DecisionFile = z.infer<typeof DecisionSchema>;

function isJobId(id: unknown): id is string {
  try {
    validateJobId(id as string);
    return true;
  } catch {
    return false;
  }
}

/** Constant-time comparison of two full lowercase sha256 hex strings. */
function sameHash(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !HASH.test(a) || !HASH.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Creates (0700) or checks a directory: it must be a real directory owned by this user, never a symbolic link. */
function ensureDir(path: string, create: boolean): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw err;
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    st = lstatSync(path);
  }
  if (st.isSymbolicLink()) throw new Error(`refusing ${path}: it is a symbolic link`);
  if (!st.isDirectory()) throw new Error(`refusing ${path}: not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`refusing ${path}: owned by another user`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

/** Creates `path` exclusively (0600), never through a symbolic link. Throws EEXIST when anything is already there. */
function writeExclusive(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
  try {
    const buf = Buffer.from(content);
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
}

type ReadResult = { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; text: string };

/** Reads a regular file of at most `max` bytes without following a symbolic link; anything else is invalid. */
function readBounded(path: string, max: number): ReadResult {
  let fd: number;
  try {
    // O_NONBLOCK: a FIFO planted here must not block the open.
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return { kind: "invalid" };
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return { kind: "invalid" };
    const buf = Buffer.alloc(max + 1);
    let len = 0;
    for (;;) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
      if (len > max) return { kind: "invalid" };
    }
    return { kind: "ok", text: buf.subarray(0, len).toString("utf8") };
  } catch {
    return { kind: "invalid" };
  } finally {
    closeSync(fd);
  }
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove.
  }
}

function parseJson<T>(schema: z.ZodType<T>, text: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function defaultSetTimeout(fn: () => void, ms: number): unknown {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
}

type Waiter = { finish: (approved: boolean) => void };

export function createApprovalQueue(opts: ApprovalQueueOptions): ApprovalQueue {
  const { dir } = opts;
  const pendingDir = join(dir, "pending");
  const decisionsDir = join(dir, "decisions");
  const now = opts.now ?? Date.now;
  const pollMs = Math.max(1, opts.pollIntervalMs ?? 500);
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const setT = opts.setTimeout ?? defaultSetTimeout;
  const clearT = opts.clearTimeout ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  const active = new Map<string, Waiter>();
  let closed = false;

  const report = (err: unknown) => {
    try {
      opts.onError?.(err);
    } catch {
      // A failing hook must not break the queue.
    }
  };

  function ensureDirs(create: boolean): boolean {
    if (create) mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    try {
      ensureDir(dir, create);
    } catch (err) {
      if (!create && (err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    ensureDir(pendingDir, true);
    ensureDir(decisionsDir, true);
    return true;
  }

  const pendingPath = (jobId: string) => join(pendingDir, `${validateJobId(jobId)}.json`);
  const decisionPath = (jobId: string) => join(decisionsDir, `${validateJobId(jobId)}.json`);

  /** A valid pending request, or null (an invalid file is removed). */
  function readPending(jobId: string): PendingApproval | null {
    const path = pendingPath(jobId);
    const r = readBounded(path, MAX_PENDING_BYTES);
    if (r.kind === "missing") return null;
    const p = r.kind === "ok" ? parseJson(PendingSchema, r.text) : null;
    if (!p || p.jobId !== jobId || p.spec.jobId !== jobId || !sameHash(p.specHash, hashOfSpec(p.spec))) {
      removeFile(path);
      return null;
    }
    if (p.createdAt > now() + CLOCK_SKEW_MS) {
      removeFile(path);
      return null;
    }
    return p as PendingApproval;
  }

  /** A valid decision, or null (an invalid file is removed). */
  function readDecision(jobId: string): DecisionFile | null {
    const path = decisionPath(jobId);
    const r = readBounded(path, MAX_DECISION_BYTES);
    if (r.kind === "missing") return null;
    const d = r.kind === "ok" ? parseJson(DecisionSchema, r.text) : null;
    if (!d || d.jobId !== jobId || d.decidedAt > now() + CLOCK_SKEW_MS) {
      removeFile(path);
      return null;
    }
    return d;
  }

  function jobIdsIn(path: string): string[] {
    return readdirSync(path)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .filter(isJobId);
  }

  async function requestApproval(req: ApprovalRequest): Promise<boolean> {
    try {
      if (closed) return false;
      const { jobId, userId, spec, reason, specHash, signal } = req;
      validateJobId(jobId);
      if (signal?.aborted) return false;
      if (active.has(jobId)) throw new Error(`job ${jobId} is already awaiting approval`);
      const pending: PendingApproval = { jobId, userId, spec: { ...spec }, reason, specHash, createdAt: now() };
      const parsed = PendingSchema.safeParse(pending);
      if (!parsed.success || spec.jobId !== jobId || !sameHash(specHash, hashOfSpec(spec))) {
        throw new Error(`invalid approval request for job ${jobId}`);
      }
      const text = `${JSON.stringify(parsed.data)}\n`;
      if (Buffer.byteLength(text) > MAX_PENDING_BYTES) {
        throw new Error(`approval request for job ${jobId} is too large to review (over ${MAX_PENDING_BYTES} bytes)`);
      }
      ensureDirs(true);
      const pPath = pendingPath(jobId);
      const dPath = decisionPath(jobId);
      // Exclusive: a request already pending for this job (in any process) is never replaced.
      writeExclusive(pPath, text);
      // A decision cannot come before its request: anything already there is stale.
      removeFile(dPath);

      return await new Promise<boolean>((resolve) => {
        let timer: unknown;
        let done = false;
        const onAbort = () => finish(false);
        const deadline = pending.createdAt + ttlMs;
        function finish(approved: boolean): void {
          if (done) return;
          done = true;
          if (timer !== undefined) clearT(timer);
          signal?.removeEventListener("abort", onAbort);
          active.delete(jobId);
          removeFile(pPath);
          removeFile(dPath);
          resolve(approved);
        }
        function poll(): void {
          timer = undefined;
          if (done) return;
          try {
            const d = readDecision(jobId);
            if (d) return finish(d.decision === "approve" && sameHash(d.specHash, specHash));
            if (now() >= deadline) return finish(false);
          } catch (err) {
            report(err);
            return finish(false);
          }
          timer = setT(poll, pollMs);
        }
        active.set(jobId, { finish });
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setT(poll, Math.min(pollMs, Math.max(0, deadline - now())));
      });
    } catch (err) {
      report(err);
      return false;
    }
  }

  return {
    requestApproval,
    list() {
      if (!ensureDirs(false)) return [];
      const out: PendingApproval[] = [];
      for (const jobId of jobIdsIn(pendingDir)) {
        const p = readPending(jobId);
        if (p) out.push(p);
      }
      return out.sort((a, b) => a.createdAt - b.createdAt || a.jobId.localeCompare(b.jobId));
    },
    show(jobId) {
      validateJobId(jobId);
      if (!ensureDirs(false)) return null;
      return readPending(jobId);
    },
    decide(jobId, decision, specHash) {
      validateJobId(jobId);
      if (decision !== "approve" && decision !== "deny") throw new Error(`invalid decision ${JSON.stringify(decision)}`);
      const pending = ensureDirs(false) ? readPending(jobId) : null;
      if (!pending) throw new Error(`no pending approval for job ${jobId}`);
      if (!sameHash(specHash, pending.specHash)) {
        throw new Error(`spec hash does not match the pending request for job ${jobId}`);
      }
      const file: DecisionFile = { jobId, decision, specHash: pending.specHash, decidedAt: now() };
      try {
        writeExclusive(decisionPath(jobId), `${JSON.stringify(file)}\n`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`job ${jobId} is already decided`);
        throw err;
      }
    },
    prune() {
      if (!ensureDirs(false)) return;
      const t = now();
      for (const jobId of jobIdsIn(decisionsDir)) {
        if (active.has(jobId)) continue;
        const d = readDecision(jobId);
        if (d && t - d.decidedAt > DECISION_MAX_AGE_MS) removeFile(decisionPath(jobId));
      }
      for (const jobId of jobIdsIn(pendingDir)) {
        if (active.has(jobId)) continue;
        const p = readPending(jobId);
        if (p && t - p.createdAt > PENDING_MAX_AGE_MS) removeFile(pendingPath(jobId));
      }
    },
    close() {
      closed = true;
      for (const w of [...active.values()]) w.finish(false);
    },
  };
}

/*
 * Characters escaped for the terminal: C0/C1 controls and DEL, format characters (bidi controls, zero-width
 * characters, BOM, tag characters, soft hyphen), line and paragraph separators, surrogates, private use, unassigned
 * code points, every space other than U+0020, variation selectors, the combining grapheme joiner and Hangul fillers.
 */
const ESCAPE = new RegExp(
  "[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}\\p{Co}\\p{Cn}\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000" +
    "\\u034f\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u3164\\uffa0\\ufe00-\\ufe0f\\u{e0100}-\\u{e01ef}]",
  "u",
);

/**
 * Makes untrusted text safe to print: every control, format, invisible or bidi character (including ESC) becomes a
 * visible `\u{XXXX}` and a newline becomes a visible `\n`. Ordinary text is unchanged.
 */
export function escapeForTerminal(s: string): string {
  let out = "";
  for (const ch of String(s)) {
    if (ch === "\n") out += "\\n";
    else if (ESCAPE.test(ch)) out += `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`;
    else out += ch;
  }
  return out;
}
