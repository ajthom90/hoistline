import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";

export interface User {
  id: string;
  githubId: string;
  login: string;
  createdAt: number;
}

export interface Machine {
  id: string;
  ownerId: string;
  name: string;
  publicKey: string;
  createdAt: number;
  lastSeenAt?: number;
}

export interface JobRow {
  id: string;
  userId: string;
  machineId: string;
  runner: string;
  repo: string;
  baseBranch: string;
  prompt: string;
  model?: string;
  command?: string;
  status: string;
  reason?: string;
  branch?: string;
  output?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoreOptions {
  /** Clock in milliseconds; inject in tests. */
  now?: () => number;
}

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
// Crockford base32: no I, L, O, U.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Codes are shown as XXXX-XXXX-XXXX; redemption ignores case, dashes and spaces. */
function normalizeCode(code: string): string {
  return code.replace(/[-\s]/g, "").toUpperCase();
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % 32]!).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

const JOB_COLUMNS = {
  machineId: "machine_id",
  runner: "runner",
  repo: "repo",
  baseBranch: "base_branch",
  prompt: "prompt",
  model: "model",
  command: "command",
  status: "status",
  reason: "reason",
  branch: "branch",
  output: "output",
  updatedAt: "updated_at",
} as const;

/** SQLite persistence for users, machines, pairing, shares and jobs. OAuth state shares the connection via `db`. */
export class Store {
  readonly db: Database.Database;
  readonly now: () => number;

  constructor(path: string, options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const dir = new URL("./migrations/", import.meta.url);
    const applied = new Set(
      this.db.prepare("SELECT name FROM schema_migrations").all().map((r) => (r as { name: string }).name),
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(new URL(file, dir), "utf8");
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file, this.now());
      })();
    }
  }

  upsertUser(github: { id: string; login: string }): User {
    const githubId = String(github.id);
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM users WHERE github_id = ?").get(githubId) as UserRecord | undefined;
      if (existing) {
        if (existing.login !== github.login) {
          this.db.prepare("UPDATE users SET login = ? WHERE id = ?").run(github.login, existing.id);
        }
        return toUser({ ...existing, login: github.login });
      }
      const row: UserRecord = { id: randomUUID(), github_id: githubId, login: github.login, created_at: this.now() };
      this.db
        .prepare("INSERT INTO users (id, github_id, login, created_at) VALUES (@id, @github_id, @login, @created_at)")
        .run(row);
      return toUser(row);
    })();
  }

  /** A single-use code, valid for 10 minutes, that a machine redeems to pair with this user. */
  createPairingCode(userId: string): string {
    const code = generateCode();
    this.db
      .prepare("INSERT INTO pairing_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(sha256(normalizeCode(code)), userId, this.now() + PAIRING_CODE_TTL_MS);
    this.sweepExpired(this.now());
    return code;
  }

  redeemPairingCode(code: string, machineName: string, publicKey: string): Machine | null {
    const hash = sha256(normalizeCode(code));
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT user_id, expires_at FROM pairing_codes WHERE code_hash = ?").get(hash) as
        | { user_id: string; expires_at: number }
        | undefined;
      if (!row) return null;
      this.db.prepare("DELETE FROM pairing_codes WHERE code_hash = ?").run(hash);
      if (row.expires_at <= this.now()) return null;
      const machine: MachineRecord = {
        id: randomUUID(),
        owner_id: row.user_id,
        name: machineName,
        public_key: publicKey,
        created_at: this.now(),
        last_seen_at: null,
      };
      this.db
        .prepare(
          `INSERT INTO machines (id, owner_id, name, public_key, created_at, last_seen_at)
           VALUES (@id, @owner_id, @name, @public_key, @created_at, @last_seen_at)`,
        )
        .run(machine);
      return toMachine(machine);
    })();
  }

  /** Machines the user owns or that were shared with their GitHub login. */
  machinesFor(userId: string): Machine[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM machines m
         WHERE m.owner_id = @userId
            OR m.id IN (SELECT s.machine_id FROM machine_shares s JOIN users u ON lower(u.login) = s.login WHERE u.id = @userId)
         ORDER BY m.created_at, m.id`,
      )
      .all({ userId }) as MachineRecord[];
    return rows.map(toMachine);
  }

  getMachine(userId: string, machineId: string): Machine | null {
    return this.machinesFor(userId).find((m) => m.id === machineId) ?? null;
  }

  markMachineSeen(machineId: string): void {
    this.db.prepare("UPDATE machines SET last_seen_at = ? WHERE id = ?").run(this.now(), machineId);
  }

  /** Only the owner may share. Throws when the machine is not the owner's. */
  shareMachine(ownerId: string, machineId: string, withLogin: string): void {
    this.requireOwned(ownerId, machineId);
    this.db
      .prepare("INSERT OR IGNORE INTO machine_shares (machine_id, login) VALUES (?, ?)")
      .run(machineId, withLogin.trim().toLowerCase());
  }

  unshareMachine(ownerId: string, machineId: string, withLogin: string): void {
    this.requireOwned(ownerId, machineId);
    this.db
      .prepare("DELETE FROM machine_shares WHERE machine_id = ? AND login = ?")
      .run(machineId, withLogin.trim().toLowerCase());
  }

  private requireOwned(ownerId: string, machineId: string): void {
    const row = this.db.prepare("SELECT 1 FROM machines WHERE id = ? AND owner_id = ?").get(machineId, ownerId);
    if (!row) throw new Error("Machine not found");
  }

  insertJob(job: JobRow): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, user_id, machine_id, runner, repo, base_branch, prompt, model, command, status,
                           reason, branch, output, created_at, updated_at)
         VALUES (@id, @userId, @machineId, @runner, @repo, @baseBranch, @prompt, @model, @command, @status,
                 @reason, @branch, @output, @createdAt, @updatedAt)`,
      )
      .run({ model: null, command: null, reason: null, branch: null, output: null, ...definedOnly(job) });
  }

  /** Jobs are visible only to the user who created them; machine shares never expose them. */
  getJob(userId: string, jobId: string): JobRow | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").get(jobId, userId) as
      | JobRecord
      | undefined;
    return row ? toJob(row) : null;
  }

  /** Applies the patch (id, userId and createdAt are immutable) and bumps updatedAt unless the patch sets it. */
  updateJob(jobId: string, patch: Partial<JobRow>): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: jobId };
    const merged: Partial<JobRow> = { updatedAt: this.now(), ...definedOnly(patch) };
    for (const [key, column] of Object.entries(JOB_COLUMNS)) {
      const value = merged[key as keyof typeof JOB_COLUMNS];
      if (value === undefined) continue;
      sets.push(`${column} = @${key}`);
      params[key] = value;
    }
    this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  /** Returns a stable random secret (32 bytes, hex), creating it on first use. */
  getOrCreateSecret(name: string): string {
    this.db
      .prepare("INSERT OR IGNORE INTO secrets (name, value) VALUES (?, ?)")
      .run(name, randomBytes(32).toString("hex"));
    return (this.db.prepare("SELECT value FROM secrets WHERE name = ?").get(name) as { value: string }).value;
  }

  /** Deletes expired pairing codes (`now` in milliseconds). */
  sweepExpired(now: number = this.now()): void {
    this.db.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?").run(now);
  }
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

interface UserRecord {
  id: string;
  github_id: string;
  login: string;
  created_at: number;
}
interface MachineRecord {
  id: string;
  owner_id: string;
  name: string;
  public_key: string;
  created_at: number;
  last_seen_at: number | null;
}
interface JobRecord {
  id: string;
  user_id: string;
  machine_id: string;
  runner: string;
  repo: string;
  base_branch: string;
  prompt: string;
  model: string | null;
  command: string | null;
  status: string;
  reason: string | null;
  branch: string | null;
  output: string | null;
  created_at: number;
  updated_at: number;
}

const toUser = (r: UserRecord): User => ({ id: r.id, githubId: r.github_id, login: r.login, createdAt: r.created_at });

function toMachine(r: MachineRecord): Machine {
  const machine: Machine = {
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    publicKey: r.public_key,
    createdAt: r.created_at,
  };
  if (r.last_seen_at !== null) machine.lastSeenAt = r.last_seen_at;
  return machine;
}

function toJob(r: JobRecord): JobRow {
  const job: JobRow = {
    id: r.id,
    userId: r.user_id,
    machineId: r.machine_id,
    runner: r.runner,
    repo: r.repo,
    baseBranch: r.base_branch,
    prompt: r.prompt,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.model !== null) job.model = r.model;
  if (r.command !== null) job.command = r.command;
  if (r.reason !== null) job.reason = r.reason;
  if (r.branch !== null) job.branch = r.branch;
  if (r.output !== null) job.output = r.output;
  return job;
}
