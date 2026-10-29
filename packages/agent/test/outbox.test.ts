import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Outbox, OUTBOX_RETENTION_MS, type JobResult } from "../src/outbox.js";

const temps: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "hoistline-outbox-"));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const posix = process.platform !== "win32";
const result = (jobId: string, extra: Partial<JobResult> = {}): JobResult => ({
  type: "job.result",
  jobId,
  status: "succeeded",
  ...extra,
});

describe("Outbox", () => {
  it("keeps each result in a private file until it is removed, across instances", () => {
    const cache = temp();
    const box = new Outbox(cache);
    const full = result("job-a", { exitCode: 0, branch: "hoistline/job-a", output: "x".repeat(70_000), truncated: true });
    box.put(full);
    box.put(result("job-b", { status: "failed", reason: "runner_exit_1", exitCode: 1 }));
    const file = join(cache, "outbox", "job-a.json");
    expect(existsSync(file)).toBe(true);
    if (posix) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(cache, "outbox")).mode & 0o777).toBe(0o700);
    }
    expect(box.ids()).toEqual(["job-a", "job-b"]);
    expect(box.has("job-a")).toBe(true);

    const again = new Outbox(cache);
    expect(again.ids()).toEqual(["job-a", "job-b"]);
    expect(again.entries()[0]).toEqual(full);

    again.remove("job-a");
    expect(existsSync(file)).toBe(false);
    expect(again.ids()).toEqual(["job-b"]);
    expect(new Outbox(cache).ids()).toEqual(["job-b"]);
  });

  it("replaces an earlier entry for the same job", () => {
    const cache = temp();
    const box = new Outbox(cache);
    box.put(result("job-a", { status: "failed", reason: "first" }));
    box.put(result("job-a", { status: "cancelled" }));
    expect(new Outbox(cache).entries()).toEqual([result("job-a", { status: "cancelled" })]);
  });

  it.runIf(posix)("refuses an outbox directory that is a symlink, and writes nothing through it", () => {
    const cache = temp();
    const elsewhere = temp();
    symlinkSync(elsewhere, join(cache, "outbox"));
    const box = new Outbox(cache);
    expect(() => box.put(result("job-a"))).toThrow(/not a plain directory/);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(box.ids()).toEqual([]);
  });

  it.runIf(posix)("never follows a symlink planted at an entry's path", () => {
    const cache = temp();
    const elsewhere = temp();
    mkdirSync(join(cache, "outbox"), { mode: 0o700 });
    const target = join(elsewhere, "target");
    writeFileSync(target, "keep");
    // Planted after the outbox was loaded: the exclusive create refuses it.
    const box = new Outbox(cache);
    symlinkSync(target, join(cache, "outbox", "job-a.json"));
    expect(() => box.put(result("job-a"))).toThrow();
    expect(readFileSync(target, "utf8")).toBe("keep");
    // Found when loading: it is not a valid entry, so the link itself (never its target) is removed.
    const reloaded = new Outbox(cache);
    expect(reloaded.ids()).toEqual([]);
    expect(existsSync(join(cache, "outbox", "job-a.json"))).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("drops the oldest entry past maxEntries and reports it", () => {
    const cache = temp();
    const dropped: [string, string][] = [];
    let t = 1000;
    const box = new Outbox(cache, { maxEntries: 2, now: () => t++, onDrop: (id, why) => dropped.push([id, why]) });
    box.put(result("job-a"));
    box.put(result("job-b"));
    box.put(result("job-c"));
    expect(box.ids()).toEqual(["job-b", "job-c"]);
    expect(dropped).toEqual([["job-a", "overflow"]]);
    expect(existsSync(join(cache, "outbox", "job-a.json"))).toBe(false);
  });

  it("prunes entries older than 24 hours", () => {
    const cache = temp();
    let now = 1_000_000;
    const dropped: [string, string][] = [];
    const box = new Outbox(cache, { now: () => now, onDrop: (id, why) => dropped.push([id, why]) });
    box.put(result("job-old"));
    now += OUTBOX_RETENTION_MS - 1000;
    box.put(result("job-new"));
    now += 2000;
    box.prune();
    expect(box.ids()).toEqual(["job-new"]);
    expect(dropped).toEqual([["job-old", "expired"]]);
    expect(existsSync(join(cache, "outbox", "job-old.json"))).toBe(false);
    // A fresh instance prunes as it loads.
    box.put(result("job-old2"));
    now += OUTBOX_RETENTION_MS + 1;
    expect(new Outbox(cache, { now: () => now }).ids()).toEqual([]);
  });

  it("discards entries that are not valid results for their file name, and ignores other files", () => {
    const cache = temp();
    const dir = join(cache, "outbox");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "job-a.json"), JSON.stringify({ savedAt: 1, result: result("job-b") }));
    writeFileSync(join(dir, "job-c.json"), "{not json");
    writeFileSync(join(dir, "job-d.json"), JSON.stringify({ savedAt: 1, result: { ...result("job-d"), status: "running" } }));
    writeFileSync(join(dir, "notes.txt"), "keep me");
    writeFileSync(join(dir, "job-e.json"), JSON.stringify({ savedAt: Date.now(), result: result("job-e") }));
    const box = new Outbox(cache);
    expect(box.ids()).toEqual(["job-e"]);
    expect(box.entries()).toEqual([result("job-e")]);
    expect(readdirSync(dir).sort()).toEqual(["job-e.json", "notes.txt"]);
  });

  it("never throws when the cache cannot hold an outbox", () => {
    const cache = temp();
    writeFileSync(join(cache, "outbox"), "a file");
    const box = new Outbox(cache);
    expect(box.ids()).toEqual([]);
    expect(box.entries()).toEqual([]);
    expect(() => box.remove("job-a")).not.toThrow();
    expect(() => box.prune()).not.toThrow();
  });
});
