import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Store, User } from "./store.js";

/** Every personal access token starts with this, so the bearer check can tell them from OAuth access tokens. */
export const PAT_PREFIX = "hl_pat_";
export const PAT_DEFAULT_DAYS = 90;
export const PAT_MAX_DAYS = 365;
export const PAT_MAX_LIVE = 20;
export const PAT_MAX_NAME = 64;

const DAY_MS = 24 * 60 * 60 * 1000;
/** last_used_at is written at most this often per token. */
const LAST_USED_RESOLUTION_MS = 60_000;
/** Expired tokens stay listed (marked expired) this long, then are deleted. */
const EXPIRED_KEPT_MS = 30 * DAY_MS;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface AccessTokenInfo {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
}

/** A refusal the user can act on (bad name, bad lifetime, too many tokens). */
export class TokenRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenRequestError";
  }
}

interface TokenRecord {
  id: string;
  user_id: string;
  name: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
}

/**
 * Personal access tokens: `hl_pat_` + 32 random bytes (base64url), shown once, stored only as SHA-256, for MCP
 * clients that cannot do interactive OAuth. Times are unix milliseconds on the store's clock.
 */
export class AccessTokens {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.db;
  }

  /**
   * Creates a token for the user. `name`: 1..64 printable characters (trimmed); `days`: an integer 1..365. Throws
   * TokenRequestError for a bad name or lifetime, or when the user already has 20 live tokens.
   */
  create(userId: string, name: string, days: number = PAT_DEFAULT_DAYS): { token: string; info: AccessTokenInfo } {
    const trimmed = name.trim();
    if (!trimmed || [...trimmed].length > PAT_MAX_NAME || /\p{C}/u.test(trimmed)) {
      throw new TokenRequestError(`the name must be 1 to ${PAT_MAX_NAME} printable characters`);
    }
    if (!Number.isInteger(days) || days < 1 || days > PAT_MAX_DAYS) {
      throw new TokenRequestError(`the lifetime must be a whole number of days from 1 to ${PAT_MAX_DAYS}`);
    }
    const token = PAT_PREFIX + randomBytes(32).toString("base64url");
    const now = this.store.now();
    const record: TokenRecord = {
      id: randomUUID(),
      user_id: userId,
      name: trimmed,
      created_at: now,
      expires_at: now + days * DAY_MS,
      last_used_at: null,
    };
    this.db.transaction(() => {
      this.prune(now);
      const live = this.db
        .prepare("SELECT count(*) AS n FROM personal_access_tokens WHERE user_id = ? AND expires_at > ?")
        .get(userId, now) as { n: number };
      if (live.n >= PAT_MAX_LIVE) throw new TokenRequestError(`you already have ${PAT_MAX_LIVE} live tokens`);
      this.db
        .prepare(
          `INSERT INTO personal_access_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
           VALUES (@id, @user_id, @name, @token_hash, @created_at, @expires_at, NULL)`,
        )
        .run({ ...record, token_hash: sha256(token) });
    })();
    return { token, info: toInfo(record) };
  }

  /** The user's tokens (live, and expired within the last 30 days), newest first. */
  list(userId: string): AccessTokenInfo[] {
    this.prune(this.store.now());
    const rows = this.db
      .prepare("SELECT * FROM personal_access_tokens WHERE user_id = ? ORDER BY created_at DESC, id")
      .all(userId) as TokenRecord[];
    return rows.map(toInfo);
  }

  /** Deletes every user's tokens that expired more than 30 days before `now`. */
  private prune(now: number): void {
    this.db.prepare("DELETE FROM personal_access_tokens WHERE expires_at <= ?").run(now - EXPIRED_KEPT_MS);
  }

  /** Revokes (deletes) one of the user's tokens. False when the user has no token with that id. */
  revoke(userId: string, tokenId: string): boolean {
    return this.db.prepare("DELETE FROM personal_access_tokens WHERE id = ? AND user_id = ?").run(tokenId, userId).changes > 0;
  }

  /**
   * The token's user and expiry when the token is live and `accept` (if given) accepts its user, else null.
   * Read-only for users (never creates or updates one); records last_used_at at most once per minute.
   */
  verify(token: string, accept?: (user: User) => boolean): { user: User; tokenId: string; expiresAt: number } | null {
    if (!token.startsWith(PAT_PREFIX)) return null;
    const now = this.store.now();
    const row = this.db.prepare("SELECT * FROM personal_access_tokens WHERE token_hash = ?").get(sha256(token)) as
      | TokenRecord
      | undefined;
    if (!row || row.expires_at <= now) return null;
    const user = this.store.getUser(row.user_id);
    if (!user || (accept && !accept(user))) return null;
    this.db
      .prepare(
        "UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)",
      )
      .run(now, row.id, now - LAST_USED_RESOLUTION_MS);
    return { user, tokenId: row.id, expiresAt: row.expires_at };
  }
}

function toInfo(r: TokenRecord): AccessTokenInfo {
  const info: AccessTokenInfo = { id: r.id, name: r.name, createdAt: r.created_at, expiresAt: r.expires_at };
  if (r.last_used_at !== null) info.lastUsedAt = r.last_used_at;
  return info;
}
