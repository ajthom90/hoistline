import { randomBytes } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  GithubIdentityProvider,
  OidcIdentityProvider,
  type FetchFn,
  type GithubOAuthConfig,
  type IdentityProvider,
  type OidcConfig,
  type UserIdentity,
  userKey,
} from "./auth/identity.js";
import { InMemoryOAuthProvider, type HubOAuthProvider } from "./auth/in-memory-provider.js";
import { CONSENT_PATH, LOGIN_CALLBACK_PATH, LoginFlow } from "./auth/login-flow.js";
import type { Gateway } from "./gateway.js";
import type { Jobs } from "./jobs.js";
import { pairRouter } from "./pairing.js";
import type { Store, User } from "./store.js";
import { registerMachineTools } from "./tools/machines.js";

export type { FetchFn, GithubOAuthConfig, OidcConfig } from "./auth/identity.js";
export type { HubOAuthProvider } from "./auth/in-memory-provider.js";
/** Path the identity provider redirects back to; register `${publicUrl}${LOGIN_CALLBACK_PATH}` with it. */
export { LOGIN_CALLBACK_PATH } from "./auth/login-flow.js";

export interface AppDeps {
  /** Public base URL clients reach the hub at, e.g. the Cloudflare Tunnel hostname. No trailing slash. */
  publicUrl: string;
  github: GithubOAuthConfig;
  /** When set, login goes through this OIDC provider instead of GitHub. */
  oidc?: OidcConfig;
  /**
   * When set and non-empty, only these users may sign in. Typed entries: `github-id:<id>`,
   * `github:<login>`, `email:<verified OIDC email>`, `sub:<OIDC subject>`; anything else throws.
   */
  allowedUsers?: string[];
  /** fetch used for identity-provider calls (inject a stub in tests). */
  fetch?: FetchFn;
  /** OAuth store (clients, codes, tokens); in memory when omitted. */
  oauthProvider?: HubOAuthProvider;
  /** Secret for signing browser cookies; random per process when omitted. */
  cookieSecret?: string;
  /** Hub database. With `gateway`, enables machine pairing (`POST /pair`) and the machine tools. */
  store?: Store;
  /** Agent connections; attach it to the http.Server separately. */
  gateway?: Gateway;
  /** The job lifecycle (create it over the same store and gateway, and attach it, separately). */
  jobs?: Jobs;
}

interface ToolContext {
  store: Store;
  gateway: Gateway;
  /** The hub user the bearer token belongs to. */
  user: User;
}

/** Creates the hub user for a freshly fetched identity, or updates its display login. */
function recordUser(store: Store, user: UserIdentity): void {
  const key = userKey(user);
  if (!key) throw new Error("identity has no stable key");
  store.upsertUser({ ...key, login: user.name });
}

function buildMcpServer(ctx?: ToolContext): McpServer {
  const server = new McpServer({ name: "hoistline", version: "0.0.0" });
  server.registerTool("ping", { description: "Check that the Hoistline hub is reachable." }, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  if (ctx) registerMachineTools(server, ctx.store, ctx.gateway, ctx.user);
  return server;
}

export function createApp(deps: AppDeps): express.Express {
  const publicUrl = new URL(deps.publicUrl);
  const callbackUrl = new URL(LOGIN_CALLBACK_PATH, publicUrl).href;
  const identity: IdentityProvider = deps.oidc
    ? new OidcIdentityProvider(deps.oidc, callbackUrl, deps.fetch)
    : new GithubIdentityProvider(deps.github, callbackUrl, deps.fetch);
  const store = deps.oauthProvider ?? new InMemoryOAuthProvider();
  const login = new LoginFlow({
    identity,
    store,
    publicUrl,
    cookieSecret: deps.cookieSecret ?? randomBytes(32).toString("base64url"),
    allowedUsers: deps.allowedUsers,
    // The only place users are created or their display login updated: the identity was just fetched from the
    // provider, so the login is current. Using a token never writes users (its saved login can be stale).
    onLogin: deps.store ? (user) => recordUser(deps.store!, user) : undefined,
  });
  const provider = login.provider();

  const app = express();
  // cloudflared connects from loopback; trust its X-Forwarded-For so rate limiting sees real client IPs.
  app.set("trust proxy", "loopback");

  // The protected resource is the whole hub (AS = RS), so its metadata lives at the root
  // well-known path. Also answer the /mcp-suffixed path that RFC 9728 clients may probe first.
  app.use(mcpAuthRouter({ provider, issuerUrl: publicUrl, resourceName: "Hoistline" }));
  app.use(
    "/.well-known/oauth-protected-resource/mcp",
    metadataHandler({ resource: publicUrl.href, authorization_servers: [publicUrl.href], resource_name: "Hoistline" }),
  );

  const machines = deps.store && deps.gateway ? { store: deps.store, gateway: deps.gateway } : undefined;
  if (machines) app.use(pairRouter(machines.store, machines.gateway.hubPublicKey));

  app.post(CONSENT_PATH, express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      await login.consent(req, res);
    } catch (err) {
      next(err);
    }
  });
  app.get(LOGIN_CALLBACK_PATH, async (req, res, next) => {
    try {
      await login.callback(req, res);
    } catch (err) {
      next(err);
    }
  });

  // With a store, a token is valid only while its identity maps to an existing hub user (read-only lookup).
  const verifier: OAuthTokenVerifier = {
    verifyAccessToken: async (token) => {
      const info = await provider.verifyAccessToken(token);
      if (!machines) return info;
      const identity = info.extra?.user as UserIdentity | undefined;
      const key = identity && userKey(identity);
      const user = key ? machines.store.getUserByKey(key.provider, key.subject) : null;
      if (!user) throw new InvalidTokenError("Invalid or expired access token");
      return { ...info, extra: { ...info.extra, hubUser: user } };
    },
  };
  const bearer = requireBearerAuth({
    verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(publicUrl),
  });

  // Stateless Streamable HTTP: a fresh server and transport per request.
  app.post("/mcp", bearer, express.json(), async (req, res, next) => {
    // Tools act as the hub user the token was issued to (resolved by provider and subject, never by login).
    const hubUser = req.auth?.extra?.hubUser as User | undefined;
    const ctx: ToolContext | undefined = machines && hubUser ? { ...machines, user: hubUser } : undefined;
    const server = buildMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      next(err);
    }
  });

  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  };
  app.get("/mcp", bearer, methodNotAllowed);
  app.delete("/mcp", bearer, methodNotAllowed);

  return app;
}
