import { createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as connectTcp, type AddressInfo } from "node:net";
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
      // "/" separates owner and machine in "<owner>/<machine>" references.
      { code, name: "bob/prod", publicKey },
      { code, name: "a", publicKey: "not-a-key" },
      { code, name: "a", publicKey: publicKeyOf(rsa) },
      { code, name: "a", publicKey, extra: 1 },
    ]) {
      expect((await postPair(hub, body)).status).toBe(400);
    }
    expect((await postPair(hub, { code, name: "x".repeat(100), publicKey })).status).toBe(200);
  });

  it("answers malformed JSON, an oversized body or a wrong content type with a JSON 400", async () => {
    const hub = await startHub();
    const post = (body: string, type = "application/json") =>
      fetch(`${hub.url}/pair`, { method: "POST", headers: { "content-type": type }, body });
    const publicKey = publicKeyOf(generateKeyPairSync("ed25519").publicKey);
    const code = hub.store.createPairingCode(hub.alice.id);
    for (const res of [
      await post("{not json"),
      await post(JSON.stringify({ code, name: "a", publicKey, pad: "x".repeat(10_000) })),
      await post(JSON.stringify({ code, name: "a", publicKey }), "text/plain"),
    ]) {
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    // None of these consumed the code.
    expect((await postPair(hub, { code, name: "a", publicKey })).status).toBe(200);
  });

  it("accepts printable names only, trimmed", async () => {
    const hub = await startHub();
    const publicKey = publicKeyOf(generateKeyPairSync("ed25519").publicKey);
    const code = hub.store.createPairingCode(hub.alice.id);
    for (const name of ["   ", "lap\ntop", "lap\u0000top", "evil‮txt.exe", "a⁦b", "x​y"]) {
      expect((await postPair(hub, { code, name, publicKey })).status, JSON.stringify(name)).toBe(400);
    }
    const res = await postPair(hub, { code, name: "  Büro-Laptop 2  ", publicKey });
    expect(res.status).toBe(200);
    const { machineId } = (await res.json()) as { machineId: string };
    expect(hub.store.getMachine(hub.alice.id, machineId)!.name).toBe("Büro-Laptop 2");
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

  it("drops a peer that ignores the close frame after a failed handshake", async () => {
    const hub = await startHub({ handshakeTimeoutMs: 50 });
    const { port } = new URL(hub.url);
    const socket = connectTcp(Number(port), "127.0.0.1");
    cleanups.push(() => void socket.destroy());
    let closedAt: number | undefined;
    socket.on("close", () => (closedAt = Date.now()));
    socket.on("error", () => {});
    socket.on("data", () => {}); // read, but never answer the close frame
    await new Promise<void>((r) => socket.once("connect", () => r()));
    const started = Date.now();
    socket.write(
      "GET /agent HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await waitFor(() => closedAt !== undefined, "terminate", 3000);
    expect(closedAt! - started).toBeLessThan(2500);
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

describe("connection lifecycle hooks", () => {
  function track(hub: Hub) {
    const events: string[] = [];
    const infos: unknown[] = [];
    hub.gateway.onConnect((machineId, info) => {
      events.push(`connect:${machineId}`);
      infos.push(info);
    });
    hub.gateway.onDisconnect((machineId) => events.push(`disconnect:${machineId}`));
    return { events, infos };
  }

  it("delivers the hello info on connect and fires on close", async () => {
    const hub = await startHub();
    const identity = await pairAs(hub, hub.alice);
    const { events, infos } = track(hub);
    const agent = new RawAgent(hub);
    const nonce = await agent.nonce();
    const signature = sign(null, agentAuthPayload(identity.machineId, nonce), identity.privateKey).toString("base64url");
    agent.ws.send(
      JSON.stringify({
        type: "hello",
        machineId: identity.machineId,
        agentVersion: "0.0.0",
        runners: ["muse"],
        runningJobs: ["job-a", "job-b"],
        servers: ["fs"],
        signature,
      } satisfies AgentToHub),
    );
    await agent.welcomed();
    expect(events).toEqual([`connect:${identity.machineId}`]);
    expect(infos).toEqual([{ runningJobs: ["job-a", "job-b"], runners: ["muse"], servers: ["fs"] }]);
    agent.ws.close();
    await waitFor(() => events.length === 2, "disconnect");
    expect(events[1]).toBe(`disconnect:${identity.machineId}`);
  });

  it("does not fire on connect for a failed handshake", async () => {
    const hub = await startHub();
    const identity = await pairAs(hub, hub.alice);
    const { events } = track(hub);
    const agent = new RawAgent(hub);
    await agent.hello(identity.machineId, identity.privateKey, "wrong-nonce");
    await agent.closed();
    expect(events).toEqual([]);
  });

  it("does not fire disconnect when a newer connection of the same machine replaces the old one", async () => {
    const hub = await startHub();
    const identity = await pairAs(hub, hub.alice);
    const { events } = track(hub);
    const first = await authenticated(hub, identity);
    const second = await authenticated(hub, identity);
    await first.closed();
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([`connect:${identity.machineId}`, `connect:${identity.machineId}`]);
    second.ws.close();
    await waitFor(() => events.length === 3, "disconnect");
    expect(events[2]).toBe(`disconnect:${identity.machineId}`);
  });

  it("fires disconnect once when liveness drops a silent agent", async () => {
    const hub = await startHub({ pingIntervalMs: 20, pongTimeoutMs: 150 });
    const identity = await pairAs(hub, hub.alice);
    const { events } = track(hub);
    const silent = await authenticated(hub, identity, { autoPong: false });
    await silent.closed();
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toEqual([`connect:${identity.machineId}`, `disconnect:${identity.machineId}`]);
  });

  it("does not fire disconnect when the hub itself closes", async () => {
    const hub = await startHub();
    const identity = await pairAs(hub, hub.alice);
    const { events } = track(hub);
    const agent = await authenticated(hub, identity);
    hub.gateway.close();
    await agent.closed();
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([`connect:${identity.machineId}`]);
  });

  it("exposes the hub signing key so jobs can be signed with it", async () => {
    const hub = await startHub();
    const key = hub.store.getOrCreateSigningKey();
    expect(hub.gateway.hubPrivateKey.export({ format: "pem", type: "pkcs8" })).toEqual(
      key.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
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

  it("closes only the affected socket with 1011 when a job-message listener throws", async () => {
    const hub = await startHub();
    const failing = await pairAs(hub, hub.alice, "failing");
    const healthy = await pairAs(hub, hub.alice, "healthy");
    const delivered: string[] = [];
    hub.gateway.onJobMessage((machineId) => {
      if (machineId === failing.machineId) throw new Error("listener bug");
      delivered.push(machineId);
    });
    const a = await authenticated(hub, failing);
    const b = await authenticated(hub, healthy);
    const event = JSON.stringify({ type: "job.event", jobId: "j", stream: "stdout", data: "x" });
    a.ws.send(event);
    await a.closed();
    expect(a.closeCode).toBe(1011);
    b.ws.send(event);
    await waitFor(() => delivered.length === 1, "delivery to the healthy machine");
    expect(hub.gateway.isOnline(healthy.machineId)).toBe(true);
    expect(b.closeCode).toBeUndefined();
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

  function addToken(token: string, identity: UserIdentity): void {
    IDENTITIES[token] = identity;
    cleanups.push(() => void delete IDENTITIES[token]);
  }

  it("maps the token identity to the hub user, never to a login string", async () => {
    const hub = await startHub();
    await pairAs(hub, hub.alice, "alice-laptop");
    // A different, signed-in GitHub account whose token carries the login "alice" sees nothing of alice's.
    hub.store.upsertUser({ provider: "github", subject: "99", login: "someone" });
    addToken("token-impostor", { provider: "github", subject: "99", name: "alice", identifiers: [] });
    expect((await listMachines(hub, "token-impostor")).machines).toEqual([]);
    expect(hub.store.machinesFor(hub.alice.id)).toHaveLength(1);
  });

  it("never writes a token's saved (possibly stale) login back to the users table", async () => {
    const hub = await startHub();
    // Mallory once held the GitHub login "bob" and renamed; her old token still says "bob".
    const mallory = hub.store.upsertUser({ provider: "github", subject: "3", login: "mallory" });
    addToken("token-mallory-old", { provider: "github", subject: "3", name: "bob", identifiers: [] });
    expect((await listMachines(hub, "token-mallory-old")).machines).toEqual([]);
    expect(hub.store.getUser(hub.bob.id)!.login).toBe("bob");
    expect(hub.store.getUser(mallory.id)!.login).toBe("mallory");
    expect(hub.store.getUser(hub.alice.id)!.login).toBe("alice");
    // A share to github:bob still reaches the real bob.
    const machine = await pairAs(hub, hub.alice);
    expect(hub.store.shareMachine(hub.alice.id, machine.machineId, "github:bob").id).toBe(hub.bob.id);
  });

  it("answers 401 for a token whose user has no hub row, and creates none", async () => {
    const hub = await startHub();
    addToken("token-ghost", { provider: "github", subject: "77", name: "ghost", identifiers: [] });
    const res = await fetch(`${hub.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-ghost",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`resource_metadata="${hub.url}/.well-known/oauth-protected-resource"`);
    expect(hub.store.getUserByKey("github", "77")).toBeNull();
  });

  it("keys OIDC users on issuer and subject", () => {
    const oidc: UserIdentity = { provider: "oidc", subject: "s-1", issuer: "https://id.test", name: "ada", identifiers: [] };
    expect(userKey(oidc)).toEqual({ provider: "oidc:https://id.test", subject: "s-1" });
    expect(userKey({ ...oidc, issuer: undefined })).toBeUndefined();
    expect(userKey(IDENTITIES["token-alice"]!)).toEqual({ provider: "github", subject: "1" });
  });
});
