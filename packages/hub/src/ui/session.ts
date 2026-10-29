import { createHash, randomBytes } from "node:crypto";
import type { Store } from "../store.js";

export const SESSION_COOKIE = "hl_session";
/** Absolute session lifetime: 12 hours from login, never extended. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface UiSession {
  userId: string;
  /** The per-session CSRF token every POST must carry. */
  csrf: string;
  expiresAt: number;
}

/**
 * Web UI sessions in SQLite: a random 32-byte id (the cookie value), stored only as its SHA-256, with the user, a
 * CSRF token and a 12-hour absolute expiry. Times are unix milliseconds on the store's clock.
 */
export class UiSessions {
  constructor(private readonly store: Store) {}

  create(userId: string): { id: string; session: UiSession } {
    const id = randomBytes(32).toString("base64url");
    const now = this.store.now();
    const session: UiSession = { userId, csrf: randomBytes(32).toString("base64url"), expiresAt: now + SESSION_TTL_MS };
    this.store.db.prepare("DELETE FROM ui_sessions WHERE expires_at <= ?").run(now);
    this.store.db
      .prepare("INSERT INTO ui_sessions (id_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(id), userId, session.csrf, now, session.expiresAt);
    return { id, session };
  }

  /** The live session for a cookie value, or null (an expired one is deleted). */
  get(id: string | undefined): UiSession | null {
    if (!id) return null;
    const row = this.store.db
      .prepare("SELECT user_id, csrf, expires_at FROM ui_sessions WHERE id_hash = ?")
      .get(sha256(id)) as { user_id: string; csrf: string; expires_at: number } | undefined;
    if (!row) return null;
    if (row.expires_at <= this.store.now()) {
      this.delete(id);
      return null;
    }
    return { userId: row.user_id, csrf: row.csrf, expiresAt: row.expires_at };
  }

  delete(id: string): void {
    this.store.db.prepare("DELETE FROM ui_sessions WHERE id_hash = ?").run(sha256(id));
  }
}
