import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
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
 * files are created 0600 in 0700 directories, symbolic links are never followed (every file is lstat-checked before
 * it is opened, and opened with O_NOFOLLOW where the platform has it), reads are bounded and strictly validated, and
 * an approval counts only for the exact spec it names (its full sha256 spec hash).
 *
 * Files are published atomically: written in full to a temporary name in the same directory, fsynced, then hard
 * linked to the final name (which fails if the name exists, so publication stays exclusive). A reader therefore never
 * sees a partial file; an empty or unparsable file younger than ten seconds is treated as "not written yet", never
 * deleted. Only the agent process (a waiting request, prune) deletes invalid files; list, show and decide never do.
 *
 * Windows: there is no O_NOFOLLOW and no process.getuid, so the ownership checks do not apply there and the trust
 * boundary is the ACL of the agent home directory (by default under the user's profile, private to that user).
 * Symbolic links are still refused on every platform by the lstat checks.
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
  /**
   * The executor's `requestApproval`. Resolves true only for an approval of this exact spec; false for a deny, an
   * abort, the TTL or close. Rejects when the queue itself fails (unsafe directory, request too large, I/O, a request
   * already pending for the job): that is not the owner's answer. Never throws synchronously.
   */
  requestApproval(req: ApprovalRequest): Promise<boolean>;
  /** Valid pending requests, oldest first. Never deletes anything. */
  list(): PendingApproval[];
  /** Never deletes anything. */
  show(jobId: string): PendingApproval | null;
  /** Records the owner's answer. Throws for an unknown job, a hash other than the request's, or a second answer. */
  decide(jobId: string, decision: ApprovalDecision, specHash: string): void;
  /**
   * Removes decisions older than an hour, orphaned pending requests older than a day, invalid files and leftover
   * temporary files. Call it from the agent process only.
   */
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
  /** Called with every error requestApproval meets (it also rejects with it). */
  onError?: (err: unknown) => void;
  /** Test hook: runs right after a pending request is published. */
  onPendingPublished?: (jobId: string) => void;
};

const MAX_PENDING_BYTES = 512 * 1024;
const MAX_DECISION_BYTES = 4 * 1024;
const DEFAULT_TTL_MS = 3600_000;
const DECISION_MAX_AGE_MS = 3600_000;
const PENDING_MAX_AGE_MS = 24 * 3600_000;
/** Timestamps this far in the future are invalid (they would never be pruned). */
const CLOCK_SKEW_MS = 60_000;
/** An empty or unparsable file younger than this may still be being written by someone: never deleted. */
const YOUNG_FILE_MS = 10_000;

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

const ownUid = typeof process.getuid === "function" ? process.getuid() : undefined;

/** Checks a directory, creating it (0700) when `create`: a real directory owned by this user, never a symbolic link. */
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
  if (ownUid !== undefined && st.uid !== ownUid) throw new Error(`refusing ${path}: owned by another user`);
  if (create && (st.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

/**
 * Publishes `content` at `path` atomically and exclusively: a private temporary file in the same directory, fsynced,
 * then hard linked to `path`. Throws EEXIST when anything is already at `path`.
 */
function publish(path: string, content: string): void {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
  try {
    try {
      const buf = Buffer.from(content);
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(tmp, path);
  } finally {
    removeFile(tmp);
  }
}

type Read<T> = { kind: "missing" } | { kind: "notyet" } | { kind: "invalid" } | { kind: "ok"; value: T };

/**
 * Reads and validates a regular file of at most `max` bytes without following a symbolic link. An empty or
 * unparsable file younger than YOUNG_FILE_MS is "notyet"; anything else that is not valid is "invalid".
 */
function readFile<T>(path: string, max: number, schema: z.ZodType<T>): Read<T> {
  let lst;
  try {
    lst = lstatSync(path);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
  if (lst.isSymbolicLink() || !lst.isFile() || lst.size > max) return { kind: "invalid" };
  let fd: number;
  try {
    // O_NONBLOCK: a FIFO swapped in after the lstat must not block the open.
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
  let text: string;
  let mtimeMs: number;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max || st.ino !== lst.ino) return { kind: "invalid" };
    if (ownUid !== undefined && st.uid !== ownUid) return { kind: "invalid" };
    mtimeMs = st.mtimeMs;
    const buf = Buffer.alloc(max + 1);
    let len = 0;
    for (;;) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
      if (len > max) return { kind: "invalid" };
    }
    text = buf.subarray(0, len).toString("utf8");
  } catch {
    return { kind: "invalid" };
  } finally {
    closeSync(fd);
  }
  let json: unknown;
  try {
    if (text.trim() === "") throw new Error("empty");
    json = JSON.parse(text);
  } catch {
    return Date.now() - mtimeMs < YOUNG_FILE_MS ? { kind: "notyet" } : { kind: "invalid" };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "invalid" };
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove.
  }
}

function defaultSetTimeout(fn: () => void, ms: number): unknown {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
}

type Waiter = { finish: (result: boolean | Error) => void };

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

  /** Checks (and with `create`, creates) the directories. False when they do not exist and `create` is off. */
  function ensureDirs(create: boolean): boolean {
    if (create) mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    try {
      ensureDir(dir, create);
      ensureDir(pendingDir, create);
      ensureDir(decisionsDir, create);
    } catch (err) {
      if (!create && (err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    return true;
  }

  const pendingPath = (jobId: string) => join(pendingDir, `${validateJobId(jobId)}.json`);
  const decisionPath = (jobId: string) => join(decisionsDir, `${validateJobId(jobId)}.json`);

  function readPending(jobId: string): Read<PendingApproval> {
    const r = readFile(pendingPath(jobId), MAX_PENDING_BYTES, PendingSchema);
    if (r.kind !== "ok") return r;
    const p = r.value;
    const consistent =
      p.jobId === jobId &&
      p.spec.jobId === jobId &&
      sameHash(p.specHash, hashOfSpec(p.spec)) &&
      p.createdAt <= now() + CLOCK_SKEW_MS;
    return consistent ? { kind: "ok", value: p as PendingApproval } : { kind: "invalid" };
  }

  function readDecision(jobId: string): Read<DecisionFile> {
    const r = readFile(decisionPath(jobId), MAX_DECISION_BYTES, DecisionSchema);
    if (r.kind !== "ok") return r;
    const d = r.value;
    return d.jobId === jobId && d.decidedAt <= now() + CLOCK_SKEW_MS ? r : { kind: "invalid" };
  }

  function namesIn(path: string): string[] {
    return readdirSync(path);
  }

  function jobIdsIn(path: string): string[] {
    return namesIn(path)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .filter(isJobId);
  }

  /** Removes temporary files older than YOUNG_FILE_MS (never following a link). */
  function pruneTemps(path: string): void {
    for (const name of namesIn(path)) {
      if (!name.endsWith(".tmp")) continue;
      const file = join(path, name);
      try {
        if (Date.now() - lstatSync(file).mtimeMs > YOUNG_FILE_MS) removeFile(file);
      } catch {
        // Gone already.
      }
    }
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
      const duplicate = () => new Error(`job ${jobId} is already awaiting approval`);
      try {
        lstatSync(pPath);
        throw duplicate();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      // A decision cannot come before its request: anything already there is stale. Removed before publishing, so an
      // answer given as soon as the request is visible is never lost.
      removeFile(dPath);
      try {
        publish(pPath, text);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") throw duplicate();
        throw err;
      }
      opts.onPendingPublished?.(jobId);

      return await new Promise<boolean>((resolve, reject) => {
        let timer: unknown;
        let done = false;
        const onAbort = () => finish(false);
        const deadline = pending.createdAt + ttlMs;
        function finish(result: boolean | Error): void {
          if (done) return;
          done = true;
          if (timer !== undefined) clearT(timer);
          signal?.removeEventListener("abort", onAbort);
          active.delete(jobId);
          removeFile(pPath);
          removeFile(dPath);
          if (result instanceof Error) reject(result);
          else resolve(result);
        }
        function poll(): void {
          timer = undefined;
          if (done) return;
          try {
            ensureDirs(false);
            const d = readDecision(jobId);
            if (d.kind === "ok") return finish(d.value.decision === "approve" && sameHash(d.value.specHash, specHash));
            if (d.kind === "invalid") removeFile(dPath);
            if (now() >= deadline) return finish(false);
          } catch (err) {
            return finish(err instanceof Error ? err : new Error(String(err)));
          }
          timer = setT(poll, pollMs);
        }
        active.set(jobId, { finish });
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setT(poll, Math.min(pollMs, Math.max(0, deadline - now())));
      });
    } catch (err) {
      report(err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  return {
    requestApproval: (req) => requestApproval(req),
    list() {
      if (!ensureDirs(false)) return [];
      const out: PendingApproval[] = [];
      for (const jobId of jobIdsIn(pendingDir)) {
        const p = readPending(jobId);
        if (p.kind === "ok") out.push(p.value);
      }
      return out.sort((a, b) => a.createdAt - b.createdAt || a.jobId.localeCompare(b.jobId));
    },
    show(jobId) {
      validateJobId(jobId);
      if (!ensureDirs(false)) return null;
      const p = readPending(jobId);
      return p.kind === "ok" ? p.value : null;
    },
    decide(jobId, decision, specHash) {
      validateJobId(jobId);
      if (decision !== "approve" && decision !== "deny") throw new Error(`invalid decision ${JSON.stringify(decision)}`);
      const p = ensureDirs(false) ? readPending(jobId) : { kind: "missing" as const };
      if (p.kind !== "ok") throw new Error(`no pending approval for job ${jobId}`);
      if (!sameHash(specHash, p.value.specHash)) {
        throw new Error(`spec hash does not match the pending request for job ${jobId}`);
      }
      const file: DecisionFile = { jobId, decision, specHash: p.value.specHash, decidedAt: now() };
      try {
        publish(decisionPath(jobId), `${JSON.stringify(file)}\n`);
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
        if (d.kind === "invalid" || (d.kind === "ok" && t - d.value.decidedAt > DECISION_MAX_AGE_MS)) {
          removeFile(decisionPath(jobId));
        }
      }
      for (const jobId of jobIdsIn(pendingDir)) {
        if (active.has(jobId)) continue;
        const p = readPending(jobId);
        if (p.kind === "invalid" || (p.kind === "ok" && t - p.value.createdAt > PENDING_MAX_AGE_MS)) {
          removeFile(pendingPath(jobId));
        }
      }
      pruneTemps(pendingDir);
      pruneTemps(decisionsDir);
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
 * Makes untrusted text safe and unambiguous to print: every control, format, invisible or bidi character (including
 * ESC) becomes a visible `\u{XXXX}`, a newline becomes `\n` and a literal backslash becomes `\\`, so source text can
 * never imitate an escape. Ordinary text is unchanged.
 */
export function escapeForTerminal(s: string): string {
  let out = "";
  for (const ch of String(s)) {
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ESCAPE.test(ch)) out += `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`;
    else out += ch;
  }
  return out;
}
