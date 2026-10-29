import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { connect, pairMachine, type AgentConnection, type AgentIdentity } from "@hoistline/agent";
import { agentAuthPayload, signJob, verifyJob, type AgentToHub, type HubToAgent } from "@hoistline/protocol";
import { InMemoryOAuthProvider } from "../src/auth/in-memory-provider.js";
import { userKey, type UserIdentity } from "../src/auth/identity.js";
import { Gateway, type GatewayOptions } from "../src/gateway.js";
import { createApp } from "../src/server.js";
import { Store, type User } from "../src/store.js";

/** Bearer tokens map straight to identities; the login flow itself is covered in mcp-endpoint.test.ts. */
const IDENTITIES: Record<string, UserIdentity> = {
  "token-alice": { provider: "github", subject: "1", name: "alice", identifiers: [] },
  "token-bob": { provider: "github", subject: "2", name: "bob", identifiers: [] },
};

class TokenProvider extends InMemoryOAuthProvider {
  override async verifyAccessToken(token: string): Promise<AuthInfo> {
    const user = IDENTITIES[token];
    if (!user) throw new InvalidTokenError("Invalid or expired access token");
    return { token, clientId: "test", scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { user } };
  }
}

interface Hub {
  url: string;
  store: Store;
  gateway: Gateway;
  alice: User;
  bob: User;
}

let dir: string;
let clock: number;
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hoistline-gateway-"));
  clock = Date.now();
});

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  rmSync(dir, { recursive: true, force: true });
});

async function startHub(opts: GatewayOptions = {}): Promise<Hub> {
  const store = new Store(join(dir, "hub.db"), { now: () => clock });
  cleanups.push(() => store.close());
  const gateway = new Gateway(store, store.getOrCreateSigningKey(), {
    handshakeTimeoutMs: 2000,
    pingIntervalMs: 50,
    pongTimeoutMs: 1000,
    ...opts,
  });
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    "request",
    createApp({
      publicUrl: url,
      github: { clientId: "gh-client", clientSecret: "gh-secret" },
      oauthProvider: new TokenProvider(),
      store,
      gateway,
    }),
  );
  gateway.attach(server);
  cleanups.push(async () => {
    gateway.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  // Same provider/subject the hub derives from the identities above.
  const alice = store.upsertUser({ provider: "github", subject: "1", login: "alice" });
  const bob = store.upsertUser({ provider: "github", subject: "2", login: "bob" });
  return { url, store, gateway, alice, bob };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function postPair(hub: Hub, body: unknown, ip?: string): Promise<Response> {
  return fetch(`${hub.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: JSON.stringify(body),
  });
}

function publicKeyOf(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("base64url");
}

async function pairAs(hub: Hub, owner: User, name = "laptop"): Promise<AgentIdentity> {
  return pairMachine(hub.url, hub.store.createPairingCode(owner.id), name);
}

/** A hand-driven agent socket. Records the close code and every hub message. */
class RawAgent {
  readonly ws: WebSocket;
  readonly messages: HubToAgent[] = [];
  closeCode?: number;
  readonly opened: Promise<void>;

  constructor(hub: Hub, opts: { autoPong?: boolean } = {}) {
    this.ws = new WebSocket(`${hub.url.replace("http", "ws")}/agent`, { autoPong: opts.autoPong ?? true });
    this.ws.on("message", (data) => this.messages.push(JSON.parse(data.toString()) as HubToAgent));
    this.ws.on("close", (code) => (this.closeCode = code));
    this.ws.on("error", () => {});
    this.opened = new Promise((r) => this.ws.once("open", () => r()));
    cleanups.push(() => this.ws.terminate());
  }

  async nonce(): Promise<string> {
    await waitFor(() => this.messages.length > 0, "challenge");
    const challenge = this.messages[0]!;
    if (challenge.type !== "challenge") throw new Error(`expected challenge, got ${challenge.type}`);
    return challenge.nonce;
  }

  async hello(machineId: string, key: KeyObject, signedNonce?: string): Promise<void> {
    const nonce = await this.nonce();
    const signature = sign(null, agentAuthPayload(machineId, signedNonce ?? nonce), key).toString("base64url");
    const hello: AgentToHub = {
      type: "hello",
      machineId,
      agentVersion: "0.0.0",
      runners: [],
      runningJobs: [],
      servers: [],
      signature,
    };
    this.ws.send(JSON.stringify(hello));
  }

  welcomed(): Promise<void> {
    return waitFor(() => this.messages.some((m) => m.type === "welcome"), "welcome");
  }

  closed(): Promise<void> {
    return waitFor(() => this.closeCode !== undefined, "close");
  }
}

async function authenticated(hub: Hub, identity: AgentIdentity, opts: { autoPong?: boolean } = {}) {
  const agent = new RawAgent(hub, opts);
  await agent.hello(identity.machineId, identity.privateKey);
  await agent.welcomed();
  return agent;
}

async function listMachines(hub: Hub, token: string) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${hub.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  try {
    const result = await client.callTool({ name: "list_machines", arguments: {} });
    return result.structuredContent as {
      machines: { id: string; name: string; online: boolean; owner: string; shared: boolean }[];
    };
  } finally {
    await client.close();
  }
}

describe("POST /pair", () => {
  it("pairs a machine with a valid code and returns an identity", async () => {
    const hub = await startHub();
    const identity = await pairAs(hub, hub.alice, "laptop");
    const machine = hub.store.getMachine(hub.alice.id, identity.machineId);
    expect(machine).toMatchObject({ name: "laptop", ownerId: hub.alice.id });
    expect(machine!.publicKey).toBe(publicKeyOf(createPublicKey(identity.privateKey)));
    expect(publicKeyOf(identity.hubPublicKey)).toBe(publicKeyOf(hub.store.getOrCreateSigningKey().publicKey));
  });

  it("answers a reused, expired or unknown code with the same 400", async () => {
    const hub = await startHub();
    const publicKey = publicKeyOf(generateKeyPairSync("ed25519").publicKey);
    const code = hub.store.createPairingCode(hub.alice.id);
    expect((await postPair(hub, { code, name: "a", publicKey })).status).toBe(200);

    const reused = await postPair(hub, { code, name: "a", publicKey });
    const unknown = await postPair(hub, { code: "AAAA-BBBB-CCCC", name: "a", publicKey });
    const stale = hub.store.createPairingCode(hub.alice.id);
    clock += 10 * 60 * 1000 + 1;
    const expired = await postPair(hub, { code: stale, name: "a", publicKey });

    const bodies = [];
    for (const res of [reused, unknown, expired]) {
      expect(res.status).toBe(400);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(hub.store.machinesFor(hub.alice.id)).toHaveLength(1);
  });

  it("rejects a bad name or key without consuming the code", async () => {
    const hub = await startHub();
    const publicKey = publicKeyOf(generateKeyPairSync("ed25519").publicKey);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey;
    const code = hub.store.createPairingCode(hub.alice.id);
    for (const body of [
      { code, name: "", publicKey },
      { code, name: "x".repeat(101), publicKey },
      { code, name: "a", publicKey: "not-a-key" },
      { code, name: "a", publicKey: publicKeyOf(rsa) },
      { code, name: "a", publicKey, extra: 1 },
    ]) {
      expect((await postPair(hub, body)).status).toBe(400);
    }
    expect((await postPair(hub, { code, name: "x".repeat(100), publicKey })).status).toBe(200);
  });

  it("allows 10 attempts per minute per client IP, then answers 429", async () => {
    const hub = await startHub();
    const body = { code: "AAAA-BBBB-CCCC", name: "a", publicKey: "x" };
    for (let i = 0; i < 10; i++) expect((await postPair(hub, body, "203.0.113.7")).status).toBe(400);
    expect((await postPair(hub, body, "203.0.113.7")).status).toBe(429);
    // The proxy-forwarded address is the key (loopback proxies are trusted), so another client is unaffected.
    expect((await postPair(hub, body, "203.0.113.8")).status).toBe(400);
    clock += 60_001;
    expect((await postPair(hub, body, "203.0.113.7")).status).toBe(400);
  });
});

describe("agent handshake", () => {
  it("welcomes an agent that signs the nonce with its machine key", async () => {
    const hub = await startHub();
    const identity = await pairAs(hub, hub.alice);
    expect(hub.gateway.isOnline(identity.machineId)).toBe(false);
    await authenticated(hub, identity);
    expect(hub.gateway.isOnline(identity.machineId)).toBe(true);
    expect(hub.store.getMachineById(identity.machineId)!.lastSeenAt).toBe(clock);
  });

  it("closes with 4401 when the signature is over a different nonce", async () => {
    const hub = await startHub();
    const identity = await pairAs(hub, hub.alice);
    const agent = new RawAgent(hub);
    await agent.hello(identity.machineId, identity.privateKey, "some-other-nonce");
    await agent.closed();
    expect(agent.closeCode).toBe(4401);
    expect(agent.messages.map((m) => m.type)).toEqual(["challenge"]);
    expect(hub.gateway.isOnline(identity.machineId)).toBe(false);
  });

  it("closes with 4401 when an agent claims another machine's id with its own key", async () => {
    const hub = await startHub();
    const victim = await pairAs(hub, hub.alice, "victim");
    const attacker = await pairAs(hub, hub.bob, "attacker");
    const agent = new RawAgent(hub);
    await agent.hello(victim.machineId, attacker.privateKey);
    await agent.closed();
    expect(agent.closeCode).toBe(4401);
    expect(hub.gateway.isOnline(victim.machineId)).toBe(false);
  });

  it("closes with 4401 for an unknown machine id", async () => {
    const hub = await startHub();
    const agent = new RawAgent(hub);
    await agent.hello("6f9c2a52-4c55-4f3f-9a55-3a2d9a0c1e11", generateKeyPairSync("ed25519").privateKey);
    await agent.closed();
    expect(agent.closeCode).toBe(4401);
  });

  it("closes a connection that does not finish the handshake in time", async () => {
    const hub = await startHub({ handshakeTimeoutMs: 100 });
    const agent = new RawAgent(hub);
    await agent.nonce();
    await agent.closed();
    expect(agent.closeCode).toBe(4408);
  });

  it("closes the socket on a malformed frame, before or after the handshake", async () => {
    const hub = await startHub();
    const identity = await pairAs(hub, hub.alice);

    const early = new RawAgent(hub);
    await early.nonce();
    early.ws.send("{not json");
    await early.closed();
    expect(early.closeCode).toBe(4401);

    const late = await authenticated(hub, identity);
    late.ws.send(JSON.stringify({ type: "job.event", jobId: "j", stream: "bogus", data: "" }));
    await late.closed();
    expect(late.closeCode).toBe(4400);
    await waitFor(() => !hub.gateway.isOnline(identity.machineId), "offline");
  });

  it("replaces an older connection for the same machine", async () => {
    const hub = await startHub();
    const identity = await pairAs(hub, hub.alice);
    const first = await authenticated(hub, identity);
    const second = await authenticated(hub, identity);
    await first.closed();
    expect(first.closeCode).toBe(4409);
    expect(second.closeCode).toBeUndefined();
    expect(hub.gateway.isOnline(identity.machineId)).toBe(true);
  });
});

describe("liveness", () => {
  it("marks an agent that stops answering pings offline", async () => {
    const hub = await startHub({ pingIntervalMs: 20, pongTimeoutMs: 150 });
    const identity = await pairAs(hub, hub.alice);
    const responsive = await pairAs(hub, hub.alice, "responsive");
    const silent = await authenticated(hub, identity, { autoPong: false });
    await authenticated(hub, responsive);
    expect((await listMachines(hub, "token-alice")).machines.find((m) => m.id === identity.machineId)?.online).toBe(
      true,
    );

    await silent.closed();
    expect(hub.gateway.isOnline(identity.machineId)).toBe(false);
    expect(hub.gateway.isOnline(responsive.machineId)).toBe(true);
    const { machines } = await listMachines(hub, "token-alice");
    expect(machines.find((m) => m.id === identity.machineId)?.online).toBe(false);
    expect(machines.find((m) => m.id === responsive.machineId)?.online).toBe(true);
  });
});

describe("agent connection", () => {
  function startAgent(identity: AgentIdentity, received: HubToAgent[] = []) {
    const events: string[] = [];
    const conn: AgentConnection = connect(
      identity,
      {
        hello: () => ({ agentVersion: "0.0.0", runners: ["build-test"], runningJobs: [], servers: [] }),
        onMessage: (msg) => received.push(msg),
        onConnected: () => events.push("connected"),
        onDisconnected: ({ willReconnect }) => events.push(willReconnect ? "dropped" : "stopped"),
      },
      { initialDelayMs: 20, maxDelayMs: 100 },
    );
    cleanups.push(() => conn.close());
    return { conn, events };
  }

  it("reconnects after the hub drops the socket", async () => {
    const hub = await startHub();
    const identity = await pairAs(hub, hub.alice);
    const { conn, events } = startAgent(identity);
    await waitFor(() => conn.connected && hub.gateway.isOnline(identity.machineId), "first connection");

    hub.gateway.disconnect(identity.machineId);
    await waitFor(() => events.includes("dropped"), "drop");
    await waitFor(() => events.filter((e) => e === "connected").length === 2, "reconnect");
    expect(hub.gateway.isOnline(identity.machineId)).toBe(true);
    expect(hub.gateway.agentInfo(identity.machineId)?.runners).toEqual(["build-test"]);
  });

  it("stops reconnecting after the hub refuses the machine", async () => {
    const hub = await startHub();
    const identity = await pairAs(hub, hub.alice);
    const forged = { ...identity, privateKey: generateKeyPairSync("ed25519").privateKey };
    const { events } = startAgent(forged);
    await waitFor(() => events.includes("stopped"), "stop");
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toEqual(["stopped"]);
  });

  it("carries signed jobs to the agent and job messages back to the hub", async () => {
    const hub = await startHub();
    const identity = await pairAs(hub, hub.alice);
    const received: HubToAgent[] = [];
    const { conn } = startAgent(identity, received);
    const fromAgents: [string, AgentToHub][] = [];
    hub.gateway.onJobMessage((machineId, msg) => fromAgents.push([machineId, msg]));
    await waitFor(() => conn.connected && hub.gateway.isOnline(identity.machineId), "connection");

    const spec = { jobId: "job-1", runner: "build-test" as const, repo: "o/r", baseBranch: "main", prompt: "p" };
    const job = signJob(spec, hub.alice.id, identity.machineId, hub.store.getOrCreateSigningKey().privateKey);
    hub.gateway.sendJob(identity.machineId, job);
    await waitFor(() => received.length === 1, "job");
    const assigned = received[0]!;
    if (assigned.type !== "job.assign") throw new Error("expected job.assign");
    expect(verifyJob(assigned.job, identity.hubPublicKey, identity.machineId).spec).toEqual(spec);

    conn.send({ type: "job.event", jobId: "job-1", stream: "stdout", data: "hi" });
    await waitFor(() => fromAgents.length === 1, "job event");
    expect(fromAgents[0]).toEqual([identity.machineId, { type: "job.event", jobId: "job-1", stream: "stdout", data: "hi" }]);
  });

  it("refuses to send a job to an offline, unknown or mismatched machine", async () => {
    const hub = await startHub();
    const identity = await pairAs(hub, hub.alice);
    const spec = { jobId: "job-1", runner: "build-test" as const, repo: "o/r", baseBranch: "main", prompt: "p" };
    const key = hub.store.getOrCreateSigningKey().privateKey;
    const job = signJob(spec, hub.alice.id, identity.machineId, key);
    expect(() => hub.gateway.sendJob(identity.machineId, job)).toThrow(/not found or offline/);
    expect(() => hub.gateway.sendJob("unknown", job)).toThrow(/not found or offline/);
    await authenticated(hub, identity);
    const other = signJob(spec, hub.alice.id, "another-machine", key);
    expect(() => hub.gateway.sendJob(identity.machineId, other)).toThrow();
  });
});

describe("list_machines", () => {
  it("lists only the caller's own and shared machines", async () => {
    const hub = await startHub();
    const alicePrivate = await pairAs(hub, hub.alice, "alice-private");
    const aliceShared = await pairAs(hub, hub.alice, "alice-shared");
    const bobOwn = await pairAs(hub, hub.bob, "bob-desktop");
    hub.store.shareMachine(hub.alice.id, aliceShared.machineId, `user:${hub.bob.id}`);
    await authenticated(hub, aliceShared);

    const forBob = (await listMachines(hub, "token-bob")).machines;
    expect(forBob.map((m) => m.id)).not.toContain(alicePrivate.machineId);
    const byName = <T extends { name: string }>(list: T[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));
    expect(byName(forBob)).toEqual([
      { id: aliceShared.machineId, name: "alice-shared", online: true, owner: "alice", shared: true },
      { id: bobOwn.machineId, name: "bob-desktop", online: false, owner: "bob", shared: false },
    ]);

    const forAlice = (await listMachines(hub, "token-alice")).machines;
    expect(byName(forAlice).map((m) => [m.name, m.shared])).toEqual([
      ["alice-private", false],
      ["alice-shared", false],
    ]);
  });

  it("maps the token identity to the hub user, never to a login string", async () => {
    const hub = await startHub();
    await pairAs(hub, hub.alice, "alice-laptop");
    // A different GitHub account that has taken the login "alice" sees nothing of the original alice's.
    IDENTITIES["token-impostor"] = { provider: "github", subject: "99", name: "alice", identifiers: [] };
    cleanups.push(() => void delete IDENTITIES["token-impostor"]);
    expect((await listMachines(hub, "token-impostor")).machines).toEqual([]);
    expect(hub.store.machinesFor(hub.alice.id)).toHaveLength(1);
  });

  it("keys OIDC users on issuer and subject", () => {
    const oidc: UserIdentity = { provider: "oidc", subject: "s-1", issuer: "https://id.test", name: "ada", identifiers: [] };
    expect(userKey(oidc)).toEqual({ provider: "oidc:https://id.test", subject: "s-1" });
    expect(userKey({ ...oidc, issuer: undefined })).toBeUndefined();
    expect(userKey(IDENTITIES["token-alice"]!)).toEqual({ provider: "github", subject: "1" });
  });
});
