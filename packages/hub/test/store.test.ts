import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { SqliteOAuthProvider } from "../src/auth/sqlite-provider.js";
import { Store, type JobRow } from "../src/store.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

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
    const alice = store.upsertUser({ provider: "github", subject: "1", login: "alice" });
    const code = store.createPairingCode(alice.id);
    const machine = store.redeemPairingCode(code, "laptop", "pk");
    expect(machine).toMatchObject({ ownerId: alice.id, name: "laptop", publicKey: "pk" });
    expect(store.redeemPairingCode(code, "laptop2", "pk2")).toBeNull();
    expect(store.machinesFor(alice.id)).toHaveLength(1);
  });

  it("expires after 10 minutes", () => {
    const store = open();
    const alice = store.upsertUser({ provider: "github", subject: "1", login: "alice" });
    const code = store.createPairingCode(alice.id);
    clock += 10 * 60 * 1000;
    expect(store.redeemPairingCode(code, "laptop", "pk")).toBeNull();
    expect(store.machinesFor(alice.id)).toEqual([]);
  });

  it("is redeemable just before expiry, ignoring case and dashes, and is not stored in clear", () => {
    const store = open();
    const alice = store.upsertUser({ provider: "github", subject: "1", login: "alice" });
    const code = store.createPairingCode(alice.id);
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const normalized = code.replaceAll("-", "");
    const stored = store.db.prepare("SELECT code_hash FROM pairing_codes").all() as { code_hash: string }[];
    expect(stored.map((r) => r.code_hash)).toEqual([sha256(normalized)]);
    expect(stored.map((r) => r.code_hash)).not.toContain(normalized);
    expect(stored.map((r) => r.code_hash)).not.toContain(code);
    clock += 10 * 60 * 1000 - 1;
    expect(store.redeemPairingCode(code.toLowerCase().replaceAll("-", ""), "laptop", "pk")).not.toBeNull();
  });

  it("rejects unknown codes and sweeps expired ones", () => {
    const store = open();
    const alice = store.upsertUser({ provider: "github", subject: "1", login: "alice" });
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
    const alice = store.upsertUser({ provider: "github", subject: "1", login: "Alice" });
    const bob = store.upsertUser({ provider: "github", subject: "2", login: "bob" });
    const machine = store.redeemPairingCode(store.createPairingCode(alice.id), "laptop", "pk")!;
    return { store, alice, bob, machine };
  }

  it("upsertUser is stable per GitHub id and tracks login changes", () => {
    const store = open();
    const a = store.upsertUser({ provider: "github", subject: "1", login: "old" });
    const b = store.upsertUser({ provider: "github", subject: "1", login: "new" });
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

  it("getMachineById and getUser look up by id only", () => {
    const { store, alice, machine } = setup();
    expect(store.getMachineById(machine.id)?.ownerId).toBe(alice.id);
    expect(store.getMachineById("nope")).toBeNull();
    expect(store.getUser(alice.id)?.login).toBe("Alice");
    expect(store.getUser("nope")).toBeNull();
    expect(store.getUserByKey("github", "1")?.id).toBe(alice.id);
    expect(store.getUserByKey("github", "999")).toBeNull();
    expect(store.getUserByKey("oidc:https://x", "1")).toBeNull();
    expect(store.getUserByKey("github", "999")).toBeNull(); // still not created
  });

  it("only the owner can share or unshare", () => {
    const { store, bob, machine } = setup();
    expect(() => store.shareMachine(bob.id, machine.id, "bob")).toThrow();
    expect(() => store.unshareMachine(bob.id, machine.id, "bob")).toThrow();
    expect(store.getMachine(bob.id, machine.id)).toBeNull();
  });

  it("sharing with a login that has not signed in throws", () => {
    const { store, alice, machine } = setup();
    expect(() => store.shareMachine(alice.id, machine.id, "carol")).toThrow(/has not signed in to Hoistline yet/);
  });

  it("an empty value or unknown prefix throws", () => {
    const { store, alice, machine } = setup();
    for (const bad of ["", "  ", "github:", "user:", "oidc:x", "gitlab:x"]) {
      expect(() => store.shareMachine(alice.id, machine.id, bad)).toThrow(/share target|prefix/);
      expect(() => store.unshareMachine(alice.id, machine.id, bad)).toThrow(/share target|prefix/);
    }
  });

  it("sharing with an ambiguous login throws", () => {
    const { store, alice, machine } = setup();
    // The store never produces this; force two GitHub rows with the same login.
    store.upsertUser({ provider: "github", subject: "9", login: "zed" });
    store.upsertUser({ provider: "github", subject: "10", login: "zed2" });
    store.db.prepare("UPDATE users SET login = 'zed' WHERE subject = '10'").run();
    expect(() => store.shareMachine(alice.id, machine.id, "zed")).toThrow(/ambiguous login/);
  });

  it("an OIDC user with a GitHub user's login does not clear it, and github:bob still resolves to GitHub", () => {
    const { store, alice, bob, machine } = setup();
    const oidc = store.upsertUser({ provider: "oidc:https://idp", subject: "9", login: "bob" });
    expect(store.db.prepare("SELECT login FROM users WHERE id = ?").get(bob.id)).toEqual({ login: "bob" });
    expect(store.shareMachine(alice.id, machine.id, "github:bob").id).toBe(bob.id);
    expect(store.getMachine(oidc.id, machine.id)).toBeNull();
  });

  it("an OIDC user taking a GitHub login does not make bob resolve to the OIDC user", () => {
    const { store, alice, bob, machine } = setup();
    const oidc = store.upsertUser({ provider: "oidc:https://idp", subject: "9", login: "Bob" });
    const shared = store.shareMachine(alice.id, machine.id, "bob");
    expect(shared.id).toBe(bob.id);
    expect(store.getMachine(oidc.id, machine.id)).toBeNull();
  });

  it("github:<login> never resolves to an OIDC user", () => {
    const { store, alice, machine } = setup();
    store.upsertUser({ provider: "oidc:https://idp", subject: "9", login: "dave" });
    expect(() => store.shareMachine(alice.id, machine.id, "github:dave")).toThrow(/has not signed in to Hoistline yet/);
    expect(() => store.shareMachine(alice.id, machine.id, "dave")).toThrow(/has not signed in to Hoistline yet/);
  });

  it("user:<id> shares and unshares by exact id, including OIDC users", () => {
    const { store, alice, machine } = setup();
    const oidc = store.upsertUser({ provider: "oidc:https://idp", subject: "9", login: "dave" });
    expect(store.shareMachine(alice.id, machine.id, `user:${oidc.id}`)).toMatchObject({ id: oidc.id, provider: oidc.provider });
    expect(store.getMachine(oidc.id, machine.id)?.id).toBe(machine.id);
    store.unshareMachine(alice.id, machine.id, `user:${oidc.id}`);
    expect(store.getMachine(oidc.id, machine.id)).toBeNull();
    expect(() => store.shareMachine(alice.id, machine.id, "user:nope")).toThrow(/has not signed in to Hoistline yet/);
  });

  it("a bare login behaves as github:<login>", () => {
    const { store, alice, bob, machine } = setup();
    expect(store.shareMachine(alice.id, machine.id, "BOB").id).toBe(bob.id);
    expect(store.listShares(alice.id, machine.id)).toEqual([{ userId: bob.id, provider: "github", login: "bob" }]);
    store.unshareMachine(alice.id, machine.id, "github:Bob");
    expect(store.listShares(alice.id, machine.id)).toEqual([]);
  });

  it("a share whose sharee's login was blanked can be listed and revoked via user:<id>", () => {
    const { store, alice, bob, machine } = setup();
    store.shareMachine(alice.id, machine.id, "bob");
    store.upsertUser({ provider: "github", subject: "666", login: "bob" }); // clears the stale holder's login
    expect(store.listShares(alice.id, machine.id)).toEqual([{ userId: bob.id, provider: "github", login: "" }]);
    expect(() => store.unshareMachine(alice.id, machine.id, "github:bob")).toThrow(/has not signed in/);
    store.unshareMachine(alice.id, machine.id, `user:${bob.id}`);
    expect(store.listShares(alice.id, machine.id)).toEqual([]);
    expect(store.getMachine(bob.id, machine.id)).toBeNull();
  });

  it("listShares is owner only", () => {
    const { store, bob, machine } = setup();
    expect(() => store.listShares(bob.id, machine.id)).toThrow("Machine not found");
  });

  it("unshare resolves only among current sharees: an unshared user throws the zero-match error", () => {
    const { store, alice, bob, machine } = setup();
    const carol = store.upsertUser({ provider: "github", subject: "3", login: "carol" });
    store.shareMachine(alice.id, machine.id, "bob");
    expect(() => store.unshareMachine(alice.id, machine.id, "github:carol")).toThrow(/has not signed in to Hoistline yet/);
    expect(() => store.unshareMachine(alice.id, machine.id, `user:${carol.id}`)).toThrow(/has not signed in/);
    expect(store.getMachine(bob.id, machine.id)?.id).toBe(machine.id);
  });

  it("an OIDC user taking a login does not clear the GitHub holder, but a GitHub takeover still clears GitHub only", () => {
    const store = open();
    const gh = store.upsertUser({ provider: "github", subject: "1", login: "x" });
    const oidc = store.upsertUser({ provider: "oidc:https://idp", subject: "1", login: "x" });
    store.upsertUser({ provider: "github", subject: "2", login: "x" });
    const rows = store.db.prepare("SELECT id, login FROM users").all() as { id: string; login: string }[];
    expect(rows.find((r) => r.id === gh.id)?.login).toBe("");
    expect(rows.find((r) => r.id === oidc.id)?.login).toBe("x");
  });

  it("a share survives the grantee renaming their login", () => {
    const { store, alice, bob, machine } = setup();
    store.shareMachine(alice.id, machine.id, "bob");
    store.upsertUser({ provider: "github", subject: "2", login: "bob2" });
    expect(store.getMachine(bob.id, machine.id)?.id).toBe(machine.id);
    store.unshareMachine(alice.id, machine.id, "bob2");
    expect(store.getMachine(bob.id, machine.id)).toBeNull();
  });

  it("a login taken over after a rename does not inherit the share", () => {
    const { store, alice, bob, machine } = setup();
    store.shareMachine(alice.id, machine.id, "bob");
    store.upsertUser({ provider: "github", subject: "2", login: "bob2" });
    const attacker = store.upsertUser({ provider: "github", subject: "666", login: "bob" });
    expect(attacker.id).not.toBe(bob.id);
    expect(store.getMachine(attacker.id, machine.id)).toBeNull();
    expect(store.machinesFor(attacker.id)).toEqual([]);
    expect(store.getMachine(bob.id, machine.id)?.id).toBe(machine.id);
  });

  it("a stale holder of a login (same provider) has the login cleared", () => {
    const { store, alice, bob, machine } = setup();
    // Bob's rename was never seen; a new subject signs in as "bob".
    const attacker = store.upsertUser({ provider: "github", subject: "666", login: "Bob" });
    expect(store.getMachine(attacker.id, machine.id)).toBeNull();
    store.shareMachine(alice.id, machine.id, "bob");
    expect(store.getMachine(attacker.id, machine.id)?.id).toBe(machine.id);
    expect(store.getMachine(bob.id, machine.id)).toBeNull();
  });

  it("the same subject under different providers is two users", () => {
    const store = open();
    const gh = store.upsertUser({ provider: "github", subject: "42", login: "alice" });
    const oidc = store.upsertUser({ provider: "oidc:https://idp", subject: "42", login: "alice2" });
    expect(oidc.id).not.toBe(gh.id);
    expect(store.upsertUser({ provider: "github", subject: "42", login: "alice" }).id).toBe(gh.id);
  });
});

describe("jobs", () => {
  function setup() {
    const store = open();
    const alice = store.upsertUser({ provider: "github", subject: "1", login: "alice" });
    const bob = store.upsertUser({ provider: "github", subject: "2", login: "bob" });
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

  it("transitionJob only applies when the job is in one of the given states", () => {
    const { store, alice, machine } = setup();
    store.insertJob(job(alice.id, machine.id));
    expect(store.transitionJob("job-1", ["running"], { status: "failed" })).toBe(false);
    expect(store.transitionJob("job-1", ["queued"], { status: "running" })).toBe(true);
    expect(store.transitionJob("job-1", ["queued", "running"], { status: "succeeded", exitCode: 0 })).toBe(true);
    expect(store.transitionJob("job-1", ["queued", "running"], { status: "failed" })).toBe(false);
    expect(store.transitionJob("nope", ["queued"], { status: "failed" })).toBe(false);
    expect(store.getJobById("job-1")).toMatchObject({ status: "succeeded", exitCode: 0 });
  });

  it("appendJobOutput keeps a UTF-8-safe tail and records the truncation, only while the job is in a given state", () => {
    const { store, alice, machine } = setup();
    store.insertJob(job(alice.id, machine.id));
    expect(store.appendJobOutput("job-1", "abc", 8, ["queued"])).toBe(true);
    expect(store.getJobById("job-1")).toMatchObject({ output: "abc" });
    expect(store.getJobById("job-1")!.outputTruncated).toBeUndefined();
    // "abc€€€" is 12 bytes; the last 8 start inside the first "€", so the cut moves to the next character.
    store.appendJobOutput("job-1", "€€€", 8, ["queued"]);
    expect(store.getJobById("job-1")).toMatchObject({ output: "€€", outputTruncated: true });
    store.updateJob("job-1", { status: "failed" });
    expect(store.appendJobOutput("job-1", "late", 8, ["queued"])).toBe(false);
    expect(store.getJobById("job-1")!.output).toBe("€€");
  });

  it("lists and counts active jobs per user and machine", () => {
    const { store, alice, bob, machine } = setup();
    const other = store.redeemPairingCode(store.createPairingCode(bob.id), "desk", "pk")!;
    store.insertJob(job(alice.id, machine.id, "a"));
    store.insertJob({ ...job(alice.id, machine.id, "b"), status: "running" });
    store.insertJob({ ...job(alice.id, machine.id, "c"), status: "succeeded" });
    store.insertJob({ ...job(bob.id, other.id, "d"), status: "awaiting_approval" });
    expect(store.activeJobs(machine.id).map((j) => j.id).sort()).toEqual(["a", "b"]);
    expect(store.activeJobs().map((j) => j.id).sort()).toEqual(["a", "b", "d"]);
    expect(store.countActiveJobs({ userId: alice.id })).toBe(2);
    expect(store.countActiveJobs({ machineId: other.id })).toBe(1);
    expect(store.machinesWithActiveJobs().sort()).toEqual([machine.id, other.id].sort());
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

  it("getOrCreateSigningKey returns one Ed25519 pair, stable across reopen", () => {
    const first = open();
    const key = first.getOrCreateSigningKey();
    expect(key.privateKey.asymmetricKeyType).toBe("ed25519");
    expect(key.publicKey.type).toBe("public");
    const der = (k: KeyObject) => k.export({ format: "der", type: "spki" }).toString("base64");
    expect(der(first.getOrCreateSigningKey().publicKey)).toBe(der(key.publicKey));
    first.close();
    const second = open().getOrCreateSigningKey();
    expect(der(second.publicKey)).toBe(der(key.publicKey));
    const signature = sign(null, Buffer.from("x"), second.privateKey);
    expect(verify(null, Buffer.from("x"), key.publicKey, signature)).toBe(true);
  });

  it("re-running migrations on an existing database is a no-op", () => {
    const first = open();
    const alice = first.upsertUser({ provider: "github", subject: "1", login: "alice" });
    first.close();
    expect(open().upsertUser({ provider: "github", subject: "1", login: "alice" }).id).toBe(alice.id);
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
    const unused = await provider.issueAuthorizationCode(client.client_id, params, user);
    const codeHashes = (store.db.prepare("SELECT code_hash FROM oauth_codes").all() as { code_hash: string }[]).map(
      (r) => r.code_hash,
    );
    expect(codeHashes).toEqual([sha256(unused)]);
    expect(JSON.stringify(store.db.prepare("SELECT * FROM oauth_codes").all())).not.toContain(unused);
    const tokenHashes = (store.db.prepare("SELECT token_hash FROM oauth_tokens").all() as { token_hash: string }[]).map(
      (r) => r.token_hash,
    );
    expect(tokenHashes.sort()).toEqual([sha256(tokens.access_token), sha256(tokens.refresh_token!)].sort());
    const dump = JSON.stringify(store.db.prepare("SELECT * FROM oauth_tokens").all());
    expect(dump).not.toContain(tokens.access_token);
    expect(dump).not.toContain(tokens.refresh_token!);
  });
});
