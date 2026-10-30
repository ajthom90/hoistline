import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryOAuthProvider } from "../src/auth/in-memory-provider.js";
import { SqliteOAuthProvider } from "../src/auth/sqlite-provider.js";
import {
  Browser,
  createPat,
  disposeContext,
  mcpClient,
  mcpStatus,
  newContext,
  oauthLogin,
  page,
  post,
  startHub,
  tokenEndpoint,
  uiLogin,
  type Hub,
  type TestContext,
} from "./ui-helpers.js";

let ctx: TestContext;
let browser: Browser;
beforeEach(() => {
  ctx = newContext();
  browser = new Browser();
});
afterEach(() => disposeContext(ctx));

const DAY = 24 * 60 * 60 * 1000;

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
}

describe("personal access tokens", () => {
  it("shows a new token once and stores only its sha256", async () => {
    const hub = await startHub(ctx);
    const alice = await uiLogin(hub, browser);
    const token = await createPat(hub, browser, "my laptop");
    expect(token).toMatch(/^hl_pat_[A-Za-z0-9_-]{43}$/);
    const rows = hub.store.db.prepare("SELECT * FROM personal_access_tokens").all() as TokenRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: alice.id,
      name: "my laptop",
      token_hash: createHash("sha256").update(token).digest("hex"),
      last_used_at: null,
    });
    expect(rows[0]!.expires_at - rows[0]!.created_at).toBe(90 * DAY);
    expect(JSON.stringify(hub.store.db.prepare("SELECT * FROM personal_access_tokens").all())).not.toContain(token);
    // The list page names the token but never shows it again.
    const { html } = await page(hub, browser, "/ui/tokens");
    expect(html).toContain("my laptop");
    expect(html).not.toContain(token);
  });

  it("lets an MCP client list tools with a token, acting as its user", async () => {
    const hub = await startHub(ctx);
    await uiLogin(hub, browser);
    const token = await createPat(hub, browser);
    const client = await mcpClient(hub, ctx, token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ping", "list_machines", "delegate_task"]));
    const out = await client.callTool({ name: "list_machines", arguments: {} });
    expect(out.structuredContent).toEqual({ machines: [] });
  });

  it("refuses revoked, expired and unknown tokens with 401", async () => {
    const hub = await startHub(ctx);
    await uiLogin(hub, browser);
    const revoked = await createPat(hub, browser, "a");
    const expiring = await createPat(hub, browser, "b", 1);
    expect(await mcpStatus(hub, revoked)).toBe(200);
    expect(await mcpStatus(hub, expiring)).toBe(200);
    expect(await mcpStatus(hub, "hl_pat_" + "x".repeat(43))).toBe(401);

    const id = (hub.store.db.prepare("SELECT id FROM personal_access_tokens WHERE name = 'a'").get() as { id: string }).id;
    const res = await post(hub, browser, `/ui/tokens/${id}/revoke`);
    expect(res.status).toBe(303);
    expect(await mcpStatus(hub, revoked)).toBe(401);

    hub.advance(DAY + 1000);
    // Re-login: the UI session (12 h) has expired as well.
    await uiLogin(hub, browser);
    expect(await mcpStatus(hub, expiring)).toBe(401);
  });

  it("cannot revoke another user's token", async () => {
    const hub = await startHub(ctx);
    await uiLogin(hub, browser);
    const token = await createPat(hub, browser);
    const id = (hub.store.db.prepare("SELECT id FROM personal_access_tokens").get() as { id: string }).id;
    const bob = new Browser();
    await uiLogin(hub, bob, "code-bob");
    expect((await post(hub, bob, `/ui/tokens/${id}/revoke`)).status).toBe(404);
    expect(await mcpStatus(hub, token)).toBe(200);
  });

  it("accepts 1..365 days, defaulting to 90", async () => {
    const hub = await startHub(ctx);
    await uiLogin(hub, browser);
    for (const days of ["0", "366", "-1", "1.5", "abc"]) {
      expect((await post(hub, browser, "/ui/tokens", { name: "t", days })).status).toBe(400);
    }
    for (const name of ["", "x".repeat(65), "bad\u0007name"]) {
      expect((await post(hub, browser, "/ui/tokens", { name, days: "30" })).status).toBe(400);
    }
    await createPat(hub, browser, "one", 1);
    await createPat(hub, browser, "max", 365);
    const rows = hub.store.db.prepare("SELECT name, created_at, expires_at FROM personal_access_tokens").all() as TokenRow[];
    const span = (name: string) => rows.find((r) => r.name === name)!;
    expect(span("one").expires_at - span("one").created_at).toBe(DAY);
    expect(span("max").expires_at - span("max").created_at).toBe(365 * DAY);
  });

  it("refuses a 21st live token", async () => {
    const hub = await startHub(ctx);
    await uiLogin(hub, browser);
    for (let i = 0; i < 20; i++) await createPat(hub, browser, `t${i}`);
    const res = await post(hub, browser, "/ui/tokens", { name: "t20" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("20");
    expect(hub.store.db.prepare("SELECT count(*) AS n FROM personal_access_tokens").get()).toEqual({ n: 20 });
  });

  it("updates last_used_at at most once per minute", async () => {
    const hub = await startHub(ctx);
    await uiLogin(hub, browser);
    const token = await createPat(hub, browser);
    const lastUsed = () =>
      (hub.store.db.prepare("SELECT last_used_at FROM personal_access_tokens").get() as { last_used_at: number }).last_used_at;
    expect(await mcpStatus(hub, token)).toBe(200);
    const first = lastUsed();
    expect(first).toBeGreaterThan(0);
    hub.advance(30_000);
    expect(await mcpStatus(hub, token)).toBe(200);
    expect(lastUsed()).toBe(first);
    hub.advance(31_000);
    expect(await mcpStatus(hub, token)).toBe(200);
    expect(lastUsed()).toBeGreaterThanOrEqual(first + 61_000);
  });

  it("stops working when its user is removed from the allowlist, without being revoked", async () => {
    const hub = await startHub(ctx, { allowedUsers: ["github:alice", "github:bob"] });
    await uiLogin(hub, browser);
    const token = await createPat(hub, browser);
    expect(await mcpStatus(hub, token)).toBe(200);
    // The same database served by a hub whose allowlist no longer has alice.
    const narrowed = await startHub(ctx, { allowedUsers: ["github:bob"] }, hub);
    expect(await mcpStatus(narrowed, token)).toBe(401);
    expect(hub.store.db.prepare("SELECT count(*) AS n FROM personal_access_tokens").get()).toEqual({ n: 1 });
    // Allowed by id as well as by login.
    const byId = await startHub(ctx, { allowedUsers: ["github-id:1"] }, hub);
    expect(await mcpStatus(byId, token)).toBe(200);
  });

  it("does not let a stale github:<login> identifier match after another account takes the login", async () => {
    const hub = await startHub(ctx);
    await uiLogin(hub, browser, "code-octo-old");
    const oldToken = await createPat(hub, browser, "old");
    const newBrowser = new Browser();
    await uiLogin(hub, newBrowser, "code-octo-new");
    const newToken = await createPat(hub, newBrowser, "new");
    const byLogin = await startHub(ctx, { allowedUsers: ["github:octo"] }, hub);
    expect(await mcpStatus(byLogin, oldToken)).toBe(401);
    expect(await mcpStatus(byLogin, newToken)).toBe(200);
    // Another identifier of the old account still counts.
    const byId = await startHub(ctx, { allowedUsers: ["github-id:10"] }, hub);
    expect(await mcpStatus(byId, oldToken)).toBe(200);
  });

  it("strips github:<login> from a user whose login was cleared earlier, when another account logs in with it", async () => {
    const oauthProvider = new InMemoryOAuthProvider();
    const hub = await startHub(ctx, { oauthProvider });
    const octoOld = await uiLogin(hub, browser, "code-octo-old");
    const pat = await createPat(hub, browser, "old");
    const { accessToken } = await oauthLogin(hub, new Browser(), "code-octo-old");
    // As left by an earlier hub: login cleared, identifiers kept.
    hub.store.db.prepare("UPDATE users SET login = '' WHERE id = ?").run(octoOld.id);
    expect(hub.store.getUserIdentifiers(octoOld.id)).toContain("github:octo");

    await uiLogin(hub, new Browser(), "code-octo-new");
    expect(hub.store.getUserIdentifiers(octoOld.id)).toEqual(["github-id:10"]);
    const byLogin = await startHub(ctx, { allowedUsers: ["github:octo"], oauthProvider }, hub);
    expect(await mcpStatus(byLogin, pat)).toBe(401);
    expect(await mcpStatus(byLogin, accessToken)).toBe(401);
    expect((await browser.request(`${byLogin.url}/ui`)).status).toBe(303);
    const byId = await startHub(ctx, { allowedUsers: ["github-id:10"], oauthProvider }, hub);
    expect(await mcpStatus(byId, pat)).toBe(200);
    expect(await mcpStatus(byId, accessToken)).toBe(200);
  });

  it("survives logout: revocation is explicit", async () => {
    const hub = await startHub(ctx);
    await uiLogin(hub, browser);
    const token = await createPat(hub, browser);
    const res = await post(hub, browser, "/ui/logout");
    expect(res.status).toBe(303);
    expect(await mcpStatus(hub, token)).toBe(200);
  });
});

describe("allowlist on OAuth tokens", () => {
  const refresh = (hub: Hub, clientId: string, refreshToken: string) =>
    tokenEndpoint(hub, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });

  it("refuses an OAuth access token once its user leaves the allowlist, and accepts it again when re-added", async () => {
    const oauthProvider = new InMemoryOAuthProvider();
    const hub = await startHub(ctx, { allowedUsers: ["github:alice", "github:bob"], oauthProvider });
    const { accessToken } = await oauthLogin(hub, browser);
    expect(await mcpStatus(hub, accessToken)).toBe(200);
    const narrowed = await startHub(ctx, { allowedUsers: ["github:bob"], oauthProvider }, hub);
    expect(await mcpStatus(narrowed, accessToken)).toBe(401);
    const byId = await startHub(ctx, { allowedUsers: ["github-id:1"], oauthProvider }, hub);
    expect(await mcpStatus(byId, accessToken)).toBe(200);
  });

  it("fails closed for an OAuth token whose user has no saved identifiers under an allowlist", async () => {
    const oauthProvider = new InMemoryOAuthProvider();
    const hub = await startHub(ctx, { oauthProvider });
    const { accessToken } = await oauthLogin(hub, browser);
    const alice = hub.store.getUserByKey("github", "1")!;
    hub.store.db.prepare("UPDATE users SET identifiers = NULL WHERE id = ?").run(alice.id);
    expect(await mcpStatus(hub, accessToken)).toBe(200);
    const listed = await startHub(ctx, { allowedUsers: ["github:alice"], oauthProvider }, hub);
    expect(await mcpStatus(listed, accessToken)).toBe(401);
  });

  it("refuses a refresh for a user no longer allowed with invalid_grant, and the refresh token is gone", async () => {
    const oauthProvider = new InMemoryOAuthProvider();
    const hub = await startHub(ctx, { allowedUsers: ["github:alice", "github:bob"], oauthProvider });
    const { clientId, refreshToken } = await oauthLogin(hub, browser);
    const narrowed = await startHub(ctx, { allowedUsers: ["github:bob"], oauthProvider }, hub);
    const refused = await refresh(narrowed, clientId, refreshToken);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("invalid_grant");
    // Re-adding the user does not revive the refused refresh token.
    expect((await refresh(hub, clientId, refreshToken)).body.error).toBe("invalid_grant");
    // An allowed user refreshes normally.
    const bob = await oauthLogin(narrowed, new Browser(), "code-bob");
    expect((await refresh(narrowed, bob.clientId, bob.refreshToken)).status).toBe(200);
  });

  it("revokes the pair a refused refresh would have issued (SQLite provider)", async () => {
    const hub = await startHub(ctx);
    const oauthProvider = new SqliteOAuthProvider(hub.store);
    const wide = await startHub(ctx, { allowedUsers: ["github:alice"], oauthProvider }, hub);
    const { clientId, refreshToken } = await oauthLogin(wide, browser);
    const kinds = () => hub.store.db.prepare("SELECT kind FROM oauth_tokens ORDER BY kind").all();
    expect(kinds()).toEqual([{ kind: "access" }, { kind: "refresh" }]);
    const narrowed = await startHub(ctx, { allowedUsers: ["github:bob"], oauthProvider }, hub);
    expect((await refresh(narrowed, clientId, refreshToken)).body.error).toBe("invalid_grant");
    // Only the original access token is left (which the verifier refuses); no refresh token survives.
    expect(kinds()).toEqual([{ kind: "access" }]);
  });
});
