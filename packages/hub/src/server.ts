import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  GithubIdentityProvider,
  OidcIdentityProvider,
  type FetchFn,
  type GithubOAuthConfig,
  type IdentityProvider,
  type OidcConfig,
} from "./auth/identity.js";
import { InMemoryOAuthProvider, type HubOAuthProvider } from "./auth/in-memory-provider.js";

export type { FetchFn, GithubOAuthConfig, OidcConfig } from "./auth/identity.js";
export type { HubOAuthProvider } from "./auth/in-memory-provider.js";

export interface AppDeps {
  /** Public base URL clients reach the hub at, e.g. the Cloudflare Tunnel hostname. No trailing slash. */
  publicUrl: string;
  github: GithubOAuthConfig;
  /** When set, login goes through this OIDC provider instead of GitHub. */
  oidc?: OidcConfig;
  /** fetch used for identity-provider calls (inject a stub in tests). */
  fetch?: FetchFn;
  /** OAuth state store; built from the identity provider when omitted. */
  createOAuthProvider?: (identity: IdentityProvider) => HubOAuthProvider;
}

/** Path the identity provider redirects back to; register `${publicUrl}${LOGIN_CALLBACK_PATH}` with it. */
export const LOGIN_CALLBACK_PATH = "/oauth/callback";

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "hoistline", version: "0.0.0" });
  server.registerTool("ping", { description: "Check that the Hoistline hub is reachable." }, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  return server;
}

export function createApp(deps: AppDeps): express.Express {
  const publicUrl = new URL(deps.publicUrl);
  const callbackUrl = new URL(LOGIN_CALLBACK_PATH, publicUrl).href;
  const identity: IdentityProvider = deps.oidc
    ? new OidcIdentityProvider(deps.oidc, callbackUrl, deps.fetch)
    : new GithubIdentityProvider(deps.github, callbackUrl, deps.fetch);
  const provider = deps.createOAuthProvider?.(identity) ?? new InMemoryOAuthProvider(identity);

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

  app.get(LOGIN_CALLBACK_PATH, async (req, res, next) => {
    try {
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      const redirect = await provider.completeLogin({
        state: str(req.query.state),
        code: str(req.query.code),
        error: str(req.query.error),
      });
      if (!redirect) {
        res.status(400).type("text/plain").send("Login expired or invalid. Start again from your MCP client.");
        return;
      }
      res.redirect(302, redirect);
    } catch (err) {
      next(err);
    }
  });

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(publicUrl),
  });

  // Stateless Streamable HTTP: a fresh server and transport per request.
  app.post("/mcp", bearer, express.json(), async (req, res, next) => {
    const server = buildMcpServer();
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
