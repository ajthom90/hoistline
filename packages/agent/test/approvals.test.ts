import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobSpec } from "@hoistline/protocol";
import { createApprovalQueue, escapeForTerminal, type ApprovalQueue } from "../src/approvals.js";
import { specHash, type ApprovalRequest } from "../src/executor.js";

const posix = process.platform !== "win32";

let root: string;
let dir: string;
const queues: ApprovalQueue[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hoistline-approvals-"));
  dir = join(root, "approvals");
});
afterEach(() => {
  for (const q of queues.splice(0)) q.close();
  rmSync(root, { recursive: true, force: true });
});

let seq = 0;
function request(over: Partial<ApprovalRequest> = {}, specOver: Partial<JobSpec> = {}): ApprovalRequest {
  const jobId = over.jobId ?? `job${++seq}`;
  const spec: JobSpec = {
    jobId,
    runner: "muse",
    repo: "owner/name",
    baseBranch: "main",
    prompt: "do the thing",
    ...specOver,
  };
  return { jobId, userId: "user-1", spec, reason: "runner rule failed", specHash: specHash(spec), ...over };
}

/** A queue driven by a manual clock and manual timers. */
function manualQueue(opts: { ttlMs?: number; onError?: (e: unknown) => void } = {}) {
  let clock = 1_000_000;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextId = 0;
  const q = createApprovalQueue({
    dir,
    now: () => clock,
    pollIntervalMs: 500,
    ttlMs: opts.ttlMs,
    onError: opts.onError,
    setTimeout: (fn, ms) => {
      const id = ++nextId;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  });
  queues.push(q);
  /** Advances the clock and runs every timer that is due, then lets promise callbacks settle. */
  async function tick(ms = 500): Promise<void> {
    clock += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= clock) {
        timers.delete(id);
        t.fn();
      }
    }
    await new Promise((r) => setImmediate(r));
  }
  return { q, tick, advance: (ms: number) => (clock += ms), timers };
}

const pendingFile = (jobId: string) => join(dir, "pending", `${jobId}.json`);
const decisionFile = (jobId: string) => join(dir, "decisions", `${jobId}.json`);

function settled<T>(p: Promise<T>): { done: boolean; value?: T } {
  const s: { done: boolean; value?: T } = { done: false };
  void p.then((v) => {
    s.done = true;
    s.value = v;
  });
  return s;
}

describe("approval queue", () => {
  it("writes a pending request and resolves true once approved with the matching hash, then removes both files", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    const result = settled(q.requestApproval(req));
    await tick(0);
    expect(existsSync(pendingFile(req.jobId))).toBe(true);
    const pending = q.show(req.jobId)!;
    expect(pending).toMatchObject({ jobId: req.jobId, userId: "user-1", spec: req.spec, reason: req.reason, specHash: req.specHash });
    expect(typeof pending.createdAt).toBe("number");
    expect(q.list().map((p) => p.jobId)).toEqual([req.jobId]);

    q.decide(req.jobId, "approve", req.specHash);
    await tick();
    expect(result).toEqual({ done: true, value: true });
    expect(existsSync(pendingFile(req.jobId))).toBe(false);
    expect(existsSync(decisionFile(req.jobId))).toBe(false);
    expect(q.list()).toEqual([]);
  });

  it("resolves false on deny", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    const result = settled(q.requestApproval(req));
    await tick(0);
    q.decide(req.jobId, "deny", req.specHash);
    await tick();
    expect(result).toEqual({ done: true, value: false });
    expect(existsSync(pendingFile(req.jobId))).toBe(false);
  });

  it("treats an approval carrying a different spec hash as a deny and removes it", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    const result = settled(q.requestApproval(req));
    await tick(0);
    // Written by hand (decide() would refuse the wrong hash).
    writeFileSync(
      decisionFile(req.jobId),
      JSON.stringify({ jobId: req.jobId, decision: "approve", specHash: "a".repeat(64), decidedAt: 1_000_000 }),
      { mode: 0o600 },
    );
    await tick();
    expect(result).toEqual({ done: true, value: false });
    expect(existsSync(decisionFile(req.jobId))).toBe(false);
    expect(existsSync(pendingFile(req.jobId))).toBe(false);
  });

  it("ignores and removes forged, invalid and oversized decision files", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    const result = settled(q.requestApproval(req));
    await tick(0);
    const bad = [
      JSON.stringify({ jobId: req.jobId, decision: "approve" }), // no hash
      JSON.stringify({ jobId: req.jobId, decision: "yes", specHash: req.specHash, decidedAt: 1 }),
      JSON.stringify({ jobId: req.jobId, decision: "approve", specHash: req.specHash, decidedAt: 1, extra: true }),
      JSON.stringify({ jobId: "other", decision: "approve", specHash: req.specHash, decidedAt: 1 }),
      JSON.stringify({ jobId: req.jobId, decision: "approve", specHash: req.specHash.toUpperCase(), decidedAt: 1 }),
      JSON.stringify({ jobId: req.jobId, decision: "approve", specHash: req.specHash, decidedAt: 1, pad: "x".repeat(5000) }),
    ];
    for (const content of bad) {
      writeFileSync(decisionFile(req.jobId), content, { mode: 0o600 });
      await tick();
      expect(result.done).toBe(false);
      expect(existsSync(decisionFile(req.jobId))).toBe(false);
      expect(existsSync(pendingFile(req.jobId))).toBe(true);
    }
    q.decide(req.jobId, "approve", req.specHash);
    await tick();
    expect(result).toEqual({ done: true, value: true });
  });

  it("does not read a 10 MB decision file fully, and ignores it", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    const result = settled(q.requestApproval(req));
    await tick(0);
    const valid = JSON.stringify({ jobId: req.jobId, decision: "approve", specHash: req.specHash, decidedAt: 1_000_000 });
    // A valid decision followed by 10 MB of whitespace: honored only if the whole file were read and parsed.
    writeFileSync(decisionFile(req.jobId), valid + " ".repeat(10 * 1024 * 1024), { mode: 0o600 });
    await tick();
    expect(result.done).toBe(false);
    expect(existsSync(decisionFile(req.jobId))).toBe(false);
  });

  it("removes a stale decision written before the request", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    mkdirSync(join(dir, "decisions"), { recursive: true, mode: 0o700 });
    writeFileSync(
      decisionFile(req.jobId),
      JSON.stringify({ jobId: req.jobId, decision: "approve", specHash: req.specHash, decidedAt: 1_000_000 }),
      { mode: 0o600 },
    );
    const result = settled(q.requestApproval(req));
    await tick(0);
    await tick();
    expect(result.done).toBe(false);
    expect(q.show(req.jobId)).not.toBeNull();
  });

  it("does not lose a decision made the moment the pending file appears", async () => {
    mkdirSync(join(dir, "decisions"), { recursive: true, mode: 0o700 });
    const req = request();
    writeFileSync(
      decisionFile(req.jobId),
      JSON.stringify({ jobId: req.jobId, decision: "deny", specHash: req.specHash, decidedAt: 1_000_000 }),
      { mode: 0o600 },
    );
    // The owner's CLI, a separate queue on the same directory.
    const q2 = createApprovalQueue({ dir });
    const q = createApprovalQueue({
      dir,
      pollIntervalMs: 5,
      // The owner answers as soon as the request is visible, before anything else runs.
      onPendingPublished: (jobId) => q2.decide(jobId, "approve", req.specHash),
    });
    queues.push(q, q2);
    expect(await q.requestApproval(req)).toBe(true);
  });

  it("publishes atomically and leaves no temporary files", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    void q.requestApproval(req);
    await tick(0);
    q.decide(req.jobId, "deny", req.specHash);
    expect(readdirSync(join(dir, "pending"))).toEqual([`${req.jobId}.json`]);
    expect(readdirSync(join(dir, "decisions"))).toEqual([`${req.jobId}.json`]);
  });

  it("treats a young empty or unparsable file as not yet written, and removes it once old", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    const result = settled(q.requestApproval(req));
    await tick(0);
    for (const content of ["", "not json", '{"jobId":']) {
      writeFileSync(decisionFile(req.jobId), content, { mode: 0o600 });
      await tick();
      expect(result.done).toBe(false);
      expect(existsSync(decisionFile(req.jobId))).toBe(true);
    }
    writeFileSync(pendingFile("planted"), "", { mode: 0o600 });
    expect(q.list().map((p) => p.jobId)).toEqual([req.jobId]);
    q.prune();
    expect(existsSync(pendingFile("planted"))).toBe(true);
    // Eleven seconds later they are garbage.
    const old = new Date(Date.now() - 11_000);
    utimesSync(decisionFile(req.jobId), old, old);
    utimesSync(pendingFile("planted"), old, old);
    await tick();
    expect(result.done).toBe(false);
    expect(existsSync(decisionFile(req.jobId))).toBe(false);
    q.prune();
    expect(existsSync(pendingFile("planted"))).toBe(false);
  });

  it("ignores temporary files when listing and prunes old ones", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    void q.requestApproval(req);
    await tick(0);
    const tmp = join(dir, "pending", `${req.jobId}.json.0123456789abcdef.tmp`);
    writeFileSync(tmp, "{}", { mode: 0o600 });
    expect(q.list().map((p) => p.jobId)).toEqual([req.jobId]);
    q.prune();
    expect(existsSync(tmp)).toBe(true);
    const old = new Date(Date.now() - 11_000);
    utimesSync(tmp, old, old);
    q.prune();
    expect(existsSync(tmp)).toBe(false);
  });

  it("a decision racing the waiter's timeout never affects a later request with the same id", async () => {
    const { q, tick } = manualQueue({ ttlMs: 1000 });
    const req = request();
    const first = settled(q.requestApproval(req));
    await tick(0);
    const shown = q.show(req.jobId)!;
    await tick(1000);
    expect(first).toEqual({ done: true, value: false });
    // The owner's `decide` read the request before it timed out and writes its answer just after.
    writeFileSync(
      decisionFile(req.jobId),
      JSON.stringify({ jobId: req.jobId, decision: "approve", specHash: shown.specHash, decidedAt: 1_001_000 }),
      { mode: 0o600 },
    );
    const second = settled(q.requestApproval(req));
    await tick(0);
    await tick();
    expect(second.done).toBe(false);
    expect(existsSync(decisionFile(req.jobId))).toBe(false);
  });

  it("can approve a request with a 100,000-character prompt", async () => {
    const { q, tick } = manualQueue();
    const req = request({}, { prompt: "é".repeat(100_000) });
    const result = settled(q.requestApproval(req));
    await tick(0);
    expect(q.show(req.jobId)?.spec.prompt).toHaveLength(100_000);
    q.decide(req.jobId, "approve", req.specHash);
    await tick();
    expect(result).toEqual({ done: true, value: true });
  });

  it("removes the pending file and resolves false when the signal aborts", async () => {
    const { q, tick } = manualQueue();
    const controller = new AbortController();
    const req = request({ signal: controller.signal });
    const result = settled(q.requestApproval(req));
    await tick(0);
    expect(existsSync(pendingFile(req.jobId))).toBe(true);
    controller.abort();
    // Removed synchronously, inside the abort.
    expect(existsSync(pendingFile(req.jobId))).toBe(false);
    await tick(0);
    expect(result).toEqual({ done: true, value: false });
  });

  it("resolves false at once for an already aborted signal", async () => {
    const { q } = manualQueue();
    const req = request({ signal: AbortSignal.abort() });
    expect(await q.requestApproval(req)).toBe(false);
    expect(existsSync(pendingFile(req.jobId))).toBe(false);
  });

  it("resolves false when the TTL expires", async () => {
    const { q, tick } = manualQueue({ ttlMs: 2000 });
    const req = request();
    const result = settled(q.requestApproval(req));
    await tick(0);
    await tick(1500);
    expect(result.done).toBe(false);
    await tick(600);
    expect(result).toEqual({ done: true, value: false });
    expect(existsSync(pendingFile(req.jobId))).toBe(false);
  });

  it("defaults the TTL to one hour", async () => {
    const { q, tick } = manualQueue();
    const result = settled(q.requestApproval(request()));
    await tick(0);
    await tick(3599_000);
    expect(result.done).toBe(false);
    await tick(1000);
    expect(result).toEqual({ done: true, value: false });
  });

  it("resolves false and cleans up on close", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    const result = settled(q.requestApproval(req));
    await tick(0);
    q.close();
    expect(existsSync(pendingFile(req.jobId))).toBe(false);
    await tick(0);
    expect(result).toEqual({ done: true, value: false });
    expect(await q.requestApproval(request())).toBe(false);
  });

  it("refuses a second pending request for the same job and keeps the first", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    const first = settled(q.requestApproval(req));
    await tick(0);
    await expect(q.requestApproval({ ...req })).rejects.toThrow(/already awaiting approval/);
    expect(existsSync(pendingFile(req.jobId))).toBe(true);
    // Another process's queue on the same directory refuses it too.
    const other = createApprovalQueue({ dir });
    queues.push(other);
    await expect(other.requestApproval({ ...req })).rejects.toThrow(/already awaiting approval/);
    expect(existsSync(pendingFile(req.jobId))).toBe(true);
    q.decide(req.jobId, "approve", req.specHash);
    await tick();
    expect(first).toEqual({ done: true, value: true });
  });

  it("rejects (does not deny) a pending request too large to read back", async () => {
    const errors: unknown[] = [];
    const { q } = manualQueue({ onError: (e) => errors.push(e) });
    // 100,000 control characters: each is six bytes of JSON, over the 512 KiB bound.
    const req = request({}, { prompt: "\u0001".repeat(100_000) });
    await expect(q.requestApproval(req)).rejects.toThrow(/too large/);
    expect(existsSync(pendingFile(req.jobId))).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("decide() rejects an unknown job, a wrong hash and a second decision", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    void q.requestApproval(req);
    await tick(0);
    expect(() => q.decide("nope", "approve", req.specHash)).toThrow(/no pending approval/);
    expect(() => q.decide(req.jobId, "approve", "b".repeat(64))).toThrow(/spec hash/);
    expect(() => q.decide(req.jobId, "approve", req.specHash.slice(0, 12))).toThrow(/spec hash/);
    expect(existsSync(decisionFile(req.jobId))).toBe(false);
    q.decide(req.jobId, "deny", req.specHash);
    expect(() => q.decide(req.jobId, "approve", req.specHash)).toThrow(/already decided/);
    expect(JSON.parse(readFileSync(decisionFile(req.jobId), "utf8"))).toMatchObject({ decision: "deny" });
  });

  it.runIf(posix)("creates directories 0700 and files 0600", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    void q.requestApproval(req);
    await tick(0);
    q.decide(req.jobId, "deny", req.specHash);
    for (const d of [dir, join(dir, "pending"), join(dir, "decisions")]) expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(statSync(pendingFile(req.jobId)).mode & 0o777).toBe(0o600);
    expect(statSync(decisionFile(req.jobId)).mode & 0o777).toBe(0o600);
  });

  it.runIf(posix)("refuses a symlinked approvals directory", async () => {
    const victim = join(root, "victim");
    mkdirSync(victim, { mode: 0o700 });
    symlinkSync(victim, dir);
    const errors: unknown[] = [];
    const { q } = manualQueue({ onError: (e) => errors.push(e) });
    await expect(q.requestApproval(request())).rejects.toThrow(/symbolic link/);
    expect(readdirSync(victim)).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(() => q.list()).toThrow(/symbolic link|not a directory/);
  });

  it.runIf(posix)("refuses a symlinked pending directory", async () => {
    const victim = join(root, "victim");
    mkdirSync(victim, { mode: 0o700 });
    mkdirSync(dir, { mode: 0o700 });
    symlinkSync(victim, join(dir, "pending"));
    const { q } = manualQueue();
    await expect(q.requestApproval(request())).rejects.toThrow(/symbolic link/);
    expect(readdirSync(victim)).toEqual([]);
  });

  it.runIf(posix)("never follows a symlinked pending file", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    void q.requestApproval(req);
    await tick(0);
    const victim = join(root, "victim.json");
    writeFileSync(victim, readFileSync(pendingFile(req.jobId)), { mode: 0o600 });
    symlinkSync(victim, pendingFile("linked"));
    expect(q.list().map((p) => p.jobId)).toEqual([req.jobId]);
    expect(() => q.decide("linked", "approve", req.specHash)).toThrow(/no pending approval/);
    expect(lstatSync(pendingFile("linked")).isSymbolicLink()).toBe(true);
    q.prune();
    expect(existsSync(pendingFile("linked"))).toBe(false);
    expect(existsSync(victim)).toBe(true);
  });

  it.runIf(posix)("never follows a symlinked decision file and leaves its target untouched", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    const result = settled(q.requestApproval(req));
    await tick(0);
    const victim = join(root, "victim.json");
    const valid = JSON.stringify({ jobId: req.jobId, decision: "approve", specHash: req.specHash, decidedAt: 1_000_000 });
    writeFileSync(victim, valid, { mode: 0o600 });
    symlinkSync(victim, decisionFile(req.jobId));
    await tick();
    expect(result.done).toBe(false);
    expect(existsSync(decisionFile(req.jobId))).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe(valid);
    // decide() does not write through a symlink either.
    symlinkSync(victim, decisionFile(req.jobId));
    expect(() => q.decide(req.jobId, "deny", req.specHash)).toThrow();
    expect(readFileSync(victim, "utf8")).toBe(valid);
    expect(lstatSync(decisionFile(req.jobId)).isSymbolicLink()).toBe(true);
  });

  it("rejects job ids that could escape the directory", async () => {
    const { q } = manualQueue();
    for (const jobId of ["../x", "a/b", "..", "", "a\\b"]) {
      await expect(q.requestApproval(request({ jobId }))).rejects.toThrow(/invalid job id/);
      expect(() => q.decide(jobId, "approve", "a".repeat(64))).toThrow(/invalid job id/);
      expect(() => q.show(jobId)).toThrow(/invalid job id/);
    }
    expect(existsSync(join(root, "x.json"))).toBe(false);
  });

  it("ignores invalid pending files when listing, and only prune removes them", async () => {
    const { q, tick } = manualQueue();
    const req = request();
    void q.requestApproval(req);
    await tick(0);
    writeFileSync(pendingFile("forged"), JSON.stringify({ jobId: "forged" }), { mode: 0o600 });
    // A pending whose hash does not match its spec.
    writeFileSync(
      pendingFile("mismatch"),
      JSON.stringify({ ...request({ jobId: "mismatch" }), specHash: "c".repeat(64), createdAt: 1_000_000 }),
      { mode: 0o600 },
    );
    expect(q.list().map((p) => p.jobId)).toEqual([req.jobId]);
    expect(q.show("forged")).toBeNull();
    expect(() => q.decide("mismatch", "approve", "c".repeat(64))).toThrow(/no pending approval/);
    expect(existsSync(pendingFile("forged"))).toBe(true);
    expect(existsSync(pendingFile("mismatch"))).toBe(true);
    q.prune();
    expect(existsSync(pendingFile("forged"))).toBe(false);
    expect(existsSync(pendingFile("mismatch"))).toBe(false);
  });

  it("prunes decisions older than an hour and orphaned pending files older than a day", async () => {
    const { q, tick, advance } = manualQueue();
    const live = request();
    void q.requestApproval(live);
    await tick(0);
    mkdirSync(join(dir, "decisions"), { recursive: true });
    const orphan = request({ jobId: "orphan" });
    const { signal: _s, ...orphanFile } = orphan;
    void _s;
    writeFileSync(pendingFile("orphan"), JSON.stringify({ ...orphanFile, createdAt: 1_000_000 }), { mode: 0o600 });
    writeFileSync(
      decisionFile("olddecision"),
      JSON.stringify({ jobId: "olddecision", decision: "deny", specHash: "d".repeat(64), decidedAt: 1_000_000 }),
      { mode: 0o600 },
    );
    advance(3600_000 + 1);
    q.prune();
    expect(existsSync(decisionFile("olddecision"))).toBe(false);
    expect(existsSync(pendingFile("orphan"))).toBe(true);
    advance(23 * 3600_000);
    q.prune();
    expect(existsSync(pendingFile("orphan"))).toBe(false);
    // The live request of this queue is never pruned.
    expect(existsSync(pendingFile(live.jobId))).toBe(true);
  });

  it("never throws synchronously; queue failures reject instead of denying", async () => {
    writeFileSync(join(root, "file"), "");
    const errors: unknown[] = [];
    const q = createApprovalQueue({ dir: join(root, "file", "approvals"), onError: (e) => errors.push(e) });
    queues.push(q);
    const calls = [
      () => q.requestApproval(request()),
      () => q.requestApproval(null as unknown as ApprovalRequest),
      () => q.requestApproval(request({ specHash: "short" })),
    ];
    for (const call of calls) {
      let p: Promise<boolean> | undefined;
      expect(() => (p = call())).not.toThrow();
      await expect(p).rejects.toThrow();
    }
    expect(errors.length).toBeGreaterThan(0);
  });

  it("works with real timers", async () => {
    const q = createApprovalQueue({ dir, pollIntervalMs: 10 });
    queues.push(q);
    const req = request();
    const p = q.requestApproval(req);
    while (!existsSync(pendingFile(req.jobId))) await new Promise((r) => setTimeout(r, 5));
    q.decide(req.jobId, "approve", req.specHash);
    expect(await p).toBe(true);
  });
});

describe("escapeForTerminal", () => {
  it("keeps ordinary text", () => {
    expect(escapeForTerminal("Fix the bug in src/app.ts, please! (owner/name) é 日本")).toBe(
      "Fix the bug in src/app.ts, please! (owner/name) é 日本",
    );
  });

  it("escapes ESC sequences, bidi overrides, zero-width characters and newlines", () => {
    expect(escapeForTerminal("a\u001b[2Jb")).toBe("a\\u{001B}[2Jb");
    expect(escapeForTerminal("x‮y")).toBe("x\\u{202E}y");
    expect(escapeForTerminal("z​w﻿")).toBe("z\\u{200B}w\\u{FEFF}");
    expect(escapeForTerminal("one\ntwo\r\n")).toBe("one\\ntwo\\u{000D}\\n");
    expect(escapeForTerminal("\u0007\u009b ⁦\t")).toBe("\\u{0007}\\u{009B}\\u{2028}\\u{2066}\\u{0009}");
    expect(escapeForTerminal("tag\u{E0041}")).toBe("tag\\u{E0041}");
    expect(escapeForTerminal("lone\uD800")).toBe("lone\\u{D800}");
  });

  it("escapes a literal backslash so source text cannot imitate an escape", () => {
    expect(escapeForTerminal("a\\nb")).toBe("a\\\\nb");
    expect(escapeForTerminal("a\nb")).toBe("a\\nb");
    expect(escapeForTerminal("a\\nb")).not.toBe(escapeForTerminal("a\nb"));
    expect(escapeForTerminal("\\u{001B}")).toBe("\\\\u{001B}");
    expect(escapeForTerminal("C:\\dir")).toBe("C:\\\\dir");
  });

  it("leaves no control characters at all", () => {
    let all = "";
    for (let c = 0; c < 0x3000; c++) all += String.fromCharCode(c);
    expect(escapeForTerminal(all)).not.toMatch(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/);
  });
});
