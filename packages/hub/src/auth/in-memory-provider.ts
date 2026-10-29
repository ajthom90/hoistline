import { randomBytes, randomUUID } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { IdentityProvider, UserIdentity } from "./identity.js";

/** An OAuth server provider that delegates login to an upstream identity provider. */
export interface HubOAuthProvider extends OAuthServerProvider {
  /**
   * Handles the upstream identity provider's redirect back to the hub. Returns the URL to send
   * the browser to (the MCP client's redirect URI with a hub code or an error), or undefined
   * when `state` is unknown or expired.
   */
  completeLogin(params: { state?: string; code?: string; error?: string }): Promise<string | undefined>;
}

/** Lifetimes in seconds. */
const LOGIN_TTL = 600;
const CODE_TTL = 600;
const ACCESS_TOKEN_TTL = 3600;
const REFRESH_TOKEN_TTL = 30 * 24 * 3600;

interface PendingLogin {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

interface AuthorizationCode {
  clientId: string;
  params: AuthorizationParams;
  user: UserIdentity;
  expiresAt: number;
}

interface Grant {
  clientId: string;
  scopes: string[];
  resource?: URL;
  user: UserIdentity;
  expiresAt: number;
}

const now = () => Math.floor(Date.now() / 1000);
const secret = () => randomBytes(32).toString("base64url");

function takeLive<T extends { expiresAt: number }>(map: Map<string, T>, key: string): T | undefined {
  const value = map.get(key);
  map.delete(key);
  return value && value.expiresAt > now() ? value : undefined;
}

function clientRedirect(params: AuthorizationParams, query: Record<string, string>): string {
  const url = new URL(params.redirectUri);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  if (params.state !== undefined) url.searchParams.set("state", params.state);
  return url.href;
}

/** In-memory OAuth state for the spike; Task 3 replaces it with a SQLite-backed provider. */
export class InMemoryOAuthProvider implements HubOAuthProvider {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly logins = new Map<string, PendingLogin>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly accessTokens = new Map<string, Grant>();
  private readonly refreshTokens = new Map<string, Grant>();

  constructor(private readonly identity: IdentityProvider) {}

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId) => this.clients.get(clientId),
    registerClient: (client) => {
      const full: OAuthClientInformationFull = {
        ...client,
        client_id: randomUUID(),
        client_id_issued_at: now(),
      };
      this.clients.set(full.client_id, full);
      return full;
    },
  };

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const state = secret();
    this.logins.set(state, { clientId: client.client_id, params, expiresAt: now() + LOGIN_TTL });
    res.redirect(302, await this.identity.authorizationUrl(state));
  }

  async completeLogin(query: { state?: string; code?: string; error?: string }): Promise<string | undefined> {
    const pending = query.state ? takeLive(this.logins, query.state) : undefined;
    if (!pending) return undefined;
    const denied = (description: string) =>
      clientRedirect(pending.params, { error: "access_denied", error_description: description });
    if (query.error || !query.code) return denied(`Login was not completed: ${query.error ?? "no code"}`);
    let user: UserIdentity;
    try {
      user = await this.identity.resolveCode(query.code);
    } catch (err) {
      return denied(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const code = secret();
    this.codes.set(code, {
      clientId: pending.clientId,
      params: pending.params,
      user,
      expiresAt: now() + CODE_TTL,
    });
    return clientRedirect(pending.params, { code });
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = this.codes.get(authorizationCode);
    if (!code || code.clientId !== client.client_id || code.expiresAt <= now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return code.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const code = takeLive(this.codes, authorizationCode);
    if (!code || code.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    if (redirectUri !== undefined && redirectUri !== code.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return this.issue({
      clientId: client.client_id,
      scopes: code.params.scopes ?? [],
      resource: code.params.resource,
      user: code.user,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const grant = takeLive(this.refreshTokens, refreshToken);
    if (!grant || grant.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    const narrowed = scopes?.length ? scopes.filter((s) => grant.scopes.includes(s)) : grant.scopes;
    return this.issue({ ...grant, scopes: narrowed });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const grant = this.accessTokens.get(token);
    if (!grant || grant.expiresAt <= now()) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: grant.expiresAt,
      resource: grant.resource,
      extra: { user: grant.user },
    };
  }

  private issue(grant: Omit<Grant, "expiresAt">): OAuthTokens {
    const accessToken = secret();
    const refreshToken = secret();
    this.accessTokens.set(accessToken, { ...grant, expiresAt: now() + ACCESS_TOKEN_TTL });
    this.refreshTokens.set(refreshToken, { ...grant, expiresAt: now() + REFRESH_TOKEN_TTL });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: refreshToken,
      scope: grant.scopes.length ? grant.scopes.join(" ") : undefined,
    };
  }
}
