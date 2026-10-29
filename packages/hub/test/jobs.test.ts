import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyJob, type AgentToHub, type HubToAgent, type SignedJob } from "@hoistline/protocol";
import {
  AmbiguousMachineError,
  Jobs,
  MachineOfflineError,
  NotFoundError,
  TooManyJobsError,
  type DelegateRequest,
  type JobsGateway,
  type JobsOptions,
} from "../src/jobs.js";
import { Store, type Machine, type User } from "../src/store.js";

const hubKey = generateKeyPairSync("ed25519");
const OUTPUT_CAP = 64 * 1024;

/** A scripted gateway: machines go online and offline by hand and agent messages are injected directly. */
class FakeGateway implements JobsGateway {
  readonly hubPrivateKey = hubKey.privateKey;
  readonly online = new Set<string>();
  readonly sent: [string, HubToAgent][] = [];
  failSend = false;
  private readonly jobListeners: ((machineId: string, msg: AgentToHub) => void)[] = [];
  private readonly connectListeners: ((
    machineId: string,
    info: { runningJobs: string[]; runners: string[]; servers: string[] },
  ) => void)[] = [];
  private readonly disconnectListeners: ((machineId: string) => void)[] = [];

  isOnline(machineId: string): boolean {
    return this.online.has(machineId);
  }
  sendJob(machineId: string, job: SignedJob): void {
    if (!this.online.has(machineId) || this.failSend) throw new Error("machine not found or offline");
    this.sent.push([machineId, { type: "job.assign", job }]);
  }
  send(machineId: string, msg: HubToAgent): void {
    if (!this.online.has(machineId) || this.failSend) throw new Error("machine not found or offline");
    this.sent.push([machineId, msg]);
  }
  onJobMessage(cb: (machineId: string, msg: AgentToHub) => void): void {
    this.jobListeners.push(cb);
  }
  onConnect(cb: (machineId: string, info: { runningJobs: string[]; runners: string[]; servers: string[] }) => void): void {
    this.connectListeners.push(cb);
  }
  onDisconnect(cb: (machineId: string) => void): void {
    this.disconnectListeners.push(cb);
  }

  connect(machineId: string, runningJobs: string[] = []): void {
    this.online.add(machineId);
    for (const cb of this.connectListeners) cb(machineId, { runningJobs, runners: [], servers: [] });
  }
  drop(machineId: string): void {
    this.online.delete(machineId);
    for (const cb of this.disconnectListeners) cb(machineId);
  }
  agent(machineId: string, msg: AgentToHub): void {
    for (const cb of this.jobListeners) cb(machineId, msg);
  }
}

/** Hand-driven timers for the disconnect grace. */
class Timers {
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  elapsed = 0;
  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.pending.set(id, { at: this.elapsed + ms, fn });
    return id;
  };
  readonly clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  get size(): number {
    return this.pending.size;
  }
  advance(ms: number): void {
    this.elapsed += ms;
    for (const [id, t] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= this.elapsed && this.pending.delete(id)) t.fn();
    }
  }
}

let dir: string;
let clock: number;
let store: Store;
let gateway: FakeGateway;
let timers: Timers;
let alice: User;
let bob: User;
let laptop: Machine;
let desktop: Machine;
const opened: Jobs[] = [];

function pair(owner: User, name: string): Machine {
  const code = store.createPairingCode(owner.id);
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return store.redeemPairingCode(code, name, publicKey)!;
}

function makeJobs(opts: JobsOptions = {}, s: Store = store): Jobs {
  const jobs = new Jobs(s, gateway, {
    now: () => clock,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    disconnectGraceMs: 60_000,
    ...opts,
  });
  jobs.attach();
  opened.push(jobs);
  return jobs;
}

const req = (machine: string, extra: Partial<DelegateRequest> = {}): DelegateRequest => ({
  machine,
  runner: "muse",
  repo: "owner/name",
  branch: "main",
  prompt: "add a README",
  ...extra,
});

function lastAssign(): SignedJob {
  const msg = [...gateway.sent].reverse().find(([, m]) => m.type === "job.assign")?.[1];
  if (msg?.type !== "job.assign") throw new Error("no job.assign sent");
  return msg.job;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hoistline-jobs-"));
  clock = 1_800_000_000_000;
  store = new Store(join(dir, "hub.db"), { now: () => clock });
  gateway = new FakeGateway();
  timers = new Timers();
  alice = store.upsertUser({ provider: "github", subject: "1", login: "alice" });
  bob = store.upsertUser({ provider: "github", subject: "2", login: "bob" });
  laptop = pair(alice, "laptop");
  desktop = pair(bob, "desktop");
});

afterEach(() => {
  for (const jobs of opened.splice(0)) jobs.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("delegate", () => {
  it("inserts a queued job, signs it for the machine and sends it", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    const row = jobs.delegate(alice.id, req(laptop.id, { model: "m1" }));
    expect(row).toMatchObject({ userId: alice.id, machineId: laptop.id, status: "queued", repo: "owner/name" });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    const signed = lastAssign();
    expect(gateway.sent[0]![0]).toBe(laptop.id);
    const verified = verifyJob(signed, hubKey.publicKey, laptop.id, clock);
    expect(verified.userId).toBe(alice.id);
    expect(verified.spec).toEqual({
      jobId: row.id,
      runner: "muse",
      repo: "owner/name",
      baseBranch: "main",
      prompt: "add a README",
      model: "m1",
    });
    expect(jobs.status(alice.id, row.id)).toBe("queued");
  });

  it("refuses an offline machine and inserts nothing", () => {
    const jobs = makeJobs();
    expect(() => jobs.delegate(alice.id, req(laptop.id))).toThrow(MachineOfflineError);
    expect(store.db.prepare("SELECT count(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    expect(gateway.sent).toEqual([]);
  });

  it("answers an unknown and a foreign machine with the identical NotFoundError", () => {
    const jobs = makeJobs();
    gateway.connect(desktop.id);
    const errors = [randomUUID(), desktop.id, "desktop"].map((machine) => {
      try {
        jobs.delegate(alice.id, req(machine));
      } catch (err) {
        return err as Error;
      }
      throw new Error("expected a throw");
    });
    for (const err of errors) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.message).toBe("machine not found");
    }
    expect(gateway.sent).toEqual([]);
  });

  it("resolves a machine by name among accessible machines, and refuses an ambiguous name", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    expect(jobs.delegate(alice.id, req("laptop")).machineId).toBe(laptop.id);

    // Bob's "laptop" is invisible to alice until it is shared with her.
    const bobLaptop = pair(bob, "laptop");
    gateway.connect(bobLaptop.id);
    expect(jobs.delegate(alice.id, req("laptop")).machineId).toBe(laptop.id);
    store.shareMachine(bob.id, bobLaptop.id, `user:${alice.id}`);
    expect(() => jobs.delegate(alice.id, req("laptop"))).toThrow(AmbiguousMachineError);
    // The id still works.
    expect(jobs.delegate(alice.id, req(bobLaptop.id)).machineId).toBe(bobLaptop.id);
  });

  it("validates the request with the job spec schema", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    expect(() => jobs.delegate(alice.id, req(laptop.id, { prompt: "" }))).toThrow();
    expect(() => jobs.delegate(alice.id, req(laptop.id, { runner: "nope" as "muse" }))).toThrow();
    expect(() => jobs.delegate(alice.id, req(laptop.id, { repo: "a\0b" }))).toThrow();
    expect(gateway.sent).toEqual([]);
  });

  it("caps active jobs per user and per machine", () => {
    const jobs = makeJobs({ maxActivePerUser: 2, maxActivePerMachine: 3 });
    gateway.connect(laptop.id);
    const first = jobs.delegate(alice.id, req(laptop.id));
    jobs.delegate(alice.id, req(laptop.id));
    expect(() => jobs.delegate(alice.id, req(laptop.id))).toThrow(TooManyJobsError);
    // Bob, sharing the machine, still has room for one more on it before the machine cap.
    store.shareMachine(alice.id, laptop.id, `user:${bob.id}`);
    jobs.delegate(bob.id, req(laptop.id));
    expect(() => jobs.delegate(bob.id, req(laptop.id))).toThrow(TooManyJobsError);
    // Finished jobs no longer count.
    gateway.agent(laptop.id, { type: "job.result", jobId: first.id, status: "succeeded" });
    expect(jobs.delegate(alice.id, req(laptop.id)).status).toBe("queued");
  });

  it("inserts the row before sending and fails it with dispatch_failed when sending throws", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    let seenAtSend: string | null = null;
    const original = gateway.sendJob.bind(gateway);
    gateway.sendJob = (machineId, job) => {
      seenAtSend = jobs.status(alice.id, job.spec.jobId);
      gateway.failSend = true;
      original(machineId, job);
    };
    expect(() => jobs.delegate(alice.id, req(laptop.id))).toThrow(MachineOfflineError);
    expect(seenAtSend).toBe("queued");
    const row = store.db.prepare("SELECT id, status, reason FROM jobs").get() as { id: string; status: string; reason: string };
    expect(row).toMatchObject({ status: "failed", reason: "dispatch_failed" });
    expect(jobs.result(alice.id, row.id)).toMatchObject({ status: "failed", reason: "dispatch_failed" });
  });
});

describe("visibility", () => {
  it("answers another user's job id exactly like an unknown id", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    const job = jobs.delegate(alice.id, req(laptop.id));
    const unknown = randomUUID();
    expect(jobs.status(bob.id, job.id)).toBeNull();
    expect(jobs.status(bob.id, unknown)).toBeNull();
    expect(jobs.result(bob.id, job.id)).toBeNull();
    expect(jobs.result(bob.id, unknown)).toBeNull();
    expect(jobs.cancel(bob.id, job.id)).toBe(false);
    expect(jobs.cancel(bob.id, unknown)).toBe(false);
    expect(jobs.status(alice.id, job.id)).toBe("queued");
    expect(gateway.sent.filter(([, m]) => m.type === "job.cancel")).toEqual([]);
  });

  it("hides a job from the machine owner when someone else delegated it", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    store.shareMachine(alice.id, laptop.id, `user:${bob.id}`);
    const job = jobs.delegate(bob.id, req(laptop.id));
    expect(jobs.status(alice.id, job.id)).toBeNull();
    expect(jobs.status(bob.id, job.id)).toBe("queued");
  });
});

describe("agent messages", () => {
  function running(jobs: Jobs) {
    gateway.connect(laptop.id);
    const job = jobs.delegate(alice.id, req(laptop.id));
    gateway.agent(laptop.id, { type: "job.event", jobId: job.id, stream: "status", data: "running" });
    return job;
  }

  it("records status events and the final result", () => {
    const jobs = makeJobs();
    const job = running(jobs);
    expect(jobs.status(alice.id, job.id)).toBe("running");
    gateway.agent(laptop.id, { type: "job.event", jobId: job.id, stream: "stdout", data: "hello " });
    gateway.agent(laptop.id, { type: "job.event", jobId: job.id, stream: "stderr", data: "world" });
    gateway.agent(laptop.id, {
      type: "job.result",
      jobId: job.id,
      status: "succeeded",
      exitCode: 0,
      branch: `hoistline/${job.id}`,
      output: "hello world",
    });
    expect(jobs.result(alice.id, job.id)).toEqual({
      jobId: job.id,
      status: "succeeded",
      exitCode: 0,
      branch: `hoistline/${job.id}`,
      output: "hello world",
      truncated: false,
    });
  });

  it("ignores messages from another machine about this machine's job, and about unknown jobs", () => {
    const dropped: string[] = [];
    const jobs = makeJobs({ onDroppedMessage: (machineId) => dropped.push(machineId) });
    const job = running(jobs);
    gateway.connect(desktop.id);
    const before = store.getJob(alice.id, job.id);
    gateway.agent(desktop.id, { type: "job.event", jobId: job.id, stream: "stdout", data: "forged" });
    gateway.agent(desktop.id, { type: "job.event", jobId: job.id, stream: "status", data: "awaiting_approval" });
    gateway.agent(desktop.id, { type: "job.result", jobId: job.id, status: "failed", reason: "forged" });
    gateway.agent(desktop.id, { type: "job.result", jobId: randomUUID(), status: "failed" });
    expect(store.getJob(alice.id, job.id)).toEqual(before);
    expect(jobs.status(alice.id, job.id)).toBe("running");
    expect(dropped).toEqual([desktop.id, desktop.id, desktop.id, desktop.id]);
  });

  it("keeps terminal states immutable and ignores a second result", () => {
    const jobs = makeJobs();
    const job = running(jobs);
    gateway.agent(laptop.id, { type: "job.result", jobId: job.id, status: "failed", exitCode: 3, reason: "runner_exit_3" });
    gateway.agent(laptop.id, { type: "job.result", jobId: job.id, status: "succeeded", branch: `hoistline/${job.id}` });
    gateway.agent(laptop.id, { type: "job.event", jobId: job.id, stream: "status", data: "running" });
    gateway.agent(laptop.id, { type: "job.event", jobId: job.id, stream: "stdout", data: "late" });
    expect(jobs.result(alice.id, job.id)).toEqual({
      jobId: job.id,
      status: "failed",
      exitCode: 3,
      reason: "runner_exit_3",
      output: "",
      truncated: false,
    });
    expect(jobs.cancel(alice.id, job.id)).toBe(false);
  });

  it("only moves status forward", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    const job = jobs.delegate(alice.id, req(laptop.id));
    const status = (data: string) =>
      gateway.agent(laptop.id, { type: "job.event", jobId: job.id, stream: "status", data });
    status("awaiting_approval");
    expect(jobs.status(alice.id, job.id)).toBe("awaiting_approval");
    status("queued");
    status("succeeded");
    expect(jobs.status(alice.id, job.id)).toBe("awaiting_approval");
    status("running");
    expect(jobs.status(alice.id, job.id)).toBe("running");
    status("awaiting_approval");
    expect(jobs.status(alice.id, job.id)).toBe("running");
  });

  it("keeps only the last 64 KiB of output and flags the truncation", () => {
    const jobs = makeJobs();
    const job = running(jobs);
    const chunk = "a".repeat(30_000);
    for (let i = 0; i < 3; i++) gateway.agent(laptop.id, { type: "job.event", jobId: job.id, stream: "stdout", data: chunk });
    gateway.agent(laptop.id, { type: "job.event", jobId: job.id, stream: "stdout", data: "THE END" });
    let result = jobs.result(alice.id, job.id)!;
    expect(Buffer.byteLength(result.output)).toBe(OUTPUT_CAP);
    expect(result.output.endsWith("aTHE END")).toBe(true);
    expect(result.truncated).toBe(true);

    gateway.agent(laptop.id, { type: "job.result", jobId: job.id, status: "succeeded", output: `${"b".repeat(70_000)}tail` });
    result = jobs.result(alice.id, job.id)!;
    expect(Buffer.byteLength(result.output)).toBe(OUTPUT_CAP);
    expect(result.output.endsWith("btail")).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("never cuts a multi-byte character when trimming the tail", () => {
    const jobs = makeJobs();
    const job = running(jobs);
    gateway.agent(laptop.id, { type: "job.event", jobId: job.id, stream: "stdout", data: "€".repeat(30_000) });
    const { output, truncated } = jobs.result(alice.id, job.id)!;
    expect(truncated).toBe(true);
    expect(output).toBe("€".repeat(Math.floor(OUTPUT_CAP / 3)));
  });

  it("keeps a result's branch only when it is this job's hoistline branch", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    const other = jobs.delegate(alice.id, req(laptop.id));
    for (const branch of ["main", `hoistline/${other.id}`, "hoistline/../main", `hoistline/x\u0007`, "refs/heads/x"]) {
      const job = jobs.delegate(alice.id, req(laptop.id));
      gateway.agent(laptop.id, { type: "job.result", jobId: job.id, status: "succeeded", branch });
      expect(jobs.result(alice.id, job.id)!.branch, branch).toBeUndefined();
      expect(jobs.status(alice.id, job.id)).toBe("succeeded");
    }
  });

  it("sanitizes the reason: control characters stripped, at most 500 chars", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    const a = jobs.delegate(alice.id, req(laptop.id));
    const b = jobs.delegate(alice.id, req(laptop.id));
    gateway.agent(laptop.id, { type: "job.result", jobId: a.id, status: "failed", reason: "bad\u001b[31m\nthing\u0000‮!" });
    gateway.agent(laptop.id, { type: "job.result", jobId: b.id, status: "failed", reason: "x".repeat(2000) });
    expect(jobs.result(alice.id, a.id)!.reason).toBe("bad[31mthing!");
    expect(jobs.result(alice.id, b.id)!.reason).toHaveLength(500);
  });
});

describe("cancel", () => {
  it("cancels a queued job immediately and tells the agent", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    const job = jobs.delegate(alice.id, req(laptop.id));
    expect(jobs.cancel(alice.id, job.id)).toBe(true);
    expect(jobs.status(alice.id, job.id)).toBe("cancelled");
    expect(gateway.sent.at(-1)).toEqual([laptop.id, { type: "job.cancel", jobId: job.id }]);
    // A late result from the agent cannot resurrect it.
    gateway.agent(laptop.id, { type: "job.result", jobId: job.id, status: "succeeded" });
    expect(jobs.status(alice.id, job.id)).toBe("cancelled");
  });

  it("asks the agent to cancel a running job and waits for its result", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    const job = jobs.delegate(alice.id, req(laptop.id));
    gateway.agent(laptop.id, { type: "job.event", jobId: job.id, stream: "status", data: "running" });
    expect(jobs.cancel(alice.id, job.id)).toBe(true);
    expect(gateway.sent.at(-1)).toEqual([laptop.id, { type: "job.cancel", jobId: job.id }]);
    expect(jobs.status(alice.id, job.id)).toBe("running");
    gateway.agent(laptop.id, { type: "job.result", jobId: job.id, status: "cancelled" });
    expect(jobs.status(alice.id, job.id)).toBe("cancelled");
  });

  it("fails a running job with agent_disconnected when its agent is offline", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    const job = jobs.delegate(alice.id, req(laptop.id));
    gateway.agent(laptop.id, { type: "job.event", jobId: job.id, stream: "status", data: "awaiting_approval" });
    gateway.online.delete(laptop.id);
    expect(jobs.cancel(alice.id, job.id)).toBe(true);
    expect(jobs.result(alice.id, job.id)).toMatchObject({ status: "failed", reason: "agent_disconnected" });
  });

  it("returns false for a finished job", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    const job = jobs.delegate(alice.id, req(laptop.id));
    gateway.agent(laptop.id, { type: "job.result", jobId: job.id, status: "succeeded" });
    expect(jobs.cancel(alice.id, job.id)).toBe(false);
    expect(jobs.status(alice.id, job.id)).toBe("succeeded");
  });
});

describe("disconnects and restarts", () => {
  function runningOn(jobs: Jobs, machine: Machine, owner: User = alice) {
    const job = jobs.delegate(owner.id, req(machine.id));
    gateway.agent(machine.id, { type: "job.event", jobId: job.id, stream: "status", data: "running" });
    return job;
  }

  it("fails a machine's active jobs with agent_disconnected once the grace runs out", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    gateway.connect(desktop.id);
    const a = runningOn(jobs, laptop);
    const queued = jobs.delegate(alice.id, req(laptop.id));
    const b = runningOn(jobs, desktop, bob);
    gateway.drop(laptop.id);
    timers.advance(59_999);
    expect(jobs.status(alice.id, a.id)).toBe("running");
    timers.advance(1);
    expect(jobs.result(alice.id, a.id)).toMatchObject({ status: "failed", reason: "agent_disconnected" });
    expect(jobs.result(alice.id, queued.id)).toMatchObject({ status: "failed", reason: "agent_disconnected" });
    expect(jobs.status(bob.id, b.id)).toBe("running");
  });

  it("keeps a job the agent still lists when it reconnects within the grace", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    const job = runningOn(jobs, laptop);
    gateway.drop(laptop.id);
    timers.advance(30_000);
    gateway.connect(laptop.id, [job.id]);
    expect(timers.size).toBe(0);
    timers.advance(120_000);
    expect(jobs.status(alice.id, job.id)).toBe("running");
  });

  it("fails jobs the reconnecting agent no longer lists with lost_on_agent", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    const kept = runningOn(jobs, laptop);
    const lost = runningOn(jobs, laptop);
    gateway.drop(laptop.id);
    gateway.connect(laptop.id, [kept.id, randomUUID()]);
    expect(jobs.status(alice.id, kept.id)).toBe("running");
    expect(jobs.result(alice.id, lost.id)).toMatchObject({ status: "failed", reason: "lost_on_agent" });
  });

  it("recovers after a hub restart: timers are armed, and a reconnect reconciles", () => {
    const first = makeJobs();
    gateway.connect(laptop.id);
    gateway.connect(desktop.id);
    const kept = runningOn(first, laptop);
    const lost = runningOn(first, laptop);
    const orphan = runningOn(first, desktop, bob);
    first.close();
    store.close();

    // A new process: new store over the same file, nobody connected yet.
    store = new Store(join(dir, "hub.db"), { now: () => clock });
    gateway = new FakeGateway();
    timers = new Timers();
    const second = makeJobs();
    second.recoverAfterRestart();
    expect(timers.size).toBe(2);
    gateway.connect(laptop.id, [kept.id]);
    expect(second.status(alice.id, kept.id)).toBe("running");
    expect(second.result(alice.id, lost.id)).toMatchObject({ status: "failed", reason: "lost_on_agent" });
    expect(second.status(bob.id, orphan.id)).toBe("running");
    timers.advance(60_000);
    expect(second.result(bob.id, orphan.id)).toMatchObject({ status: "failed", reason: "agent_disconnected" });
    expect(second.status(alice.id, kept.id)).toBe("running");
  });

  it("sweeps jobs older than maxJobAgeMs with timeout", () => {
    const jobs = makeJobs({ maxJobAgeMs: 1000 });
    gateway.connect(laptop.id);
    const old = runningOn(jobs, laptop);
    clock += 600;
    const young = jobs.delegate(alice.id, req(laptop.id));
    const done = jobs.delegate(alice.id, req(laptop.id));
    gateway.agent(laptop.id, { type: "job.result", jobId: done.id, status: "succeeded" });
    jobs.sweep(clock + 401);
    expect(jobs.result(alice.id, old.id)).toMatchObject({ status: "failed", reason: "timeout" });
    expect(jobs.status(alice.id, young.id)).toBe("queued");
    expect(jobs.status(alice.id, done.id)).toBe("succeeded");
  });

  it("stops reacting after close()", () => {
    const jobs = makeJobs();
    gateway.connect(laptop.id);
    const job = runningOn(jobs, laptop);
    gateway.drop(laptop.id);
    jobs.close();
    expect(timers.size).toBe(0);
    gateway.connect(laptop.id, []);
    gateway.agent(laptop.id, { type: "job.result", jobId: job.id, status: "failed" });
    expect(store.getJob(alice.id, job.id)!.status).toBe("running");
  });
});
