import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connect,
  createExecutor,
  pairMachine,
  registerRunner,
  type AgentConnection,
  type AgentIdentity,
  type ApprovalRequest,
  type Executor,
  type PolicyConfig,
} from "@hoistline/agent";
import { InMemoryOAuthProvider } from "../src/auth/in-memory-provider.js";
import { Gateway } from "../src/gateway.js";
import { Jobs } from "../src/jobs.js";
import { createApp } from "../src/server.js";
import { Store, type User } from "../src/store.js";

/*
 * End to end: a real hub (createApp, Store, Gateway, Jobs) on an ephemeral port and a real agent (pairMachine,
 * connect, createExecutor) running a fake `muse` (a node script) against a local bare remote.
 */

const FIXTURE_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const ID = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false"];
const fx = (args: string[], cwd?: string) =>
  execFileSync("git", [...ID, ...args], { cwd, env: FIXTURE_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The fake runner: writes files into the worktree, prints, and optionally waits for a gate file to appear. */
const RUNNER_SOURCE = `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [cwd, prompt] = process.argv.slice(2);
const p = JSON.parse(prompt);
process.stdout.write("fake muse working\\n");
for (const [file, content] of Object.entries(p.write ?? {})) writeFileSync(join(cwd, file), content);
while (p.gate && !existsSync(p.gate)) await new Promise((r) => setTimeout(r, 20));
`;

let dir: string;
let remote: string;
const cleanups: (() => void | Promise<void>)[] = [];

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "hoistline-e2e-fixture-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  remote = join(root, "remote.git");
  const seed = join(root, "seed");
  fx(["init", "-q", "--bare", "-b", "main", remote]);
  fx(["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "README"), "main\n");
  fx(["add", "README"], seed);
  fx(["commit", "-q", "-m", "main"], seed);
  fx(["push", "-q", remote, "main"], seed);
  const script = join(root, "runner.mjs");
  writeFileSync(script, RUNNER_SOURCE);
  // Started by absolute path: no runner CLI is ever looked up on PATH here.
  registerRunner("muse", { file: process.execPath, args: (spec, ctx) => [script, ctx.cwd!, spec.prompt] });
  return () => {
    for (const fn of cleanups.splice(0).reverse()) void fn();
  };
});

const perTest: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hoistline-e2e-"));
});
afterEach(async () => {
  for (const fn of perTest.splice(0).reverse()) await fn();
  rmSync(dir, { recursive: true, force: true });
});

interface Hub {
  url: string;
  store: Store;
  gateway: Gateway;
  jobs: Jobs;
  owner: User;
  stop(): Promise<void>;
}

async function startHub(opts: { port?: number; graceMs?: number } = {}): Promise<Hub> {
  const store = new Store(join(dir, "hub.db"));
  const gateway = new Gateway(store, store.getOrCreateSigningKey(), { pingIntervalMs: 100, pongTimeoutMs: 2000 });
  const jobs = new Jobs(store, gateway, { disconnectGraceMs: opts.graceMs ?? 5000 });
  jobs.attach();
  jobs.recoverAfterRestart();
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    "request",
    createApp({
      publicUrl: url,
      github: { clientId: "gh-client", clientSecret: "gh-secret" },
      oauthProvider: new InMemoryOAuthProvider(),
      store,
      gateway,
      jobs,
    }),
  );
  gateway.attach(server);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    jobs.close();
    gateway.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  };
  perTest.push(stop);
  const owner = store.upsertUser({ provider: "github", subject: "1", login: "alice" });
  return { url, store, gateway, jobs, owner, stop };
}

type Agent = {
  conn: AgentConnection;
  executor: Executor;
  /** runningJobs of every hello sent. */
  hellos: string[][];
  /** Opens a new connection for the same executor (the previous one must be closed). */
  reconnect(): AgentConnection;
};

function startAgent(
  identity: AgentIdentity,
  opts: { policy?: PolicyConfig; requestApproval?: (req: ApprovalRequest) => Promise<boolean> } = {},
): Agent {
  let current: AgentConnection | undefined = undefined;
  const hellos: string[][] = [];
  const executor = createExecutor({
    machineId: identity.machineId,
    hubPublicKey: identity.hubPublicKey,
    cacheDir: join(dir, "agent-cache"),
    loadPolicy: () => opts.policy ?? { mode: "trusted" },
    requestApproval: opts.requestApproval,
    send: (msg) => {
      if (!current) throw new Error("not connected");
      current.send(msg);
    },
    prepareOptions: { remoteFor: () => remote, allowFileProtocol: true },
  });
  const open = () => {
    current = connect(
      identity,
      {
        hello: () => {
          const runningJobs = executor.runningJobs();
          hellos.push(runningJobs);
          return { agentVersion: "0.0.0", runners: ["muse"], runningJobs, servers: [] };
        },
        onMessage: (msg) => executor.onMessage(msg),
        // Unacknowledged results go out again after every welcome.
        onConnected: () => executor.flushOutbox(),
      },
      { initialDelayMs: 20, maxDelayMs: 100 },
    );
    return current;
  };
  const agent: Agent = {
    conn: open(),
    executor,
    hellos,
    reconnect: () => (agent.conn = open()),
  };
  perTest.push(async () => {
    agent.conn.close();
    await executor.close();
  });
  return agent;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const remoteFile = (branch: string, file: string) => fx(["show", `refs/heads/${branch}:${file}`], remote);

async function pairedAgent(hub: Hub, opts: Parameters<typeof startAgent>[1] = {}) {
  const identity = await pairMachine(hub.url, hub.store.createPairingCode(hub.owner.id), "laptop");
  const agent = startAgent(identity, opts);
  await waitFor(() => hub.gateway.isOnline(identity.machineId), "agent online");
  return { identity, agent, ...agent };
}

const outboxFile = (jobId: string) => join(dir, "agent-cache", "outbox", `${jobId}.json`);

function delegate(hub: Hub, machine: string, script: { write?: Record<string, string>; gate?: string }) {
  return hub.jobs.delegate(hub.owner.id, {
    machine,
    runner: "muse",
    repo: "https://github.com/Owner/Name.git",
    branch: "main",
    prompt: JSON.stringify(script),
  });
}

describe("end to end", () => {
  it("delegates a job that runs on the agent and pushes its branch", async () => {
    const hub = await startHub();
    const { identity } = await pairedAgent(hub);
    const job = delegate(hub, "laptop", { write: { "result.txt": "done by muse\n" } });
    await waitFor(() => hub.jobs.status(hub.owner.id, job.id) === "succeeded", "job to succeed");
    const result = hub.jobs.result(hub.owner.id, job.id)!;
    expect(result).toMatchObject({ status: "succeeded", branch: `hoistline/${job.id}`, exitCode: 0, truncated: false });
    expect(result.output).toContain("fake muse working");
    expect(remoteFile(`hoistline/${job.id}`, "result.txt")).toBe("done by muse\n");
    expect(existsSync(join(dir, "agent-cache", "work", job.id))).toBe(false);
    expect(hub.store.getJobById(job.id)?.machineId).toBe(identity.machineId);
  });

  it("fails a job with agent_disconnected when its agent dies mid-run", async () => {
    const hub = await startHub({ graceMs: 300 });
    const { conn, executor } = await pairedAgent(hub);
    const job = delegate(hub, "laptop", { gate: join(dir, "never") });
    await waitFor(() => hub.jobs.status(hub.owner.id, job.id) === "running", "job running");
    // The agent process goes away: its socket closes and it never reports again.
    conn.close();
    await executor.close();
    await waitFor(() => hub.jobs.status(hub.owner.id, job.id) !== "running", "job to end", 5000);
    expect(hub.jobs.result(hub.owner.id, job.id)).toMatchObject({ status: "failed", reason: "agent_disconnected" });
  });

  it("keeps a running job across a hub restart when the agent comes back listing it", async () => {
    let hub = await startHub({ graceMs: 2000 });
    const port = Number(new URL(hub.url).port);
    const { identity, executor } = await pairedAgent(hub);
    const gate = join(dir, "gate");
    const job = delegate(hub, "laptop", { write: { "restart.txt": "survived\n" }, gate });
    await waitFor(() => hub.jobs.status(hub.owner.id, job.id) === "running", "job running");

    await hub.stop();
    hub = await startHub({ port, graceMs: 2000 });
    await waitFor(() => hub.gateway.isOnline(identity.machineId), "agent reconnects");
    expect(executor.runningJobs()).toEqual([job.id]);
    // Past the grace: reconciliation, not the timer, decided the job's fate.
    await new Promise((r) => setTimeout(r, 2300));
    expect(hub.jobs.status(hub.owner.id, job.id)).toBe("running");

    writeFileSync(gate, "");
    await waitFor(() => hub.jobs.status(hub.owner.id, job.id) === "succeeded", "job to succeed");
    expect(hub.jobs.result(hub.owner.id, job.id)).toMatchObject({ branch: `hoistline/${job.id}` });
    expect(remoteFile(`hoistline/${job.id}`, "restart.txt")).toBe("survived\n");
  });

  it("delivers a result produced while the agent was disconnected once it reconnects, then forgets it", async () => {
    const hub = await startHub({ graceMs: 10_000 });
    const { identity, agent } = await pairedAgent(hub);
    const gate = join(dir, "gate");
    const job = delegate(hub, "laptop", { write: { "offline.txt": "finished offline\n" }, gate });
    await waitFor(() => hub.jobs.status(hub.owner.id, job.id) === "running", "job running");

    agent.conn.close();
    await waitFor(() => !hub.gateway.isOnline(identity.machineId), "hub notices the disconnect");
    writeFileSync(gate, "");
    await waitFor(() => existsSync(outboxFile(job.id)), "result stored in the outbox");
    expect(hub.jobs.status(hub.owner.id, job.id)).toBe("running");

    agent.reconnect();
    await waitFor(() => hub.jobs.status(hub.owner.id, job.id) === "succeeded", "replayed result lands");
    expect(agent.hellos.at(-1)).toEqual([job.id]);
    expect(hub.jobs.result(hub.owner.id, job.id)).toMatchObject({ branch: `hoistline/${job.id}` });
    expect(remoteFile(`hoistline/${job.id}`, "offline.txt")).toBe("finished offline\n");
    await waitFor(() => !existsSync(outboxFile(job.id)), "ack removes the outbox entry");
    expect(agent.executor.runningJobs()).toEqual([]);
  });

  it("replaces agent_disconnected with the real outcome when the result arrives after the grace", async () => {
    const hub = await startHub({ graceMs: 300 });
    const { identity, agent } = await pairedAgent(hub);
    const gate = join(dir, "gate");
    const job = delegate(hub, "laptop", { write: { "late.txt": "late\n" }, gate });
    await waitFor(() => hub.jobs.status(hub.owner.id, job.id) === "running", "job running");

    agent.conn.close();
    await waitFor(() => hub.jobs.status(hub.owner.id, job.id) === "failed", "grace expires");
    expect(hub.jobs.result(hub.owner.id, job.id)).toMatchObject({ reason: "agent_disconnected" });
    writeFileSync(gate, "");
    await waitFor(() => existsSync(outboxFile(job.id)), "result stored in the outbox");

    agent.reconnect();
    await waitFor(() => hub.jobs.status(hub.owner.id, job.id) === "succeeded", "late result upgrades the job");
    expect(hub.jobs.result(hub.owner.id, job.id)).toMatchObject({ branch: `hoistline/${job.id}` });
    await waitFor(() => !existsSync(outboxFile(job.id)), "ack removes the outbox entry");
    expect(hub.gateway.isOnline(identity.machineId)).toBe(true);
  });

  it("cancels on reconnect a job cancelled on the hub while it awaited approval offline; a later approval runs nothing", async () => {
    let approve: (ok: boolean) => void = () => {};
    const hub = await startHub({ graceMs: 10_000 });
    const { identity, agent } = await pairedAgent(hub, {
      policy: { mode: "restricted", repos: ["someone/else"], runners: ["muse"], onViolation: "ask" },
      requestApproval: () => new Promise<boolean>((r) => (approve = r)),
    });
    const job = delegate(hub, "laptop", { write: { "never.txt": "x" } });
    await waitFor(() => hub.jobs.status(hub.owner.id, job.id) === "awaiting_approval", "awaiting approval");

    agent.conn.close();
    await waitFor(() => !hub.gateway.isOnline(identity.machineId), "hub notices the disconnect");
    expect(hub.jobs.cancel(hub.owner.id, job.id)).toBe(true);
    expect(hub.jobs.status(hub.owner.id, job.id)).toBe("failed");

    agent.reconnect();
    await waitFor(() => hub.jobs.status(hub.owner.id, job.id) === "cancelled", "agent cancels it");
    await waitFor(() => agent.executor.runningJobs().length === 0, "agent forgets it");
    approve(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(hub.jobs.status(hub.owner.id, job.id)).toBe("cancelled");
    expect(existsSync(join(dir, "agent-cache", "work", job.id))).toBe(false);
    expect(() => remoteFile(`hoistline/${job.id}`, "never.txt")).toThrow();
  });
});
