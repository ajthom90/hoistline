import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToHub, HubToAgent } from "@hoistline/protocol";
import { z } from "zod";
import { escapeForTerminal } from "./approvals.js";
import { trackProcessGroup } from "./children.js";
import { agentHome } from "./identity.js";
import { evaluateToolCall, type PolicyConfig } from "./policy.js";

/** Server names: lowercase letters, digits and dashes, no dots (a policy entry is `server.tool`). */
export const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_SERVERS = 32;

/** The refusal for a tool the policy would `ask` about: a tool call is synchronous and cannot wait. */
export const ASK_DENIED_REASON =
  "this tool needs the owner's approval, which direct mode cannot wait for; ask the owner to allow it in the policy";

const ServerConfigSchema = z
  .object({
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(65_536)).max(1000),
    env: z.record(z.string().min(1).max(1000), z.string().max(65_536)).optional(),
    cwd: z.string().min(1).max(4096).optional(),
  })
  .strict();

/** Strict schema for `<agentHome>/servers.json`. Only the owner edits it; the hub can never add or change servers. */
export const ServersFileSchema = z
  .object({
    servers: z
      .record(z.string().regex(SERVER_NAME, "server names are lowercase letters, digits and dashes"), ServerConfigSchema)
      .refine((s) => Object.keys(s).length <= MAX_SERVERS, `at most ${MAX_SERVERS} servers`),
  })
  .strict();

export type ServerConfig = { command: string; args: string[]; env?: Record<string, string>; cwd?: string };

/** `$HOISTLINE_AGENT_HOME/servers.json`, defaulting to `~/.hoistline/servers.json`. */
export function defaultServersPath(env: Record<string, string | undefined> = process.env): string {
  return join(agentHome(env), "servers.json");
}

/**
 * Reads the owner's stdio MCP servers. A missing file means no servers. An unreadable or invalid file also means no
 * servers (fail closed), with `error` saying why. Never throws.
 */
export function loadServers(path: string): { servers: Record<string, ServerConfig>; error?: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { servers: {} };
    return { servers: {}, error: `servers file ${path} is invalid or unreadable: ${(err as Error).message}` };
  }
  try {
    return { servers: ServersFileSchema.parse(JSON.parse(text)).servers as Record<string, ServerConfig> };
  } catch (err) {
    const why = err instanceof z.ZodError ? z.prettifyError(err).replace(/\s*\n\s*/g, "; ") : (err as Error).message;
    return { servers: {}, error: `servers file ${path} is invalid: ${why}` };
  }
}

export interface ProxiedTool {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpProxyOptions {
  /** Per-call timeout. Default 55 s (the hub gives up after 60 s). */
  callTimeoutMs?: number;
  /** Timeout for starting a server and listing its tools. Default 30 s. */
  listTimeoutMs?: number;
  /** Where the agent's own environment comes from (for PATH, HOME, ...). Default process.env. */
  baseEnv?: Record<string, string | undefined>;
  /** Log lines (already escaped). Default: stderr. */
  log?: (line: string) => void;
  /** Timer for restarts after a crash. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const DEFAULT_CALL_TIMEOUT_MS = 55_000;
const DEFAULT_LIST_TIMEOUT_MS = 30_000;
const RESTART_INITIAL_MS = 1000;
const RESTART_MAX_MS = 60_000;
/** A server that stayed up this long before crashing restarts from the shortest delay again. */
const STABLE_UPTIME_MS = RESTART_MAX_MS;
/** Protocol limits of AgentToHub tools.list (see @hoistline/protocol). */
const MAX_TOOL_NAME = 200;
const MAX_DESCRIPTION = 2000;
const MAX_TOOLS_PER_SERVER = 500;
/** Description plus schema of one tool; larger tools are left out. */
const MAX_TOOL_BYTES = 64 * 1024;
/** What one tools.list or tools.result frame may carry; the hub connection's limit is 8 MiB. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** Text kept of a result too large for the hub connection. The hub caps results at 1 MiB anyway. */
const RESULT_TEXT_KEEP = 1024 * 1024;
const MAX_ERROR = 10_000;
const MAX_STDERR_LINES = 1000;
const MAX_STDERR_LINE = 300;

/** The environment a server gets before its configured env: only what a program needs to run. */
function minimalEnv(base: Record<string, string | undefined>): Record<string, string> {
  const keys =
    process.platform === "win32" ? ["PATH", "Path", "USERPROFILE", "LANG", "SYSTEMROOT", "TEMP"] : ["PATH", "HOME", "LANG"];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Stdio transport for the SDK Client that spawns the server in its own process group (POSIX) and registers it with
 * the children registry, so a forced stop SIGKILLs the server and everything it started. Gets exactly the env given.
 */
class ServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private child?: ChildProcessWithoutNullStreams;
  private readonly buffer = new ReadBuffer();

  constructor(
    private readonly params: { command: string; args: string[]; env: Record<string, string>; cwd?: string },
    private readonly onStderr: (line: string) => void,
  ) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.params.command, this.params.args, {
          env: this.params.env,
          cwd: this.params.cwd,
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(err as Error);
        return;
      }
      this.child = child;
      const untrack = trackProcessGroup(child.pid);
      let spawned = false;
      child.once("spawn", () => {
        spawned = true;
        resolve();
      });
      child.on("error", (err) => {
        if (!spawned) reject(err);
        else this.onerror?.(err);
      });
      child.once("close", () => {
        untrack();
        this.child = undefined;
        this.onclose?.();
      });
      child.stdin.on("error", (err) => this.onerror?.(err));
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          this.buffer.append(chunk);
          for (let msg = this.buffer.readMessage(); msg !== null; msg = this.buffer.readMessage()) this.onmessage?.(msg);
        } catch (err) {
          this.onerror?.(err as Error);
        }
      });
      const decoder = new StringDecoder("utf8");
      let partial = "";
      child.stderr.on("data", (chunk: Buffer) => {
        const lines = (partial + decoder.write(chunk)).split("\n");
        partial = lines.pop() ?? "";
        if (partial.length > MAX_STDERR_LINE) {
          lines.push(partial);
          partial = "";
        }
        for (const line of lines) this.onStderr(line);
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child) return reject(new Error("server is not running"));
      if (child.stdin.write(serializeMessage(message))) resolve();
      else child.stdin.once("drain", resolve);
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const within = (ms: number) =>
      Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    if (await within(2000)) return;
    signal(child, "SIGTERM");
    if (await within(2000)) return;
    signal(child, "SIGKILL");
  }
}

/** Signals the server's whole process group on POSIX, the process itself on Windows. */
function signal(child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    // Already gone.
  }
}

interface ServerState {
  readonly name: string;
  readonly config: ServerConfig;
  client?: Client;
  transport?: ServerTransport;
  starting?: Promise<Client>;
  startedAt: number;
  /** Consecutive crashes; picks the next restart delay. */
  crashes: number;
  restartTimer?: unknown;
  restartAt?: number;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Direct mode on the agent: proxies the owner's stdio MCP servers (from servers.json) for the hub. Each server starts
 * on first use, keeps running, and is restarted with backoff after a crash. The policy is evaluated on every list
 * and call; `ask` counts as deny.
 */
export class McpProxy {
  private readonly states = new Map<string, ServerState>();
  private readonly loadPolicy: () => PolicyConfig;
  private readonly callTimeoutMs: number;
  private readonly listTimeoutMs: number;
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly log: (line: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private closed = false;

  /** The delay before restart number `crashes + 1`: 1 s, 2 s, 4 s ... at most 60 s. */
  static restartDelay(crashes: number): number {
    return Math.min(RESTART_MAX_MS, RESTART_INITIAL_MS * 2 ** Math.min(crashes, 30));
  }

  constructor(
    servers: Record<string, ServerConfig>,
    policy: PolicyConfig | (() => PolicyConfig),
    opts: McpProxyOptions = {},
  ) {
    for (const [name, config] of Object.entries(servers)) {
      this.states.set(name, { name, config, startedAt: 0, crashes: 0 });
    }
    this.loadPolicy = typeof policy === "function" ? policy : () => policy;
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.listTimeoutMs = opts.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.baseEnv = opts.baseEnv ?? process.env;
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms).unref());
    this.clearTimer = opts.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** The configured server names (for the hello). */
  serverNames(): string[] {
    return [...this.states.keys()];
  }

  /** True while the server's process is up and initialized. */
  isRunning(server: string): boolean {
    return this.states.get(server)?.client !== undefined;
  }

  /** Every tool the policy allows (trusted: all), from every server that could be started. */
  async listTools(): Promise<ProxiedTool[]> {
    const policy = this.loadPolicy();
    const lists = await Promise.all(
      [...this.states.values()].map(async (state) => {
        try {
          const client = await this.ensure(state);
          const tools: ProxiedTool[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 20; page++) {
            const r = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.listTimeoutMs });
            for (const t of r.tools) {
              if (evaluateToolCall(policy, state.name, t.name).result !== "allow") continue;
              const tool: ProxiedTool = { server: state.name, name: t.name };
              if (typeof t.description === "string") tool.description = t.description;
              if (isPlainObject(t.inputSchema)) tool.inputSchema = t.inputSchema;
              tools.push(tool);
            }
            cursor = r.nextCursor;
            if (!cursor) break;
          }
          return tools;
        } catch (err) {
          this.log(`direct mode: server ${escapeForTerminal(state.name)}: cannot list tools: ${escapeForTerminal(message(err))}`);
          return [];
        }
      }),
    );
    return lists.flat();
  }

  /** Calls a tool if the policy allows it now. Throws with the reason otherwise, or when the call fails. */
  async call(server: string, tool: string, args: unknown): Promise<unknown> {
    const decision = evaluateToolCall(this.loadPolicy(), server, tool);
    if (decision.result === "ask") throw new Error(ASK_DENIED_REASON);
    if (decision.result !== "allow") throw new Error(decision.reason);
    const state = this.states.get(server);
    if (!state) throw new Error(`unknown server ${JSON.stringify(server)}`);
    if (!isPlainObject(args)) throw new Error("tool arguments must be an object");
    const client = await this.ensure(state);
    return await client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.callTimeoutMs });
  }

  /** Answers the hub's tools.list and tools.call; ignores everything else. Never throws. */
  onMessage(msg: HubToAgent, send: (msg: AgentToHub) => void): void {
    const reply = (m: AgentToHub) => {
      try {
        send(m);
      } catch (err) {
        this.log(`direct mode: cannot answer the hub: ${escapeForTerminal(message(err))}`);
      }
    };
    try {
      if (msg?.type === "tools.list") {
        const callId = msg.callId;
        void this.listTools()
          .then((tools) => reply({ type: "tools.list", callId, servers: this.inventory(tools) }))
          .catch(() => reply({ type: "tools.list", callId, servers: [] }));
      } else if (msg?.type === "tools.call") {
        const callId = msg.callId;
        void this.call(msg.server, msg.tool, msg.args)
          .then((result) => reply({ type: "tools.result", callId, ok: true, result: fitResult(result) }))
          .catch((err: unknown) => reply({ type: "tools.result", callId, ok: false, error: message(err).slice(0, MAX_ERROR) }));
      }
    } catch {
      // A malformed message must not take the connection down.
    }
  }

  /** Stops every server and any pending restart. Later lists and calls fail. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.states.values()].map(async (state) => {
        if (state.restartTimer !== undefined) this.clearTimer(state.restartTimer);
        state.restartTimer = undefined;
        const transport = state.transport;
        state.client = undefined;
        state.transport = undefined;
        try {
          await state.starting;
        } catch {
          // Failed to start: nothing to stop.
        }
        await (state.transport ?? transport)?.close();
      }),
    );
  }

  /** Groups tools by server and fits them to the protocol and frame limits. */
  private inventory(tools: ProxiedTool[]): Extract<AgentToHub, { type: "tools.list" }>["servers"] {
    const servers = new Map<string, { name: string; tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] }>();
    for (const name of this.states.keys()) servers.set(name, { name, tools: [] });
    let budget = MAX_FRAME_BYTES;
    let dropped = 0;
    for (const t of tools) {
      const entry = servers.get(t.server);
      if (!entry || t.name.length > MAX_TOOL_NAME || entry.tools.length >= MAX_TOOLS_PER_SERVER) {
        dropped++;
        continue;
      }
      const info: { name: string; description?: string; inputSchema?: Record<string, unknown> } = { name: t.name };
      if (t.description !== undefined) info.description = t.description.slice(0, MAX_DESCRIPTION);
      if (t.inputSchema !== undefined) info.inputSchema = t.inputSchema;
      let size: number;
      try {
        size = Buffer.byteLength(JSON.stringify(info));
      } catch {
        dropped++;
        continue;
      }
      if (size > MAX_TOOL_BYTES || size > budget) {
        dropped++;
        continue;
      }
      budget -= size;
      entry.tools.push(info);
    }
    if (dropped > 0) this.log(`direct mode: ${dropped} tools left out of the list sent to the hub (too large or too many)`);
    return [...servers.values()];
  }

  private ensure(state: ServerState): Promise<Client> {
    if (this.closed) return Promise.reject(new Error("direct mode is shut down"));
    if (state.client) return Promise.resolve(state.client);
    if (state.starting) return state.starting;
    if (state.restartTimer !== undefined) {
      const secs = Math.max(1, Math.ceil(((state.restartAt ?? Date.now()) - Date.now()) / 1000));
      return Promise.reject(new Error(`server ${JSON.stringify(state.name)} stopped unexpectedly; restarting in ${secs} s`));
    }
    state.starting = this.start(state).finally(() => {
      state.starting = undefined;
    });
    return state.starting;
  }

  private async start(state: ServerState): Promise<Client> {
    let stderrLines = 0;
    const transport = new ServerTransport(
      {
        command: state.config.command,
        args: state.config.args,
        env: { ...minimalEnv(this.baseEnv), ...state.config.env },
        cwd: state.config.cwd,
      },
      (line) => {
        stderrLines++;
        if (stderrLines > MAX_STDERR_LINES) return;
        const shown = line.length > MAX_STDERR_LINE ? `${line.slice(0, MAX_STDERR_LINE)}...` : line;
        this.log(`server ${escapeForTerminal(state.name)}: ${escapeForTerminal(shown)}`);
        if (stderrLines === MAX_STDERR_LINES) this.log(`server ${escapeForTerminal(state.name)}: further stderr output not shown`);
      },
    );
    const client = new Client({ name: "hoistline-agent", version: "0.0.0" });
    client.onerror = () => {
      // Transport errors surface as failed requests or a close.
    };
    let intentional = false;
    state.transport = transport;
    transport.onclose = () => {
      if (state.transport === transport) {
        state.transport = undefined;
        state.client = undefined;
      }
      if (!intentional && !this.closed) this.crashed(state);
    };
    try {
      await client.connect(transport, { timeout: this.listTimeoutMs });
    } catch (err) {
      // Could not spawn, exited, or did not initialize in time: a crash (crashed() schedules one restart at most).
      intentional = true;
      if (state.transport === transport) state.transport = undefined;
      await transport.close();
      if (!this.closed) this.crashed(state);
      throw err;
    }
    if (this.closed || state.transport !== transport) {
      intentional = true;
      await transport.close();
      throw new Error("direct mode is shut down");
    }
    state.client = client;
    state.startedAt = Date.now();
    return client;
  }

  private crashed(state: ServerState): void {
    if (state.restartTimer !== undefined) return;
    if (state.startedAt > 0 && Date.now() - state.startedAt >= STABLE_UPTIME_MS) state.crashes = 0;
    const delay = McpProxy.restartDelay(state.crashes);
    state.crashes++;
    state.startedAt = 0;
    this.log(`direct mode: server ${escapeForTerminal(state.name)} stopped; restarting in ${delay / 1000} s`);
    state.restartAt = Date.now() + delay;
    state.restartTimer = this.setTimer(() => {
      state.restartTimer = undefined;
      state.restartAt = undefined;
      if (this.closed) return;
      this.ensure(state).catch(() => {
        // Logged as a crash; the next restart is already scheduled.
      });
    }, delay);
  }
}

/** A result small enough for one hub frame: oversized results keep 1 MiB of text plus a marker, nothing else. */
function fitResult(result: unknown): unknown {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(result) ?? "");
  } catch {
    return { isError: true, content: [{ type: "text", text: "[the tool's result could not be serialized]" }] };
  }
  if (size <= MAX_FRAME_BYTES) return result;
  const r = isPlainObject(result) ? result : {};
  const content = Array.isArray(r.content) ? (r.content as unknown[]) : [];
  let keep = RESULT_TEXT_KEEP;
  const parts: string[] = [];
  for (const item of content) {
    if (keep <= 0) break;
    if (isPlainObject(item) && item.type === "text" && typeof item.text === "string") {
      const text = item.text.slice(0, keep);
      keep -= text.length;
      parts.push(text);
    }
  }
  parts.push(`[truncated: the tool's result was ${size} bytes, too large to send to the hub]`);
  return { ...(r.isError === true ? { isError: true } : {}), content: [{ type: "text", text: parts.join("\n") }] };
}
