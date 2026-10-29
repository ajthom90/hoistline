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
export const CLOSE_INTERNAL_ERROR = 1011;
/** How long a peer gets to answer our close frame before the socket is terminated. */
const CLOSE_GRACE_MS = 1000;

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

/** What onConnect listeners receive from the agent's hello. */
export interface ConnectInfo {
  runningJobs: string[];
  runners: string[];
  servers: string[];
}

type JobMessageListener = (machineId: string, msg: AgentToHub) => void;
type ConnectListener = (machineId: string, info: ConnectInfo) => void;
type DisconnectListener = (machineId: string) => void;

/**
 * Agent connections. An agent dials `/agent`, receives a random nonce and must answer with a hello signed by
 * the machine key it registered at pairing. Afterwards every frame must be a valid AgentToHub message.
 */
export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<string, Connection>();
  private readonly listeners: JobMessageListener[] = [];
  private readonly connectListeners: ConnectListener[] = [];
  private readonly disconnectListeners: DisconnectListener[] = [];
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

  /** The hub's job-signing private key, for Jobs, which signs every job it sends. */
  get hubPrivateKey(): KeyObject {
    return this.hubKey.privateKey;
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

  /**
   * Called after a machine authenticated (after its welcome was sent), on every connect including one that replaces
   * an older connection, with what its hello announced. A throwing listener is ignored.
   */
  onConnect(cb: ConnectListener): void {
    this.connectListeners.push(cb);
  }

  /**
   * Called when a machine's current authenticated connection ends: the socket closed, or liveness dropped it. NOT
   * called when the connection is replaced by a newer connection of the same machine (the machine never went
   * offline), nor when the gateway itself closes. A throwing listener is ignored.
   */
  onDisconnect(cb: DisconnectListener): void {
    this.disconnectListeners.push(cb);
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
    const timer = setTimeout(() => closeHard(ws, CLOSE_HANDSHAKE_TIMEOUT), this.handshakeTimeoutMs);
    ws.once("close", () => clearTimeout(timer));
    ws.once("message", (data, isBinary) => {
      clearTimeout(timer);
      const hello = parseFrame(data, isBinary);
      const machineId = hello?.type === "hello" ? this.authenticate(hello, nonce) : undefined;
      if (!machineId || hello?.type !== "hello") {
        closeHard(ws, CLOSE_AUTH_FAILED);
        return;
      }
      try {
        this.register(machineId, ws, hello);
      } catch {
        closeHard(ws, CLOSE_INTERNAL_ERROR);
      }
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
    // Throws (and the caller closes the socket) before the connection is registered if the store fails.
    this.store.markMachineSeen(machineId);
    const previous = this.connections.get(machineId);
    const conn: Connection = { ws, info, lastPong: this.now() };
    this.connections.set(machineId, conn);
    if (previous) closeHard(previous.ws, CLOSE_REPLACED);

    ws.on("pong", () => {
      conn.lastPong = this.now();
    });
    ws.on("message", (data, isBinary) => {
      const msg = parseFrame(data, isBinary);
      if (!msg || msg.type === "hello") {
        closeHard(ws, CLOSE_PROTOCOL_ERROR);
        return;
      }
      try {
        for (const listener of this.listeners) listener(machineId, msg);
      } catch {
        // A failing listener costs this machine its connection, never the hub its process.
        closeHard(ws, CLOSE_INTERNAL_ERROR);
      }
    });
    ws.on("close", () => {
      // Not the current connection: replaced, already dropped by liveness, or the gateway closed.
      if (this.connections.get(machineId) !== conn) return;
      this.connections.delete(machineId);
      this.emitDisconnect(machineId);
    });
    ws.send(JSON.stringify({ type: "welcome" } satisfies HubToAgent));
    const connectInfo: ConnectInfo = {
      runningJobs: [...info.runningJobs],
      runners: [...info.runners],
      servers: [...info.servers],
    };
    for (const listener of this.connectListeners) {
      try {
        listener(machineId, connectInfo);
      } catch {
        // A listener bug must not cost the agent its connection.
      }
    }
  }

  private emitDisconnect(machineId: string): void {
    for (const listener of this.disconnectListeners) {
      try {
        listener(machineId);
      } catch {
        // Ignored, see onDisconnect.
      }
    }
  }

  private checkLiveness(): void {
    const now = this.now();
    for (const [machineId, conn] of this.connections) {
      if (now - conn.lastPong > this.pongTimeoutMs) {
        // Deleted first, so the close event that follows does not report the machine a second time.
        this.connections.delete(machineId);
        conn.ws.terminate();
        this.emitDisconnect(machineId);
      } else {
        conn.ws.ping();
      }
    }
  }
}

/** Sends a close frame, then drops the TCP connection if the peer has not completed the close in time. */
function closeHard(ws: WebSocket, code: number): void {
  ws.close(code);
  const timer = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);
  timer.unref();
  ws.once("close", () => clearTimeout(timer));
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
