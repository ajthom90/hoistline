import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentToHub, type HubToAgent } from "@hoistline/protocol";
import { killTrackedProcessGroups } from "../src/children.js";
import type { PolicyConfig } from "../src/policy.js";
import {
  ASK_DENIED_REASON,
  DEFAULT_LIST_TIMEOUT_MS,
  McpProxy,
  defaultServersPath,
  loadServers,
  type McpProxyOptions,
  type ServerConfig,
} from "../src/proxy.js";

const STUB = fileURLToPath(new URL("./fixtures/stub-mcp-server.mjs", import.meta.url));
const posix = process.platform !== "win32";

let dir: string;
const proxies: McpProxy[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hoistline-proxy-"));
});
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.close()));
  rmSync(dir, { recursive: true, force: true });
});

type StubTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type StubBehaviour = {
  junk?: boolean;
  noInit?: boolean;
  flood?: boolean;
  exitAtStart?: boolean;
  spewAtStart?: number;
  endlessPages?: number;
  grandchild?: boolean;
};
function stub(tools?: StubTool[], extra: Partial<ServerConfig> = {}, pidFile?: string, behaviour: StubBehaviour = {}): ServerConfig {
  return { command: process.execPath, args: [STUB, JSON.stringify({ tools, pidFile, ...behaviour })], ...extra };
}

const TOOLS: StubTool[] = [
  { name: "echo", description: "Echoes.", inputSchema: { type: "object", properties: { x: { type: "string" } } } },
  { name: "env" },
  { name: "crash" },
  { name: "hang" },
  { name: "big" },
];

function proxy(
  servers: Record<string, ServerConfig>,
  policy: PolicyConfig | (() => PolicyConfig) = { mode: "trusted" },
  opts: McpProxyOptions = {},
): McpProxy {
  const p = new McpProxy(servers, policy, { log: () => {}, ...opts });
  proxies.push(p);
  return p;
}

const restricted = (tools: string[] | undefined, onViolation: "deny" | "ask" = "deny"): PolicyConfig => ({
  mode: "restricted",
  repos: [],
  runners: [],
  ...(tools ? { tools } : {}),
  onViolation,
});

const textOf = (result: unknown) =>
  ((result as { content: { type: string; text: string }[] }).content ?? []).map((c) => c.text).join("\n");

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const pids = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("servers.json", () => {
  it("lives in the agent home", () => {
    expect(defaultServersPath({ HOISTLINE_AGENT_HOME: dir })).toBe(join(dir, "servers.json"));
  });

  it("missing file means no servers and no error", () => {
    expect(loadServers(join(dir, "servers.json"))).toEqual({ servers: {} });
  });

  it("invalid file means no servers plus an error", () => {
    const path = join(dir, "servers.json");
    for (const bad of [
      "{not json",
      JSON.stringify({ servers: { "a.b": { command: "x", args: [] } } }),
      JSON.stringify({ servers: { Upper: { command: "x", args: [] } } }),
      JSON.stringify({ servers: { ok: { command: "x", args: [], extra: 1 } } }),
      JSON.stringify({ servers: { ok: { command: "", args: [] } } }),
      JSON.stringify({ servers: {}, more: true }),
      JSON.stringify({
        servers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`s${i}`, { command: "x", args: [] }])),
      }),
    ]) {
      writeFileSync(path, bad);
      const r = loadServers(path);
      expect(r.servers).toEqual({});
      expect(r.error).toMatch(/servers file .* is invalid/);
    }
  });

  it("parses a valid file", () => {
    const path = join(dir, "servers.json");
    const servers = {
      fs: { command: "/usr/bin/fs-server", args: ["--root", "/tmp"], env: { A: "1" }, cwd: "/tmp" },
      "web-2": { command: "web", args: [] },
    };
    writeFileSync(path, JSON.stringify({ servers }));
    expect(loadServers(path)).toEqual({ servers });
  });
});

describe("McpProxy", () => {
  it("lists every tool in trusted mode and only allowed tools in restricted mode", async () => {
    const servers = { stub: stub(TOOLS), other: stub([{ name: "one" }, { name: "two" }]) };
    const all = await proxy(servers).listTools();
    expect(all.map((t) => `${t.server}.${t.name}`).sort()).toEqual(
      ["stub.echo", "stub.env", "stub.crash", "stub.hang", "stub.big", "other.one", "other.two"].sort(),
    );
    expect(all.find((t) => t.name === "echo")).toMatchObject({
      description: "Echoes.",
      inputSchema: { type: "object", properties: { x: { type: "string" } } },
    });

    const some = await proxy(servers, restricted(["stub.echo", "other.*"])).listTools();
    expect(some.map((t) => `${t.server}.${t.name}`).sort()).toEqual(["other.one", "other.two", "stub.echo"]);
    // ask counts as not allowed.
    expect(await proxy(servers, restricted(["stub.echo"], "ask")).listTools()).toHaveLength(1);
    expect(await proxy(servers, restricted(undefined)).listTools()).toEqual([]);
  });

  it("calls an allowed tool and denies one the policy does not allow", async () => {
    const p = proxy({ stub: stub(TOOLS) }, restricted(["stub.echo"]));
    expect(JSON.parse(textOf(await p.call("stub", "echo", { x: "hi" })))).toEqual({ tool: "echo", args: { x: "hi" } });
    await expect(p.call("stub", "env", {})).rejects.toThrow(/"stub.env" is not in the allowed tools/);
  });

  it("treats ask as deny: direct mode cannot wait for the owner", async () => {
    const p = proxy({ stub: stub(TOOLS) }, restricted(["stub.echo"], "ask"));
    await expect(p.call("stub", "env", {})).rejects.toThrow(ASK_DENIED_REASON);
    expect(ASK_DENIED_REASON).toBe(
      "this tool needs the owner's approval, which direct mode cannot wait for; ask the owner to allow it in the policy",
    );
  });

  it("re-reads the policy on every call", async () => {
    let policy: PolicyConfig = restricted(["stub.echo"]);
    const p = proxy({ stub: stub(TOOLS) }, () => policy);
    await p.call("stub", "echo", {});
    policy = restricted([]);
    await expect(p.call("stub", "echo", {})).rejects.toThrow(/not in the allowed tools/);
    policy = { mode: "trusted" };
    await p.call("stub", "env", {});
  });

  it("refuses an unknown server and non-object args", async () => {
    const p = proxy({ stub: stub(TOOLS) });
    await expect(p.call("nope", "echo", {})).rejects.toThrow(/unknown server/);
    await expect(p.call("stub", "echo", [1, 2])).rejects.toThrow(/arguments must be an object/);
  });

  it("starts servers lazily with a minimal environment plus the configured env", async () => {
    const pidFile = join(dir, "pids");
    process.env.HOISTLINE_TEST_SECRET = "do-not-pass";
    try {
      const p = proxy({ stub: stub(TOOLS, { env: { FOO: "bar" } }, pidFile) });
      expect(pids(pidFile)).toEqual([]);
      const env = JSON.parse(textOf(await p.call("stub", "env", {}))) as Record<string, string>;
      expect(env.FOO).toBe("bar");
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOISTLINE_TEST_SECRET).toBeUndefined();
      for (const key of Object.keys(env)) {
        expect(["FOO", "PATH", "HOME", "USERPROFILE", "LANG", "SYSTEMROOT", "TEMP", "__CF_USER_TEXT_ENCODING"]).toContain(key);
      }
      // Kept running: a second call uses the same process.
      await p.call("stub", "echo", {});
      expect(pids(pidFile)).toHaveLength(1);
    } finally {
      delete process.env.HOISTLINE_TEST_SECRET;
    }
  });

  it("times out a call that never answers", async () => {
    const p = proxy({ stub: stub(TOOLS) }, { mode: "trusted" }, { callTimeoutMs: 200 });
    const started = Date.now();
    await expect(p.call("stub", "hang", {})).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("restarts a crashed server only on demand, after a backoff of 1 s, 2 s, 4 s ...", async () => {
    const pidFile = join(dir, "pids");
    let now = 1_000_000;
    const p = proxy({ stub: stub(TOOLS, {}, pidFile) }, { mode: "trusted" }, { now: () => now });
    await p.call("stub", "echo", {});
    for (const [i, delay] of [1000, 2000, 4000].entries()) {
      await expect(p.call("stub", "crash", {})).rejects.toThrow();
      await waitFor(() => !p.isRunning("stub"), `crash ${i + 1} noticed`);
      // Nobody asks: nothing restarts it.
      await new Promise((r) => setTimeout(r, 150));
      expect(pids(pidFile)).toHaveLength(i + 1);
      now += delay - 1;
      await expect(p.call("stub", "echo", {})).rejects.toThrow(/stopped unexpectedly; try again in 1 s/);
      expect(pids(pidFile)).toHaveLength(i + 1);
      now += 1;
      await p.call("stub", "echo", {});
      expect(pids(pidFile)).toHaveLength(i + 2);
    }
  });

  it("after 5 failed starts in a row, stays failed until a demand 60 s later", async () => {
    const pidFile = join(dir, "pids");
    let now = 1_000_000;
    const p = proxy({ bad: stub(TOOLS, {}, pidFile, { exitAtStart: true }) }, { mode: "trusted" }, { now: () => now });
    for (const [i, delay] of [1000, 2000, 4000, 8000].entries()) {
      await expect(p.call("bad", "echo", {})).rejects.toThrow();
      expect(pids(pidFile)).toHaveLength(i + 1);
      now += delay;
    }
    await expect(p.call("bad", "echo", {})).rejects.toThrow();
    expect(pids(pidFile)).toHaveLength(5);
    now += 16_000;
    await expect(p.call("bad", "echo", {})).rejects.toThrow(/try again in 44 s/);
    now += 44_000 - 1;
    await expect(p.call("bad", "echo", {})).rejects.toThrow(/try again in 1 s/);
    expect(pids(pidFile)).toHaveLength(5);
    now += 1;
    await expect(p.call("bad", "echo", {})).rejects.toThrow();
    expect(pids(pidFile)).toHaveLength(6);
  });

  it("skips stdout lines that are not JSON-RPC and keeps reading, logging once", async () => {
    const lines: string[] = [];
    const p = proxy({ stub: stub(TOOLS, {}, undefined, { junk: true }) }, { mode: "trusted" }, {
      log: (l) => lines.push(l),
      callTimeoutMs: 2000,
      startTimeoutMs: 2000,
    });
    const started = Date.now();
    expect(JSON.parse(textOf(await p.call("stub", "echo", { a: 1 })))).toEqual({ tool: "echo", args: { a: 1 } });
    await p.call("stub", "echo", {});
    expect(Date.now() - started).toBeLessThan(1500);
    expect(lines.filter((l) => l.includes("not JSON-RPC"))).toHaveLength(1);
  });

  it("stops a server whose output line is too large, keeps the others working, and restarts it on demand", async () => {
    const pidFile = join(dir, "pids");
    const lines: string[] = [];
    let now = 1_000_000;
    const p = proxy(
      { spewer: stub([...TOOLS, { name: "spew" }], {}, pidFile), other: stub(TOOLS) },
      { mode: "trusted" },
      { log: (l) => lines.push(l), now: () => now, maxLineBytes: 64 * 1024 },
    );
    await p.call("other", "echo", {});
    await p.call("spewer", "echo", {});
    const pending = p.call("spewer", "hang", {});
    pending.catch(() => {});
    await expect(p.call("spewer", "spew", { bytes: 200 * 1024 })).rejects.toThrow(/server output too large/);
    await expect(pending).rejects.toThrow(/server output too large/);
    await waitFor(() => !p.isRunning("spewer"), "the spewer stopped");
    expect(lines.filter((l) => l.includes("output too large"))).toHaveLength(1);
    // The process group is gone, the agent is still here and the other server still answers.
    const [first] = pids(pidFile);
    if (posix) await waitFor(() => !alive(Number(first)), "the spewer's process gone");
    expect(JSON.parse(textOf(await p.call("other", "echo", { a: 1 })))).toEqual({ tool: "echo", args: { a: 1 } });
    // Normal backoff, then the next demand starts it again.
    await expect(p.call("spewer", "echo", {})).rejects.toThrow(/try again in 1 s/);
    now += 1000;
    await p.call("spewer", "echo", {});
    expect(pids(pidFile)).toHaveLength(2);
  });

  it("says why a server that writes too large a line while starting did not start", async () => {
    const p = proxy({ s: stub(TOOLS, {}, undefined, { spewAtStart: 200 * 1024 }) }, { mode: "trusted" }, {
      maxLineBytes: 64 * 1024,
    });
    await expect(p.call("s", "echo", {})).rejects.toThrow(/server output too large/);
  });

  it("survives an output line over the default 10 MiB limit", async () => {
    const p = proxy({ spewer: stub([...TOOLS, { name: "spew" }]), other: stub(TOOLS) });
    await expect(p.call("spewer", "spew", { bytes: 11 * 1024 * 1024 })).rejects.toThrow(/server output too large/);
    await p.call("other", "echo", {});
  });

  it("gives up on a server that never reads its input, within the start deadline, and still shuts down", async () => {
    const pidFile = join(dir, "pids");
    const p = proxy({ flood: stub(TOOLS, {}, pidFile, { flood: true }) }, { mode: "trusted" }, { startTimeoutMs: 500 });
    const started = Date.now();
    expect(await p.listTools()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1500);
    const pid = Number(pids(pidFile)[0]);
    await waitFor(() => !alive(pid), "flooding server killed", 3000);
    const closing = Date.now();
    await p.close();
    expect(Date.now() - closing).toBeLessThan(1000);
  });

  it("shutdown does not wait for a server that is still starting", async () => {
    const pidFile = join(dir, "pids");
    const p = proxy({ slow: stub(TOOLS, {}, pidFile, { noInit: true }) }, { mode: "trusted" }, { startTimeoutMs: 10_000 });
    const listing = p.listTools();
    await waitFor(() => pids(pidFile).length === 1, "server spawned");
    const closing = Date.now();
    await p.close();
    expect(Date.now() - closing).toBeLessThan(1000);
    expect(await listing).toEqual([]);
    const pid = Number(pids(pidFile)[0]);
    await waitFor(() => !alive(pid), "starting server killed", 3000);
  });

  it("lists the healthy servers' tools when another server's listing does not finish in time", async () => {
    const lines: string[] = [];
    const p = proxy(
      { slow: stub(TOOLS, {}, undefined, { endlessPages: 100 }), stuck: stub(TOOLS, {}, undefined, { noInit: true }), ok: stub([{ name: "one" }]) },
      { mode: "trusted" },
      { listTimeoutMs: 400, startTimeoutMs: 10_000, log: (l) => lines.push(l) },
    );
    const started = Date.now();
    const tools = await p.listTools();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(tools.map((t) => `${t.server}.${t.name}`)).toEqual(["ok.one"]);
    expect(lines.some((l) => l.includes("slow") && l.includes("cannot list tools"))).toBe(true);
    expect(lines.some((l) => l.includes("stuck") && l.includes("cannot list tools"))).toBe(true);
  });

  it("lists within 20 s per server by default, below the hub's 25 s wait", () => {
    expect(DEFAULT_LIST_TIMEOUT_MS).toBe(20_000);
  });

  it.runIf(posix)("kills the rest of a server's process group when the server exits", async () => {
    const pidFile = join(dir, "pids");
    const p = proxy({ stub: stub(TOOLS, {}, pidFile, { grandchild: true }) });
    await p.listTools();
    await waitFor(() => pids(pidFile).length === 2, "grandchild started");
    const [leader, grandchild] = pids(pidFile).map(Number) as [number, number];
    expect(alive(grandchild)).toBe(true);
    await expect(p.call("stub", "crash", {})).rejects.toThrow();
    await waitFor(() => !alive(leader), "leader exited");
    await waitFor(() => !alive(grandchild), "grandchild killed", 3000);
  });

  it("caps the restart delay at 60 s", () => {
    expect(McpProxy.restartDelay(0)).toBe(1000);
    expect(McpProxy.restartDelay(5)).toBe(32_000);
    expect(McpProxy.restartDelay(6)).toBe(60_000);
    expect(McpProxy.restartDelay(30)).toBe(60_000);
  });

  it.runIf(posix)("registers server processes so a forced stop kills them", async () => {
    const pidFile = join(dir, "pids");
    const p = proxy({ stub: stub(TOOLS, {}, pidFile) });
    await p.listTools();
    const pid = Number(pids(pidFile)[0]);
    expect(alive(pid)).toBe(true);
    expect(killTrackedProcessGroups()).toBeGreaterThan(0);
    await waitFor(() => !alive(pid), "server process killed");
  });

  it.runIf(posix)("close stops every server process", async () => {
    const pidFile = join(dir, "pids");
    const p = proxy({ a: stub(TOOLS, {}, pidFile), b: stub(TOOLS, {}, pidFile) });
    await p.listTools();
    const started = pids(pidFile).map(Number);
    expect(started).toHaveLength(2);
    await p.close();
    await waitFor(() => started.every((pid) => !alive(pid)), "servers stopped");
  });

  it("a server that cannot start lists nothing and fails its calls", async () => {
    const p = proxy({ broken: { command: join(dir, "does-not-exist"), args: [] }, stub: stub(TOOLS) });
    const tools = await p.listTools();
    expect(tools.every((t) => t.server === "stub")).toBe(true);
    await expect(p.call("broken", "x", {})).rejects.toThrow();
  });
});

describe("McpProxy.onMessage", () => {
  function collect() {
    const sent: AgentToHub[] = [];
    return {
      sent,
      send: (m: AgentToHub) => {
        sent.push(AgentToHub.parse(m));
      },
    };
  }

  it("answers tools.list with the allowed tools, grouped by server, within the protocol limits", async () => {
    const long = `${"d".repeat(1999)}\u{1F600}${"d".repeat(3000)}`;
    const p = proxy({
      stub: stub([...TOOLS, { name: "wordy", description: long }, { name: "n".repeat(300) }]),
    });
    const { sent, send } = collect();
    p.onMessage({ type: "tools.list", callId: "c1" }, send);
    await waitFor(() => sent.length === 1, "tools.list answer");
    const msg = sent[0]! as Extract<AgentToHub, { type: "tools.list" }>;
    expect(msg.callId).toBe("c1");
    const tools = msg.servers.find((s) => s.name === "stub")!.tools;
    const wordy = tools.find((t) => t.name === "wordy")!.description!;
    expect(wordy.length).toBeLessThanOrEqual(2000);
    // Never cut between the two halves of a surrogate pair.
    expect(wordy.isWellFormed()).toBe(true);
    expect(tools.some((t) => t.name.length > 200)).toBe(false);
    expect(tools.find((t) => t.name === "echo")!.inputSchema).toEqual({
      type: "object",
      properties: { x: { type: "string" } },
    });
  });

  it("answers tools.call with tools.result, ok or not, and never throws", async () => {
    const p = proxy({ stub: stub(TOOLS) }, restricted(["stub.echo", "stub.big"]));
    const { sent, send } = collect();
    const call = (callId: string, tool: string, args: Record<string, unknown> = {}): HubToAgent => ({
      type: "tools.call",
      callId,
      userId: "u1",
      server: "stub",
      tool,
      args,
    });
    p.onMessage(call("ok", "echo", { x: 1 }), send);
    p.onMessage(call("denied", "env"), send);
    p.onMessage(call("huge", "big", { bytes: 6 * 1024 * 1024 }), send);
    p.onMessage({ type: "job.cancel", jobId: "j" }, send);
    expect(() => p.onMessage(null as unknown as HubToAgent, send)).not.toThrow();
    expect(() =>
      p.onMessage({ type: "tools.list", callId: "x" }, () => {
        throw new Error("socket gone");
      }),
    ).not.toThrow();
    await waitFor(() => sent.filter((m) => m.type === "tools.result").length === 3, "three results");
    const byId = Object.fromEntries(sent.map((m) => [(m as { callId: string }).callId, m]));
    expect(byId.ok).toMatchObject({ ok: true });
    expect(JSON.parse(textOf((byId.ok as { result: unknown }).result))).toEqual({ tool: "echo", args: { x: 1 } });
    expect(byId.denied).toMatchObject({ ok: false, error: expect.stringMatching(/not in the allowed tools/) });
    // Too big for the hub connection: cut to fit, with a marker.
    const huge = byId.huge as { ok: true; result: unknown };
    expect(huge.ok).toBe(true);
    expect(JSON.stringify(huge.result).length).toBeLessThan(5 * 1024 * 1024);
    expect(textOf(huge.result)).toMatch(/truncated/);
  });
});
