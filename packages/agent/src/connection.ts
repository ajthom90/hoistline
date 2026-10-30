import { sign } from "node:crypto";
import WebSocket from "ws";
import { agentAuthPayload, AgentToHub, HubToAgent, type RunnerName } from "@hoistline/protocol";
import type { AgentIdentity } from "./identity.js";
import { parseHubUrl } from "./pair.js";

/** Close codes the hub uses; the agent does not reconnect after these. */
export const CLOSE_AUTH_FAILED = 4401;
export const CLOSE_REPLACED = 4409;
const FATAL_CLOSE_CODES = new Set([CLOSE_AUTH_FAILED, CLOSE_REPLACED]);
/** The agent closes with this when the hub sends something unexpected. */
const CLOSE_PROTOCOL_ERROR = 4400;

const MAX_PAYLOAD = 8 * 1024 * 1024;

/**
 * Default idle window: the hub pings every 15 s (gateway.ts), so 45 s of silence (3 missed pings) means the
 * connection is dead, typically half-open after sleep or a network change.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

export interface AgentHandlers {
  /** State announced in the hello on every (re)connect. */
  hello(): { agentVersion: string; os?: string; runners: RunnerName[]; runningJobs: string[]; servers: string[] };
  /** Every validated hub message after the handshake. */
  onMessage(msg: HubToAgent): void;
  /** The hub accepted the handshake. */
  onConnected?(): void;
  /** The socket closed; `willReconnect` is false after close(), or when the hub refused this machine or replaced the connection. */
  onDisconnected?(info: { code: number; willReconnect: boolean }): void;
}

export interface AgentConnection {
  /** True between the hub's welcome and the next disconnect. */
  readonly connected: boolean;
  /** Sends a message to the hub; throws when not connected. */
  send(msg: AgentToHub): void;
  /** Closes the connection and stops reconnecting. */
  close(): void;
}

export interface ConnectOptions {
  /** First reconnect delay; doubles per failed attempt up to maxDelayMs. Default 1 s. */
  initialDelayMs?: number;
  /** Default 60 s. */
  maxDelayMs?: number;
  /** Give up on a connection that has not been welcomed within this time. Default 10 s. */
  handshakeTimeoutMs?: number;
  /**
   * After the handshake, drop the connection (and reconnect) when nothing, not even a ping, has arrived from the
   * hub for this long. Default 45 s; must comfortably exceed the hub's ping interval (15 s).
   */
  idleTimeoutMs?: number;
  /** Jitter source in [0, 1). */
  random?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** The hub's WebSocket endpoint for a hub base URL: ws(s)://host/agent. */
export function agentSocketUrl(hubUrl: string): string {
  const url = parseHubUrl(hubUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/agent";
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * Keeps an outbound WebSocket to the hub: proves the machine key on each connection, dispatches validated hub
 * messages and reconnects with capped exponential backoff plus jitter. Pings are answered by the socket; a hub that
 * sends nothing (no message, ping or pong) for the idle window is treated as gone and the socket is terminated.
 */
export function connect(identity: AgentIdentity, handlers: AgentHandlers, opts: ConnectOptions = {}): AgentConnection {
  const url = agentSocketUrl(identity.hubUrl);
  const initialDelay = opts.initialDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 60_000;
  const handshakeTimeout = opts.handshakeTimeoutMs ?? 10_000;
  const idleTimeout = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const random = opts.random ?? Math.random;
  const setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));

  let socket: WebSocket | undefined;
  let connected = false;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: unknown;

  function open(): void {
    reconnectTimer = undefined;
    if (stopped) return;
    const ws = new WebSocket(url, { maxPayload: MAX_PAYLOAD });
    socket = ws;
    let phase: "challenge" | "welcome" | "ready" = "challenge";
    const handshakeTimer = setTimer(() => ws.terminate(), handshakeTimeout);
    let idleTimer: unknown;
    let closed = false;
    // Any sign of life from the hub (message, ping, pong) pushes the idle deadline back. A half-open TCP connection
    // never errors on an idle agent, so this deadline is what notices it and hands over to the reconnect backoff.
    const touch = (): void => {
      if (phase !== "ready" || closed) return;
      if (idleTimer !== undefined) clearTimer(idleTimer);
      idleTimer = setTimer(() => ws.terminate(), idleTimeout);
      // Never keep the process alive just for this timer.
      (idleTimer as { unref?: () => void } | undefined)?.unref?.();
    };

    ws.on("error", () => {
      // A close event follows; reconnecting is handled there.
    });
    ws.on("ping", touch);
    ws.on("pong", touch);
    ws.on("message", (data, isBinary) => {
      touch();
      const msg = isBinary ? undefined : parse(data.toString());
      if (!msg) return ws.close(CLOSE_PROTOCOL_ERROR);
      if (phase === "challenge") {
        if (msg.type !== "challenge") return ws.close(CLOSE_PROTOCOL_ERROR);
        const signature = sign(null, agentAuthPayload(identity.machineId, msg.nonce), identity.privateKey);
        const hello: AgentToHub = {
          type: "hello",
          ...handlers.hello(),
          machineId: identity.machineId,
          signature: signature.toString("base64url"),
        };
        ws.send(JSON.stringify(hello));
        phase = "welcome";
      } else if (phase === "welcome") {
        if (msg.type !== "welcome") return ws.close(CLOSE_PROTOCOL_ERROR);
        clearTimer(handshakeTimer);
        phase = "ready";
        connected = true;
        attempt = 0;
        touch();
        handlers.onConnected?.();
      } else {
        if (msg.type === "challenge" || msg.type === "welcome") return ws.close(CLOSE_PROTOCOL_ERROR);
        handlers.onMessage(msg);
      }
    });
    ws.on("close", (code) => {
      closed = true;
      clearTimer(handshakeTimer);
      if (idleTimer !== undefined) clearTimer(idleTimer);
      idleTimer = undefined;
      if (socket !== ws) return;
      socket = undefined;
      connected = false;
      const willReconnect = !stopped && !FATAL_CLOSE_CODES.has(code);
      if (willReconnect) scheduleReconnect();
      else stopped = true;
      handlers.onDisconnected?.({ code, willReconnect });
    });
  }

  function scheduleReconnect(): void {
    const capped = Math.min(maxDelay, initialDelay * 2 ** attempt);
    attempt = Math.min(attempt + 1, 30);
    // Equal jitter: half fixed, half random, so a fleet of agents does not reconnect in lockstep.
    reconnectTimer = setTimer(open, capped / 2 + random() * (capped / 2));
  }

  open();

  return {
    get connected() {
      return connected;
    },
    send(msg: AgentToHub): void {
      if (!connected || !socket) throw new Error("not connected to the hub");
      socket.send(JSON.stringify(AgentToHub.parse(msg)));
    },
    close(): void {
      stopped = true;
      if (reconnectTimer !== undefined) clearTimer(reconnectTimer);
      reconnectTimer = undefined;
      socket?.close(1000);
    },
  };
}

function parse(text: string): HubToAgent | undefined {
  try {
    const result = HubToAgent.safeParse(JSON.parse(text));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
