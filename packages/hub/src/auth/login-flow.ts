import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { parseAllowedUsers } from "./allowlist.js";
import { CookieSigner, parseCookies, safeEqual, serializeCookie } from "./cookies.js";
import type { IdentityProvider, UserIdentity } from "./identity.js";
import type { HubOAuthProvider } from "./in-memory-provider.js";

export const CONSENT_PATH = "/oauth/consent";
export const LOGIN_CALLBACK_PATH = "/oauth/callback";

/** Binds an in-progress login to the browser that started it. */
const LOGIN_COOKIE = "hl_login";
/** Signed list of (client id, redirect URI) pairs this browser has approved. */
const APPROVED_COOKIE = "hl_approved";
const LOGIN_TTL = 600;
const APPROVED_TTL = 365 * 24 * 3600;
const MAX_APPROVED = 20;

interface PendingLogin {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  /** Value of the browser's login cookie. */
  browserNonce: string;
  csrf: string;
  /** Set once the user approved the client (on the consent page or earlier in this browser). */
  approved: boolean;
  expiresAt: number;
}

export interface LoginFlowOptions {
  identity: IdentityProvider;
  store: HubOAuthProvider;
  /** Hub public URL; cookies are Secure when it is https. */
  publicUrl: URL;
  /** Secret for signing cookies. */
  cookieSecret: string;
  /** When set, only these users may sign in (matched case-insensitively against the identity's identifiers). */
  allowedUsers?: string[];
  /**
   * Called with the freshly fetched identity of an allowed user before the authorization code is issued
   * (e.g. to record the hub user and its current login). If it throws, the login is denied.
   */
  onLogin?: (user: UserIdentity) => void | Promise<void>;
}

const now = () => Math.floor(Date.now() / 1000);
const random = () => randomBytes(32).toString("base64url");

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

function clientRedirect(params: AuthorizationParams, query: Record<string, string>): string {
  const url = new URL(params.redirectUri);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  if (params.state !== undefined) url.searchParams.set("state", params.state);
  return url.href;
}

/** A remembered approval covers exactly one client and one redirect URI, as named on the consent page. */
function approvalKey(client: OAuthClientInformationFull, params: AuthorizationParams): string {
  // Hashed to keep the cookie small whatever the redirect URI length.
  return createHash("sha256").update(JSON.stringify([client.client_id, params.redirectUri])).digest("base64url");
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * The browser side of login: the hub's own consent page, the browser binding of each
 * login, the hand-off to the upstream identity provider, and the allowlist.
 */
export class LoginFlow {
  private readonly logins = new Map<string, PendingLogin>();
  private readonly signer: CookieSigner;
  private readonly secure: boolean;
  private readonly allowed?: Set<string>;

  constructor(private readonly options: LoginFlowOptions) {
    this.signer = new CookieSigner(options.cookieSecret);
    this.secure = options.publicUrl.protocol === "https:";
    if (options.allowedUsers?.length) this.allowed = new Set(parseAllowedUsers(options.allowedUsers));
  }

  /** The provider handed to the SDK auth router: the store, with `authorize` starting this flow. */
  provider(): OAuthServerProvider {
    const store = this.options.store;
    const provider: OAuthServerProvider = {
      get clientsStore() {
        return store.clientsStore;
      },
      authorize: (client, params, res) => this.start(client, params, res),
      challengeForAuthorizationCode: (client, code) => store.challengeForAuthorizationCode(client, code),
      exchangeAuthorizationCode: (...args) => store.exchangeAuthorizationCode(...args),
      exchangeRefreshToken: (...args) => store.exchangeRefreshToken(...args),
      verifyAccessToken: (token) => store.verifyAccessToken(token),
    };
    // Optional capabilities: the SDK router offers /revoke only when revokeToken exists.
    if (store.revokeToken) provider.revokeToken = (client, request) => store.revokeToken!(client, request);
    if (store.skipLocalPkceValidation !== undefined) provider.skipLocalPkceValidation = store.skipLocalPkceValidation;
    return provider;
  }

  /** Called by the SDK's /authorize handler after it validated the client, redirect URI and PKCE. */
  async start(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const state = random();
    const pending: PendingLogin = {
      client,
      params,
      browserNonce: random(),
      csrf: random(),
      approved: this.approvals(res.req).includes(approvalKey(client, params)),
      expiresAt: now() + LOGIN_TTL,
    };
    this.prune();
    this.logins.set(state, pending);
    res.append("Set-Cookie", this.cookie(LOGIN_COOKIE, pending.browserNonce, LOGIN_TTL));
    if (pending.approved) {
      res.redirect(302, await this.options.identity.authorizationUrl(state));
      return;
    }
    res
      .status(200)
      .type("html")
      .set({
        "Cache-Control": "no-store",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
      })
      .send(this.consentPage(state, pending));
  }

  /** POST /oauth/consent from the consent page. */
  async consent(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const state = str(body.state) ?? "";
    const pending = this.liveLogin(state);
    const csrf = str(body.csrf);
    if (!pending || !csrf || !safeEqual(csrf, pending.csrf) || !this.fromSameBrowser(req, pending)) {
      res.status(400).type("text/plain").send("Invalid or expired consent request. Start again from your MCP client.");
      return;
    }
    if (body.decision !== "approve") {
      this.logins.delete(state);
      res.redirect(302, clientRedirect(pending.params, { error: "access_denied", error_description: "The user denied access" }));
      return;
    }
    pending.approved = true;
    const key = approvalKey(pending.client, pending.params);
    const approved = [key, ...this.approvals(req).filter((k) => k !== key)].slice(0, MAX_APPROVED);
    res.append("Set-Cookie", this.cookie(APPROVED_COOKIE, this.signer.sign(JSON.stringify(approved)), APPROVED_TTL));
    res.redirect(302, await this.options.identity.authorizationUrl(state));
  }

  /** GET /oauth/callback from the upstream identity provider. */
  async callback(req: Request, res: Response): Promise<void> {
    const state = str(req.query.state) ?? "";
    const pending = this.liveLogin(state);
    if (!pending || !pending.approved || !this.fromSameBrowser(req, pending)) {
      res.status(400).type("text/plain").send("Login expired or invalid. Start again from your MCP client.");
      return;
    }
    this.logins.delete(state);
    res.append("Set-Cookie", this.cookie(LOGIN_COOKIE, "", 0));
    const denied = (description: string) =>
      res.redirect(302, clientRedirect(pending.params, { error: "access_denied", error_description: description }));

    const code = str(req.query.code);
    const error = str(req.query.error);
    if (error || !code) return denied(`Login was not completed: ${error ?? "no code"}`);
    let user: UserIdentity;
    try {
      user = await this.options.identity.resolveCode(code);
    } catch (err) {
      return denied(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.allowed && !user.identifiers.some((id) => this.allowed!.has(id))) {
      return denied(`${user.name} is not allowed to use this hub`);
    }
    if (this.options.onLogin) {
      try {
        await this.options.onLogin(user);
      } catch {
        return denied("Login failed: the hub could not record this user");
      }
    }
    const hubCode = await this.options.store.issueAuthorizationCode(pending.client.client_id, pending.params, user);
    res.redirect(302, clientRedirect(pending.params, { code: hubCode }));
  }

  private liveLogin(state: string): PendingLogin | undefined {
    const pending = state ? this.logins.get(state) : undefined;
    return pending && pending.expiresAt > now() ? pending : undefined;
  }

  private fromSameBrowser(req: Request, pending: PendingLogin): boolean {
    const nonce = parseCookies(req.headers.cookie).get(LOGIN_COOKIE);
    return nonce !== undefined && safeEqual(nonce, pending.browserNonce);
  }

  /** Approval keys (see approvalKey) remembered in this browser's signed cookie. */
  private approvals(req: Request): string[] {
    const data = this.signer.verify(parseCookies(req.headers.cookie).get(APPROVED_COOKIE));
    if (!data) return [];
    try {
      const keys: unknown = JSON.parse(data);
      return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
    } catch {
      return [];
    }
  }

  private cookie(name: string, value: string, maxAge: number): string {
    return serializeCookie(name, value, { secure: this.secure, maxAge, path: "/" });
  }

  private prune(): void {
    for (const [state, login] of this.logins) if (login.expiresAt <= now()) this.logins.delete(state);
  }

  private consentPage(state: string, pending: PendingLogin): string {
    const name = escapeHtml(pending.client.client_name?.trim() || "An unnamed application");
    const host = escapeHtml(new URL(pending.params.redirectUri).host);
    const redirect = escapeHtml(pending.params.redirectUri);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize access to Hoistline</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; background: #fff; }
  code { word-break: break-all; }
  button { font: inherit; padding: .5rem 1.25rem; margin-right: .5rem; cursor: pointer; }
</style>
</head>
<body>
<h1>Authorize access to Hoistline</h1>
<p><strong>${name}</strong> wants to use your Hoistline hub on your behalf.</p>
<p>After you sign in, it will receive access at <strong>${host}</strong> (<code>${redirect}</code>).</p>
<p>Only approve if you started this from that application.</p>
<form method="post" action="${CONSENT_PATH}">
  <input type="hidden" name="state" value="${escapeHtml(state)}">
  <input type="hidden" name="csrf" value="${escapeHtml(pending.csrf)}">
  <button type="submit" name="decision" value="approve">Approve</button>
  <button type="submit" name="decision" value="deny">Deny</button>
</form>
</body>
</html>
`;
  }
}
