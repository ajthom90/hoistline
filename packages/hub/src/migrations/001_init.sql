CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX machines_owner ON machines(owner_id);

-- Shares are keyed by lowercased GitHub login so they can be granted before the person has signed in.
CREATE TABLE machine_shares (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  PRIMARY KEY (machine_id, login)
);
CREATE INDEX machine_shares_login ON machine_shares(login);

-- Only the SHA-256 of a pairing code is stored.
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  runner TEXT NOT NULL,
  repo TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  command TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  branch TEXT,
  output TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_user ON jobs(user_id);

CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  info TEXT NOT NULL
);

-- Codes and tokens are stored as SHA-256 hashes; times are unix seconds.
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  params TEXT NOT NULL,
  user TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT,
  user TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
