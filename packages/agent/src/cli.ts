import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { createApprovalQueue, escapeForTerminal, type ApprovalQueue, type PendingApproval } from "./approvals.js";
import { connect, type AgentConnection, type AgentHandlers } from "./connection.js";
import { createExecutor, type CreateExecutorOptions, type Executor } from "./executor.js";
import type { PrepareOptions } from "./git.js";
import { agentHome, defaultIdentityPath, loadIdentity, saveIdentity, type AgentIdentity } from "./identity.js";
import { pairMachine } from "./pair.js";
import { DENY_ALL, defaultPolicyPath, loadEffectivePolicy, loadPolicy, savePolicy, type PolicyConfig } from "./policy.js";
import { registerBuiltinRunners, registeredRunners } from "./runners/index.js";
import { runSetup, type SetupIO } from "./setup.js";

/** How the CLI talks to the owner. Injected so `main` runs in-process in tests. */
export type CliIO = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Lines the owner types (without line endings). Read only by commands that ask something. */
  stdin?: AsyncIterable<string> | Iterable<string>;
  /** True when stdin and stdout are a terminal: interactive approval needs one. */
  isTTY?: boolean;
  env: Record<string, string | undefined>;
};

/** Injection points for tests. Production uses the defaults. */
export type CliDeps = {
  fetch?: typeof fetch;
  pairMachine?: typeof pairMachine;
  connect?: (identity: AgentIdentity, handlers: AgentHandlers) => AgentConnection;
  createExecutor?: (opts: CreateExecutorOptions) => Executor;
  /** Registers the runners `run` offers. Default: registerBuiltinRunners. */
  registerRunners?: () => void;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Subscribes to SIGINT/SIGTERM; returns the unsubscribe. Default: process signals. */
  onSignal?: (handler: (signal: "SIGINT" | "SIGTERM") => void) => () => void;
  /** How long `run` waits for a clean shutdown before exiting anyway. Default 5 s. */
  shutdownTimeoutMs?: number;
  approvalPollIntervalMs?: number;
  /** Test only: lets jobs push to a local remote. */
  prepareOptions?: PrepareOptions;
};

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
/** `run` interrupted a second time while shutting down. */
export const EXIT_INTERRUPTED = 130;

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const DEFAULT_PROMPT_MAX = 20_000;
const MIN_HASH_PREFIX = 12;

export const AGENT_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const HELP = `hoistline-agent: runs jobs from a Hoistline hub on this machine

usage:
  hoistline-agent pair <hub-url> <code> [--name <name>] [--force]
  hoistline-agent setup [--yes]
  hoistline-agent policy show
  hoistline-agent run [--cache-dir <dir>] [--max-concurrent <n>]
  hoistline-agent approvals [list]
  hoistline-agent approvals show <jobId> [--max <chars>]
  hoistline-agent approvals approve <jobId> [--yes --hash <spec hash prefix>] [--max <chars>]
  hoistline-agent approvals deny <jobId>
  hoistline-agent status
  hoistline-agent version
  hoistline-agent help

Files live in $HOISTLINE_AGENT_HOME (default ~/.hoistline).
approvals approve asks you to type the job id; without a terminal it needs both --yes and
--hash with at least ${MIN_HASH_PREFIX} hex characters of the request's spec hash.
`;

class UsageError extends Error {}

type Ctx = {
  io: CliIO;
  deps: CliDeps;
  home: string;
  out: (line: string) => void;
  err: (line: string) => void;
  readLine: (prompt: string) => Promise<string | null>;
};

/** Runs the CLI. Resolves with the exit code; never throws. */
export async function main(argv: string[], io: CliIO, deps: CliDeps = {}): Promise<number> {
  const ctx: Ctx = {
    io,
    deps,
    home: agentHome(io.env),
    out: (line) => io.stdout(`${line}\n`),
    err: (line) => io.stderr(`${line}\n`),
    readLine: lineReader(io),
  };
  try {
    return await dispatch(argv, ctx);
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.err(`hoistline-agent: ${escapeForTerminal(e.message)}`);
      ctx.err("usage: see hoistline-agent help");
      return EXIT_USAGE;
    }
    ctx.err(`hoistline-agent: error: ${escapeForTerminal(message(e))}`);
    return EXIT_ERROR;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function lineReader(io: CliIO): (prompt: string) => Promise<string | null> {
  let it: AsyncIterator<string> | Iterator<string> | undefined;
  return async (prompt) => {
    io.stdout(prompt);
    const stdin = io.stdin;
    if (!stdin) return null;
    it ??=
      Symbol.asyncIterator in stdin
        ? (stdin as AsyncIterable<string>)[Symbol.asyncIterator]()
        : (stdin as Iterable<string>)[Symbol.iterator]();
    const r = await it.next();
    return r.done ? null : String(r.value).replace(/\r?\n?$/, "");
  };
}

type Options = NonNullable<ParseArgsConfig["options"]>;

function parse(args: string[], options: Options, positionals: { min: number; max: number; usage: string }) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(`${message(e)} (usage: ${positionals.usage})`);
  }
  const n = parsed.positionals.length;
  if (n < positionals.min || n > positionals.max) {
    throw new UsageError(`expected ${positionals.usage}`);
  }
  return parsed as { values: Record<string, string | boolean | undefined>; positionals: string[] };
}

async function dispatch(argv: string[], ctx: Ctx): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      ctx.io.stdout(HELP);
      return EXIT_OK;
    case "version":
    case "--version":
      parse(rest, {}, { min: 0, max: 0, usage: "version" });
      ctx.out(AGENT_VERSION);
      return EXIT_OK;
    case "pair":
      return pair(rest, ctx);
    case "setup":
      return setup(rest, ctx);
    case "policy": {
      const [sub, ...more] = rest;
      if (sub !== "show") throw new UsageError("unknown policy command (usage: policy show)");
      parse(more, {}, { min: 0, max: 0, usage: "policy show" });
      return policyShow(ctx);
    }
    case "run":
      return run(rest, ctx);
    case "approvals":
      return approvals(rest, ctx);
    case "status":
      parse(rest, {}, { min: 0, max: 0, usage: "status" });
      return status(ctx);
    case undefined:
      ctx.io.stderr(HELP);
      return EXIT_USAGE;
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function pair(args: string[], ctx: Ctx): Promise<number> {
  const usage = "pair <hub-url> <code> [--name <name>] [--force]";
  const { values, positionals } = parse(
    args,
    { name: { type: "string" }, force: { type: "boolean" } },
    { min: 2, max: 2, usage },
  );
  const [hubUrl, code] = positionals as [string, string];
  const path = defaultIdentityPath(ctx.io.env);
  if (exists(path) && values.force !== true) {
    ctx.err(`hoistline-agent: this machine is already paired (${escapeForTerminal(path)}); use --force to pair again`);
    return EXIT_ERROR;
  }
  const name = typeof values.name === "string" ? values.name : hostname();
  const pairFn = ctx.deps.pairMachine ?? pairMachine;
  const identity = await pairFn(hubUrl, code, name, ctx.deps.fetch ? { fetch: ctx.deps.fetch } : {});
  saveIdentity(path, identity);
  ctx.out(`paired with ${escapeForTerminal(identity.hubUrl)}`);
  ctx.out(`machine id: ${escapeForTerminal(identity.machineId)}`);
  ctx.out(`identity saved to ${escapeForTerminal(path)}`);
  return EXIT_OK;
}

function policySummary(policy: PolicyConfig): string {
  if (policy.mode === "trusted") return "trusted mode: every job and tool call from the hub runs";
  const runners = policy.runners.length ? policy.runners.join(", ") : "none";
  const models = policy.models ? `${policy.models.length} models` : "any model";
  return (
    `restricted mode: ${policy.repos.length} repos, runners ${runners}, ${models}, ` +
    `${policy.tools?.length ?? 0} tools, on violation ${policy.onViolation}`
  );
}

type PolicyState =
  | { kind: "missing" }
  | { kind: "invalid"; why: string }
  | { kind: "ok"; policy: PolicyConfig };

function readPolicyState(path: string): PolicyState {
  try {
    const p = loadPolicy(path);
    return p === null ? { kind: "missing" } : { kind: "ok", policy: p };
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause;
    return { kind: "invalid", why: cause ? message(cause) : message(e) };
  }
}

function policyStateLine(state: PolicyState): string {
  if (state.kind === "missing") return "deny-all (no policy file; run hoistline-agent setup)";
  if (state.kind === "invalid") return "deny-all (the policy file is invalid)";
  return policySummary(state.policy);
}

async function setup(args: string[], ctx: Ctx): Promise<number> {
  const { values } = parse(args, { yes: { type: "boolean" } }, { min: 0, max: 0, usage: "setup [--yes]" });
  const path = defaultPolicyPath(ctx.io.env);
  if (exists(path) && values.yes !== true) {
    if (!ctx.io.isTTY) {
      ctx.err(`hoistline-agent: a policy already exists at ${escapeForTerminal(path)}; use --yes to replace it`);
      return EXIT_ERROR;
    }
    const answer = await ctx.readLine(`A policy already exists at ${escapeForTerminal(path)}. Replace it? (yes/no) `);
    if (answer?.trim().toLowerCase() !== "yes") {
      ctx.err("hoistline-agent: setup cancelled; the policy is unchanged");
      return EXIT_ERROR;
    }
  }
  const io: SetupIO = {
    ask: async (question) => {
      const line = await ctx.readLine(`${question} `);
      if (line === null) throw new Error("input ended before setup finished; nothing was saved");
      return line;
    },
    print: (text) => ctx.out(text),
  };
  const policy = await runSetup(io);
  savePolicy(path, policy);
  ctx.out(`policy saved to ${escapeForTerminal(path)}`);
  ctx.out(policySummary(policy));
  return EXIT_OK;
}

function printJson(ctx: Ctx, value: unknown): void {
  for (const line of JSON.stringify(value, null, 2).split("\n")) ctx.out(escapeForTerminal(line));
}

function policyShow(ctx: Ctx): number {
  const path = defaultPolicyPath(ctx.io.env);
  ctx.out(`policy file: ${escapeForTerminal(path)}`);
  const state = readPolicyState(path);
  if (state.kind === "missing") {
    ctx.out("no policy file: deny-all is in effect (nothing runs); run hoistline-agent setup");
  } else if (state.kind === "invalid") {
    ctx.out(`the policy file is invalid: deny-all is in effect (nothing runs): ${escapeForTerminal(state.why)}`);
  } else {
    ctx.out(policySummary(state.policy));
  }
  ctx.out("effective policy:");
  printJson(ctx, state.kind === "ok" ? state.policy : DENY_ALL);
  return EXIT_OK;
}

function queueFor(ctx: Ctx): ApprovalQueue {
  return createApprovalQueue({ dir: join(ctx.home, "approvals"), now: ctx.deps.now });
}

function status(ctx: Ctx): number {
  const idPath = defaultIdentityPath(ctx.io.env);
  if (!exists(idPath)) {
    ctx.out("hub: not paired (run hoistline-agent pair <hub-url> <code>)");
  } else {
    try {
      const identity = loadIdentity(idPath);
      ctx.out(`hub: ${escapeForTerminal(identity.hubUrl)}`);
      ctx.out(`machine id: ${escapeForTerminal(identity.machineId)}`);
    } catch {
      ctx.out(`hub: the identity file ${escapeForTerminal(idPath)} is invalid; pair again with --force`);
    }
  }
  ctx.out(`policy: ${policyStateLine(readPolicyState(defaultPolicyPath(ctx.io.env)))}`);
  let pending: string;
  try {
    pending = String(queueFor(ctx).list().length);
  } catch (e) {
    pending = `unknown (${escapeForTerminal(message(e))})`;
  }
  ctx.out(`pending approvals: ${pending}`);
  return EXIT_OK;
}

function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function parseMax(value: string | boolean | undefined): number {
  if (value === undefined) return DEFAULT_PROMPT_MAX;
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) throw new UsageError("--max must be a number of characters");
  return Number(value);
}

function showLines(p: PendingApproval, now: number, max: number): string[] {
  const e = escapeForTerminal;
  const lines = [
    `job:         ${e(p.jobId)}`,
    `requested:   ${age(now - p.createdAt)} ago by user ${e(p.userId)}`,
    `reason:      ${e(p.reason)}`,
    `repo:        ${e(p.spec.repo)}`,
    `base branch: ${e(p.spec.baseBranch)}`,
    `runner:      ${e(p.spec.runner)}`,
    `model:       ${p.spec.model === undefined ? "(runner default)" : e(p.spec.model)}`,
  ];
  if (p.spec.command !== undefined) lines.push(`command:     ${e(p.spec.command)}`);
  lines.push(`spec hash:   ${p.specHash}`);
  const chars = [...p.spec.prompt];
  lines.push(`prompt (${chars.length} chars):`);
  lines.push(e(chars.slice(0, max).join("")));
  if (chars.length > max) {
    lines.push(`[truncated ${chars.length - max} chars; the approval covers the full prompt]`);
  }
  return lines;
}

function requirePending(queue: ApprovalQueue, jobId: string): PendingApproval {
  const p = queue.show(jobId);
  if (!p) throw new Error(`no pending approval for job ${jobId}`);
  return p;
}

async function approvals(args: string[], ctx: Ctx): Promise<number> {
  const [sub = "list", ...rest] = args;
  const now = (ctx.deps.now ?? Date.now)();
  switch (sub) {
    case "list": {
      parse(rest, {}, { min: 0, max: 0, usage: "approvals [list]" });
      const pending = queueFor(ctx).list();
      if (pending.length === 0) {
        ctx.out("no pending approvals");
        return EXIT_OK;
      }
      const rows = pending.map((p) => [
        escapeForTerminal(p.jobId),
        age(now - p.createdAt),
        escapeForTerminal(p.spec.runner),
        escapeForTerminal(p.spec.repo),
        escapeForTerminal(p.reason.split(/\r?\n/)[0] ?? ""),
      ]);
      const header = ["JOB", "AGE", "RUNNER", "REPO", "REASON"];
      const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
      for (const row of [header, ...rows]) {
        ctx.out(row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]!))).join("  "));
      }
      ctx.out("show one with: hoistline-agent approvals show <jobId>");
      return EXIT_OK;
    }
    case "show": {
      const { values, positionals } = parse(rest, { max: { type: "string" } }, {
        min: 1,
        max: 1,
        usage: "approvals show <jobId> [--max <chars>]",
      });
      const max = parseMax(values.max);
      const p = requirePending(queueFor(ctx), positionals[0]!);
      for (const line of showLines(p, now, max)) ctx.out(line);
      return EXIT_OK;
    }
    case "approve":
      return approve(rest, ctx, now);
    case "deny": {
      const { positionals } = parse(rest, {}, { min: 1, max: 1, usage: "approvals deny <jobId>" });
      const jobId = positionals[0]!;
      const queue = queueFor(ctx);
      const p = requirePending(queue, jobId);
      queue.decide(jobId, "deny", p.specHash);
      ctx.out(`denied job ${escapeForTerminal(jobId)}`);
      return EXIT_OK;
    }
    default:
      throw new UsageError(`unknown approvals command ${JSON.stringify(sub)}`);
  }
}

async function approve(args: string[], ctx: Ctx, now: number): Promise<number> {
  const usage = "approvals approve <jobId> [--yes --hash <spec hash prefix>] [--max <chars>]";
  const { values, positionals } = parse(
    args,
    { yes: { type: "boolean" }, hash: { type: "string" }, max: { type: "string" } },
    { min: 1, max: 1, usage },
  );
  const max = parseMax(values.max);
  const jobId = positionals[0]!;
  const nonInteractive = values.yes !== undefined || values.hash !== undefined;
  let prefix: string | undefined;
  if (nonInteractive) {
    if (values.yes !== true || typeof values.hash !== "string") {
      throw new UsageError("approving without a prompt needs both --yes and --hash <spec hash prefix>");
    }
    if (!new RegExp(`^[0-9a-fA-F]{${MIN_HASH_PREFIX},64}$`).test(values.hash)) {
      throw new UsageError(`--hash must be ${MIN_HASH_PREFIX} to 64 hex characters of the request's spec hash`);
    }
    prefix = values.hash.toLowerCase();
  } else if (!ctx.io.isTTY) {
    throw new UsageError("not a terminal: approve with --yes --hash <spec hash prefix>, or run this in a terminal");
  }

  const queue = queueFor(ctx);
  const p = requirePending(queue, jobId);
  if (prefix !== undefined) {
    if (!p.specHash.startsWith(prefix)) {
      ctx.err(`hoistline-agent: --hash does not match the pending request for job ${escapeForTerminal(jobId)}; not approved`);
      return EXIT_ERROR;
    }
  } else {
    for (const line of showLines(p, now, max)) ctx.out(line);
    const answer = await ctx.readLine(`Type the job id (${escapeForTerminal(jobId)}) to approve exactly this request: `);
    if (answer?.trim() !== jobId) {
      ctx.err("hoistline-agent: the job id did not match; not approved");
      return EXIT_ERROR;
    }
  }
  // The hash of the request that was shown (or matched): a different request under this id is refused.
  queue.decide(jobId, "approve", p.specHash);
  ctx.out(`approved job ${escapeForTerminal(jobId)} (spec hash ${p.specHash})`);
  return EXIT_OK;
}

/** Creates a private directory (0700); refuses a symbolic link or a non-directory. */
function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${path} is not a directory`);
  if ((st.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

function defaultOnSignal(handler: (signal: "SIGINT" | "SIGTERM") => void): () => void {
  const onInt = () => handler("SIGINT");
  const onTerm = () => handler("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  };
}

async function run(args: string[], ctx: Ctx): Promise<number> {
  const usage = "run [--cache-dir <dir>] [--max-concurrent <n>]";
  const { values } = parse(
    args,
    { "cache-dir": { type: "string" }, "max-concurrent": { type: "string" } },
    { min: 0, max: 0, usage },
  );
  let maxConcurrentJobs: number | undefined;
  if (values["max-concurrent"] !== undefined) {
    const v = String(values["max-concurrent"]);
    if (!/^\d{1,3}$/.test(v) || Number(v) < 1) throw new UsageError("--max-concurrent must be a positive integer");
    maxConcurrentJobs = Number(v);
  }
  const { deps } = ctx;
  const log = ctx.err;

  const idPath = defaultIdentityPath(ctx.io.env);
  if (!exists(idPath)) {
    log("hoistline-agent: not paired: run hoistline-agent pair <hub-url> <code> first");
    return EXIT_ERROR;
  }
  const identity = loadIdentity(idPath);
  const cacheDir = typeof values["cache-dir"] === "string" ? resolve(values["cache-dir"]) : join(ctx.home, "cache");
  ensurePrivateDir(cacheDir);
  const policyPath = defaultPolicyPath(ctx.io.env);

  (deps.registerRunners ?? registerBuiltinRunners)();
  const queue = createApprovalQueue({
    dir: join(ctx.home, "approvals"),
    now: deps.now,
    pollIntervalMs: deps.approvalPollIntervalMs,
    onError: (e) => log(`approval queue: ${escapeForTerminal(message(e))}`),
  });
  try {
    queue.prune();
  } catch (e) {
    log(`approval queue: ${escapeForTerminal(message(e))}`);
  }

  let conn: AgentConnection | undefined;
  const executor = (deps.createExecutor ?? createExecutor)({
    machineId: identity.machineId,
    hubPublicKey: identity.hubPublicKey,
    cacheDir,
    send: (msg) => {
      if (!conn) throw new Error("not connected to the hub");
      conn.send(msg);
    },
    // Read per job, so policy edits apply without a restart. Missing or invalid: deny all.
    loadPolicy: () => loadEffectivePolicy(policyPath),
    requestApproval: (req) => {
      log(`job ${escapeForTerminal(String(req.jobId))} is awaiting approval; run: hoistline-agent approvals`);
      return queue.requestApproval(req);
    },
    ...(maxConcurrentJobs !== undefined ? { maxConcurrentJobs } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.prepareOptions ? { prepareOptions: deps.prepareOptions } : {}),
  });

  conn = (deps.connect ?? connect)(identity, {
    hello: () => ({
      agentVersion: AGENT_VERSION,
      runners: registeredRunners(),
      runningJobs: executor.runningJobs(),
      servers: [],
    }),
    onConnected: () => {
      // Synchronously, inside the welcome handler: see Executor.flushOutbox.
      executor.flushOutbox();
      log("connected to the hub");
    },
    onMessage: (msg) => executor.onMessage(msg),
    onDisconnected: ({ code, willReconnect }) => {
      log(
        willReconnect
          ? `disconnected from the hub (code ${code}); reconnecting`
          : `disconnected from the hub (code ${code}); not reconnecting`,
      );
    },
  });
  log(
    `hoistline-agent ${AGENT_VERSION}: machine ${escapeForTerminal(identity.machineId)}, ` +
      `hub ${escapeForTerminal(identity.hubUrl)}, policy ${policyStateLine(readPolicyState(policyPath))}`,
  );

  const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  const onSignal = deps.onSignal ?? defaultOnSignal;
  const connection = conn;
  return await new Promise<number>((resolveExit) => {
    let stopping = false;
    let timer: unknown;
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearT(timer);
      off();
      resolveExit(code);
    };
    const off = onSignal((sig) => {
      if (stopping) {
        log(`${sig} again: exiting now`);
        return finish(EXIT_INTERRUPTED);
      }
      stopping = true;
      log(`${sig}: shutting down (send it again to exit at once)`);
      timer = setT(() => {
        log("shutdown is taking too long; exiting");
        finish(EXIT_OK);
      }, deps.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
      void (async () => {
        try {
          // Aborts every job first (removing its pending approval), so they end cancelled, not denied.
          const closing = executor.close();
          queue.close();
          await closing;
        } catch {
          // Exiting anyway.
        }
        try {
          connection.close();
        } catch {
          // Exiting anyway.
        }
        finish(EXIT_OK);
      })();
    });
  });
}

