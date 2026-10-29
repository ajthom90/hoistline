import { createHash, type KeyObject } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalJson,
  verifyJob,
  type AgentToHub,
  type HubToAgent,
  type JobSpec,
  type SignedJob,
} from "@hoistline/protocol";
import {
  commitWorktree,
  prepareWorktree,
  pushBranch,
  removeWorktree,
  validateBranch,
  validateJobId,
  validateRepo,
  type PrepareOptions,
} from "./git.js";
import { EventStreamer, OutputTail, enforceLogBudget, openJobLog, type Timers } from "./job-output.js";
import { sweepOrphanWork } from "./maintenance.js";
import { Outbox, type JobResult } from "./outbox.js";
import { defaultPolicyPath, evaluateJob, loadEffectivePolicy, type PolicyConfig } from "./policy.js";
import { runJob } from "./runners/index.js";
import { claimJobSync } from "./seen-jobs.js";

/** What the machine's owner is asked to approve. `spec` is exactly what runs if approved; `specHash` identifies it. */
export type ApprovalRequest = {
  jobId: string;
  userId: string;
  spec: JobSpec;
  reason: string;
  /** sha256 hex of canonicalJson({ jobId, repo, runner, model, command, prompt, baseBranch }) of `spec`. */
  specHash: string;
};

/** The git operations a job uses. */
export type GitOps = {
  prepareWorktree: typeof prepareWorktree;
  commitWorktree: typeof commitWorktree;
  pushBranch: typeof pushBranch;
  removeWorktree: typeof removeWorktree;
};

export type ExecutorDeps = {
  machineId: string;
  hubPublicKey: KeyObject;
  cacheDir: string;
  /** Reports to the hub. May throw (not connected); the executor carries on. */
  send: (msg: AgentToHub) => void;
  /** Read when a job starts, so policy edits apply without a restart. Default: the policy file, missing = deny all. */
  loadPolicy?: () => PolicyConfig;
  /** Asks the owner about a job the policy marks `ask`. Default: deny. */
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
  /** Aborting cancels the job (with createExecutor: every job). */
  signal?: AbortSignal;
  now?: () => number;
  prepareOptions?: PrepareOptions;
  runnerTimeoutMs?: number;
  /** How long to wait for an approval. Default one hour. */
  approvalTimeoutMs?: number;
  /** Where full job logs go. Default `<cacheDir>/logs`. */
  logDir?: string;
  /** Limit on output streamed as events per job. Default 2 MiB. */
  onOutputLimitBytes?: number;
  setTimeout?: Timers["setTimeout"];
  clearTimeout?: Timers["clearTimeout"];
  /** Replaces git operations. For tests. */
  git?: Partial<GitOps>;
};

const DEFAULT_APPROVAL_TIMEOUT_MS = 3600_000;
const RESULT_TAIL_BYTES = 64 * 1024;
const MAX_REASON = 500;

type Outcome = Omit<JobResult, "type" | "jobId">;
/** A job that passed verification and was claimed. Its spec is frozen: it is what policy sees and what runs. */
type Admitted = { jobId: string; userId: string; spec: JobSpec };

type RunContext = {
  deps: ExecutorDeps;
  signal: AbortSignal;
  /** Sends events; never throws. */
  send: (msg: AgentToHub) => void;
  /** Delivers the final result; never throws. */
  finish: (result: JobResult) => void;
  /** The job now waits for its owner: whatever it holds while waiting can be released. */
  onAwaitingApproval?: () => void;
  /** Approved: resolves once the job may run (or the signal aborts). */
  reacquire?: (signal: AbortSignal) => Promise<void>;
};

function defaultSetTimeout(fn: () => void, ms: number): unknown {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
}

function isJobId(id: unknown): id is string {
  try {
    validateJobId(id as string);
    return true;
  } catch {
    return false;
  }
}

function safeSend(deps: ExecutorDeps): (msg: AgentToHub) => void {
  return (msg) => {
    try {
      deps.send(msg);
    } catch {
      // Not connected. Results are kept in the outbox (createExecutor) and replayed on the next connection.
    }
  };
}

function gitOf(deps: ExecutorDeps): GitOps {
  return { prepareWorktree, commitWorktree, pushBranch, removeWorktree, ...deps.git };
}

/** sha256 hex of the fields that define what a job does. */
export function specHash(spec: JobSpec): string {
  const { jobId, repo, runner, model, command, prompt, baseBranch } = spec;
  return createHash("sha256")
    .update(canonicalJson({ jobId, repo, runner, model, command, prompt, baseBranch }))
    .digest("hex");
}

/** An error as a reason the hub may show: no cache path, no control characters, at most 500 characters. */
function sanitizeReason(err: unknown, cacheDir: string): string {
  let text = err instanceof Error ? err.message : String(err);
  const prefixes = new Set([cacheDir, resolve(cacheDir)]);
  try {
    prefixes.add(realpathSync(cacheDir));
  } catch {
    // The cache directory does not exist.
  }
  for (const p of [...prefixes].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(p).join("<cache>");
  text = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return [...text].slice(0, MAX_REASON).join("") || "job_failed";
}

function cancelled(signal: AbortSignal): Outcome {
  return signal.reason === "agent_shutdown" ? { status: "cancelled", reason: "agent_shutdown" } : { status: "cancelled" };
}

/**
 * Admission: verifies the signed job (including its age) and claims its id durably, both synchronously. Reports a
 * refusal itself (invalid_job, replayed_job, internal_error) and returns null; a job whose id is unsafe is dropped
 * silently.
 */
function admit(signed: SignedJob, deps: ExecutorDeps, send: (msg: AgentToHub) => void): Admitted | null {
  const now = deps.now ?? Date.now;
  let spec: JobSpec;
  let userId: string;
  try {
    ({ spec, userId } = verifyJob(signed, deps.hubPublicKey, deps.machineId, now()));
  } catch {
    // The claimed id is only echoed back when it is safe to; otherwise the job is dropped silently.
    const claimed = (signed as { spec?: { jobId?: unknown } } | null)?.spec?.jobId;
    if (isJobId(claimed)) send({ type: "job.result", jobId: claimed, status: "failed", reason: "invalid_job" });
    return null;
  }
  if (!isJobId(spec.jobId)) return null;
  const jobId = spec.jobId;
  try {
    if (!claimJobSync(deps.cacheDir, jobId, now())) {
      send({ type: "job.result", jobId, status: "failed", reason: "replayed_job" });
      return null;
    }
  } catch {
    send({ type: "job.result", jobId, status: "failed", reason: "internal_error" });
    return null;
  }
  return { jobId, userId, spec: Object.freeze({ ...spec }) };
}

/**
 * Runs one signed job end to end and reports through `deps.send`: verification, replay claim, input validation,
 * policy (and approval), a fresh worktree, the runner, then commit and push of `hoistline/<jobId>`. The worktree is
 * always removed. Never throws.
 */
export async function execute(signed: SignedJob, deps: ExecutorDeps): Promise<void> {
  try {
    const send = safeSend(deps);
    const job = admit(signed, deps, send);
    if (!job) return;
    await runAdmitted(job, { deps, signal: deps.signal ?? new AbortController().signal, send, finish: send });
  } catch {
    // runAdmitted reports every failure; this only guards the promise.
  }
}

/** Everything after admission. No age check here: the job was verified when it arrived. */
async function runAdmitted(job: Admitted, ctx: RunContext): Promise<void> {
  let outcome: Outcome;
  try {
    outcome = await decideAndRun(job, ctx);
  } catch {
    // Anything unexpected (policy loading, evaluation, ...): the hub still learns the job is over.
    outcome = { status: "failed", reason: "internal_error" };
  }
  ctx.finish({ type: "job.result", jobId: job.jobId, ...outcome });
}

async function decideAndRun(job: Admitted, ctx: RunContext): Promise<Outcome> {
  const { deps, signal } = ctx;
  const { jobId, userId, spec } = job;
  let repo: string;
  try {
    repo = validateRepo(spec.repo);
    validateBranch(spec.baseBranch);
  } catch {
    return { status: "failed", reason: "invalid_job" };
  }
  if (signal.aborted) return cancelled(signal);

  const policy = (deps.loadPolicy ?? (() => loadEffectivePolicy(defaultPolicyPath())))();
  // From here on only the canonical repo is used, and the spec that runs is the one that was evaluated.
  const runSpec: JobSpec = Object.freeze({ ...spec, repo });
  const decision = evaluateJob(policy, runSpec);
  if (decision.result === "deny") return { status: "failed", reason: sanitizeReason(decision.reason, deps.cacheDir) };
  if (decision.result === "ask") {
    ctx.send({ type: "job.event", jobId, stream: "status", data: "awaiting_approval" });
    ctx.onAwaitingApproval?.();
    const answer = await askApproval(deps, signal, {
      jobId,
      userId,
      spec: { ...runSpec },
      reason: decision.reason,
      specHash: specHash(runSpec),
    });
    if (answer === "aborted") return cancelled(signal);
    if (answer === "timeout") return { status: "failed", reason: "approval_timeout" };
    if (answer === "denied") return { status: "failed", reason: "approval_denied" };
    await ctx.reacquire?.(signal);
  }
  if (signal.aborted) return cancelled(signal);

  ctx.send({ type: "job.event", jobId, stream: "status", data: "running" });
  const out = { tail: new OutputTail(RESULT_TAIL_BYTES), capped: false };
  let outcome: Outcome;
  try {
    outcome = await runInWorktree(runSpec, ctx, out);
  } catch (err) {
    outcome = { status: "failed", reason: sanitizeReason(err, deps.cacheDir) };
  } finally {
    try {
      await gitOf(deps).removeWorktree(repo, jobId, deps.cacheDir);
    } catch {
      // Left for the orphan sweep; never changes the job's outcome.
    }
  }
  const output = out.tail.text();
  if (output) outcome = { ...outcome, output };
  if (out.tail.truncated || out.capped) outcome = { ...outcome, truncated: true };
  return outcome;
}

/** Resolves with the owner's answer, or "timeout", or "aborted"; an answer after an abort is ignored. */
async function askApproval(
  deps: ExecutorDeps,
  signal: AbortSignal,
  req: ApprovalRequest,
): Promise<"approved" | "denied" | "timeout" | "aborted"> {
  const setT = deps.setTimeout ?? defaultSetTimeout;
  const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  if (!deps.requestApproval) return "denied";
  if (signal.aborted) return "aborted";
  let timer: unknown;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise((settle) => {
      timer = setT(() => settle("timeout"), deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS);
      onAbort = () => settle("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => deps.requestApproval!(req))
        .then(
          (ok) => settle(ok === true ? "approved" : "denied"),
          () => settle("denied"),
        );
    });
  } finally {
    clearT(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function runInWorktree(
  spec: JobSpec,
  ctx: RunContext,
  out: { tail: OutputTail; capped: boolean },
): Promise<Outcome> {
  const { deps, signal } = ctx;
  const git = gitOf(deps);
  const { jobId, repo } = spec;
  const ws = await git.prepareWorktree(repo, spec.baseBranch, jobId, deps.cacheDir, deps.prepareOptions);
  if (signal.aborted) return cancelled(signal);

  const log = openJobLog(deps.logDir ?? join(deps.cacheDir, "logs"), jobId, { now: deps.now });
  const streamer = new EventStreamer(jobId, ctx.send, {
    setTimeout: deps.setTimeout ?? defaultSetTimeout,
    clearTimeout: deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout)),
    capBytes: deps.onOutputLimitBytes,
  });
  let result;
  try {
    result = await runJob(
      spec,
      ws.dir,
      (chunk, stream) => {
        out.tail.push(chunk);
        log?.write(chunk);
        streamer.push(chunk, stream);
      },
      signal,
      { timeoutMs: deps.runnerTimeoutMs },
    );
  } finally {
    streamer.close();
    out.capped = streamer.capped;
    log?.close();
  }

  if (result.aborted) return cancelled(signal);
  if (result.timedOut) return { status: "failed", reason: "runner_timeout" };
  if (result.exitCode !== 0) {
    return { status: "failed", exitCode: result.exitCode, reason: `runner_exit_${result.exitCode}` };
  }
  if (signal.aborted) return cancelled(signal);
  const commit = await git.commitWorktree(repo, jobId, deps.cacheDir, deps.prepareOptions);
  // Checked once more right before publishing. Once pushBranch has started the push cannot be called back: a cancel
  // arriving during it is too late, and the job reports what actually happened.
  if (signal.aborted) return cancelled(signal);
  if (commit.tip === ws.baseSha) return { status: "succeeded", exitCode: 0, reason: "no_changes" };
  await git.pushBranch(repo, jobId, deps.cacheDir, deps.prepareOptions);
  return { status: "succeeded", exitCode: 0, branch: ws.branch };
}

export type Executor = {
  /** Handles job.assign, job.cancel and job.ack; ignores everything else. Never throws. */
  onMessage(msg: HubToAgent): void;
  /**
   * Ids for the hello message, at most 1000: the jobs this executor holds (queued, awaiting approval or running) in
   * arrival order, then finished jobs whose result the hub has not acknowledged yet.
   */
  runningJobs(): string[];
  /** Sends every unacknowledged result again. Call it after every welcome. Never throws. */
  flushOutbox(): void;
  /** Applies log retention, the log budget and the orphaned work sweep now (also run at start and hourly). */
  runMaintenance(): Promise<void>;
  /** Cancels every job (reason agent_shutdown) and resolves once they have all settled. Later assignments are ignored. */
  close(): Promise<void>;
};

export type CreateExecutorOptions = ExecutorDeps & {
  /** Jobs that may run at once. Jobs awaiting approval do not count. Default 2. */
  maxConcurrentJobs?: number;
  /** Jobs that may wait for a slot; more fail with agent_busy. Default 200. */
  maxQueuedJobs?: number;
  /** Total size of the job logs; the oldest finished logs go first. Default 1 GiB. */
  maxTotalLogBytes?: number;
  /** Unacknowledged results kept; past this the oldest is dropped. Default 1000. */
  outboxMaxEntries?: number;
  /** Called for every unacknowledged result dropped (too many, or older than 24 hours). */
  onOutboxDrop?: (jobId: string, why: "overflow" | "expired") => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

const MAX_LISTED_JOBS = 1000;
const MAX_TOMBSTONES = 1000;
const TOMBSTONE_TTL_MS = 3600_000;
const MAINTENANCE_INTERVAL_MS = 3600_000;
const DEFAULT_MAX_LOG_BYTES = 1024 * 1024 * 1024;

type Entry = Admitted & {
  controller: AbortController;
  signal: AbortSignal;
  /** Waiting for its first slot. */
  queued: boolean;
  holdsSlot: boolean;
  seq: number;
  done?: Promise<void>;
};

/**
 * Runs assigned jobs, at most `maxConcurrentJobs` at once. Each job is verified and claimed when it arrives; waiting
 * jobs are started taking turns between users (the user served longest ago goes first). A job awaiting approval gives
 * its slot up and waits for one again once approved. Every final result goes to the outbox before it is sent and stays
 * there until the hub acknowledges it. A second job.assign for a job this executor holds is ignored.
 */
export function createExecutor(opts: CreateExecutorOptions): Executor {
  const deps: ExecutorDeps = opts;
  const max = Math.max(1, opts.maxConcurrentJobs ?? 2);
  const maxQueued = Math.max(0, opts.maxQueuedJobs ?? 200);
  const now = deps.now ?? Date.now;
  const send = safeSend(deps);
  const outbox = new Outbox(deps.cacheDir, { maxEntries: opts.outboxMaxEntries, now, onDrop: opts.onOutboxDrop });
  const entries = new Map<string, Entry>();
  const queues = new Map<string, Entry[]>();
  const lastServed = new Map<string, number>();
  const waiters: { entry: Entry; grant: () => void }[] = [];
  /** Cancels that arrived before their job: jobId -> expiry. */
  const tombstones = new Map<string, number>();
  let slots = 0;
  let served = 0;
  let seq = 0;
  let queuedCount = 0;
  let closed = false;

  function deliver(result: JobResult): void {
    try {
      outbox.put(result);
    } catch {
      // Cannot be stored: it is still sent once, best effort.
    }
    send(result);
  }

  function take(entry: Entry): void {
    slots++;
    entry.holdsSlot = true;
    lastServed.set(entry.userId, ++served);
  }

  function release(entry: Entry): void {
    if (!entry.holdsSlot) return;
    entry.holdsSlot = false;
    slots--;
  }

  function dequeue(entry: Entry): void {
    const queue = queues.get(entry.userId);
    const i = queue ? queue.indexOf(entry) : -1;
    if (i < 0) return;
    queue!.splice(i, 1);
    if (queue!.length === 0) queues.delete(entry.userId);
    entry.queued = false;
    queuedCount--;
  }

  /** The first waiting job of the user served longest ago (never served counts as longest). */
  function nextQueued(): Entry | undefined {
    let best: Entry | undefined;
    let bestServed = Infinity;
    for (const [userId, queue] of queues) {
      const head = queue[0]!;
      const s = lastServed.get(userId) ?? 0;
      if (s < bestServed || (s === bestServed && head.seq < best!.seq)) {
        best = head;
        bestServed = s;
      }
    }
    if (best) dequeue(best);
    return best;
  }

  function forgetIfIdle(userId: string): void {
    for (const e of entries.values()) if (e.userId === userId) return;
    lastServed.delete(userId);
  }

  function pump(): void {
    while (!closed && slots < max) {
      const waiter = waiters.shift();
      if (waiter) {
        take(waiter.entry);
        waiter.grant();
        continue;
      }
      const entry = nextQueued();
      if (!entry) return;
      take(entry);
      start(entry);
    }
  }

  function reacquire(entry: Entry, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const onAbort = () => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        resolve();
      };
      const waiter = {
        entry,
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      waiters.push(waiter);
      pump();
    });
  }

  function start(entry: Entry): void {
    entry.done = runAdmitted(entry, {
      deps,
      signal: entry.signal,
      send,
      finish: deliver,
      onAwaitingApproval: () => {
        release(entry);
        pump();
      },
      reacquire: (signal) => reacquire(entry, signal),
    }).finally(() => {
      release(entry);
      entries.delete(entry.jobId);
      forgetIfIdle(entry.userId);
      pump();
    });
  }

  function takeTombstone(jobId: string): boolean {
    const expiry = tombstones.get(jobId);
    if (expiry === undefined) return false;
    tombstones.delete(jobId);
    return expiry > now();
  }

  function addTombstone(jobId: string): void {
    if (!isJobId(jobId)) return;
    const t = now();
    for (const [id, expiry] of tombstones) {
      if (expiry > t) break;
      tombstones.delete(id);
    }
    tombstones.delete(jobId);
    while (tombstones.size >= MAX_TOMBSTONES) tombstones.delete(tombstones.keys().next().value!);
    tombstones.set(jobId, t + TOMBSTONE_TTL_MS);
  }

  function assign(signed: SignedJob): void {
    const claimed = (signed as { spec?: { jobId?: unknown } } | null)?.spec?.jobId;
    // A duplicate of a job held here must not reach admission: its replay refusal would end the real job on the hub.
    if (closed || (isJobId(claimed) && entries.has(claimed))) return;
    const job = admit(signed, deps, send);
    if (!job) return;
    const { jobId } = job;
    if (takeTombstone(jobId)) return deliver({ type: "job.result", jobId, status: "cancelled" });
    if (queuedCount >= maxQueued) return deliver({ type: "job.result", jobId, status: "failed", reason: "agent_busy" });
    const controller = new AbortController();
    const signal = deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal;
    const entry: Entry = { ...job, controller, signal, queued: true, holdsSlot: false, seq: ++seq };
    entries.set(jobId, entry);
    const queue = queues.get(job.userId);
    if (queue) queue.push(entry);
    else queues.set(job.userId, [entry]);
    queuedCount++;
    pump();
  }

  function cancelQueued(entry: Entry, reason?: string): void {
    dequeue(entry);
    entries.delete(entry.jobId);
    forgetIfIdle(entry.userId);
    // It never ran, so there is nothing to undo.
    deliver({ type: "job.result", jobId: entry.jobId, status: "cancelled", ...(reason ? { reason } : {}) });
  }

  function cancel(jobId: string): void {
    const entry = entries.get(jobId);
    if (entry?.queued) return cancelQueued(entry);
    if (entry) return entry.controller.abort();
    // Finished, result not yet acknowledged: the hub no longer wants it.
    if (outbox.has(jobId)) return outbox.remove(jobId);
    // Not here (yet): if the assignment follows, it is cancelled on arrival.
    addTombstone(jobId);
  }

  let maintenance: Promise<void> = Promise.resolve();
  function runMaintenance(): Promise<void> {
    maintenance = maintenance.then(async () => {
      try {
        outbox.prune();
        enforceLogBudget(deps.logDir ?? join(deps.cacheDir, "logs"), {
          maxTotalBytes: opts.maxTotalLogBytes ?? DEFAULT_MAX_LOG_BYTES,
          now: now(),
          keep: new Set(entries.keys()),
        });
        await sweepOrphanWork(deps.cacheDir, { keep: (id) => entries.has(id), now: now() });
      } catch {
        // Best effort; tried again next time.
      }
    });
    return maintenance;
  }
  const setRepeat =
    opts.setInterval ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    });
  const clearRepeat = opts.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));
  const timer = setRepeat(() => {
    if (!closed) void runMaintenance();
  }, MAINTENANCE_INTERVAL_MS);
  void runMaintenance();

  return {
    onMessage(msg) {
      try {
        if (msg?.type === "job.assign") assign(msg.job);
        else if (msg?.type === "job.cancel") cancel(msg.jobId);
        else if (msg?.type === "job.ack") outbox.remove(msg.jobId);
      } catch {
        // A malformed message must not take the connection down.
      }
    },
    runningJobs() {
      const ids = [...entries.keys()];
      for (const id of outbox.ids()) if (!entries.has(id)) ids.push(id);
      return ids.slice(0, MAX_LISTED_JOBS);
    },
    flushOutbox() {
      try {
        outbox.prune();
        for (const result of outbox.entries()) send(result);
      } catch {
        // Tried again after the next welcome.
      }
    },
    runMaintenance,
    async close() {
      if (!closed) {
        closed = true;
        clearRepeat(timer);
      }
      for (const entry of [...entries.values()]) if (entry.queued) cancelQueued(entry, "agent_shutdown");
      const settling: Promise<void>[] = [];
      for (const entry of entries.values()) {
        entry.controller.abort("agent_shutdown");
        if (entry.done) settling.push(entry.done);
      }
      await Promise.all(settling);
      await maintenance;
    },
  };
}
