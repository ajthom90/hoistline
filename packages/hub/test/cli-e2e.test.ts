import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadIdentity, main, registerRunner, savePolicy, type CliDeps, type CliIO } from "@hoistline/agent";
import { InMemoryOAuthProvider } from "../src/auth/in-memory-provider.js";
import { Gateway } from "../src/gateway.js";
import { Jobs } from "../src/jobs.js";
import { createApp } from "../src/server.js";
import { Store, type User } from "../src/store.js";

/*
 * End to end through the agent CLI: a real hub, `hoistline-agent pair` and `hoistline-agent run` in-process (with a
 * fake `muse`, a node script started by absolute path, and a local bare remote), and the owner answering approvals
 * with `hoistline-agent approvals`.
 */

const FIXTURE_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const ID = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false"];
const fx = (args: string[], cwd?: string) =>
  execFileSync("git", [...ID, ...args], { cwd, env: FIXTURE_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const RUNNER_SOURCE = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const [cwd, prompt] = process.argv.slice(2);
const p = JSON.parse(prompt);
process.stdout.write("fake muse working\\n");
for (const [file, content] of Object.entries(p.write ?? {})) writeFileSync(join(cwd, file), content);
`;

let fixtures: string;
let remote: string;
let script: string;
beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), "hoistline-cli-e2e-fixture-"));
  remote = join(fixtures, "remote.git");
  const seed = join(fixtures, "seed");
  fx(["init", "-q", "--bare", "-b", "main", remote]);
  fx(["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "README"), "main\n");
  fx(["add", "README"], seed);
  fx(["commit", "-q", "-m", "main"], seed);
  fx(["push", "-q", remote, "main"], seed);
  script = join(fixtures, "runner.mjs");
  writeFileSync(script, RUNNER_SOURCE);
  return () => rmSync(fixtures, { recursive: true, force: true });
});

let dir: string;
const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hoistline-cli-e2e-"));
});
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  rmSync(dir, { recursive: true, force: true });
});

async function startHub(): Promise<{ url: string; store: Store; gateway: Gateway; jobs: Jobs; owner: User }> {
  const store = new Store(join(dir, "hub.db"));
  const gateway = new Gateway(store, store.getOrCreateSigningKey(), { pingIntervalMs: 100, pongTimeoutMs: 2000 });
  const jobs = new Jobs(store, gateway, { disconnectGraceMs: 5000 });
  jobs.attach();
  jobs.recoverAfterRestart();
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    "request",
    createApp({
      publicUrl: url,
      github: { clientId: "gh-client", clientSecret: "gh-secret" },
      oauthProvider: new InMemoryOAuthProvider(),
      store,
      gateway,
      jobs,
    }),
  );
  gateway.attach(server);
  cleanups.push(async () => {
    jobs.close();
    gateway.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
  const owner = store.upsertUser({ provider: "github", subject: "1", login: "alice" });
  return { url, store, gateway, jobs, owner };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("agent CLI end to end", () => {
  it("parks ask jobs for `approvals`, runs the approved one, fails the denied one, and cleans up on a signal", async () => {
    const hub = await startHub();
    const home = join(dir, "agent-home");
    let out = "";
    let err = "";
    const io: CliIO = {
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
      stdin: [],
      isTTY: false,
      env: { HOISTLINE_AGENT_HOME: home },
    };
    const cli = (...argv: string[]) => main(argv, io);

    expect(await cli("pair", hub.url, hub.store.createPairingCode(hub.owner.id), "--name", "laptop")).toBe(0);
    const identity = loadIdentity(join(home, "identity.json"));
    savePolicy(join(home, "policy.json"), {
      mode: "restricted",
      repos: ["someone/else"],
      runners: ["muse"],
      onViolation: "ask",
    });

    const spawned: string[] = [];
    let signal: ((sig: "SIGINT" | "SIGTERM") => void) | undefined;
    const deps: CliDeps = {
      // Only the fake runner, started by absolute path: no runner CLI is ever looked up on PATH.
      registerRunners: () =>
        registerRunner("muse", {
          file: process.execPath,
          args: (spec, ctx) => {
            spawned.push(process.execPath);
            return [script, ctx.cwd!, spec.prompt];
          },
        }),
      prepareOptions: { remoteFor: () => remote, allowFileProtocol: true },
      approvalPollIntervalMs: 20,
      onSignal: (handler) => {
        signal = handler;
        return () => {};
      },
    };
    const running = main(["run", "--cache-dir", join(dir, "cache")], io, deps);
    let stopped = false;
    cleanups.push(async () => {
      if (!stopped) {
        signal?.("SIGINT");
        await running;
      }
    });
    await waitFor(() => hub.gateway.isOnline(identity.machineId), "agent online");

    const pendingDir = join(home, "approvals", "pending");
    const pending = () => (existsSync(pendingDir) ? readdirSync(pendingDir) : []);
    const delegate = (write: Record<string, string>) =>
      hub.jobs.delegate(hub.owner.id, {
        machine: "laptop",
        runner: "muse",
        repo: "https://github.com/Owner/Name.git",
        branch: "main",
        prompt: JSON.stringify({ write }),
      });
    const parked = async (jobId: string) => {
      await waitFor(() => hub.jobs.status(hub.owner.id, jobId) === "awaiting_approval", "awaiting approval on the hub");
      await waitFor(() => pending().includes(`${jobId}.json`), "pending approval on the agent");
      expect(err).toContain(`job ${jobId} is awaiting approval; run: hoistline-agent approvals`);
    };

    // Approved: the full hash comes from `approvals show`; a prefix (usage error) or a wrong hash is refused and the
    // job keeps waiting.
    const job = delegate({ "approved.txt": "approved by the owner\n" });
    await parked(job.id);
    out = "";
    expect(await cli("approvals", "show", job.id)).toBe(0);
    const hash = /spec hash:\s+([0-9a-f]{64})/.exec(out)![1]!;
    const wrong = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
    expect(await cli("approvals", "approve", job.id, "--yes", "--hash", hash.slice(0, 16))).toBe(2);
    expect(await cli("approvals", "approve", job.id, "--yes", "--hash", wrong)).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(hub.jobs.status(hub.owner.id, job.id)).toBe("awaiting_approval");
    expect(pending()).toEqual([`${job.id}.json`]);
    expect(await cli("approvals", "approve", job.id, "--yes", "--hash", hash)).toBe(0);
    await waitFor(() => hub.jobs.status(hub.owner.id, job.id) === "succeeded", "approved job to succeed");
    expect(hub.jobs.result(hub.owner.id, job.id)).toMatchObject({ status: "succeeded", branch: `hoistline/${job.id}` });
    expect(fx(["show", `refs/heads/hoistline/${job.id}:approved.txt`], remote)).toBe("approved by the owner\n");
    expect(spawned).toEqual([process.execPath]);
    expect(pending()).toEqual([]);

    // Denied.
    const denied = delegate({ "denied.txt": "never\n" });
    await parked(denied.id);
    expect(await cli("approvals", "deny", denied.id)).toBe(0);
    await waitFor(() => hub.jobs.status(hub.owner.id, denied.id) === "failed", "denied job to fail");
    expect(hub.jobs.result(hub.owner.id, denied.id)).toMatchObject({ status: "failed", reason: "approval_denied" });
    expect(() => fx(["show", `refs/heads/hoistline/${denied.id}:denied.txt`], remote)).toThrow();
    expect(spawned).toHaveLength(1);

    // Stopping `run` withdraws what is still waiting.
    const waiting = delegate({ "waiting.txt": "never\n" });
    await parked(waiting.id);
    signal!("SIGINT");
    expect(await running).toBe(0);
    stopped = true;
    expect(pending()).toEqual([]);
    await waitFor(() => hub.jobs.status(hub.owner.id, waiting.id) !== "awaiting_approval", "waiting job to end");
    expect(hub.jobs.result(hub.owner.id, waiting.id)).toMatchObject({ status: "cancelled", reason: "agent_shutdown" });
    expect(spawned).toHaveLength(1);
  });

  it("holds a shared user's job under the owner's ask policy until the owner approves it on the agent", async () => {
    const hub = await startHub();
    const bob = hub.store.upsertUser({ provider: "github", subject: "2", login: "bob" });
    const home = join(dir, "agent-home");
    let out = "";
    const io: CliIO = {
      stdout: (s) => (out += s),
      stderr: () => {},
      stdin: [],
      isTTY: false,
      env: { HOISTLINE_AGENT_HOME: home },
    };
    const cli = (...argv: string[]) => main(argv, io);
    expect(await cli("pair", hub.url, hub.store.createPairingCode(hub.owner.id), "--name", "laptop")).toBe(0);
    const identity = loadIdentity(join(home, "identity.json"));
    hub.store.shareMachine(hub.owner.id, identity.machineId, "github:bob");
    savePolicy(join(home, "policy.json"), {
      mode: "restricted",
      repos: ["someone/else"],
      runners: ["muse"],
      onViolation: "ask",
    });

    const spawned: string[] = [];
    let signal: ((sig: "SIGINT" | "SIGTERM") => void) | undefined;
    const running = main(["run", "--cache-dir", join(dir, "cache")], io, {
      registerRunners: () =>
        registerRunner("muse", {
          file: process.execPath,
          args: (spec, ctx) => {
            spawned.push(process.execPath);
            return [script, ctx.cwd!, spec.prompt];
          },
        }),
      prepareOptions: { remoteFor: () => remote, allowFileProtocol: true },
      approvalPollIntervalMs: 20,
      onSignal: (handler) => {
        signal = handler;
        return () => {};
      },
    });
    cleanups.push(async () => {
      signal?.("SIGINT");
      await running;
    });
    await waitFor(() => hub.gateway.isOnline(identity.machineId), "agent online");

    const job = hub.jobs.delegate(bob.id, {
      machine: identity.machineId,
      runner: "muse",
      repo: "https://github.com/Owner/Name.git",
      branch: "main",
      prompt: JSON.stringify({ write: { "shared.txt": "from bob\n" } }),
    });
    await waitFor(() => hub.jobs.status(bob.id, job.id) === "awaiting_approval", "awaiting approval on the hub");
    const pendingDir = join(home, "approvals", "pending");
    await waitFor(() => existsSync(pendingDir) && readdirSync(pendingDir).includes(`${job.id}.json`), "pending approval");
    await new Promise((r) => setTimeout(r, 200));
    expect(hub.jobs.status(bob.id, job.id)).toBe("awaiting_approval");
    expect(spawned).toEqual([]);

    out = "";
    expect(await cli("approvals", "show", job.id)).toBe(0);
    const hash = /spec hash:\s+([0-9a-f]{64})/.exec(out)![1]!;
    expect(await cli("approvals", "approve", job.id, "--yes", "--hash", hash)).toBe(0);
    await waitFor(() => hub.jobs.status(bob.id, job.id) === "succeeded", "approved job to succeed");
    expect(spawned).toEqual([process.execPath]);
    expect(fx(["show", `refs/heads/hoistline/${job.id}:shared.txt`], remote)).toBe("from bob\n");
  });
});
