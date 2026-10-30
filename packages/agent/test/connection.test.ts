import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { connect, type AgentConnection } from "../src/connection.js";
import type { AgentIdentity } from "../src/identity.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A fake hub that completes the handshake on every connection; `pingEveryMs` makes it ping afterwards. */
async function fakeHub(pingEveryMs?: number) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  let connections = 0;
  const timers: NodeJS.Timeout[] = [];
  wss.on("connection", (ws: WebSocket) => {
    connections++;
    ws.send(JSON.stringify({ type: "challenge", nonce: "n" }));
    ws.once("message", () => {
      ws.send(JSON.stringify({ type: "welcome" }));
      if (pingEveryMs !== undefined) {
        const t = setInterval(() => ws.ping(), pingEveryMs);
        timers.push(t);
        ws.on("close", () => clearInterval(t));
      }
    });
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearInterval(t);
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  );
  const port = (wss.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, connections: () => connections };
}

function identity(hubUrl: string): AgentIdentity {
  const machine = generateKeyPairSync("ed25519");
  const hub = generateKeyPairSync("ed25519");
  return { machineId: "m1", hubUrl, privateKey: machine.privateKey, hubPublicKey: hub.publicKey };
}

function startAgent(hubUrl: string, idleTimeoutMs: number) {
  const events: string[] = [];
  const conn: AgentConnection = connect(
    identity(hubUrl),
    {
      hello: () => ({ agentVersion: "0.0.0", runners: [], runningJobs: [], servers: [] }),
      onMessage: () => {},
      onConnected: () => events.push("connected"),
      onDisconnected: ({ willReconnect }) => events.push(willReconnect ? "dropped" : "stopped"),
    },
    { initialDelayMs: 10, maxDelayMs: 20, idleTimeoutMs },
  );
  cleanups.push(() => conn.close());
  return { conn, events };
}

async function waitFor(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("agent liveness", () => {
  it("drops and reconnects when the hub goes silent after the handshake", async () => {
    const hub = await fakeHub();
    const { events } = startAgent(hub.url, 100);
    await waitFor(() => events.includes("connected"), "first connection");
    await waitFor(() => events.includes("dropped"), "idle drop");
    await waitFor(() => events.filter((e) => e === "connected").length >= 2, "reconnect");
    expect(hub.connections()).toBeGreaterThanOrEqual(2);
  });

  it("stays connected while the hub keeps pinging", async () => {
    const hub = await fakeHub(20);
    const { conn, events } = startAgent(hub.url, 100);
    await waitFor(() => events.includes("connected"), "connection");
    await new Promise((r) => setTimeout(r, 400));
    expect(events).toEqual(["connected"]);
    expect(conn.connected).toBe(true);
    expect(hub.connections()).toBe(1);
  });
});
