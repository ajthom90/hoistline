import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";

export interface User {
  id: string;
  provider: string;
  subject: string;
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
  exitCode?: number;
  /** The last 64 KiB (or whatever cap the writer used) of the job's output. */
  output?: string;
  /** True once output was cut to its tail. */
  outputTruncated?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Job states in which a job can still change. */
export const ACTIVE_JOB_STATUSES = ["queued", "awaiting_approval", "running"] as const;

export interface StoreOptions {
  /** Clock in milliseconds; inject in tests. */
  now?: () => number;
}

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
// Crockford base32: no I, L, O, U.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;
const SIGNING_KEY_SECRET = "hub-signing-key";

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
  exitCode: "exit_code",
  output: "output",
  outputTruncated: "output_truncated",
  updatedAt: "updated_at",
} as const;

/** better-sqlite3 binds no booleans. */
const sqlValue = (value: unknown) => (typeof value === "boolean" ? (value ? 1 : 0) : value);

const ACTIVE_SQL = `status IN (${ACTIVE_JOB_STATUSES.map((s) => `'${s}'`).join(", ")})`;

/** The last `maxBytes` bytes of `text`, starting at a character boundary. */
export function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let start = bytes.length - maxBytes;
  while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start++;
  return { text: bytes.toString("utf8", start), truncated: true };
}

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

  /**
   * Finds or creates the user for an identity-provider subject. `provider` is "github" (subject = numeric id)
   * or "oidc:<issuer>". The login is display-only. Only GitHub logins are unique, so for GitHub another
   * subject still holding the same login is stale and has its login cleared; other providers' logins are never
   * cleared or treated as unique.
   */
  upsertUser(identity: { provider: string; subject: string; login: string }): User {
    const { provider, subject, login } = identity;
    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM users WHERE provider = ? AND subject = ?")
        .get(provider, subject) as UserRecord | undefined;
      let record: UserRecord;
      if (existing) {
        this.db.prepare("UPDATE users SET login = ? WHERE id = ?").run(login, existing.id);
        record = { ...existing, login };
      } else {
        record = { id: randomUUID(), provider, subject, login, created_at: this.now() };
        this.db
          .prepare(
            "INSERT INTO users (id, provider, subject, login, created_at) VALUES (@id, @provider, @subject, @login, @created_at)",
          )
          .run(record);
      }
      if (provider === "github" && login) {
        this.db
          .prepare("UPDATE users SET login = '' WHERE provider = ? AND id != ? AND lower(login) = lower(?)")
          .run(provider, record.id, login);
      }
      return toUser(record);
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
            OR m.id IN (SELECT machine_id FROM machine_shares WHERE user_id = @userId)
         ORDER BY m.created_at, m.id`,
      )
      .all({ userId }) as MachineRecord[];
    return rows.map(toMachine);
  }

  getMachine(userId: string, machineId: string): Machine | null {
    return this.machinesFor(userId).find((m) => m.id === machineId) ?? null;
  }

  /**
   * Unscoped lookup for agent authentication only (the agent proves the machine key). Never use it to answer a
   * user's request; use getMachine, which is scoped to the caller.
   */
  getMachineById(machineId: string): Machine | null {
    const row = this.db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as MachineRecord | undefined;
    return row ? toMachine(row) : null;
  }

  /** Read-only lookup by identity-provider key (see upsertUser); never creates or updates. */
  getUserByKey(provider: string, subject: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE provider = ? AND subject = ?").get(provider, subject) as
      | UserRecord
      | undefined;
    return row ? toUser(row) : null;
  }

  getUser(userId: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRecord | undefined;
    return row ? toUser(row) : null;
  }

  markMachineSeen(machineId: string): void {
    this.db.prepare("UPDATE machines SET last_seen_at = ? WHERE id = ?").run(this.now(), machineId);
  }

  /**
   * Only the owner may share. `target` is `github:<login>` (case-insensitive, GitHub users only),
   * `user:<hub user id>` (exact), or a bare string, which means `github:<string>`. It is resolved to a user id
   * now and the share is keyed on that id. Returns the resolved user. Throws if the machine is not the owner's,
   * the target is empty or has an unknown prefix, nobody matches, or the login is ambiguous.
   */
  shareMachine(ownerId: string, machineId: string, target: string): User {
    this.requireOwned(ownerId, machineId);
    const user = this.resolveTarget(target);
    this.db.prepare("INSERT OR IGNORE INTO machine_shares (machine_id, user_id) VALUES (?, ?)").run(machineId, user.id);
    return toUser(user);
  }

  /** Revokes a share. `target` takes the same forms as shareMachine but resolves only among current sharees. */
  unshareMachine(ownerId: string, machineId: string, target: string): void {
    this.requireOwned(ownerId, machineId);
    const user = this.resolveTarget(target, machineId);
    this.db.prepare("DELETE FROM machine_shares WHERE machine_id = ? AND user_id = ?").run(machineId, user.id);
  }

  /** Users holding a share on the machine (owner only). */
  listShares(ownerId: string, machineId: string): { userId: string; provider: string; login: string }[] {
    this.requireOwned(ownerId, machineId);
    return this.db
      .prepare(
        `SELECT u.id AS userId, u.provider AS provider, u.login AS login
         FROM machine_shares s JOIN users u ON u.id = s.user_id
         WHERE s.machine_id = ? ORDER BY u.provider, u.login, u.id`,
      )
      .all(machineId) as { userId: string; provider: string; login: string }[];
  }

  private resolveTarget(target: string, withinSharesOf?: string): UserRecord {
    const raw = target.trim();
    const colon = raw.indexOf(":");
    const prefix = colon === -1 ? "github" : raw.slice(0, colon).toLowerCase();
    const value = (colon === -1 ? raw : raw.slice(colon + 1)).trim();
    if (prefix !== "github" && prefix !== "user") {
      throw new Error(`unknown share target prefix "${prefix}"; use github:<login> or user:<id>`);
    }
    if (!value) throw new Error("share target is empty; use github:<login> or user:<id>");
    const match = prefix === "user" ? "id = ?" : "provider = 'github' AND lower(login) = lower(?)";
    const params: string[] = [value];
    let scope = "";
    if (withinSharesOf !== undefined) {
      scope = " AND id IN (SELECT user_id FROM machine_shares WHERE machine_id = ?)";
      params.push(withinSharesOf);
    }
    const rows = this.db.prepare(`SELECT * FROM users WHERE ${match}${scope}`).all(...params) as UserRecord[];
    if (rows.length === 0) throw new Error(`${value} has not signed in to Hoistline yet`);
    if (rows.length > 1) throw new Error(`ambiguous login: ${value}`);
    return rows[0]!;
  }

  private requireOwned(ownerId: string, machineId: string): void {
    const row = this.db.prepare("SELECT 1 FROM machines WHERE id = ? AND owner_id = ?").get(machineId, ownerId);
    if (!row) throw new Error("Machine not found");
  }

  insertJob(job: JobRow): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, user_id, machine_id, runner, repo, base_branch, prompt, model, command, status,
                           reason, branch, exit_code, output, output_truncated, created_at, updated_at)
         VALUES (@id, @userId, @machineId, @runner, @repo, @baseBranch, @prompt, @model, @command, @status,
                 @reason, @branch, @exitCode, @output, @outputTruncated, @createdAt, @updatedAt)`,
      )
      .run({
        model: null,
        command: null,
        reason: null,
        branch: null,
        exitCode: null,
        output: null,
        ...definedOnly(job),
        outputTruncated: job.outputTruncated ? 1 : 0,
      });
  }

  /**
   * Unscoped lookup for messages from an authenticated agent only (the caller must compare machineId with the
   * authenticated machine). Never use it to answer a user's request; use getJob, which is scoped to the caller.
   */
  getJobById(jobId: string): JobRow | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRecord | undefined;
    return row ? toJob(row) : null;
  }

  /** Jobs that can still change (queued, awaiting_approval, running), optionally of one machine, oldest first. */
  activeJobs(machineId?: string): JobRow[] {
    const rows = (
      machineId === undefined
        ? this.db.prepare(`SELECT * FROM jobs WHERE ${ACTIVE_SQL} ORDER BY created_at, id`).all()
        : this.db
            .prepare(`SELECT * FROM jobs WHERE machine_id = ? AND ${ACTIVE_SQL} ORDER BY created_at, id`)
            .all(machineId)
    ) as JobRecord[];
    return rows.map(toJob);
  }

  countActiveJobs(filter: { userId: string } | { machineId: string }): number {
    const [column, value] = "userId" in filter ? ["user_id", filter.userId] : ["machine_id", filter.machineId];
    const row = this.db.prepare(`SELECT count(*) AS n FROM jobs WHERE ${column} = ? AND ${ACTIVE_SQL}`).get(value) as {
      n: number;
    };
    return row.n;
  }

  /** Ids of machines that have at least one active job. */
  machinesWithActiveJobs(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT machine_id FROM jobs WHERE ${ACTIVE_SQL}`).all() as {
      machine_id: string;
    }[];
    return rows.map((r) => r.machine_id);
  }

  /**
   * Applies the patch (like updateJob) only if the job's status is currently one of `from`, atomically. Returns
   * whether it applied. This is how states only move forward and terminal states stay terminal.
   */
  transitionJob(jobId: string, from: readonly string[], patch: Partial<JobRow>): boolean {
    if (from.length === 0) return false;
    const { sets, params } = jobSets(patch, this.now());
    const placeholders = from.map((status, i) => {
      params[`from${i}`] = status;
      return `@from${i}`;
    });
    params.id = jobId;
    const result = this.db
      .prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = @id AND status IN (${placeholders.join(", ")})`)
      .run(params);
    return result.changes > 0;
  }

  /**
   * Appends to the job's output keeping only the last `maxBytes` bytes (cut at a character boundary) and sets
   * outputTruncated once anything was dropped. Only while the job's status is one of `whileIn`; returns whether
   * it appended. One transaction.
   */
  appendJobOutput(jobId: string, chunk: string, maxBytes: number, whileIn: readonly string[]): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT status, output, output_truncated FROM jobs WHERE id = ?").get(jobId) as
        | { status: string; output: string | null; output_truncated: number }
        | undefined;
      if (!row || !whileIn.includes(row.status)) return false;
      const tail = utf8Tail((row.output ?? "") + chunk, maxBytes);
      this.db
        .prepare("UPDATE jobs SET output = ?, output_truncated = ?, updated_at = ? WHERE id = ?")
        .run(tail.text, row.output_truncated || tail.truncated ? 1 : 0, this.now(), jobId);
      return true;
    })();
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
    const { sets, params } = jobSets(patch, this.now());
    params.id = jobId;
    this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  /** Returns a stable random secret (32 bytes, hex), creating it on first use. */
  getOrCreateSecret(name: string): string {
    this.db
      .prepare("INSERT OR IGNORE INTO secrets (name, value) VALUES (?, ?)")
      .run(name, randomBytes(32).toString("hex"));
    return (this.db.prepare("SELECT value FROM secrets WHERE name = ?").get(name) as { value: string }).value;
  }

  /** The hub's Ed25519 job-signing key pair, generated on first use and stored (PKCS8 PEM) in `secrets`. */
  getOrCreateSigningKey(): { privateKey: KeyObject; publicKey: KeyObject } {
    const fresh = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    this.db.prepare("INSERT OR IGNORE INTO secrets (name, value) VALUES (?, ?)").run(SIGNING_KEY_SECRET, fresh);
    const row = this.db.prepare("SELECT value FROM secrets WHERE name = ?").get(SIGNING_KEY_SECRET) as {
      value: string;
    };
    const privateKey = createPrivateKey(row.value);
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }

  /** Deletes expired pairing codes (`now` in milliseconds). */
  sweepExpired(now: number = this.now()): void {
    this.db.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?").run(now);
  }
}

/** SET clauses for a job patch; id, userId and createdAt are immutable and never included. */
function jobSets(patch: Partial<JobRow>, now: number): { sets: string[]; params: Record<string, unknown> } {
  const sets: string[] = [];
  const params: Record<string, unknown> = {};
  const merged: Partial<JobRow> = { updatedAt: now, ...definedOnly(patch) };
  for (const [key, column] of Object.entries(JOB_COLUMNS)) {
    const value = merged[key as keyof typeof JOB_COLUMNS];
    if (value === undefined) continue;
    sets.push(`${column} = @${key}`);
    params[key] = sqlValue(value);
  }
  return { sets, params };
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

interface UserRecord {
  id: string;
  provider: string;
  subject: string;
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
  exit_code: number | null;
  output: string | null;
  output_truncated: number;
  created_at: number;
  updated_at: number;
}

const toUser = (r: UserRecord): User => ({
  id: r.id,
  provider: r.provider,
  subject: r.subject,
  login: r.login,
  createdAt: r.created_at,
});

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
  if (r.exit_code !== null) job.exitCode = r.exit_code;
  if (r.output !== null) job.output = r.output;
  if (r.output_truncated) job.outputTruncated = true;
  return job;
}
