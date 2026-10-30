import { createHash, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { agentAuthPayload, type AgentToHub, type HubToAgent } from "@hoistline/protocol";
import { pairMachine, type AgentIdentity } from "@hoistline/agent";
import { InMemoryOAuthProvider } from "../src/auth/in-memory-provider.js";
import { Gateway } from "../src/gateway.js";
import { Jobs } from "../src/jobs.js";
import { createApp, type AppDeps } from "../src/server.js";
import { Store, type User } from "../src/store.js";

/*
 * Shared by ui.test.ts and tokens.test.ts: a real hub over a temp SQLite file, a GitHub stub (no network), a browser
 * with a cookie jar, and a hand-driven agent socket.
 */

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

export const GITHUB_USERS: Record<string, { id: number; login: string }> = {
  "code-alice": { id: 1, login: "alice" },
  "code-bob": { id: 2, login: "bob" },
  "code-carol": { id: 3, login: "carol" },
  // Two GitHub accounts that held the login "octo" one after the other (the first one renamed).
  "code-octo-old": { id: 10, login: "octo" },
  "code-octo-new": { id: 11, login: "octo" },
};

/** GitHub's token exchange and user API, answering the codes in GITHUB_USERS only; anything else fails the test. */
export const githubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.href === "https://github.com/login/oauth/access_token") {
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    if (!GITHUB_USERS[body.code!]) return json({ error: "bad_verification_code" });
    return json({ access_token: `gh-${body.code}`, token_type: "bearer" });
  }
  if (url.href === "https://api.github.com/user") {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const user = GITHUB_USERS[auth.replace(/^Bearer gh-/, "")];
    return user ? json(user) : new Response("forbidden", { status: 403 });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

/** A user agent with its own cookie jar; requests never follow redirects. */
export class Browser {
  readonly cookies = new Map<string, string>();
  readonly setCookieHeaders: string[] = [];

  async request(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
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

  postForm(url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
    return this.request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(form).toString(),
    });
  }
}

export interface Hub {
  url: string;
  store: Store;
  gateway: Gateway;
  jobs: Jobs;
  /** Moves the store's clock (sessions, tokens) forward. */
  advance(ms: number): void;
}

export interface TestContext {
  dir: string;
  cleanups: (() => void | Promise<void>)[];
}

export function newContext(): TestContext {
  return { dir: mkdtempSync(join(tmpdir(), "hoistline-ui-")), cleanups: [] };
}

export async function disposeContext(ctx: TestContext): Promise<void> {
  for (const fn of ctx.cleanups.splice(0).reverse()) await fn();
  rmSync(ctx.dir, { recursive: true, force: true });
}

/** Starts a hub app over the store (a new one unless given), on its own port. */
export async function startHub(
  ctx: TestContext,
  extra: Partial<AppDeps> = {},
  shared?: { store: Store; gateway: Gateway; jobs: Jobs; advance: (ms: number) => void },
): Promise<Hub> {
  let offset = 0;
  const store = shared?.store ?? new Store(join(ctx.dir, "hub.db"), { now: () => Date.now() + offset });
  const gateway =
    shared?.gateway ?? new Gateway(store, store.getOrCreateSigningKey(), { pingIntervalMs: 100, pongTimeoutMs: 2000 });
  const jobs = shared?.jobs ?? new Jobs(store, gateway, { disconnectGraceMs: 5000 });
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    "request",
    createApp({
      publicUrl: url,
      github: { clientId: "gh-client", clientSecret: "gh-secret" },
      fetch: githubFetch,
      oauthProvider: new InMemoryOAuthProvider(),
      store,
      gateway,
      jobs,
      ...extra,
    }),
  );
  if (!shared) {
    jobs.attach();
    gateway.attach(server);
  }
  ctx.cleanups.push(async () => {
    if (!shared) {
      jobs.close();
      gateway.close();
    }
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    if (!shared) store.close();
  });
  return { url, store, gateway, jobs, advance: shared?.advance ?? ((ms) => (offset += ms)) };
}

/** Starts the UI login in the browser; returns the GitHub authorize URL. */
export async function startUiLogin(hub: Hub, browser: Browser): Promise<URL> {
  const res = await browser.request(`${hub.url}/ui/login`);
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

/** Full UI login as the GitHub user behind `code`; returns the hub user. */
export async function uiLogin(hub: Hub, browser: Browser, code = "code-alice"): Promise<User> {
  const upstream = await startUiLogin(hub, browser);
  const res = await browser.request(
    `${hub.url}/oauth/callback?${new URLSearchParams({ code, state: upstream.searchParams.get("state")! })}`,
  );
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/ui");
  const gh = GITHUB_USERS[code]!;
  return hub.store.getUserByKey("github", String(gh.id))!;
}

const CLIENT_REDIRECT = "http://127.0.0.1:9/callback";

/** POST /token with a form; returns the status and JSON body. */
export async function tokenEndpoint(hub: Hub, form: Record<string, string>) {
  const res = await fetch(`${hub.url}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A full MCP OAuth login (register, consent, GitHub callback, code exchange) as the GitHub user behind `code`. */
export async function oauthLogin(
  hub: Hub,
  browser: Browser,
  code = "code-alice",
): Promise<{ clientId: string; accessToken: string; refreshToken: string }> {
  const reg = await fetch(`${hub.url}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "test", redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none" }),
  });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${hub.url}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "s",
  }).toString();
  let res = await browser.request(authorize);
  if (res.status === 200) {
    const html = await res.text();
    const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)![1]!;
    res = await browser.postForm(`${hub.url}/oauth/consent`, { state: field("state"), csrf: field("csrf"), decision: "approve" });
  }
  const upstream = new URL(res.headers.get("location")!);
  const back = await browser.request(
    `${hub.url}/oauth/callback?${new URLSearchParams({ code, state: upstream.searchParams.get("state")! })}`,
  );
  const hubCode = new URL(back.headers.get("location")!).searchParams.get("code");
  expect(hubCode).toBeTruthy();
  const tokens = await tokenEndpoint(hub, {
    grant_type: "authorization_code",
    client_id: clientId,
    code: hubCode!,
    code_verifier: verifier,
    redirect_uri: CLIENT_REDIRECT,
  });
  expect(tokens.status).toBe(200);
  return { clientId, accessToken: String(tokens.body.access_token), refreshToken: String(tokens.body.refresh_token) };
}

/** The CSRF token of a /ui page. */
export function csrfOf(html: string): string {
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  expect(csrf).toBeTruthy();
  return csrf!;
}

/** GET a /ui page in the browser and return its HTML and CSRF token. */
export async function page(hub: Hub, browser: Browser, path = "/ui"): Promise<{ html: string; csrf: string }> {
  const res = await browser.request(`${hub.url}${path}`);
  expect(res.status).toBe(200);
  const html = await res.text();
  return { html, csrf: csrfOf(html) };
}

/** POST a /ui form with the session's CSRF token. */
export async function post(hub: Hub, browser: Browser, path: string, form: Record<string, string> = {}): Promise<Response> {
  const { csrf } = await page(hub, browser);
  return browser.postForm(`${hub.url}${path}`, { csrf, ...form });
}

/** Creates a personal access token in the UI and returns it. */
export async function createPat(hub: Hub, browser: Browser, name = "ci", days?: number): Promise<string> {
  const res = await post(hub, browser, "/ui/tokens", { name, ...(days === undefined ? {} : { days: String(days) }) });
  expect(res.status).toBe(200);
  const token = /(hl_pat_[A-Za-z0-9_-]{43})/.exec(await res.text())?.[1];
  expect(token).toBeTruthy();
  return token!;
}

export async function mcpClient(hub: Hub, ctx: TestContext, token: string): Promise<Client> {
  const c = new Client({ name: "test", version: "0.0.0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${hub.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  ctx.cleanups.push(() => c.close());
  return c;
}

/** POST /mcp tools/list with a bearer token; returns the HTTP status. */
export async function mcpStatus(hub: Hub, token: string): Promise<number> {
  const res = await fetch(`${hub.url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await res.body?.cancel();
  return res.status;
}

export async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function pair(hub: Hub, owner: User, name = "laptop"): Promise<AgentIdentity> {
  return pairMachine(hub.url, hub.store.createPairingCode(owner.id), name);
}

/** A hand-driven agent socket: records every hub message and the close code, never runs anything. */
export class RawAgent {
  readonly ws: WebSocket;
  readonly messages: HubToAgent[] = [];
  closeCode?: number;

  constructor(hub: Hub, ctx: TestContext) {
    this.ws = new WebSocket(`${hub.url.replace("http", "ws")}/agent`);
    this.ws.on("message", (data) => this.messages.push(JSON.parse(data.toString()) as HubToAgent));
    this.ws.on("close", (code) => (this.closeCode = code));
    this.ws.on("error", () => {});
    ctx.cleanups.push(() => this.ws.terminate());
  }

  async hello(machineId: string, key: KeyObject, runners: ("muse" | "codex")[] = ["muse"]): Promise<void> {
    await waitFor(() => this.messages.length > 0, "challenge");
    const challenge = this.messages[0]!;
    if (challenge.type !== "challenge") throw new Error(`expected challenge, got ${challenge.type}`);
    const signature = sign(null, agentAuthPayload(machineId, challenge.nonce), key).toString("base64url");
    const hello: AgentToHub = { type: "hello", machineId, agentVersion: "0.0.0", runners, runningJobs: [], servers: [], signature };
    this.ws.send(JSON.stringify(hello));
  }

  send(msg: AgentToHub): void {
    this.ws.send(JSON.stringify(msg));
  }
}

/** An authenticated raw agent for the identity. */
export async function onlineAgent(hub: Hub, ctx: TestContext, identity: AgentIdentity): Promise<RawAgent> {
  const agent = new RawAgent(hub, ctx);
  await agent.hello(identity.machineId, identity.privateKey);
  await waitFor(() => agent.messages.some((m) => m.type === "welcome"), "welcome");
  return agent;
}

export const delegateArgs = { runner: "muse" as const, repo: "https://github.com/Owner/Name.git", branch: "main", prompt: "do it" };
