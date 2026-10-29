import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

function oidcStub() {
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
      return json({ sub: "user-7", preferred_username: "ada" });
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

async function registerClient(hub: string): Promise<string> {
  const res = await fetch(`${hub}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "test client",
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Runs /authorize and returns the upstream identity-provider redirect. */
async function startAuthorize(hub: string, clientId: string, challenge: string): Promise<URL> {
  const url = new URL(`${hub}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "client-state",
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

async function callback(hub: string, params: Record<string, string>): Promise<URL> {
  const res = await fetch(`${hub}/oauth/callback?${new URLSearchParams(params)}`, {
    redirect: "manual",
  });
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
    const again = await fetch(`${hub}/oauth/callback?code=gh-code&state=${state}`, { redirect: "manual" });
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
