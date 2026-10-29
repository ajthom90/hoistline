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
    model: z.string().max(100).optional(),
    command: z.string().max(10_000).optional(),
  })
  .strict();
export type JobSpec = z.infer<typeof JobSpecSchema>;

export const SignedJobSchema = z
  .object({
    spec: JobSpecSchema,
    userId: z.string().min(1).max(200),
    issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    signature: z.string(),
  })
  .strict();
export type SignedJob = z.infer<typeof SignedJobSchema>;

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

function signedBytes(spec: JobSpec, userId: string, issuedAt: number): Buffer {
  return Buffer.from(canonicalJson({ spec, userId, issuedAt }), "utf8");
}

function assertEd25519(key: KeyObject): void {
  if (key.asymmetricKeyType !== "ed25519") throw new Error("hub key must be an Ed25519 key");
}

export function signJob(
  spec: JobSpec,
  userId: string,
  hubPrivateKey: KeyObject,
  now: number = Date.now(),
): SignedJob {
  assertEd25519(hubPrivateKey);
  const parsed = SignedJobSchema.parse({ spec, userId, issuedAt: now, signature: "" });
  const signature = sign(null, signedBytes(parsed.spec, parsed.userId, parsed.issuedAt), hubPrivateKey);
  return {
    spec: parsed.spec,
    userId: parsed.userId,
    issuedAt: parsed.issuedAt,
    signature: signature.toString("base64url"),
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
 * Trust boundary: returns the spec and userId only if the signature is valid and the job is fresh.
 * Throws otherwise; never returns partial data.
 */
export function verifyJob(
  job: SignedJob,
  hubPublicKey: KeyObject,
  now: number = Date.now(),
): { spec: JobSpec; userId: string } {
  assertEd25519(hubPublicKey);
  const parsed = SignedJobSchema.safeParse(job);
  if (!parsed.success) throw new Error("invalid signed job");
  const { spec, userId, issuedAt, signature } = parsed.data;
  const sigBytes = decodeSignature(signature);
  if (!verify(null, signedBytes(spec, userId, issuedAt), hubPublicKey, sigBytes)) {
    throw new Error("invalid job signature");
  }
  if (now - issuedAt > MAX_JOB_AGE_MS) throw new Error("job expired");
  if (issuedAt - now > MAX_CLOCK_SKEW_MS) throw new Error("job issued in the future");
  return { spec, userId };
}
