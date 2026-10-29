import { randomUUID } from "node:crypto";
import { JobSpecSchema, signJob, type AgentToHub, type JobSpec, type RunnerName } from "@hoistline/protocol";
import type { Gateway } from "./gateway.js";
import { ACTIVE_JOB_STATUSES, utf8Tail, type JobRow, type Machine, type Store } from "./store.js";

export type JobStatus = "queued" | "awaiting_approval" | "running" | "succeeded" | "failed" | "cancelled";

export interface DelegateRequest {
  /** A machine id, or the name of a machine the caller can access. */
  machine: string;
  runner: RunnerName;
  repo: string;
  /** The base branch the job starts from. */
  branch: string;
  prompt: string;
  model?: string;
  command?: string;
}

export interface JobResult {
  jobId: string;
  status: JobStatus;
  reason?: string;
  branch?: string;
  exitCode?: number;
  /** At most the last 64 KiB of the job's output. */
  output: string;
  /** True when earlier output was dropped. */
  truncated: boolean;
}

export interface JobsOptions {
  now?: () => number;
  /** How long a machine may stay disconnected before its active jobs fail with agent_disconnected. Default 60 s. */
  disconnectGraceMs?: number;
  /** Active jobs older than this fail with `timeout` (see sweep). Default 3 hours. */
  maxJobAgeMs?: number;
  /** Default 20. */
  maxActivePerUser?: number;
  /** Default 20. */
  maxActivePerMachine?: number;
  /** How often attach() runs sweep. Default 60 s. */
  sweepIntervalMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Called for every agent message that was dropped because it is not about one of that machine's jobs. */
  onDroppedMessage?: (machineId: string, msg: AgentToHub) => void;
}

/** The parts of Gateway that Jobs uses. */
export type JobsGateway = Pick<
  Gateway,
  "isOnline" | "sendJob" | "send" | "onJobMessage" | "onConnect" | "onDisconnect" | "hubPrivateKey"
>;

/** Unknown machines and machines the caller cannot access look the same. */
export class NotFoundError extends Error {
  constructor(message = "machine not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class MachineOfflineError extends Error {
  constructor(message = "machine is offline") {
    super(message);
    this.name = "MachineOfflineError";
  }
}

export class AmbiguousMachineError extends Error {
  constructor(name: string) {
    super(`more than one machine is named ${JSON.stringify(name)}; use its id`);
    this.name = "AmbiguousMachineError";
  }
}

export class TooManyJobsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TooManyJobsError";
  }
}

export const OUTPUT_TAIL_BYTES = 64 * 1024;
const MAX_REASON = 500;
const ACTIVE: readonly string[] = ACTIVE_JOB_STATUSES;
const TERMINAL_FROM_AGENT = new Set(["succeeded", "failed", "cancelled"]);
const RESULT_BRANCH = /^hoistline\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Control characters, C1, and invisible/bidi formatting characters (same set the agent's policy strips).
const UNSAFE_CHARS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064" +
    "\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb\\u{e0000}-\\u{e007f}]",
  "gu",
);

/** Agent-supplied reason text: unsafe characters stripped, at most 500 characters. */
function cleanReason(reason: string): string {
  const text = reason.replace(UNSAFE_CHARS, "");
  if (text.length <= MAX_REASON) return text;
  // Never end on half of a surrogate pair.
  return text.slice(0, MAX_REASON).replace(/[\ud800-\udbff]$/, "");
}

/**
 * The job lifecycle on the hub. Every state lives in SQLite (a restart loses nothing); the agent reports progress
 * over the gateway, and every agent message is checked against the machine that sent it before it changes state.
 * Terminal states (succeeded, failed, cancelled) never change again.
 */
export class Jobs {
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly maxAgeMs: number;
  private readonly maxPerUser: number;
  private readonly maxPerMachine: number;
  private readonly sweepIntervalMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly graceTimers = new Map<string, unknown>();
  private sweepTimer?: NodeJS.Timeout;
  private attached = false;
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly gateway: JobsGateway,
    private readonly opts: JobsOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.graceMs = opts.disconnectGraceMs ?? 60_000;
    this.maxAgeMs = opts.maxJobAgeMs ?? 3 * 60 * 60 * 1000;
    this.maxPerUser = opts.maxActivePerUser ?? 20;
    this.maxPerMachine = opts.maxActivePerMachine ?? 20;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;
    this.setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms).unref());
    this.clearTimer = opts.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Subscribes to the gateway and starts the periodic sweep. Call once. */
  attach(): void {
    if (this.attached) throw new Error("jobs already attached");
    this.attached = true;
    this.gateway.onJobMessage((machineId, msg) => {
      if (!this.closed) this.handleMessage(machineId, msg);
    });
    this.gateway.onConnect((machineId, info) => {
      if (this.closed) return;
      this.cancelGrace(machineId);
      this.reconcile(machineId, info.runningJobs);
    });
    this.gateway.onDisconnect((machineId) => {
      if (!this.closed) this.armGrace(machineId);
    });
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  /**
   * Call once at startup: every machine with active jobs gets the disconnect grace, so its jobs cannot stay
   * "running" forever if its agent never returns. A reconnect (hello) reconciles them earlier.
   */
  recoverAfterRestart(): void {
    for (const machineId of this.store.machinesWithActiveJobs()) {
      if (!this.gateway.isOnline(machineId)) this.armGrace(machineId);
    }
  }

  close(): void {
    this.closed = true;
    for (const handle of this.graceTimers.values()) this.clearTimer(handle);
    this.graceTimers.clear();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  /**
   * Creates a job on a machine the user can access and sends it, signed, to the machine. Throws NotFoundError,
   * AmbiguousMachineError, MachineOfflineError, TooManyJobsError, or a validation error for a malformed request.
   */
  delegate(userId: string, req: DelegateRequest): JobRow {
    const machine = this.resolveMachine(userId, req.machine);
    if (!this.gateway.isOnline(machine.id)) throw new MachineOfflineError();
    const spec: JobSpec = JobSpecSchema.parse({
      jobId: randomUUID(),
      runner: req.runner,
      repo: req.repo,
      baseBranch: req.branch,
      prompt: req.prompt,
      model: req.model,
      command: req.command,
    });
    if (this.store.countActiveJobs({ userId }) >= this.maxPerUser) {
      throw new TooManyJobsError(`you already have ${this.maxPerUser} active jobs`);
    }
    if (this.store.countActiveJobs({ machineId: machine.id }) >= this.maxPerMachine) {
      throw new TooManyJobsError(`this machine already has ${this.maxPerMachine} active jobs`);
    }
    const now = this.now();
    const row: JobRow = {
      id: spec.jobId,
      userId,
      machineId: machine.id,
      runner: spec.runner,
      repo: spec.repo,
      baseBranch: spec.baseBranch,
      prompt: spec.prompt,
      model: spec.model,
      command: spec.command,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    // Recorded before it is sent, so a result can never arrive for a job the hub does not know.
    this.store.insertJob(row);
    try {
      this.gateway.sendJob(machine.id, signJob(spec, userId, machine.id, this.gateway.hubPrivateKey, now));
    } catch {
      this.store.transitionJob(row.id, ACTIVE, { status: "failed", reason: "dispatch_failed" });
      throw new MachineOfflineError();
    }
    return this.store.getJob(userId, row.id) ?? row;
  }

  status(userId: string, jobId: string): JobStatus | null {
    return (this.store.getJob(userId, jobId)?.status as JobStatus | undefined) ?? null;
  }

  result(userId: string, jobId: string): JobResult | null {
    const job = this.store.getJob(userId, jobId);
    if (!job) return null;
    const result: JobResult = {
      jobId: job.id,
      status: job.status as JobStatus,
      output: job.output ?? "",
      truncated: job.outputTruncated === true,
    };
    if (job.reason !== undefined) result.reason = job.reason;
    if (job.branch !== undefined) result.branch = job.branch;
    if (job.exitCode !== undefined) result.exitCode = job.exitCode;
    return result;
  }

  /**
   * Queued: cancelled at once (the agent is told, best effort). Awaiting approval or running: the agent is asked
   * to cancel and its job.result sets the final state; if the agent is offline the job fails with
   * agent_disconnected. Returns false for finished, unknown and other users' jobs.
   */
  cancel(userId: string, jobId: string): boolean {
    const job = this.store.getJob(userId, jobId);
    if (!job) return false;
    if (job.status === "queued") {
      this.store.transitionJob(job.id, ["queued"], { status: "cancelled" });
      // The assignment was already sent; tell the agent so it does not run it.
      this.trySend(job.machineId, job.id);
      return true;
    }
    if (job.status !== "running" && job.status !== "awaiting_approval") return false;
    if (!this.trySend(job.machineId, job.id)) {
      this.store.transitionJob(job.id, ACTIVE, { status: "failed", reason: "agent_disconnected" });
    }
    return true;
  }

  /**
   * The machine's agent (re)connected and reported the jobs it still has: every active job of that machine it
   * does not list fails with lost_on_agent; listed ones stay as they are.
   */
  reconcile(machineId: string, running: string[]): void {
    const listed = new Set(running);
    for (const job of this.store.activeJobs(machineId)) {
      if (!listed.has(job.id)) this.store.transitionJob(job.id, ACTIVE, { status: "failed", reason: "lost_on_agent" });
    }
  }

  /** Fails every active job older than maxJobAgeMs with `timeout`. */
  sweep(now: number = this.now()): void {
    for (const job of this.store.activeJobs()) {
      if (now - job.createdAt > this.maxAgeMs) {
        this.store.transitionJob(job.id, ACTIVE, { status: "failed", reason: "timeout" });
      }
    }
  }

  private resolveMachine(userId: string, ref: string): Machine {
    const byId = this.store.getMachine(userId, ref);
    if (byId) return byId;
    const named = this.store.machinesFor(userId).filter((m) => m.name === ref);
    if (named.length > 1) throw new AmbiguousMachineError(ref);
    if (named.length === 1) return named[0]!;
    throw new NotFoundError();
  }

  private trySend(machineId: string, jobId: string): boolean {
    if (!this.gateway.isOnline(machineId)) return false;
    try {
      this.gateway.send(machineId, { type: "job.cancel", jobId });
      return true;
    } catch {
      return false;
    }
  }

  private armGrace(machineId: string): void {
    if (this.graceTimers.has(machineId)) return;
    const handle = this.setTimer(() => {
      this.graceTimers.delete(machineId);
      if (this.closed || this.gateway.isOnline(machineId)) return;
      for (const job of this.store.activeJobs(machineId)) {
        this.store.transitionJob(job.id, ACTIVE, { status: "failed", reason: "agent_disconnected" });
      }
    }, this.graceMs);
    this.graceTimers.set(machineId, handle);
  }

  private cancelGrace(machineId: string): void {
    const handle = this.graceTimers.get(machineId);
    if (handle === undefined) return;
    this.clearTimer(handle);
    this.graceTimers.delete(machineId);
  }

  private handleMessage(machineId: string, msg: AgentToHub): void {
    if (msg.type !== "job.event" && msg.type !== "job.result") return;
    // Only the machine the job was sent to may report on it.
    const job = this.store.getJobById(msg.jobId);
    if (!job || job.machineId !== machineId) {
      this.opts.onDroppedMessage?.(machineId, msg);
      return;
    }
    if (msg.type === "job.event") {
      if (msg.stream === "status") {
        if (msg.data === "running") this.store.transitionJob(job.id, ["queued", "awaiting_approval"], { status: "running" });
        else if (msg.data === "awaiting_approval") {
          this.store.transitionJob(job.id, ["queued"], { status: "awaiting_approval" });
        }
        return;
      }
      this.store.appendJobOutput(job.id, msg.data, OUTPUT_TAIL_BYTES, ACTIVE);
      return;
    }
    if (!TERMINAL_FROM_AGENT.has(msg.status)) return;
    const patch: Partial<JobRow> = { status: msg.status };
    if (msg.exitCode !== undefined) patch.exitCode = msg.exitCode;
    if (msg.reason !== undefined) patch.reason = cleanReason(msg.reason);
    if (msg.branch !== undefined && msg.branch === `hoistline/${job.id}` && RESULT_BRANCH.test(msg.branch)) {
      patch.branch = msg.branch;
    }
    if (msg.output !== undefined) {
      const tail = utf8Tail(msg.output, OUTPUT_TAIL_BYTES);
      patch.output = tail.text;
      if (tail.truncated) patch.outputTruncated = true;
    }
    this.store.transitionJob(job.id, ACTIVE, patch);
  }
}
