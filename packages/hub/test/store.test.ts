import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { SqliteOAuthProvider } from "../src/auth/sqlite-provider.js";
import { Store, type JobRow } from "../src/store.js";

let dir: string;
let clock: number;
const stores: Store[] = [];

function open(path = join(dir, "hub.db")): Store {
  const store = new Store(path, { now: () => clock });
  stores.push(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hoistline-store-"));
  clock = 1_700_000_000_000;
});

afterEach(() => {
  for (const s of stores.splice(0)) if (s.db.open) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function job(userId: string, machineId: string, id = "job-1"): JobRow {
  return {
    id,
    userId,
    machineId,
    runner: "claude",
    repo: "acme/app",
    baseBranch: "main",
    prompt: "fix the bug",
    status: "queued",
    createdAt: clock,
    updatedAt: clock,
  };
}

describe("pairing codes", () => {
  it("returns a machine once and null the second time", () => {
    const store = open();
    const alice = store.upsertUser({ id: "1", login: "alice" });
    const code = store.createPairingCode(alice.id);
    const machine = store.redeemPairingCode(code, "laptop", "pk");
    expect(machine).toMatchObject({ ownerId: alice.id, name: "laptop", publicKey: "pk" });
    expect(store.redeemPairingCode(code, "laptop2", "pk2")).toBeNull();
    expect(store.machinesFor(alice.id)).toHaveLength(1);
  });

  it("expires after 10 minutes", () => {
    const store = open();
    const alice = store.upsertUser({ id: "1", login: "alice" });
    const code = store.createPairingCode(alice.id);
    clock += 10 * 60 * 1000;
    expect(store.redeemPairingCode(code, "laptop", "pk")).toBeNull();
    expect(store.machinesFor(alice.id)).toEqual([]);
  });

  it("is redeemable just before expiry, ignoring case and dashes, and is not stored in clear", () => {
    const store = open();
    const alice = store.upsertUser({ id: "1", login: "alice" });
    const code = store.createPairingCode(alice.id);
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const stored = store.db.prepare("SELECT code_hash FROM pairing_codes").all() as { code_hash: string }[];
    expect(stored.map((r) => r.code_hash)).not.toContain(code);
    clock += 10 * 60 * 1000 - 1;
    expect(store.redeemPairingCode(code.toLowerCase().replaceAll("-", ""), "laptop", "pk")).not.toBeNull();
  });

  it("rejects unknown codes and sweeps expired ones", () => {
    const store = open();
    const alice = store.upsertUser({ id: "1", login: "alice" });
    expect(store.redeemPairingCode("NOPE-NOPE-NOPE", "x", "pk")).toBeNull();
    store.createPairingCode(alice.id);
    clock += 11 * 60 * 1000;
    store.sweepExpired(clock);
    expect(store.db.prepare("SELECT count(*) AS n FROM pairing_codes").get()).toEqual({ n: 0 });
  });
});

describe("machines and sharing", () => {
  function setup() {
    const store = open();
    const alice = store.upsertUser({ id: "1", login: "Alice" });
    const bob = store.upsertUser({ id: "2", login: "bob" });
    const machine = store.redeemPairingCode(store.createPairingCode(alice.id), "laptop", "pk")!;
    return { store, alice, bob, machine };
  }

  it("upsertUser is stable per GitHub id and tracks login changes", () => {
    const store = open();
    const a = store.upsertUser({ id: "1", login: "old" });
    const b = store.upsertUser({ id: "1", login: "new" });
    expect(b.id).toBe(a.id);
    expect(b.login).toBe("new");
  });

  it("getMachine returns null for another user's unshared machine", () => {
    const { store, bob, machine } = setup();
    expect(store.getMachine(bob.id, machine.id)).toBeNull();
    expect(store.machinesFor(bob.id)).toEqual([]);
  });

  it("machinesFor includes owned and shared machines; unshare removes access", () => {
    const { store, alice, bob, machine } = setup();
    const bobsOwn = store.redeemPairingCode(store.createPairingCode(bob.id), "desktop", "pk2")!;
    store.shareMachine(alice.id, machine.id, "BOB");
    expect(store.machinesFor(bob.id).map((m) => m.id).sort()).toEqual([machine.id, bobsOwn.id].sort());
    expect(store.getMachine(bob.id, machine.id)?.id).toBe(machine.id);
    store.unshareMachine(alice.id, machine.id, "bob");
    expect(store.machinesFor(bob.id).map((m) => m.id)).toEqual([bobsOwn.id]);
  });

  it("only the owner can share or unshare", () => {
    const { store, bob, machine } = setup();
    expect(() => store.shareMachine(bob.id, machine.id, "bob")).toThrow();
    expect(() => store.unshareMachine(bob.id, machine.id, "bob")).toThrow();
    expect(store.getMachine(bob.id, machine.id)).toBeNull();
  });

  it("a share can be granted before the person has signed in", () => {
    const { store, alice, machine } = setup();
    store.shareMachine(alice.id, machine.id, "carol");
    const carol = store.upsertUser({ id: "3", login: "carol" });
    expect(store.getMachine(carol.id, machine.id)?.id).toBe(machine.id);
  });
});

describe("jobs", () => {
  function setup() {
    const store = open();
    const alice = store.upsertUser({ id: "1", login: "alice" });
    const bob = store.upsertUser({ id: "2", login: "bob" });
    const machine = store.redeemPairingCode(store.createPairingCode(alice.id), "laptop", "pk")!;
    return { store, alice, bob, machine };
  }

  it("getJob returns null for another user's job, even on a machine shared with them", () => {
    const { store, alice, bob, machine } = setup();
    store.shareMachine(alice.id, machine.id, "bob");
    store.insertJob(job(alice.id, machine.id));
    expect(store.getJob(alice.id, "job-1")).toMatchObject({ id: "job-1", status: "queued" });
    expect(store.getJob(bob.id, "job-1")).toBeNull();
  });

  it("updateJob patches fields, bumps updatedAt, and cannot reassign the owner", () => {
    const { store, alice, bob, machine } = setup();
    const original = job(alice.id, machine.id);
    store.insertJob({ ...original, model: "opus" });
    clock += 5000;
    store.updateJob("job-1", { status: "done", branch: "hoistline/x", output: "ok", userId: bob.id, createdAt: 1 });
    expect(store.getJob(alice.id, "job-1")).toEqual({
      ...original,
      model: "opus",
      status: "done",
      branch: "hoistline/x",
      output: "ok",
      updatedAt: clock,
    });
    expect(store.getJob(bob.id, "job-1")).toBeNull();
  });
});

describe("persistence", () => {
  it("getOrCreateSecret is stable across reopen", () => {
    const first = open();
    const secret = first.getOrCreateSecret("cookie");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(first.getOrCreateSecret("cookie")).toBe(secret);
    expect(first.getOrCreateSecret("other")).not.toBe(secret);
    first.close();
    expect(open().getOrCreateSecret("cookie")).toBe(secret);
  });

  it("re-running migrations on an existing database is a no-op", () => {
    const first = open();
    const alice = first.upsertUser({ id: "1", login: "alice" });
    first.close();
    expect(open().upsertUser({ id: "1", login: "alice" }).id).toBe(alice.id);
  });
});

describe("SqliteOAuthProvider", () => {
  const user = { provider: "github", id: "1", login: "alice" } as never;
  const params = {
    redirectUri: "https://client.example/cb",
    codeChallenge: "challenge",
    scopes: ["mcp"],
    resource: new URL("https://hub.example/"),
  };

  function setup(path?: string) {
    const store = open(path);
    const provider = new SqliteOAuthProvider(store);
    const client = provider.clientsStore.registerClient!({
      redirect_uris: ["https://client.example/cb"],
    }) as OAuthClientInformationFull;
    return { store, provider, client };
  }

  it("persists clients and tokens across a restart", async () => {
    const path = join(dir, "restart.db");
    const a = setup(path);
    const code = await a.provider.issueAuthorizationCode(a.client.client_id, params, user);
    const tokens = await a.provider.exchangeAuthorizationCode(a.client, code, undefined, params.redirectUri);
    a.store.close();

    const store = open(path);
    const provider = new SqliteOAuthProvider(store);
    expect(await provider.clientsStore.getClient(a.client.client_id)).toMatchObject({ client_id: a.client.client_id });
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info).toMatchObject({
      clientId: a.client.client_id,
      scopes: ["mcp"],
      expiresAt: Math.floor(clock / 1000) + 3600,
      extra: { user },
    });
    expect(info.resource?.href).toBe("https://hub.example/");
    const refreshed = await provider.exchangeRefreshToken(a.client, tokens.refresh_token!);
    expect(refreshed.access_token).not.toBe(tokens.access_token);
  });

  it("codes are single use and bound to client and redirect_uri", async () => {
    const { provider, client } = setup();
    const other = provider.clientsStore.registerClient!({ redirect_uris: ["https://client.example/cb"] }) as OAuthClientInformationFull;

    let code = await provider.issueAuthorizationCode(client.client_id, params, user);
    expect(await provider.challengeForAuthorizationCode(client, code)).toBe("challenge");
    await expect(provider.challengeForAuthorizationCode(other, code)).rejects.toThrow();
    await expect(provider.exchangeAuthorizationCode(other, code, undefined, params.redirectUri)).rejects.toThrow();
    // A failed attempt consumes the code.
    await expect(provider.exchangeAuthorizationCode(client, code, undefined, params.redirectUri)).rejects.toThrow();

    code = await provider.issueAuthorizationCode(client.client_id, params, user);
    await expect(provider.exchangeAuthorizationCode(client, code, undefined, "https://evil.example/cb")).rejects.toThrow();

    code = await provider.issueAuthorizationCode(client.client_id, params, user);
    await provider.exchangeAuthorizationCode(client, code, undefined, params.redirectUri);
    await expect(provider.exchangeAuthorizationCode(client, code, undefined, params.redirectUri)).rejects.toThrow();
  });

  it("expires codes after 10 minutes, access tokens after 1 hour and refresh tokens after 30 days", async () => {
    const { provider, client } = setup();
    const code = await provider.issueAuthorizationCode(client.client_id, params, user);
    clock += 600_000;
    await expect(provider.exchangeAuthorizationCode(client, code, undefined, params.redirectUri)).rejects.toThrow();

    const fresh = await provider.issueAuthorizationCode(client.client_id, params, user);
    const tokens = await provider.exchangeAuthorizationCode(client, fresh, undefined, params.redirectUri);
    clock += 3_599_000;
    await provider.verifyAccessToken(tokens.access_token);
    clock += 1000;
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    clock += 30 * 24 * 3600 * 1000;
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow();
  });

  it("rotates refresh tokens and honors narrowed scopes", async () => {
    const { provider, client } = setup();
    const code = await provider.issueAuthorizationCode(client.client_id, { ...params, scopes: ["a", "b"] }, user);
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, params.redirectUri);
    const next = await provider.exchangeRefreshToken(client, tokens.refresh_token!, ["a", "zzz"]);
    expect(next.scope).toBe("a");
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow();
  });

  it("revokeToken kills the pair for the owning client only", async () => {
    const { provider, client } = setup();
    const other = provider.clientsStore.registerClient!({ redirect_uris: ["https://client.example/cb"] }) as OAuthClientInformationFull;
    const code = await provider.issueAuthorizationCode(client.client_id, params, user);
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, params.redirectUri);

    await provider.revokeToken(other, { token: tokens.refresh_token! });
    await provider.verifyAccessToken(tokens.access_token);

    await provider.revokeToken(client, { token: tokens.refresh_token! });
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow();
  });

  it("sweepExpired removes expired codes and tokens", async () => {
    const { store, provider, client } = setup();
    const code = await provider.issueAuthorizationCode(client.client_id, params, user);
    await provider.exchangeAuthorizationCode(client, code, undefined, params.redirectUri);
    await provider.issueAuthorizationCode(client.client_id, params, user);
    const count = (table: string) => (store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect([count("oauth_codes"), count("oauth_tokens")]).toEqual([1, 2]);
    clock += 31 * 24 * 3600 * 1000;
    provider.sweepExpired(clock);
    expect([count("oauth_codes"), count("oauth_tokens")]).toEqual([0, 0]);
  });

  it("stores codes and tokens hashed", async () => {
    const { store, provider, client } = setup();
    const code = await provider.issueAuthorizationCode(client.client_id, params, user);
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, params.redirectUri);
    const dump = JSON.stringify(store.db.prepare("SELECT token_hash FROM oauth_tokens").all());
    expect(dump).not.toContain(tokens.access_token);
    expect(dump).not.toContain(tokens.refresh_token!);
  });
});
