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
function stub(tools?: StubTool[], extra: Partial<ServerConfig> = {}, pidFile?: string): ServerConfig {
  return { command: process.execPath, args: [STUB, JSON.stringify({ tools, pidFile })], ...extra };
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

  it("restarts a crashed server with backoff (1 s, 2 s, 4 s ... at most 60 s)", async () => {
    const pidFile = join(dir, "pids");
    const delays: number[] = [];
    const p = proxy({ stub: stub(TOOLS, {}, pidFile) }, { mode: "trusted" }, {
      setTimeout: (fn, ms) => {
        delays.push(ms);
        return setTimeout(fn, 0);
      },
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    });
    await p.call("stub", "echo", {});
    for (let i = 1; i <= 3; i++) {
      await expect(p.call("stub", "crash", {})).rejects.toThrow();
      await waitFor(() => pids(pidFile).length === i + 1, `restart ${i}`);
      // Usable again once restarted.
      await waitFor(() => p.isRunning("stub"), `server running after restart ${i}`);
      await p.call("stub", "echo", {});
    }
    expect(delays).toEqual([1000, 2000, 4000]);
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
    const long = "d".repeat(5000);
    const p = proxy({
      stub: stub([...TOOLS, { name: "wordy", description: long }, { name: "n".repeat(300) }]),
    });
    const { sent, send } = collect();
    p.onMessage({ type: "tools.list", callId: "c1" }, send);
    await waitFor(() => sent.length === 1, "tools.list answer");
    const msg = sent[0]! as Extract<AgentToHub, { type: "tools.list" }>;
    expect(msg.callId).toBe("c1");
    const tools = msg.servers.find((s) => s.name === "stub")!.tools;
    expect(tools.find((t) => t.name === "wordy")!.description!.length).toBeLessThanOrEqual(2000);
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
