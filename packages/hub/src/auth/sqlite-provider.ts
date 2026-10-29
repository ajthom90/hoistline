import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Store } from "../store.js";
import type { HubOAuthProvider } from "./in-memory-provider.js";
import type { UserIdentity } from "./identity.js";

/** Lifetimes in seconds; same as the in-memory provider. */
const CODE_TTL = 600;
const ACCESS_TOKEN_TTL = 3600;
const REFRESH_TOKEN_TTL = 30 * 24 * 3600;

const secret = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

interface CodeRow {
  client_id: string;
  params: string;
  user: string;
  expires_at: number;
}

interface TokenRow {
  grant_id: string;
  client_id: string;
  scopes: string;
  resource: string | null;
  user: string;
  expires_at: number;
}

interface Grant {
  clientId: string;
  scopes: string[];
  resource?: URL;
  user: UserIdentity;
}

/**
 * OAuth state (clients, codes, tokens) in the hub's SQLite database, so tokens survive restarts.
 * Codes and tokens are stored as SHA-256 hashes. Mirrors InMemoryOAuthProvider's behavior.
 */
export class SqliteOAuthProvider implements HubOAuthProvider {
  private readonly db: Store["db"];
  private readonly nowMs: () => number;

  constructor(store: Store) {
    this.db = store.db;
    this.nowMs = store.now;
  }

  private now(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId) => {
      const row = this.db.prepare("SELECT info FROM oauth_clients WHERE client_id = ?").get(clientId) as
        | { info: string }
        | undefined;
      return row ? (JSON.parse(row.info) as OAuthClientInformationFull) : undefined;
    },
    registerClient: (client) => {
      const full: OAuthClientInformationFull = {
        ...client,
        client_id: randomUUID(),
        client_id_issued_at: this.now(),
      };
      this.db
        .prepare("INSERT INTO oauth_clients (client_id, info) VALUES (?, ?)")
        .run(full.client_id, JSON.stringify(full));
      return full;
    },
  };

  async issueAuthorizationCode(clientId: string, params: AuthorizationParams, user: UserIdentity): Promise<string> {
    this.sweepExpired();
    const code = secret();
    const stored = { ...params, resource: params.resource?.href };
    this.db
      .prepare("INSERT INTO oauth_codes (code_hash, client_id, params, user, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(hash(code), clientId, JSON.stringify(stored), JSON.stringify(user), this.now() + CODE_TTL);
    return code;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = this.findCode(authorizationCode);
    if (!row || row.client_id !== client.client_id || row.expires_at <= this.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return (JSON.parse(row.params) as { codeChallenge: string }).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    // Single use: the row is consumed whether or not the checks below pass.
    const row = this.db.transaction(() => {
      const found = this.findCode(authorizationCode);
      this.db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(hash(authorizationCode));
      return found;
    })();
    if (!row || row.expires_at <= this.now() || row.client_id !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    const params = JSON.parse(row.params) as { redirectUri: string; scopes?: string[]; resource?: string };
    if (redirectUri !== undefined && redirectUri !== params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return this.issue({
      clientId: client.client_id,
      scopes: params.scopes ?? [],
      resource: params.resource ? new URL(params.resource) : undefined,
      user: JSON.parse(row.user) as UserIdentity,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    // Rotated: the presented refresh token is consumed whether or not the checks below pass.
    const row = this.db.transaction(() => {
      const found = this.db
        .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
        .get(hash(refreshToken)) as TokenRow | undefined;
      this.db.prepare("DELETE FROM oauth_tokens WHERE token_hash = ?").run(hash(refreshToken));
      return found;
    })();
    if (!row || row.expires_at <= this.now() || row.client_id !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    const grant = toGrant(row);
    const narrowed = scopes?.length ? scopes.filter((s) => grant.scopes.includes(s)) : grant.scopes;
    return this.issue({ ...grant, scopes: narrowed });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.db
      .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'")
      .get(hash(token)) as TokenRow | undefined;
    if (!row || row.expires_at <= this.now()) {
      if (row) this.db.prepare("DELETE FROM oauth_tokens WHERE token_hash = ?").run(hash(token));
      throw new InvalidTokenError("Invalid or expired access token");
    }
    const grant = toGrant(row);
    return {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: row.expires_at,
      resource: grant.resource,
      extra: { user: grant.user },
    };
  }

  /** Revokes the presented token and its sibling (the other half of the access/refresh pair), for this client only. */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const row = this.db.prepare("SELECT grant_id, client_id FROM oauth_tokens WHERE token_hash = ?").get(
      hash(request.token),
    ) as { grant_id: string; client_id: string } | undefined;
    if (row && row.client_id === client.client_id) {
      this.db.prepare("DELETE FROM oauth_tokens WHERE grant_id = ?").run(row.grant_id);
    }
  }

  /** Deletes expired codes and tokens (`now` in milliseconds). */
  sweepExpired(now: number = this.nowMs()): void {
    const seconds = Math.floor(now / 1000);
    this.db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(seconds);
    this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at <= ?").run(seconds);
  }

  private findCode(code: string): CodeRow | undefined {
    return this.db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(hash(code)) as CodeRow | undefined;
  }

  private issue(grant: Grant): OAuthTokens {
    this.sweepExpired();
    const accessToken = secret();
    const refreshToken = secret();
    const grantId = randomUUID();
    const insert = this.db.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, scopes, resource, user, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const common = [grantId, grant.clientId, JSON.stringify(grant.scopes), grant.resource?.href ?? null, JSON.stringify(grant.user)] as const;
    this.db.transaction(() => {
      insert.run(hash(accessToken), "access", ...common, this.now() + ACCESS_TOKEN_TTL);
      insert.run(hash(refreshToken), "refresh", ...common, this.now() + REFRESH_TOKEN_TTL);
    })();
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: refreshToken,
      scope: grant.scopes.length ? grant.scopes.join(" ") : undefined,
    };
  }
}

function toGrant(row: TokenRow): Grant {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes) as string[],
    resource: row.resource ? new URL(row.resource) : undefined,
    user: JSON.parse(row.user) as UserIdentity,
  };
}
