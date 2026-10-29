-- The typed allowlist identifiers (JSON array, see auth/allowlist.ts) from the user's last interactive login, so
-- personal access tokens can be re-checked against the allowlist on every use. NULL until the user logs in again.
ALTER TABLE users ADD COLUMN identifiers TEXT;

-- Web UI sessions. Only the SHA-256 of the session id is stored; times are unix milliseconds.
CREATE TABLE ui_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX ui_sessions_user ON ui_sessions(user_id);

-- Personal access tokens for MCP clients that cannot do interactive OAuth. Only the SHA-256 of the token is stored;
-- times are unix milliseconds. Revoking deletes the row.
CREATE TABLE personal_access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX personal_access_tokens_user ON personal_access_tokens(user_id);
