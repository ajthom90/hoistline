import { sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

export const RunnerName = z.enum(["muse", "codex", "cursor", "grok", "build-test"]);
export type RunnerName = z.infer<typeof RunnerName>;

// Field validation only; git-specific validation (ref names, repo format) lives elsewhere.
export const JobSpecSchema = z
  .object({
    jobId: z.string().min(1).max(100),
    runner: RunnerName,
    repo: z.string().min(1).max(200),
    baseBranch: z.string().min(1).max(255),
    prompt: z.string().min(1).max(100_000),
    model: z.string().min(1).max(100).optional(),
    command: z.string().min(1).max(10_000).optional(),
  })
  .strict();
export type JobSpec = z.infer<typeof JobSpecSchema>;

/**
 * Parsing with this schema checks shape only. It does NOT verify the signature;
 * only verifyJob does.
 */
export const SignedJobSchema = z
  .object({
    spec: JobSpecSchema,
    machineId: z.string().min(1).max(100),
    userId: z.string().min(1).max(200),
    issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    signature: z.string(),
  })
  .strict();
export type SignedJob = z.infer<typeof SignedJobSchema>;

/*
 * Responsibilities that remain with the AGENT after verifyJob succeeds (Tasks 7 and 9):
 * - Replay defense: remember seen jobIds for MAX_JOB_AGE_MS + MAX_CLOCK_SKEW_MS, durably
 *   across restarts, and refuse duplicates.
 * - Validate repo, baseBranch and jobId before use. They flow into branch names and
 *   worktree paths, so inputs such as `../`, `ext::` or `--upload-pack=` must be refused.
 */

const DOMAIN_TAG = "hoistline-job-v1";

/** Jobs older than this are rejected. */
export const MAX_JOB_AGE_MS = 5 * 60_000;
/** Jobs issued further in the future than this are rejected (clock skew allowance). */
export const MAX_CLOCK_SKEW_MS = 60_000;

const ED25519_SIGNATURE_BYTES = 64;

/** Deterministic JSON: object keys sorted at every depth, no whitespace, undefined values omitted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

function signedBytes(spec: JobSpec, userId: string, machineId: string, issuedAt: number): Buffer {
  return Buffer.from(
    canonicalJson({ v: DOMAIN_TAG, machineId, spec, userId, issuedAt }),
    "utf8",
  );
}

function assertEd25519(key: KeyObject): void {
  if (key.asymmetricKeyType !== "ed25519") throw new Error("hub key must be an Ed25519 key");
}

export function signJob(
  spec: JobSpec,
  userId: string,
  machineId: string,
  hubPrivateKey: KeyObject,
  now: number = Date.now(),
): SignedJob {
  assertEd25519(hubPrivateKey);
  const parsed = SignedJobSchema.parse({ spec, machineId, userId, issuedAt: now, signature: "" });
  const bytes = signedBytes(parsed.spec, parsed.userId, parsed.machineId, parsed.issuedAt);
  return {
    spec: parsed.spec,
    machineId: parsed.machineId,
    userId: parsed.userId,
    issuedAt: parsed.issuedAt,
    signature: sign(null, bytes, hubPrivateKey).toString("base64url"),
  };
}

function decodeSignature(signature: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(signature)) throw new Error("malformed signature encoding");
  const bytes = Buffer.from(signature, "base64url");
  // Reject non-canonical encodings (wrong length, nonzero trailing bits).
  if (bytes.length !== ED25519_SIGNATURE_BYTES || bytes.toString("base64url") !== signature) {
    throw new Error("malformed signature encoding");
  }
  return bytes;
}

/**
 * Trust boundary: returns the spec, userId and machineId only if the signature is valid, the job
 * is addressed to expectedMachineId and the job is fresh. Throws otherwise; never returns partial data.
 */
export function verifyJob(
  job: SignedJob,
  hubPublicKey: KeyObject,
  expectedMachineId: string,
  now: number = Date.now(),
): { spec: JobSpec; userId: string; machineId: string } {
  assertEd25519(hubPublicKey);
  if (typeof expectedMachineId !== "string" || expectedMachineId.length === 0) {
    throw new Error("expectedMachineId is required");
  }
  if (!Number.isSafeInteger(now)) throw new Error("invalid clock");
  const parsed = SignedJobSchema.safeParse(job);
  if (!parsed.success) throw new Error("invalid signed job");
  const { spec, userId, machineId, issuedAt, signature } = parsed.data;
  const sigBytes = decodeSignature(signature);
  if (!verify(null, signedBytes(spec, userId, machineId, issuedAt), hubPublicKey, sigBytes)) {
    throw new Error("invalid job signature");
  }
  if (machineId !== expectedMachineId) throw new Error("job addressed to a different machine");
  if (now - issuedAt > MAX_JOB_AGE_MS) throw new Error("job expired");
  if (issuedAt - now > MAX_CLOCK_SKEW_MS) throw new Error("job issued in the future");
  return { spec, userId, machineId };
}
