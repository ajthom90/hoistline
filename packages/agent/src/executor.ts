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
import { EventStreamer, OutputTail, openJobLog, type Timers } from "./job-output.js";
import { DENY_ALL, defaultPolicyPath, evaluateJob, loadEffectivePolicy, type PolicyConfig } from "./policy.js";
import { runJob } from "./runners/index.js";
import { claimJob } from "./seen-jobs.js";

/** What the machine's owner is asked to approve. `spec` is exactly what runs if approved; `specHash` identifies it. */
export type ApprovalRequest = {
  jobId: string;
  userId: string;
  spec: JobSpec;
  reason: string;
  /** sha256 hex of canonicalJson({ jobId, repo, runner, model, command, prompt, baseBranch }) of `spec`. */
  specHash: string;
};

export type ExecutorDeps = {
  machineId: string;
  hubPublicKey: KeyObject;
  cacheDir: string;
  /** Reports to the hub. May throw (not connected); the executor carries on. */
  send: (msg: AgentToHub) => void;
  /** Read for every job, so policy edits apply without a restart. Default: the policy file, missing or bad = deny all. */
  loadPolicy?: () => PolicyConfig;
  /** Asks the owner about a job the policy marks `ask`. Default: deny. */
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
  /** Aborting cancels the job. */
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
};

const DEFAULT_APPROVAL_TIMEOUT_MS = 3600_000;
const RESULT_TAIL_BYTES = 64 * 1024;
const MAX_REASON = 500;

type Result = Extract<AgentToHub, { type: "job.result" }>;
type Outcome = Omit<Result, "type" | "jobId">;

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
  text =text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return [...text].slice(0, MAX_REASON).join("") || "job_failed";
}

/**
 * Runs one signed job end to end and reports through `deps.send`: verification, replay claim, input validation,
 * policy (and approval), a fresh worktree, the runner, then commit and push of `hoistline/<jobId>`. The worktree is
 * always removed. Never throws.
 */
export async function execute(signed: SignedJob, deps: ExecutorDeps): Promise<void> {
  try {
    await run(signed, deps);
  } catch {
    // Every expected failure is reported inside run; this only guards the promise.
  }
}

async function run(signed: SignedJob, deps: ExecutorDeps): Promise<void> {
  const send = (msg: AgentToHub) => {
    try {
      deps.send(msg);
    } catch {
      // Not connected. The hub reconciles the job when the agent reconnects.
    }
  };
  const now = deps.now ?? Date.now;
  let spec: JobSpec;
  let userId: string;
  try {
    ({ spec, userId } = verifyJob(signed, deps.hubPublicKey, deps.machineId, now()));
  } catch {
    // The claimed id is only echoed back when it is safe to; otherwise the job is dropped silently.
    const claimed = (signed as { spec?: { jobId?: unknown } } | null)?.spec?.jobId;
    if (isJobId(claimed)) send({ type: "job.result", jobId: claimed, status: "failed", reason: "invalid_job" });
    return;
  }
  if (!isJobId(spec.jobId)) return;
  const jobId = spec.jobId;
  const finish = (outcome: Outcome) => send({ type: "job.result", jobId, ...outcome });
  const reason = (err: unknown) => sanitizeReason(err, deps.cacheDir);

  try {
    if (!(await claimJob(deps.cacheDir, jobId, now()))) return finish({ status: "failed", reason: "replayed_job" });
  } catch (err) {
    return finish({ status: "failed", reason: reason(err) });
  }

  let repo: string;
  try {
    repo = validateRepo(spec.repo);
    validateBranch(spec.baseBranch);
  } catch {
    return finish({ status: "failed", reason: "invalid_job" });
  }

  const signal = deps.signal ?? new AbortController().signal;
  if (signal.aborted) return finish({ status: "cancelled" });

  let policy: PolicyConfig;
  try {
    policy = (deps.loadPolicy ?? (() => loadEffectivePolicy(defaultPolicyPath())))();
  } catch {
    policy = DENY_ALL;
  }
  // From here on only the canonical repo is used, and the spec that runs is the one that was evaluated.
  const runSpec: JobSpec = Object.freeze({ ...spec, repo });
  const decision = evaluateJob(policy, runSpec);
  if (decision.result === "deny") return finish({ status: "failed", reason: reason(decision.reason) });
  if (decision.result === "ask") {
    send({ type: "job.event", jobId, stream: "status", data: "awaiting_approval" });
    const answer = await askApproval(deps, signal, {
      jobId,
      userId,
      spec: { ...runSpec },
      reason: decision.reason,
      specHash: specHash(runSpec),
    });
    if (answer === "aborted") return finish({ status: "cancelled" });
    if (answer === "timeout") return finish({ status: "failed", reason: "approval_timeout" });
    if (answer === "denied") return finish({ status: "failed", reason: "approval_denied" });
  }
  if (signal.aborted) return finish({ status: "cancelled" });

  send({ type: "job.event", jobId, stream: "status", data: "running" });
  let outcome: Outcome;
  const tail = new OutputTail(RESULT_TAIL_BYTES);
  try {
    outcome = await runInWorktree(runSpec, deps, signal, tail, send);
  } catch (err) {
    outcome = { status: "failed", reason: reason(err) };
  } finally {
    try {
      await removeWorktree(repo, jobId, deps.cacheDir);
    } catch {
      // Left for the next cleanup; never changes the job's outcome.
    }
  }
  const output = tail.text();
  finish(output ? { ...outcome, output } : outcome);
}

async function askApproval(
  deps: ExecutorDeps,
  signal: AbortSignal,
  req: ApprovalRequest,
): Promise<"approved" | "denied" | "timeout" | "aborted"> {
  const setT = deps.setTimeout ?? defaultSetTimeout;
  const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  if (!deps.requestApproval) return "denied";
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
  deps: ExecutorDeps,
  signal: AbortSignal,
  tail: OutputTail,
  send: (msg: AgentToHub) => void,
): Promise<Outcome> {
  const { jobId, repo } = spec;
  const ws = await prepareWorktree(repo, spec.baseBranch, jobId, deps.cacheDir, deps.prepareOptions);
  if (signal.aborted) return { status: "cancelled" };

  const log = openJobLog(deps.logDir ?? join(deps.cacheDir, "logs"), jobId, { now: deps.now });
  const streamer = new EventStreamer(jobId, send, {
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
        tail.push(chunk);
        log?.write(chunk);
        streamer.push(chunk, stream);
      },
      signal,
      { timeoutMs: deps.runnerTimeoutMs },
    );
  } finally {
    streamer.close();
    log?.close();
  }

  if (result.aborted) return { status: "cancelled" };
  if (result.timedOut) return { status: "failed", reason: "runner_timeout" };
  if (result.exitCode !== 0) {
    return { status: "failed", exitCode: result.exitCode, reason: `runner_exit_${result.exitCode}` };
  }
  const commit = await commitWorktree(repo, jobId, deps.cacheDir, deps.prepareOptions);
  if (commit.tip === ws.baseSha) return { status: "succeeded", exitCode: 0, reason: "no_changes" };
  await pushBranch(repo, jobId, deps.cacheDir, deps.prepareOptions);
  return { status: "succeeded", exitCode: 0, branch: ws.branch };
}

export type Executor = {
  /** Handles job.assign and job.cancel; ignores everything else. Never throws. */
  onMessage(msg: HubToAgent): void;
  /** Ids of the jobs this executor holds, queued or running, oldest first (for the hello message). */
  runningJobs(): string[];
  /** Cancels every job and resolves once they have all settled. Later assignments are ignored. */
  close(): Promise<void>;
};

type Entry = { job: SignedJob; controller: AbortController; done?: Promise<void> };

/**
 * Runs assigned jobs, at most `maxConcurrentJobs` (default 2) at once; the rest wait in arrival order. A second
 * job.assign for a job this executor already holds is ignored.
 */
export function createExecutor(deps: ExecutorDeps & { maxConcurrentJobs?: number }): Executor {
  const max = Math.max(1, deps.maxConcurrentJobs ?? 2);
  const jobs = new Map<string, Entry>();
  const queue: string[] = [];
  let running = 0;
  let closed = false;

  const sendSafe = (msg: AgentToHub) => {
    try {
      deps.send(msg);
    } catch {
      // Not connected.
    }
  };

  function pump(): void {
    while (!closed && running < max && queue.length > 0) {
      const jobId = queue.shift()!;
      const entry = jobs.get(jobId)!;
      running++;
      entry.done = execute(entry.job, { ...deps, signal: entry.controller.signal }).finally(() => {
        running--;
        if (jobs.get(jobId) === entry) jobs.delete(jobId);
        pump();
      });
    }
  }

  function assign(job: SignedJob): void {
    const jobId = (job as { spec?: { jobId?: unknown } } | null)?.spec?.jobId;
    if (closed || !isJobId(jobId) || jobs.has(jobId)) return;
    jobs.set(jobId, { job, controller: new AbortController() });
    queue.push(jobId);
    pump();
  }

  function cancel(jobId: string): void {
    const entry = jobs.get(jobId);
    if (!entry) return;
    if (entry.done) {
      entry.controller.abort();
      return;
    }
    // Still waiting: it never ran, so there is nothing to undo.
    queue.splice(queue.indexOf(jobId), 1);
    jobs.delete(jobId);
    sendSafe({ type: "job.result", jobId, status: "cancelled" });
  }

  return {
    onMessage(msg) {
      try {
        if (msg?.type === "job.assign") assign(msg.job);
        else if (msg?.type === "job.cancel") cancel(msg.jobId);
      } catch {
        // A malformed message must not take the connection down.
      }
    },
    runningJobs: () => [...jobs.keys()],
    async close() {
      closed = true;
      for (const jobId of [...queue]) cancel(jobId);
      const settling: Promise<void>[] = [];
      for (const entry of jobs.values()) {
        entry.controller.abort();
        if (entry.done) settling.push(entry.done);
      }
      await Promise.all(settling);
    },
  };
}
