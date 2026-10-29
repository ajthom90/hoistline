import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentToHub } from "@hoistline/protocol";
import { EventStreamer, OutputTail, enforceLogBudget, openJobLog } from "../src/job-output.js";
import { claimJob, claimJobSync } from "../src/seen-jobs.js";

const temps: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "hoistline-output-"));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const posix = process.platform !== "win32";
const KiB = 1024;

/** Hand-driven timers. */
class Timers {
  private seq = 0;
  readonly pending = new Map<number, () => void>();
  readonly delays: number[] = [];
  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    this.delays.push(ms);
    this.pending.set(++this.seq, fn);
    return this.seq;
  };
  readonly clearTimeout = (h: unknown): void => void this.pending.delete(h as number);
  fire(): void {
    for (const [id, fn] of [...this.pending]) {
      this.pending.delete(id);
      fn();
    }
  }
}

type Event = Extract<AgentToHub, { type: "job.event" }>;

function streamer(opts: { capBytes?: number; throwing?: boolean } = {}) {
  const sent: Event[] = [];
  const timers = new Timers();
  const s = new EventStreamer("job-1", (msg) => {
    if (opts.throwing) throw new Error("not connected");
    sent.push(msg as Event);
  }, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, capBytes: opts.capBytes });
  return { s, sent, timers };
}

describe("EventStreamer", () => {
  it("coalesces small chunks within one window, keeping streams in order", () => {
    const { s, sent, timers } = streamer();
    s.push("a", "stdout");
    s.push("b", "stdout");
    s.push("E", "stderr");
    s.push("c", "stdout");
    expect(sent).toEqual([]);
    expect(timers.delays).toEqual([100]);
    timers.fire();
    expect(sent.map((e) => [e.stream, e.data])).toEqual([
      ["stdout", "ab"],
      ["stderr", "E"],
      ["stdout", "c"],
    ]);
    expect(sent.every((e) => e.type === "job.event" && e.jobId === "job-1")).toBe(true);
  });

  it("flushes at 48 KiB without waiting for the window and sends at most 16 KiB per event", () => {
    const { s, sent } = streamer();
    for (let i = 0; i < 6; i++) s.push("x".repeat(8 * KiB), "stdout");
    expect(sent.map((e) => e.data.length)).toEqual([16 * KiB, 16 * KiB, 16 * KiB]);
  });

  it("never splits a multi-byte character across events", () => {
    const { s, sent } = streamer();
    s.push("€".repeat(20_000), "stdout"); // 60,000 bytes
    expect(sent.length).toBeGreaterThan(1);
    for (const e of sent) expect(Buffer.byteLength(e.data)).toBeLessThanOrEqual(16 * KiB);
    expect(sent.map((e) => e.data).join("")).toBe("€".repeat(20_000));
  });

  it("stops sending once the per-job cap is reached", () => {
    const { s, sent, timers } = streamer({ capBytes: 40 * KiB });
    for (let i = 0; i < 10; i++) s.push("y".repeat(8 * KiB), "stdout");
    s.close();
    timers.fire();
    const total = sent.reduce((n, e) => n + Buffer.byteLength(e.data), 0);
    expect(total).toBeLessThanOrEqual(40 * KiB);
    expect(total).toBeGreaterThanOrEqual(32 * KiB);
    s.push("more", "stdout");
    timers.fire();
    expect(sent.reduce((n, e) => n + Buffer.byteLength(e.data), 0)).toBe(total);
  });

  it("swallows send failures and flushes on close", () => {
    const { s, timers } = streamer({ throwing: true });
    expect(() => s.push("a", "stdout")).not.toThrow();
    expect(() => timers.fire()).not.toThrow();
    const ok = streamer();
    ok.s.push("z", "stderr");
    ok.s.close();
    expect(ok.sent.map((e) => e.data)).toEqual(["z"]);
    expect(ok.timers.pending.size).toBe(0);
  });
});

describe("OutputTail", () => {
  it("keeps only the last 64 KiB, cut at a character boundary", () => {
    const tail = new OutputTail(64 * KiB);
    tail.push("start-");
    for (let i = 0; i < 10; i++) tail.push("€".repeat(10_000));
    tail.push("THE END");
    const text = tail.text();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * KiB);
    expect(Buffer.byteLength(text)).toBeGreaterThan(64 * KiB - 4);
    expect(text.endsWith("€THE END")).toBe(true);
    expect(text.startsWith("€")).toBe(true);
    const small = new OutputTail(64 * KiB);
    small.push("a");
    small.push("b");
    expect(small.text()).toBe("ab");
  });
});

describe("openJobLog", () => {
  it.runIf(posix)("creates <dir>/<jobId>.log with mode 0600 in a 0700 directory and caps its size", () => {
    const dir = join(temp(), "logs");
    const log = openJobLog(dir, "job-1", { maxBytes: 10 })!;
    log.write("12345");
    log.write("67890abc");
    log.write("more");
    log.close();
    const file = join(dir, "job-1.log");
    expect(readFileSync(file, "utf8")).toBe("1234567890");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("never reuses an existing log file", () => {
    const dir = temp();
    writeFileSync(join(dir, "job-1.log"), "old");
    expect(openJobLog(dir, "job-1")).toBeNull();
    expect(readFileSync(join(dir, "job-1.log"), "utf8")).toBe("old");
  });

  it.runIf(posix)("never writes through a symlinked log directory or a symlinked log file", () => {
    const base = temp();
    const target = join(base, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, join(base, "logs"));
    expect(openJobLog(join(base, "logs"), "job-1")).toBeNull();
    expect(readdirSync(target)).toEqual([]);

    const real = join(base, "real");
    mkdirSync(real);
    symlinkSync(join(target, "victim"), join(real, "job-2.log"));
    expect(openJobLog(real, "job-2")).toBeNull();
    expect(existsSync(join(target, "victim"))).toBe(false);
  });

  it("prunes logs older than 7 days, and nothing else", () => {
    const dir = temp();
    const now = Date.now();
    const old = (now - 8 * 24 * 3600_000) / 1000;
    writeFileSync(join(dir, "stale.log"), "x");
    utimesSync(join(dir, "stale.log"), old, old);
    writeFileSync(join(dir, "fresh.log"), "x");
    writeFileSync(join(dir, "stale.txt"), "x");
    utimesSync(join(dir, "stale.txt"), old, old);
    openJobLog(dir, "job-3", { now: () => now })!.close();
    expect(readdirSync(dir).sort()).toEqual(["fresh.log", "job-3.log", "stale.txt"]);
  });
});

describe("claimJob", () => {
  it.runIf(posix)("claims a job id once, durably, in a 0700 directory with 0600 markers", async () => {
    const cache = temp();
    expect(await claimJob(cache, "job-1")).toBe(true);
    expect(await claimJob(cache, "job-1")).toBe(false);
    expect(await claimJob(cache, "job-2")).toBe(true);
    const dir = join(cache, "seen-jobs");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "job-1")).mode & 0o777).toBe(0o600);
  });

  it("prunes markers older than 24 hours", async () => {
    const cache = temp();
    const now = Date.now();
    await claimJob(cache, "old", now);
    const t = (now - 25 * 3600_000) / 1000;
    utimesSync(join(cache, "seen-jobs", "old"), t, t);
    await claimJob(cache, "new", now);
    expect(readdirSync(join(cache, "seen-jobs")).sort()).toEqual(["new"]);
  });

  it.runIf(posix)("refuses a symlinked seen-jobs directory", async () => {
    const cache = temp();
    const target = join(cache, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, join(cache, "seen-jobs"));
    await expect(claimJob(cache, "job-1")).rejects.toThrow(/not a plain directory/);
    expect(readdirSync(target)).toEqual([]);
    expect(lstatSync(join(cache, "seen-jobs")).isSymbolicLink()).toBe(true);
  });

  it("refuses an unsafe job id", async () => {
    const cache = temp();
    await expect(claimJob(cache, "../x")).rejects.toThrow(/invalid job id/);
  });

  it("has a synchronous form that shares the same markers", async () => {
    const cache = temp();
    expect(claimJobSync(cache, "job-1", Date.now())).toBe(true);
    expect(await claimJob(cache, "job-1")).toBe(false);
    expect(claimJobSync(cache, "job-1", Date.now())).toBe(false);
    expect(() => claimJobSync(cache, "../x", Date.now())).toThrow(/invalid job id/);
  });
});

describe("truncation flags", () => {
  it("OutputTail.truncated is true only once output was dropped", () => {
    const tail = new OutputTail(10);
    tail.push("12345");
    tail.push("67890");
    expect(tail.truncated).toBe(false);
    tail.push("x");
    expect(tail.truncated).toBe(true);
    expect(tail.text()).toBe("234567890x");
  });

  it("EventStreamer.capped is true only once output was held back by the cap", () => {
    const { s } = streamer({ capBytes: 10 });
    s.push("1234567890", "stdout");
    s.flush();
    expect(s.capped).toBe(false);
    s.push("x", "stdout");
    s.flush();
    expect(s.capped).toBe(true);
  });
});

describe("enforceLogBudget", () => {
  const DAY = 24 * 3600_000;
  function logAt(dir: string, name: string, bytes: number, mtimeMs: number) {
    writeFileSync(join(dir, name), "x".repeat(bytes));
    utimesSync(join(dir, name), mtimeMs / 1000, mtimeMs / 1000);
  }

  it("removes logs past retention, then the oldest finished logs until the total fits", () => {
    const dir = temp();
    const now = Date.now();
    logAt(dir, "ancient.log", 10, now - 8 * DAY);
    logAt(dir, "a.log", 1000, now - 4000);
    logAt(dir, "b.log", 1000, now - 3000);
    logAt(dir, "c.log", 1000, now - 2000);
    logAt(dir, "d.log", 1000, now - 1000);
    logAt(dir, "other.txt", 5000, now - 9 * DAY);
    enforceLogBudget(dir, { maxTotalBytes: 2500, now, keep: new Set() });
    expect(readdirSync(dir).sort()).toEqual(["c.log", "d.log", "other.txt"]);
  });

  it("never removes the log of an active job, even when it alone is over budget", () => {
    const dir = temp();
    const now = Date.now();
    logAt(dir, "job-live.log", 5000, now - 9000);
    logAt(dir, "job-done.log", 100, now - 1000);
    enforceLogBudget(dir, { maxTotalBytes: 1000, now, keep: new Set(["job-live"]) });
    expect(readdirSync(dir)).toEqual(["job-live.log"]);
  });

  it.runIf(posix)("never follows a symlinked directory, and never throws", () => {
    const base = temp();
    const target = join(base, "elsewhere");
    mkdirSync(target);
    writeFileSync(join(target, "precious.log"), "x".repeat(5000));
    symlinkSync(target, join(base, "logs"));
    expect(() => enforceLogBudget(join(base, "logs"), { maxTotalBytes: 1, now: Date.now(), keep: new Set() })).not.toThrow();
    expect(readdirSync(target)).toEqual(["precious.log"]);
    expect(() => enforceLogBudget(join(base, "missing"), { maxTotalBytes: 1, now: Date.now(), keep: new Set() })).not.toThrow();
  });
});
