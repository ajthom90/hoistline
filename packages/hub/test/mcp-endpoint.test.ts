import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InMemoryOAuthProvider } from "../src/auth/in-memory-provider.js";
import { createApp, type AppDeps } from "../src/server.js";

const CLIENT_REDIRECT = "http://localhost:9999/callback";

type StubRoute = (url: URL, init: RequestInit | undefined) => Response | undefined;

/** A fetch that answers only the given routes; anything else is a test failure (no network). */
function stubFetch(routes: StubRoute[]): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    for (const route of routes) {
      const res = route(url, init);
      if (res) return res;
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch: fn as typeof fetch, calls };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function githubStub(user = { id: 42, login: "octocat" }) {
  return stubFetch([
    (url, init) => {
      if (url.href !== "https://github.com/login/oauth/access_token") return undefined;
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      if (body.code !== "gh-code" || body.client_secret !== "gh-secret") {
        return json({ error: "bad_verification_code" });
      }
      return json({ access_token: "gh-access", token_type: "bearer" });
    },
    (url, init) => {
      if (url.href !== "https://api.github.com/user") return undefined;
      const headers = new Headers(init?.headers);
      if (headers.get("authorization") !== "Bearer gh-access" || !headers.get("user-agent")) {
        return new Response("forbidden", { status: 403 });
      }
      return json(user);
    },
  ]);
}

const ISSUER = "https://issuer.test";

function oidcStub(userinfo: Record<string, unknown> = { sub: "user-7", preferred_username: "ada" }) {
  return stubFetch([
    (url) =>
      url.href === `${ISSUER}/.well-known/openid-configuration`
        ? json({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/auth`,
            token_endpoint: `${ISSUER}/token`,
            userinfo_endpoint: `${ISSUER}/userinfo`,
          })
        : undefined,
    (url, init) => {
      if (url.href !== `${ISSUER}/token`) return undefined;
      const form = new URLSearchParams(String(init?.body));
      if (form.get("code") !== "oidc-code" || form.get("grant_type") !== "authorization_code") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return json({ access_token: "oidc-access", token_type: "Bearer" });
    },
    (url, init) => {
      if (url.href !== `${ISSUER}/userinfo`) return undefined;
      if (new Headers(init?.headers).get("authorization") !== "Bearer oidc-access") {
        return new Response("unauthorized", { status: 401 });
      }
      return json(userinfo);
    },
  ]);
}

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

async function startHub(extra: Partial<AppDeps> = {}): Promise<string> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const publicUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app = createApp({
    publicUrl,
    github: { clientId: "gh-client", clientSecret: "gh-secret" },
    ...extra,
  });
  server.on("request", app);
  return publicUrl;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** A user agent with its own cookie jar; requests never follow redirects. */
class Browser {
  readonly cookies = new Map<string, string>();
  readonly setCookieHeaders: string[] = [];

  async request(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const header of res.headers.getSetCookie()) {
      this.setCookieHeaders.push(header);
      const pair = header.split(";")[0]!;
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === "" || /max-age=0/i.test(header)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  postForm(url: string, form: Record<string, string>): Promise<Response> {
    return this.request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  }
}

/** The browser the default helpers act in; a fresh one per test. */
let browser: Browser;
beforeEach(() => {
  browser = new Browser();
});

async function registerClient(
  hub: string,
  clientName = "test client",
  redirectUris = [CLIENT_REDIRECT],
): Promise<string> {
  const res = await fetch(`${hub}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** GET /authorize in the given browser; returns the raw response (consent page or redirect). */
function openAuthorize(
  hub: string,
  clientId: string,
  challenge: string,
  user = browser,
  redirectUri = CLIENT_REDIRECT,
): Promise<Response> {
  const url = new URL(`${hub}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "client-state",
  }).toString();
  return user.request(url);
}

/** Hidden form fields of the hub consent page. */
function consentForm(html: string): { state: string; csrf: string } {
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  const state = field("state");
  const csrf = field("csrf");
  expect(state).toBeTruthy();
  expect(csrf).toBeTruthy();
  return { state: state!, csrf: csrf! };
}

/** Runs /authorize (approving the hub consent page if shown) and returns the upstream identity-provider redirect. */
async function startAuthorize(hub: string, clientId: string, challenge: string, user = browser): Promise<URL> {
  let res = await openAuthorize(hub, clientId, challenge, user);
  if (res.status === 200) {
    res = await user.postForm(`${hub}/oauth/consent`, { ...consentForm(await res.text()), decision: "approve" });
  }
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

async function callback(hub: string, params: Record<string, string>, user = browser): Promise<URL> {
  const res = await user.request(`${hub}/oauth/callback?${new URLSearchParams(params)}`);
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

async function token(hub: string, form: Record<string, string>) {
  const res = await fetch(`${hub}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Full GitHub login: register, authorize, GitHub callback, code exchange. */
async function githubLogin(hub: string) {
  const clientId = await registerClient(hub);
  const { verifier, challenge } = pkce();
  const upstream = await startAuthorize(hub, clientId, challenge);
  const back = await callback(hub, { code: "gh-code", state: upstream.searchParams.get("state")! });
  const tokens = await token(hub, {
    grant_type: "authorization_code",
    client_id: clientId,
    code: back.searchParams.get("code")!,
    code_verifier: verifier,
    redirect_uri: CLIENT_REDIRECT,
  });
  expect(tokens.status).toBe(200);
  return { clientId, tokens: tokens.body };
}

describe("MCP endpoint", () => {
  it("rejects unauthenticated POST /mcp with 401 pointing at protected-resource metadata", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const res = await fetch(`${hub}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${hub}/.well-known/oauth-protected-resource"`,
    );
  });

  it("serves OAuth authorization-server and protected-resource metadata as JSON", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const as = await fetch(`${hub}/.well-known/oauth-authorization-server`);
    expect(as.headers.get("content-type")).toContain("application/json");
    const asBody = (await as.json()) as Record<string, string>;
    expect(asBody.issuer).toBe(`${hub}/`);
    expect(asBody.registration_endpoint).toBe(`${hub}/register`);
    expect(asBody.authorization_endpoint).toBe(`${hub}/authorize`);

    const pr = await fetch(`${hub}/.well-known/oauth-protected-resource`);
    expect(pr.headers.get("content-type")).toContain("application/json");
    const prBody = (await pr.json()) as { authorization_servers: string[] };
    expect(prBody.authorization_servers).toEqual([`${hub}/`]);

    // RFC 9728 clients may probe the path-suffixed form for the /mcp resource first.
    const suffixed = await fetch(`${hub}/.well-known/oauth-protected-resource/mcp`);
    expect(suffixed.status).toBe(200);
    expect(await suffixed.json()).toEqual(prBody);
  });

  it("lets an authenticated SDK client list and call ping", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const { tokens } = await githubLogin(hub);
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${hub}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${String(tokens.access_token)}` } },
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["ping"]);
      const result = await client.callTool({ name: "ping", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    } finally {
      await client.close();
    }
  });
});

describe("GitHub login", () => {
  it("redirects /authorize to GitHub with the hub callback and a hub state", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const clientId = await registerClient(hub);
    const upstream = await startAuthorize(hub, clientId, pkce().challenge);
    expect(`${upstream.origin}${upstream.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(upstream.searchParams.get("client_id")).toBe("gh-client");
    expect(upstream.searchParams.get("redirect_uri")).toBe(`${hub}/oauth/callback`);
    expect(upstream.searchParams.get("scope")).toBe("read:user");
    expect(upstream.searchParams.get("state")).toMatch(/.{20,}/);
    expect(upstream.searchParams.get("state")).not.toBe("client-state");
  });

  it("issues a hub code to the client after the GitHub callback, carrying the client state", async () => {
    const stub = githubStub();
    const hub = await startHub({ fetch: stub.fetch });
    const clientId = await registerClient(hub);
    const upstream = await startAuthorize(hub, clientId, pkce().challenge);
    const back = await callback(hub, { code: "gh-code", state: upstream.searchParams.get("state")! });
    expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT);
    expect(back.searchParams.get("state")).toBe("client-state");
    expect(back.searchParams.get("code")).toBeTruthy();
    expect(stub.calls).toEqual([
      "POST https://github.com/login/oauth/access_token",
      "GET https://api.github.com/user",
    ]);
  });

  it("returns access_denied to the client when GitHub rejects the code", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const clientId = await registerClient(hub);
    const upstream = await startAuthorize(hub, clientId, pkce().challenge);
    const back = await callback(hub, { code: "wrong", state: upstream.searchParams.get("state")! });
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("client-state");
  });

  it("returns access_denied when the user denies consent at GitHub", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const clientId = await registerClient(hub);
    const upstream = await startAuthorize(hub, clientId, pkce().challenge);
    const back = await callback(hub, { error: "access_denied", state: upstream.searchParams.get("state")! });
    expect(back.searchParams.get("error")).toBe("access_denied");
  });

  it("rejects an unknown or reused callback state", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const res = await fetch(`${hub}/oauth/callback?code=gh-code&state=nope`, { redirect: "manual" });
    expect(res.status).toBe(400);

    const clientId = await registerClient(hub);
    const upstream = await startAuthorize(hub, clientId, pkce().challenge);
    const state = upstream.searchParams.get("state")!;
    await callback(hub, { code: "gh-code", state });
    const again = await browser.request(`${hub}/oauth/callback?code=gh-code&state=${state}`);
    expect(again.status).toBe(400);
  });

  it("rejects a wrong PKCE verifier and a reused code", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const clientId = await registerClient(hub);
    const { verifier, challenge } = pkce();
    const upstream = await startAuthorize(hub, clientId, challenge);
    const back = await callback(hub, { code: "gh-code", state: upstream.searchParams.get("state")! });
    const code = back.searchParams.get("code")!;
    const base = { grant_type: "authorization_code", client_id: clientId, code, redirect_uri: CLIENT_REDIRECT };

    expect((await token(hub, { ...base, code_verifier: pkce().verifier })).status).toBe(400);
    expect((await token(hub, { ...base, code_verifier: verifier })).status).toBe(200);
    expect((await token(hub, { ...base, code_verifier: verifier })).status).toBe(400);
  });

  it("issues expiring tokens and rotates the refresh token", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const { clientId, tokens } = await githubLogin(hub);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBeGreaterThan(0);
    const refreshed = await token(hub, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: String(tokens.refresh_token),
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).not.toBe(tokens.access_token);
    const reused = await token(hub, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: String(tokens.refresh_token),
    });
    expect(reused.status).toBe(400);
  });
});

describe("OIDC login", () => {
  it("uses OIDC discovery instead of GitHub when OIDC is configured", async () => {
    const stub = oidcStub();
    const hub = await startHub({
      fetch: stub.fetch,
      oidc: { issuer: ISSUER, clientId: "oidc-client", clientSecret: "oidc-secret" },
    });
    const clientId = await registerClient(hub);
    const { verifier, challenge } = pkce();
    const upstream = await startAuthorize(hub, clientId, challenge);
    expect(`${upstream.origin}${upstream.pathname}`).toBe(`${ISSUER}/auth`);
    expect(upstream.searchParams.get("client_id")).toBe("oidc-client");
    expect(upstream.searchParams.get("response_type")).toBe("code");
    expect(upstream.searchParams.get("scope")).toBe("openid profile email");
    expect(upstream.searchParams.get("redirect_uri")).toBe(`${hub}/oauth/callback`);

    const back = await callback(hub, { code: "oidc-code", state: upstream.searchParams.get("state")! });
    expect(back.searchParams.get("state")).toBe("client-state");
    const tokens = await token(hub, {
      grant_type: "authorization_code",
      client_id: clientId,
      code: back.searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: CLIENT_REDIRECT,
    });
    expect(tokens.status).toBe(200);
    expect(stub.calls).toEqual([
      `GET ${ISSUER}/.well-known/openid-configuration`,
      `POST ${ISSUER}/token`,
      `GET ${ISSUER}/userinfo`,
    ]);

    const mcp = await fetch(`${hub}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${String(tokens.body.access_token)}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    expect(mcp.status).toBe(200);
  });
});

describe("hub consent and browser binding", () => {
  it("shows a consent page naming a new client before going upstream", async () => {
    const stub = githubStub();
    const hub = await startHub({ fetch: stub.fetch });
    const clientId = await registerClient(hub, "Claude");
    const res = await openAuthorize(hub, clientId, pkce().challenge);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Claude");
    expect(html).toContain("localhost:9999");
    expect(stub.calls).toEqual([]);
    const loginCookie = browser.setCookieHeaders.find((h) => h.startsWith("hl_login="));
    expect(loginCookie).toMatch(/HttpOnly/i);
    expect(loginCookie).toMatch(/SameSite=Lax/i);
  });

  it("returns access_denied with the client state when the user denies", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const clientId = await registerClient(hub);
    const page = await openAuthorize(hub, clientId, pkce().challenge);
    const res = await browser.postForm(`${hub}/oauth/consent`, { ...consentForm(await page.text()), decision: "deny" });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("client-state");
  });

  it("continues upstream when the user approves", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const clientId = await registerClient(hub);
    const page = await openAuthorize(hub, clientId, pkce().challenge);
    const res = await browser.postForm(`${hub}/oauth/consent`, {
      ...consentForm(await page.text()),
      decision: "approve",
    });
    expect(res.status).toBe(302);
    const upstream = new URL(res.headers.get("location")!);
    expect(`${upstream.origin}${upstream.pathname}`).toBe("https://github.com/login/oauth/authorize");
    const approved = browser.setCookieHeaders.find((h) => h.startsWith("hl_approved="));
    expect(approved).toMatch(/HttpOnly/i);
    expect(approved).toMatch(/SameSite=Lax/i);
  });

  it("skips the page for an approved client in the same browser only", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const clientId = await registerClient(hub);
    await startAuthorize(hub, clientId, pkce().challenge);

    const again = await openAuthorize(hub, clientId, pkce().challenge);
    expect(again.status).toBe(302);
    expect(new URL(again.headers.get("location")!).hostname).toBe("github.com");

    const other = await openAuthorize(hub, clientId, pkce().challenge, new Browser());
    expect(other.status).toBe(200);
  });

  it("remembers an approval for the approved redirect URI only", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const otherRedirect = "http://localhost:9999/other";
    const clientId = await registerClient(hub, "test client", [CLIENT_REDIRECT, otherRedirect]);
    await startAuthorize(hub, clientId, pkce().challenge);
    expect((await openAuthorize(hub, clientId, pkce().challenge)).status).toBe(302);
    const other = await openAuthorize(hub, clientId, pkce().challenge, browser, otherRedirect);
    expect(other.status).toBe(200);
    expect(await other.text()).toContain("/other");
  });

  it("forbids framing the consent page", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const res = await openAuthorize(hub, await registerClient(hub), pkce().challenge);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("ignores a tampered approval cookie", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const clientId = await registerClient(hub);
    await startAuthorize(hub, clientId, pkce().challenge);
    const forged = new Browser();
    const [payload] = browser.cookies.get("hl_approved")!.split(".");
    forged.cookies.set("hl_approved", `${payload}.AAAA`);
    expect((await openAuthorize(hub, clientId, pkce().challenge, forged)).status).toBe(200);
  });

  it("rejects a callback from a browser other than the one that started the login", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const clientId = await registerClient(hub);
    const upstream = await startAuthorize(hub, clientId, pkce().challenge);
    const params = { code: "gh-code", state: upstream.searchParams.get("state")! };
    const query = new URLSearchParams(params);

    expect((await new Browser().request(`${hub}/oauth/callback?${query}`)).status).toBe(400);
    expect((await fetch(`${hub}/oauth/callback?${query}`, { redirect: "manual" })).status).toBe(400);

    // The browser that started the login can still finish it.
    const back = await callback(hub, params);
    expect(back.searchParams.get("code")).toBeTruthy();
  });

  it("rejects a consent post with a forged or missing CSRF token or from another browser", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const clientId = await registerClient(hub);
    const page = await openAuthorize(hub, clientId, pkce().challenge);
    const form = consentForm(await page.text());
    const consentUrl = `${hub}/oauth/consent`;

    expect((await browser.postForm(consentUrl, { ...form, csrf: "forged", decision: "approve" })).status).toBe(400);
    expect((await browser.postForm(consentUrl, { state: form.state, decision: "approve" })).status).toBe(400);
    expect((await new Browser().postForm(consentUrl, { ...form, decision: "approve" })).status).toBe(400);
    // The genuine post still works afterwards.
    expect((await browser.postForm(consentUrl, { ...form, decision: "approve" })).status).toBe(302);
  });

  it("marks cookies Secure when the public URL is https, and not otherwise", async () => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    server.on(
      "request",
      createApp({ publicUrl: "https://hub.example.com", github: { clientId: "gh-client", clientSecret: "gh-secret" } }),
    );
    const clientId = await registerClient(local);
    await openAuthorize(local, clientId, pkce().challenge);
    expect(browser.setCookieHeaders.find((h) => h.startsWith("hl_login="))).toMatch(/; Secure/);

    const plain = new Browser();
    const hub = await startHub({ fetch: githubStub().fetch });
    await openAuthorize(hub, await registerClient(hub), pkce().challenge, plain);
    expect(plain.setCookieHeaders.find((h) => h.startsWith("hl_login="))).not.toMatch(/Secure/);
  });

  it("HTML-escapes the client name and redirect URI on the consent page", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const clientId = await registerClient(hub, `<script>alert("x")</script>&`);
    const html = await (await openAuthorize(hub, clientId, pkce().challenge)).text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;");
  });
});

describe("allowed users", () => {
  async function login(extra: Partial<AppDeps>, code: string): Promise<URL> {
    const hub = await startHub(extra);
    const clientId = await registerClient(hub);
    const upstream = await startAuthorize(hub, clientId, pkce().challenge);
    return callback(hub, { code, state: upstream.searchParams.get("state")! });
  }
  const github = (allowedUsers?: string[]) => login({ fetch: githubStub().fetch, allowedUsers }, "gh-code");
  const oidc = (allowedUsers: string[], userinfo?: Record<string, unknown>) => {
    browser = new Browser();
    return login(
      {
        fetch: oidcStub(userinfo).fetch,
        oidc: { issuer: ISSUER, clientId: "oidc-client", clientSecret: "oidc-secret" },
        allowedUsers,
      },
      "oidc-code",
    );
  };
  const granted = (back: URL) => back.searchParams.get("code") !== null;

  it("lets anyone sign in when no allowlist is set", async () => {
    expect((await github()).searchParams.get("code")).toBeTruthy();
  });

  it("lets a listed GitHub login sign in (case-insensitive)", async () => {
    expect((await github(["github:someone", "github:OctoCat"])).searchParams.get("code")).toBeTruthy();
  });

  it("lets a listed GitHub numeric id sign in", async () => {
    expect(granted(await github(["github-id:42"]))).toBe(true);
    browser = new Browser();
    expect(granted(await github(["github-id:43"]))).toBe(false);
  });

  it("denies an unlisted user with access_denied and the client state", async () => {
    const back = await github(["github:someone"]);
    expect(back.searchParams.get("code")).toBeNull();
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("client-state");
  });

  it("never matches a GitHub identity against email: or sub: entries", async () => {
    expect(granted(await github(["email:octocat", "sub:42", "sub:octocat"]))).toBe(false);
  });

  it("accepts a mixed list", async () => {
    expect(granted(await github(["email:ada@example.com", "sub:user-7", "github-id:42"]))).toBe(true);
    expect(granted(await oidc(["github-id:42", "github:ada", "sub:user-7"]))).toBe(true);
  });

  it("matches OIDC email only when email_verified is true", async () => {
    const allow = ["email:ADA@example.com"];
    expect(granted(await oidc(allow, { sub: "s1", email: "ada@example.com", email_verified: true }))).toBe(true);
    expect(granted(await oidc(allow, { sub: "s1", email: "ada@example.com", email_verified: false }))).toBe(false);
    expect(granted(await oidc(allow, { sub: "s1", email: "ada@example.com" }))).toBe(false);
  });

  it("never authorizes by OIDC preferred_username", async () => {
    expect(granted(await oidc(["email:ada@example.com"], { sub: "s1", preferred_username: "ada@example.com" }))).toBe(
      false,
    );
  });

  it("compares OIDC sub case-sensitively and never matches it against github entries", async () => {
    expect(granted(await oidc(["sub:user-7"]))).toBe(true);
    expect(granted(await oidc(["sub:USER-7"]))).toBe(false);
    expect(granted(await oidc(["github:user-7", "github:ada"]))).toBe(false);
  });

  it("rejects untyped or unknown-prefix entries when the app is created", () => {
    const deps = { publicUrl: "https://hub.example.com", github: { clientId: "a", clientSecret: "b" } };
    expect(() => createApp({ ...deps, allowedUsers: ["octocat"] })).toThrow(/"octocat"/);
    expect(() => createApp({ ...deps, allowedUsers: ["gitlab:x"] })).toThrow(/"gitlab:x"/);
  });
});

describe("store pass-through", () => {
  it("offers /revoke and forwards to the store when the store implements revokeToken", async () => {
    const revoked: string[] = [];
    class RevokingStore extends InMemoryOAuthProvider {
      async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
        revoked.push(request.token);
      }
    }
    const hub = await startHub({ fetch: githubStub().fetch, oauthProvider: new RevokingStore() });
    const meta = (await (await fetch(`${hub}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
    expect(meta.revocation_endpoint).toBe(`${hub}/revoke`);
    const clientId = await registerClient(hub);
    const res = await fetch(`${hub}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "some-token", client_id: clientId }),
    });
    expect(res.status).toBe(200);
    expect(revoked).toEqual(["some-token"]);
  });

  it("does not offer /revoke when the store lacks revokeToken", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const meta = (await (await fetch(`${hub}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
    expect(meta.revocation_endpoint).toBeUndefined();
  });
});

describe("token endpoint", () => {
  it("rejects client B presenting client A's authorization code", async () => {
    const hub = await startHub({ fetch: githubStub().fetch });
    const clientA = await registerClient(hub);
    const clientB = await registerClient(hub);
    const { verifier, challenge } = pkce();
    const upstream = await startAuthorize(hub, clientA, challenge);
    const back = await callback(hub, { code: "gh-code", state: upstream.searchParams.get("state")! });
    const form = {
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: CLIENT_REDIRECT,
    };
    const stolen = await token(hub, { ...form, client_id: clientB });
    expect(stolen.status).toBe(400);
    expect(stolen.body.error).toBe("invalid_grant");
    expect((await token(hub, { ...form, client_id: clientA })).status).toBe(200);
  });
});
