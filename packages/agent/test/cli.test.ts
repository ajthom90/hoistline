import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HubToAgent, JobSpec } from "@hoistline/protocol";
import { createApprovalQueue, type ApprovalQueue } from "../src/approvals.js";
import { main, type CliDeps, type CliIO } from "../src/cli.js";
import { specHash, type ApprovalRequest, type CreateExecutorOptions, type Executor } from "../src/executor.js";
import { loadIdentity, saveIdentity, type AgentIdentity } from "../src/identity.js";
import type { AgentConnection, AgentHandlers } from "../src/connection.js";

const posix = process.platform !== "win32";
const MACHINE_ID = "6f9c2a52-4c55-4f3f-9a55-3a2d9a0c1e11";
const hubKey = generateKeyPairSync("ed25519");
const hubPublicKeyDer = hubKey.publicKey.export({ format: "der", type: "spki" }).toString("base64url");

let home: string;
const queues: ApprovalQueue[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hoistline-cli-"));
});
afterEach(() => {
  for (const q of queues.splice(0)) q.close();
  rmSync(home, { recursive: true, force: true });
});

type Out = { io: CliIO; out: () => string; err: () => string };
function io(opts: { lines?: string[]; isTTY?: boolean; env?: Record<string, string> } = {}): Out {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
      stdin: opts.lines ?? [],
      isTTY: opts.isTTY ?? false,
      env: { HOISTLINE_AGENT_HOME: home, ...opts.env },
    },
    out: () => out,
    err: () => err,
  };
}

async function run(argv: string[], opts: Parameters<typeof io>[0] = {}, deps: CliDeps = {}) {
  const o = io(opts);
  const code = await main(argv, o.io, deps);
  return { code, out: o.out(), err: o.err() };
}

function writeIdentity(): AgentIdentity {
  const identity: AgentIdentity = {
    machineId: MACHINE_ID,
    hubUrl: "https://hub.example.com",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    hubPublicKey: hubKey.publicKey,
  };
  saveIdentity(join(home, "identity.json"), identity);
  return identity;
}

const RESTRICTED = { mode: "restricted", repos: ["owner/name"], runners: ["muse"], onViolation: "ask" };
function writePolicy(policy: unknown = RESTRICTED): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "policy.json"), JSON.stringify(policy));
}

let seq = 0;
function request(specOver: Partial<JobSpec> = {}, reason = "runner rule failed"): ApprovalRequest {
  const jobId = `job${++seq}`;
  const spec: JobSpec = { jobId, runner: "muse", repo: "owner/name", baseBranch: "main", prompt: "fix it", ...specOver };
  return { jobId, userId: "user-1", spec, reason, specHash: specHash(spec) };
}

/** Parks a request in the queue under `home`, as `run` would. */
async function park(req: ApprovalRequest): Promise<{ result: Promise<boolean> }> {
  const q = createApprovalQueue({ dir: join(home, "approvals"), pollIntervalMs: 10 });
  queues.push(q);
  const result = q.requestApproval(req);
  while (!existsSync(join(home, "approvals", "pending", `${req.jobId}.json`))) await new Promise((r) => setTimeout(r, 5));
  return { result };
}

const pendingCount = () => {
  try {
    return readdirSync(join(home, "approvals", "pending")).length;
  } catch {
    return 0;
  }
};

describe("usage", () => {
  it("prints help and exits 0", async () => {
    const r = await run(["help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["pair", "setup", "policy show", "run", "approvals", "status", "version"]) expect(r.out).toContain(cmd);
  });

  it("prints the version", async () => {
    const r = await run(["version"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it.each([
    [[]],
    [["bogus"]],
    [["pair"]],
    [["pair", "https://hub.example.com"]],
    [["pair", "https://hub.example.com", "code", "extra"]],
    [["pair", "https://hub.example.com", "code", "--bogus"]],
    [["policy"]],
    [["policy", "edit"]],
    [["approvals", "bogus"]],
    [["approvals", "show"]],
    [["approvals", "approve"]],
    [["approvals", "deny", "a", "b"]],
    [["approvals", "show", "job1", "--max", "abc"]],
    [["run", "--max-concurrent", "0"]],
    [["run", "extra"]],
    [["status", "extra"]],
  ])("exits 2 on bad usage: %j", async (argv) => {
    const r = await run(argv);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/usage|unknown|invalid|expected/i);
  });
});

describe("pair", () => {
  function stubFetch() {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ machineId: MACHINE_ID, hubPublicKey: hubPublicKeyDer });
    }) as typeof fetch;
    return { fetch: fetchFn, seen };
  }

  it("pairs, saves the identity 0600 and prints the machine id but no key", async () => {
    const hub = stubFetch();
    const r = await run(["pair", "https://hub.example.com", "ABCD-EFGH", "--name", "laptop"], {}, { fetch: hub.fetch });
    expect(r.code).toBe(0);
    expect(hub.seen[0]).toMatchObject({ url: "https://hub.example.com/pair", body: { code: "ABCD-EFGH", name: "laptop" } });
    expect(r.out).toContain(MACHINE_ID);
    expect(r.out + r.err).not.toMatch(/PRIVATE KEY|MC4CAQ/);
    expect(r.out + r.err).not.toContain(hubPublicKeyDer);
    expect(loadIdentity(join(home, "identity.json")).machineId).toBe(MACHINE_ID);
    if (posix) expect(statSync(join(home, "identity.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an identity without --force", async () => {
    writeIdentity();
    const before = readFileSync(join(home, "identity.json"), "utf8");
    const hub = stubFetch();
    const r = await run(["pair", "https://hub.example.com", "CODE"], {}, { fetch: hub.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already paired.*--force/);
    expect(hub.seen).toEqual([]);
    expect(readFileSync(join(home, "identity.json"), "utf8")).toBe(before);

    const forced = await run(["pair", "https://hub.example.com", "CODE", "--force"], {}, { fetch: hub.fetch });
    expect(forced.code).toBe(0);
    expect(readFileSync(join(home, "identity.json"), "utf8")).not.toBe(before);
  });

  it("pairs against a real localhost server", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        expect(JSON.parse(body)).toMatchObject({ code: "C0DE" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ machineId: MACHINE_ID, hubPublicKey: hubPublicKeyDer }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const r = await run(["pair", url, "C0DE"]);
      expect(r.code).toBe(0);
      expect(loadIdentity(join(home, "identity.json")).hubUrl).toBe(url);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("reports a pairing failure with exit 1 and saves nothing", async () => {
    const fetchFn = (async () => Response.json({ error: "bad" }, { status: 400 })) as unknown as typeof fetch;
    const r = await run(["pair", "https://hub.example.com", "CODE"], {}, { fetch: fetchFn });
    expect(r.code).toBe(1);
    expect(r.err).toContain("pairing failed: HTTP 400");
    expect(existsSync(join(home, "identity.json"))).toBe(false);
  });

  it("refuses a plain-http hub that is not loopback", async () => {
    const r = await run(["pair", "http://hub.example.com", "CODE"], {}, { fetch: stubFetch().fetch });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/https/);
  });
});

describe("setup", () => {
  const ANSWERS = ["restricted", "owner/name", "muse", "", "", "ask"];

  it("writes the policy 0600 and prints its path and a summary", async () => {
    const r = await run(["setup"], { lines: ANSWERS });
    expect(r.code).toBe(0);
    const path = join(home, "policy.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(RESTRICTED);
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(r.out).toContain(path);
    expect(r.out).toMatch(/restricted/);
  });

  it("refuses to overwrite a policy without --yes, and overwrites with it", async () => {
    writePolicy({ mode: "trusted" });
    const r = await run(["setup"], { lines: ANSWERS });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already exists.*--yes/);
    expect(JSON.parse(readFileSync(join(home, "policy.json"), "utf8"))).toEqual({ mode: "trusted" });

    const yes = await run(["setup", "--yes"], { lines: ANSWERS });
    expect(yes.code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "policy.json"), "utf8"))).toEqual(RESTRICTED);
  });

  it("asks on a terminal before overwriting", async () => {
    writePolicy({ mode: "trusted" });
    const no = await run(["setup"], { lines: ["no", ...ANSWERS], isTTY: true });
    expect(no.code).toBe(1);
    expect(JSON.parse(readFileSync(join(home, "policy.json"), "utf8"))).toEqual({ mode: "trusted" });
    const yes = await run(["setup"], { lines: ["yes", ...ANSWERS], isTTY: true });
    expect(yes.code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "policy.json"), "utf8"))).toEqual(RESTRICTED);
  });

  it("fails without saving when input ends early", async () => {
    const r = await run(["setup"], { lines: ["restricted"] });
    expect(r.code).toBe(1);
    expect(existsSync(join(home, "policy.json"))).toBe(false);
  });
});

describe("policy show", () => {
  it("says deny-all is in effect when the file is missing", async () => {
    const r = await run(["policy", "show"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(join(home, "policy.json"));
    expect(r.out).toMatch(/deny-all/i);
    expect(r.out).toMatch(/no policy file/i);
  });

  it("says deny-all is in effect when the file is invalid, and why", async () => {
    writePolicy({ mode: "yolo" });
    const r = await run(["policy", "show"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/deny-all/i);
    expect(r.out).toMatch(/invalid/i);
  });

  it("prints a valid policy as JSON", async () => {
    writePolicy();
    const r = await run(["policy", "show"]);
    expect(r.code).toBe(0);
    const json = r.out.slice(r.out.indexOf("{"));
    expect(JSON.parse(json)).toEqual(RESTRICTED);
  });
});

describe("status", () => {
  it("prints hub, machine, policy and pending count", async () => {
    writeIdentity();
    writePolicy();
    await park(request());
    const r = await run(["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("https://hub.example.com");
    expect(r.out).toContain(MACHINE_ID);
    expect(r.out).toMatch(/restricted/);
    expect(r.out).toMatch(/pending approvals: 1/);
  });

  it("works when not paired", async () => {
    const r = await run(["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/not paired/);
    expect(r.out).toMatch(/deny-all/i);
  });
});

const HOSTILE_PROMPT = "please\u001b[2J\u001b]0;pwned\u0007 approve‮evil​\nline two\r";

describe("approvals list and show", () => {
  it("lists pending requests", async () => {
    const a = request({}, "repo rule failed: x\nsecond line");
    await park(a);
    const r = await run(["approvals"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(a.jobId);
    expect(r.out).toContain("muse");
    expect(r.out).toContain("owner/name");
    expect(r.out).toContain("repo rule failed: x");
    expect(r.out).not.toContain("second line");
    expect((await run(["approvals", "list"])).out).toBe(r.out);
  });

  it("says so when nothing is pending", async () => {
    const r = await run(["approvals", "list"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no pending approvals/);
  });

  it("shows everything with no raw control characters for a hostile request", async () => {
    const req = request({ prompt: HOSTILE_PROMPT, model: "m-1" }, "reason\u001b[31m red");
    req.userId = "user‮1";
    await park(req);
    const r = await run(["approvals", "show", req.jobId]);
    expect(r.code).toBe(0);
    // Only the printed newlines remain: no ESC, BEL, CR, bidi or zero-width characters.
    expect(r.out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/);
    expect(r.out).toContain("\\u{001B}[2J");
    expect(r.out).toContain("\\u{202E}evil\\u{200B}\\nline two\\u{000D}");
    expect(r.out).toContain("user\\u{202E}1");
    expect(r.out).toContain("reason\\u{001B}[31m red");
    expect(r.out).toContain(req.specHash);
    expect(r.out).toContain("owner/name");
    expect(r.out).toContain("m-1");
    expect(r.out).toContain("main");
  });

  it("truncates a long prompt with a clear marker", async () => {
    const req = request({ prompt: "p".repeat(30_000) });
    await park(req);
    const r = await run(["approvals", "show", req.jobId]);
    expect(r.out).toContain("p".repeat(20_000));
    expect(r.out).not.toContain("p".repeat(20_001));
    expect(r.out).toContain("[truncated 10000 chars; the approval covers the full prompt]");
    const all = await run(["approvals", "show", req.jobId, "--max", "40000"]);
    expect(all.out).toContain("p".repeat(30_000));
    expect(all.out).not.toContain("truncated");
  });

  it("shows the command of a build-test job", async () => {
    const req = request({ runner: "build-test", command: "npm test" });
    await park(req);
    const r = await run(["approvals", "show", req.jobId]);
    expect(r.out).toContain("npm test");
  });

  it("exits 1 for an unknown or invalid job id", async () => {
    expect((await run(["approvals", "show", "nope"])).code).toBe(1);
    const bad = await run(["approvals", "show", "../x"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/invalid job id/);
  });
});

describe("approvals approve and deny", () => {
  it("approves interactively when the owner types the job id", async () => {
    const req = request({ prompt: HOSTILE_PROMPT });
    const { result } = await park(req);
    const r = await run(["approvals", "approve", req.jobId], { isTTY: true, lines: [req.jobId] });
    expect(r.code).toBe(0);
    expect(r.out).toContain(req.specHash);
    expect(r.out).toContain("\\u{001B}[2J");
    expect(await result).toBe(true);
  });

  it("aborts when the owner types something else", async () => {
    const req = request();
    const { result } = await park(req);
    const r = await run(["approvals", "approve", req.jobId], { isTTY: true, lines: ["job-other"] });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not approved/);
    expect(pendingCount()).toBe(1);
    expect(existsSync(join(home, "approvals", "decisions", `${req.jobId}.json`))).toBe(false);
    const eof = await run(["approvals", "approve", req.jobId], { isTTY: true, lines: [] });
    expect(eof.code).toBe(1);
    queues[0]!.close();
    expect(await result).toBe(false);
  });

  it("refuses non-interactive approval without both --yes and a matching --hash of at least 12 hex chars", async () => {
    const req = request();
    const { result } = await park(req);
    const attempts: [string[], number][] = [
      [[], 2], // not a terminal, no flags
      [["--yes"], 2],
      [["--hash", req.specHash.slice(0, 12)], 2],
      [["--yes", "--hash", req.specHash.slice(0, 11)], 2],
      [["--yes", "--hash", "zz" + req.specHash.slice(2, 14)], 2],
      [["--yes", "--hash", (req.specHash[0] === "0" ? "1" : "0") + req.specHash.slice(1, 16)], 1],
    ];
    for (const [flags, code] of attempts) {
      const r = await run(["approvals", "approve", req.jobId, ...flags], { lines: [req.jobId] });
      expect([flags, r.code]).toEqual([flags, code]);
      expect(existsSync(join(home, "approvals", "decisions", `${req.jobId}.json`))).toBe(false);
    }
    const ok = await run(["approvals", "approve", req.jobId, "--yes", "--hash", req.specHash.slice(0, 12).toUpperCase()]);
    expect(ok.code).toBe(0);
    expect(await result).toBe(true);
  });

  it("denies without confirmation", async () => {
    const req = request();
    const { result } = await park(req);
    const r = await run(["approvals", "deny", req.jobId]);
    expect(r.code).toBe(0);
    expect(await result).toBe(false);
  });

  it("exits 1 for an unknown job or a second decision", async () => {
    expect((await run(["approvals", "deny", "nope"])).code).toBe(1);
    const req = request();
    const q = createApprovalQueue({ dir: join(home, "approvals"), pollIntervalMs: 60_000 });
    queues.push(q);
    void q.requestApproval(req);
    while (pendingCount() === 0) await new Promise((r) => setTimeout(r, 5));
    expect((await run(["approvals", "deny", req.jobId])).code).toBe(0);
    const again = await run(["approvals", "approve", req.jobId, "--yes", "--hash", req.specHash]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already decided/);
  });
});

describe("run", () => {
  type Fake = {
    deps: CliDeps;
    handlers: () => AgentHandlers;
    executorOpts: () => CreateExecutorOptions;
    calls: string[];
    received: HubToAgent[];
    trigger: (sig: "SIGINT" | "SIGTERM") => void;
    connected: () => boolean;
  };

  function fakes(opts: { closeHangs?: boolean; shutdownTimeoutMs?: number } = {}): Fake {
    const calls: string[] = [];
    const received: HubToAgent[] = [];
    let handlers: AgentHandlers | undefined;
    let executorOpts: CreateExecutorOptions | undefined;
    let signalHandler: ((sig: "SIGINT" | "SIGTERM") => void) | undefined;
    const executor: Executor = {
      onMessage: (msg) => {
        calls.push("executor.onMessage");
        received.push(msg);
      },
      runningJobs: () => ["job-a", "job-b"],
      flushOutbox: () => {
        calls.push("executor.flushOutbox");
      },
      runMaintenance: async () => {},
      close: () => {
        calls.push("executor.close");
        return opts.closeHangs ? new Promise<void>(() => {}) : Promise.resolve();
      },
    };
    const deps: CliDeps = {
      registerRunners: () => calls.push("registerRunners"),
      createExecutor: (o) => {
        executorOpts = o;
        calls.push("createExecutor");
        return executor;
      },
      connect: (identity, h) => {
        calls.push(`connect ${identity.machineId}`);
        handlers = h;
        const conn: AgentConnection = {
          connected: true,
          send: () => {},
          close: () => {
            calls.push("connection.close");
          },
        };
        return conn;
      },
      onSignal: (handler) => {
        signalHandler = handler;
        return () => calls.push("signals.off");
      },
      shutdownTimeoutMs: opts.shutdownTimeoutMs,
    };
    return {
      deps,
      calls,
      received,
      handlers: () => handlers!,
      executorOpts: () => executorOpts!,
      trigger: (sig) => signalHandler!(sig),
      connected: () => handlers !== undefined,
    };
  }

  async function started(f: Fake, argv: string[] = ["run"]) {
    const o = io();
    const done = main(argv, o.io, f.deps);
    const deadline = Date.now() + 5000;
    while (!f.connected()) {
      if (Date.now() > deadline) throw new Error(`run did not connect: ${o.err()}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return { done, err: o.err };
  }

  it("fails clearly when not paired", async () => {
    const f = fakes();
    const r = await run(["run"], {}, f.deps);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not paired.*hoistline-agent pair/);
    expect(f.calls).not.toContain("createExecutor");
  });

  it("wires the executor to the connection and shuts down on a signal", async () => {
    writeIdentity();
    const f = fakes();
    const { done, err } = await started(f, ["run", "--max-concurrent", "3"]);
    expect(f.calls.slice(0, 3)).toEqual(["registerRunners", "createExecutor", `connect ${MACHINE_ID}`]);
    const opts = f.executorOpts();
    expect(opts).toMatchObject({ machineId: MACHINE_ID, cacheDir: join(home, "cache"), maxConcurrentJobs: 3 });
    if (posix) expect(statSync(join(home, "cache")).mode & 0o777).toBe(0o700);
    // The policy is read per job from this home: missing means deny-all.
    expect(opts.loadPolicy!()).toMatchObject({ mode: "restricted", repos: [], runners: [] });
    writePolicy({ mode: "trusted" });
    expect(opts.loadPolicy!()).toEqual({ mode: "trusted" });

    const hello = f.handlers().hello();
    expect(hello).toEqual({ agentVersion: expect.any(String), runners: expect.any(Array), runningJobs: ["job-a", "job-b"], servers: [] });

    // onConnected flushes synchronously: the flush has happened by the time it returns.
    const before = f.calls.length;
    f.handlers().onConnected!();
    expect(f.calls.slice(before)).toEqual(["executor.flushOutbox"]);
    expect(err()).toMatch(/connected/);

    const msg: HubToAgent = { type: "job.cancel", jobId: "job-a" };
    f.handlers().onMessage(msg);
    expect(f.received).toEqual([msg]);

    f.handlers().onDisconnected!({ code: 1006, willReconnect: true });
    expect(err()).toMatch(/disconnected/);

    f.trigger("SIGTERM");
    expect(await done).toBe(0);
    const i = f.calls.indexOf("executor.close");
    expect(i).toBeGreaterThan(-1);
    expect(f.calls.indexOf("connection.close")).toBeGreaterThan(i);
    expect(f.calls).toContain("signals.off");
  });

  it("uses --cache-dir", async () => {
    writeIdentity();
    const f = fakes();
    const cache = join(home, "elsewhere");
    const { done } = await started(f, ["run", "--cache-dir", cache]);
    expect(f.executorOpts().cacheDir).toBe(cache);
    expect(existsSync(cache)).toBe(true);
    f.trigger("SIGINT");
    expect(await done).toBe(0);
  });

  it("prints a line when a job awaits approval, without the prompt, and parks it in the queue", async () => {
    writeIdentity();
    const f = fakes();
    const { done, err } = await started(f);
    const controller = new AbortController();
    const req = { ...request({ prompt: "SECRET PROMPT TEXT" }), signal: controller.signal };
    const answer = f.executorOpts().requestApproval!(req);
    while (pendingCount() === 0) await new Promise((r) => setTimeout(r, 5));
    expect(err()).toContain(`job ${req.jobId} is awaiting approval; run: hoistline-agent approvals`);
    expect(err()).not.toContain("SECRET PROMPT TEXT");
    controller.abort();
    expect(await answer).toBe(false);
    expect(pendingCount()).toBe(0);
    f.trigger("SIGINT");
    expect(await done).toBe(0);
  });

  it("leaves no pending approvals behind after a signal", async () => {
    writeIdentity();
    const f = fakes();
    const { done } = await started(f);
    const answer = f.executorOpts().requestApproval!(request());
    while (pendingCount() === 0) await new Promise((r) => setTimeout(r, 5));
    f.trigger("SIGINT");
    expect(await done).toBe(0);
    expect(await answer).toBe(false);
    expect(pendingCount()).toBe(0);
  });

  it("exits within the bound even if shutdown hangs, and at once on a second signal", async () => {
    writeIdentity();
    const f = fakes({ closeHangs: true, shutdownTimeoutMs: 100 });
    const { done } = await started(f);
    const t0 = Date.now();
    f.trigger("SIGINT");
    expect(await done).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2000);

    const g = fakes({ closeHangs: true, shutdownTimeoutMs: 60_000 });
    const second = await started(g);
    g.trigger("SIGINT");
    g.trigger("SIGINT");
    expect(await second.done).toBe(130);
  });

  it("never logs secrets or the private key", async () => {
    const identity = writeIdentity();
    const f = fakes();
    const { done, err } = await started(f);
    f.handlers().onConnected!();
    f.trigger("SIGINT");
    await done;
    const pem = identity.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(err()).not.toContain(pem.split("\n")[1]!);
    expect(err()).not.toMatch(/PRIVATE KEY/);
  });
});
