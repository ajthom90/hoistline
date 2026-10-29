import { createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { agentAuthPayload, AgentToHub, type HubToAgent, type SignedJob } from "@hoistline/protocol";
import type { Store } from "./store.js";

export const AGENT_PATH = "/agent";

/** Close codes. Authentication failures carry no detail beyond the code. */
export const CLOSE_AUTH_FAILED = 4401;
export const CLOSE_HANDSHAKE_TIMEOUT = 4408;
export const CLOSE_PROTOCOL_ERROR = 4400;
export const CLOSE_REPLACED = 4409;

const MAX_PAYLOAD = 8 * 1024 * 1024;
const ED25519_SIGNATURE_BYTES = 64;

export interface GatewayOptions {
  /** Close connections that have not been welcomed within this time. Default 10 s. */
  handshakeTimeoutMs?: number;
  /** Default 15 s. */
  pingIntervalMs?: number;
  /** A machine with no pong for this long is closed and shows offline. Default 40 s. */
  pongTimeoutMs?: number;
  /** Clock for liveness, in milliseconds. */
  now?: () => number;
}

type Hello = Extract<AgentToHub, { type: "hello" }>;
/** What an agent announced in its hello. */
export type AgentInfo = Omit<Hello, "type" | "signature">;

interface Connection {
  ws: WebSocket;
  info: AgentInfo;
  lastPong: number;
}

type JobMessageListener = (machineId: string, msg: AgentToHub) => void;

/**
 * Agent connections. An agent dials `/agent`, receives a random nonce and must answer with a hello signed by
 * the machine key it registered at pairing. Afterwards every frame must be a valid AgentToHub message.
 */
export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<string, Connection>();
  private readonly listeners: JobMessageListener[] = [];
  private readonly handshakeTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly now: () => number;
  private server?: Server;
  private pingTimer?: NodeJS.Timeout;
  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head);

  constructor(
    private readonly store: Store,
    private readonly hubKey: { privateKey: KeyObject; publicKey: KeyObject },
    opts: GatewayOptions = {},
  ) {
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10_000;
    this.pingIntervalMs = opts.pingIntervalMs ?? 15_000;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? 40_000;
    this.now = opts.now ?? Date.now;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
    this.wss.on("error", () => {});
  }

  /** The hub's job-signing public key, as handed to agents at pairing. */
  get hubPublicKey(): KeyObject {
    return this.hubKey.publicKey;
  }

  attach(server: Server): void {
    if (this.server) throw new Error("gateway already attached");
    this.server = server;
    server.on("upgrade", this.onUpgrade);
    this.pingTimer = setInterval(() => this.checkLiveness(), this.pingIntervalMs);
    this.pingTimer.unref();
  }

  isOnline(machineId: string): boolean {
    return this.connections.get(machineId)?.ws.readyState === 1; // WebSocket.OPEN
  }

  /** The hello of a connected machine (runners, running jobs, MCP servers). */
  agentInfo(machineId: string): AgentInfo | undefined {
    return this.isOnline(machineId) ? this.connections.get(machineId)!.info : undefined;
  }

  /** Throws when the machine is not connected; unknown and offline machines are indistinguishable. */
  sendJob(machineId: string, job: SignedJob): void {
    const ws = this.socket(machineId);
    if (job.machineId !== machineId) throw new Error("job is addressed to a different machine");
    ws.send(JSON.stringify({ type: "job.assign", job } satisfies HubToAgent));
  }

  /** Sends any hub message to a connected machine; throws when it is not connected. */
  send(machineId: string, msg: HubToAgent): void {
    this.socket(machineId).send(JSON.stringify(msg));
  }

  private socket(machineId: string): WebSocket {
    const conn = this.connections.get(machineId);
    if (!conn || conn.ws.readyState !== 1) throw new Error("machine not found or offline");
    return conn.ws;
  }

  /** Every validated message from an authenticated agent other than hello. */
  onJobMessage(cb: JobMessageListener): void {
    this.listeners.push(cb);
  }

  /** Drops a machine's connection (the agent reconnects unless the code tells it not to). */
  disconnect(machineId: string, code = 1001): void {
    this.connections.get(machineId)?.ws.close(code);
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.server?.off("upgrade", this.onUpgrade);
    this.server = undefined;
    for (const ws of this.wss.clients) ws.terminate();
    this.connections.clear();
    this.wss.close();
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = new URL(req.url ?? "/", "http://hub").pathname;
    if (path !== AGENT_PATH) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.handshake(ws));
  }

  private handshake(ws: WebSocket): void {
    ws.on("error", () => {});
    const nonce = randomBytes(32).toString("base64url");
    const timer = setTimeout(() => ws.close(CLOSE_HANDSHAKE_TIMEOUT), this.handshakeTimeoutMs);
    ws.once("close", () => clearTimeout(timer));
    ws.once("message", (data, isBinary) => {
      clearTimeout(timer);
      const hello = parseFrame(data, isBinary);
      const machineId = hello?.type === "hello" ? this.authenticate(hello, nonce) : undefined;
      if (!machineId || hello?.type !== "hello") {
        ws.close(CLOSE_AUTH_FAILED);
        return;
      }
      this.register(machineId, ws, hello);
    });
    ws.send(JSON.stringify({ type: "challenge", nonce } satisfies HubToAgent));
  }

  /** Returns the machine id when the hello is signed over this nonce by that machine's registered key. */
  private authenticate(hello: Hello, nonce: string): string | undefined {
    try {
      const machine = this.store.getMachineById(hello.machineId);
      if (!machine) return undefined;
      const signature = Buffer.from(hello.signature, "base64url");
      if (signature.length !== ED25519_SIGNATURE_BYTES || signature.toString("base64url") !== hello.signature) {
        return undefined;
      }
      const key = createPublicKey({ key: Buffer.from(machine.publicKey, "base64url"), format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ed25519") return undefined;
      return verify(null, agentAuthPayload(machine.id, nonce), key, signature) ? machine.id : undefined;
    } catch {
      return undefined;
    }
  }

  private register(machineId: string, ws: WebSocket, hello: Hello): void {
    const info: AgentInfo = {
      machineId: hello.machineId,
      agentVersion: hello.agentVersion,
      runners: hello.runners,
      runningJobs: hello.runningJobs,
      servers: hello.servers,
    };
    const previous = this.connections.get(machineId);
    const conn: Connection = { ws, info, lastPong: this.now() };
    this.connections.set(machineId, conn);
    previous?.ws.close(CLOSE_REPLACED);
    this.store.markMachineSeen(machineId);

    ws.on("pong", () => {
      conn.lastPong = this.now();
    });
    ws.on("message", (data, isBinary) => {
      const msg = parseFrame(data, isBinary);
      if (!msg || msg.type === "hello") {
        ws.close(CLOSE_PROTOCOL_ERROR);
        return;
      }
      for (const listener of this.listeners) listener(machineId, msg);
    });
    ws.on("close", () => {
      if (this.connections.get(machineId) === conn) this.connections.delete(machineId);
    });
    ws.send(JSON.stringify({ type: "welcome" } satisfies HubToAgent));
  }

  private checkLiveness(): void {
    const now = this.now();
    for (const [machineId, conn] of this.connections) {
      if (now - conn.lastPong > this.pongTimeoutMs) {
        this.connections.delete(machineId);
        conn.ws.terminate();
      } else {
        conn.ws.ping();
      }
    }
  }
}

function parseFrame(data: RawData, isBinary: boolean): AgentToHub | undefined {
  if (isBinary) return undefined;
  try {
    const result = AgentToHub.safeParse(JSON.parse(data.toString()));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
