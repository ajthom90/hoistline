import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobSpec } from "@hoistline/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DENY_ALL,
  PolicyFileError,
  PolicySchema,
  defaultPolicyPath,
  effectivePolicy,
  evaluateJob,
  evaluateToolCall,
  loadEffectivePolicy,
  loadPolicy,
  runSetup,
  savePolicy,
  type PolicyConfig,
  type SetupIO,
} from "../src/index.js";

const job = (over: Partial<JobSpec> = {}): JobSpec => ({
  jobId: "j1",
  runner: "codex",
  repo: "owner/name",
  baseBranch: "main",
  prompt: "do it",
  ...over,
});

const restricted = (over: Record<string, unknown> = {}): PolicyConfig =>
  ({ mode: "restricted", repos: ["owner/name"], runners: ["codex"], onViolation: "deny", ...over }) as PolicyConfig;

function scripted(answers: string[]) {
  const printed: string[] = [];
  const questions: string[] = [];
  const io: SetupIO = {
    async ask(q) {
      questions.push(q);
      const a = answers.shift();
      if (a === undefined) throw new Error("out of answers");
      return a;
    },
    print: (t) => printed.push(t),
  };
  return { io, printed, questions };
}

const count = (texts: string[], needle: string) => texts.join("\n").split(needle).length - 1;

describe("trusted mode", () => {
  const p: PolicyConfig = { mode: "trusted" };
  it("allows any job and any tool, never asking", () => {
    for (const spec of [job(), job({ repo: "evil/x", runner: "build-test", command: "rm -rf /", model: "zzz" })]) {
      expect(evaluateJob(p, spec).result).toBe("allow");
    }
    expect(evaluateToolCall(p, "any", "thing").result).toBe("allow");
  });
});

describe("restricted jobs", () => {
  it("allows a matching job", () => {
    expect(evaluateJob(restricted(), job()).result).toBe("allow");
  });

  it("denies a repo not in repos and names it", () => {
    const d = evaluateJob(restricted(), job({ repo: "other/thing" }));
    expect(d.result).toBe("deny");
    expect(d.reason).toContain("other/thing");
  });

  it("returns ask instead of deny with onViolation ask", () => {
    expect(evaluateJob(restricted({ onViolation: "ask" }), job({ repo: "other/thing" })).result).toBe("ask");
    expect(evaluateToolCall(restricted({ onViolation: "ask" }), "a", "b").result).toBe("ask");
  });

  it("matches repos exactly on owner/name, case-insensitively, across URL forms", () => {
    const p = restricted({ repos: ["Owner/Name"] });
    expect(evaluateJob(p, job({ repo: "OWNER/name" })).result).toBe("allow");
    expect(evaluateJob(p, job({ repo: "https://github.com/Owner/Name.git" })).result).toBe("allow");
    expect(evaluateJob(restricted(), job({ repo: "https://github.com/Owner/Name.git" })).result).toBe("allow");
    expect(evaluateJob(p, job({ repo: "owner/name2" })).result).toBe("deny");
    expect(evaluateJob(p, job({ repo: "owner2/name" })).result).toBe("deny");
    expect(evaluateJob(p, job({ repo: "xowner/name" })).result).toBe("deny");
    expect(evaluateJob(p, job({ repo: "https://evil.com/owner/name" })).result).toBe("deny");
    expect(evaluateJob(p, job({ repo: "--upload-pack=x/y" })).result).toBe("deny");
  });

  it("denies a runner not listed", () => {
    const d = evaluateJob(restricted(), job({ runner: "grok" }));
    expect(d.result).toBe("deny");
    expect(d.reason).toContain("grok");
  });

  it("denies build-test unless explicitly listed", () => {
    const spec = job({ runner: "build-test", command: "make" });
    expect(evaluateJob(restricted(), spec).result).toBe("deny");
    expect(evaluateJob(restricted({ runners: ["build-test"] }), spec).result).toBe("allow");
  });

  it("models: unset allows any (or none); set requires a listed model", () => {
    expect(evaluateJob(restricted(), job({ model: "anything" })).result).toBe("allow");
    expect(evaluateJob(restricted(), job()).result).toBe("allow");
    const p = restricted({ models: ["m1"] });
    expect(evaluateJob(p, job({ model: "m1" })).result).toBe("allow");
    expect(evaluateJob(p, job()).result).toBe("deny");
    expect(evaluateJob(p, job({ model: "M1" })).result).toBe("deny");
    expect(evaluateJob(p, job({ model: "m2" })).reason).toContain("m2");
    expect(evaluateJob(restricted({ models: [] }), job({ model: "m1" })).result).toBe("deny");
  });

  it("does not throw on a malformed spec", () => {
    expect(evaluateJob(restricted(), {} as JobSpec).result).toBe("deny");
    expect(evaluateJob(restricted(), null as unknown as JobSpec).result).toBe("deny");
    expect(evaluateJob(restricted(), job({ repo: 5 as unknown as string })).result).toBe("deny");
  });

  it("strips control characters and truncates values in reasons", () => {
    const d = evaluateJob(restricted(), job({ runner: "grok", repo: "owner/name" }));
    expect(d.reason).toContain("grok");
    const d2 = evaluateJob(restricted({ models: ["a"] }), job({ model: `x\u001b[31m\n\r\u0000${"y".repeat(500)}` }));
    expect(d2.result).toBe("deny");
    expect(d2.reason).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(d2.reason.length).toBeLessThan(220);
    expect(d2.reason).not.toContain("y".repeat(101));
    const d3 = evaluateJob(restricted(), job({ repo: `bad\nrepo\u0007${"z".repeat(300)}` }));
    expect(d3.reason).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(d3.reason).not.toContain("z".repeat(101));
  });
});

describe("restricted tool calls", () => {
  it("unset tools denies every call", () => {
    const d = evaluateToolCall(restricted(), "a", "b");
    expect(d.result).toBe("deny");
    expect(d.reason).toContain("a.b");
  });

  it("server.tool and server.* work; matching is exact and case-sensitive", () => {
    const p = restricted({ tools: ["a.b", "srv.*"] });
    expect(evaluateToolCall(p, "a", "b").result).toBe("allow");
    expect(evaluateToolCall(p, "srv", "anything").result).toBe("allow");
    expect(evaluateToolCall(p, "a", "bc").result).toBe("deny");
    expect(evaluateToolCall(p, "ab", "c").result).toBe("deny");
    expect(evaluateToolCall(p, "A", "b").result).toBe("deny");
    expect(evaluateToolCall(p, "a", "B").result).toBe("deny");
    expect(evaluateToolCall(p, "SRV", "x").result).toBe("deny");
    expect(evaluateToolCall(p, "a", "*").result).toBe("deny");
    expect(evaluateToolCall(restricted({ tools: [] }), "a", "b").result).toBe("deny");
  });

  it("rejects ambiguous dotted server names and non-strings", () => {
    const p = restricted({ tools: ["a.b.c"] });
    expect(evaluateToolCall(p, "a.b", "c").result).toBe("deny");
    expect(evaluateToolCall(p, undefined as unknown as string, "c").result).toBe("deny");
  });
});

describe("invalid policies", () => {
  const bad: unknown[] = [
    { mode: "trusted", extra: 1 },
    { mode: "root" },
    { mode: "restricted" },
    { mode: "restricted", repos: ["owner/name"], runners: ["codex"], onViolation: "allow" },
    { mode: "restricted", repos: ["--upload-pack=x/y"], runners: ["codex"], onViolation: "deny" },
    { mode: "restricted", repos: [], runners: ["bash"], onViolation: "deny" },
    { mode: "restricted", repos: [], runners: [], onViolation: "deny", extra: true },
    null,
    undefined,
    "trusted",
    42,
    [],
  ];
  it.each(bad.map((b) => [JSON.stringify(b) ?? "undefined", b]))("denies %s without throwing", (_n, p) => {
    expect(PolicySchema.safeParse(p).success).toBe(false);
    expect(evaluateJob(p as PolicyConfig, job()).result).toBe("deny");
    expect(evaluateToolCall(p as PolicyConfig, "a", "b").result).toBe("deny");
    expect(effectivePolicy(p as PolicyConfig)).toEqual(DENY_ALL);
  });

  it("DENY_ALL denies everything", () => {
    expect(evaluateJob(DENY_ALL, job()).result).toBe("deny");
    expect(evaluateToolCall(DENY_ALL, "a", "b").result).toBe("deny");
  });

  it("effectivePolicy(null) is DENY_ALL and valid policies pass through", () => {
    expect(effectivePolicy(null)).toEqual(DENY_ALL);
    expect(effectivePolicy({ mode: "trusted" })).toEqual({ mode: "trusted" });
    expect(effectivePolicy(restricted())).toEqual(restricted());
  });
});

describe("persistence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hoistline-policy-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("defaults under HOISTLINE_AGENT_HOME", () => {
    expect(defaultPolicyPath({ HOISTLINE_AGENT_HOME: "/x/y" })).toBe("/x/y/policy.json");
  });

  it("round-trips, with file mode 0600, directory 0700 and no temp files left", () => {
    const path = join(dir, "home", "policy.json");
    savePolicy(path, restricted({ tools: ["a.*"], models: ["m"] }));
    expect(loadPolicy(path)).toEqual(restricted({ tools: ["a.*"], models: ["m"] }));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "home")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dir, "home"))).toEqual(["policy.json"]);
    savePolicy(path, { mode: "trusted" });
    expect(loadPolicy(path)).toEqual({ mode: "trusted" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses to save an invalid policy", () => {
    expect(() => savePolicy(join(dir, "p.json"), { mode: "root" } as unknown as PolicyConfig)).toThrow();
  });

  it("missing file is null (and denies via effectivePolicy)", () => {
    const path = join(dir, "nope.json");
    expect(loadPolicy(path)).toBeNull();
    expect(loadEffectivePolicy(path)).toEqual(DENY_ALL);
  });

  it.each(["{not json", '{"mode":"trusted","extra":1}', '{"mode":"root"}', "null", ""])(
    "corrupt or invalid file %j throws PolicyFileError and yields DENY_ALL",
    (content) => {
      const path = join(dir, "policy.json");
      writeFileSync(path, content);
      expect(() => loadPolicy(path)).toThrow(PolicyFileError);
      expect(loadEffectivePolicy(path)).toEqual(DENY_ALL);
    },
  );

  it("an unreadable path (a directory) is a PolicyFileError, not null", () => {
    expect(() => loadPolicy(dir)).toThrow(PolicyFileError);
    expect(loadEffectivePolicy(dir)).toEqual(DENY_ALL);
  });
});

describe("runSetup", () => {
  it("trusted: prints the consequence exactly once, asks nothing more, never in evaluateJob", async () => {
    const { io, printed, questions } = scripted(["trusted"]);
    const policy = await runSetup(io);
    expect(policy).toEqual({ mode: "trusted" });
    expect(questions).toHaveLength(1);
    expect(count(printed, "arbitrary code with your privileges")).toBe(1);
    expect(printed.join(" ")).toContain("users the machine is shared with");
    expect(printed.join(" ")).toContain("any user signed in to this hub");

    // Evaluating never prints or asks anything.
    const before = printed.length;
    expect(evaluateJob(policy, job()).result).toBe("allow");
    expect(evaluateJob(policy, job()).reason).not.toContain("privileges");
    expect(printed).toHaveLength(before);
  });

  it("restricted: says there is no sandbox, warns about build-test, returns a validated policy", async () => {
    const { io, printed } = scripted([
      "Restricted",
      "https://github.com/Owner/Name.git, other/repo",
      "codex, build-test",
      "m1, m2",
      "srv.*, a.b",
      "ask",
    ]);
    const policy = await runSetup(io);
    expect(policy).toEqual({
      mode: "restricted",
      repos: ["owner/name", "other/repo"],
      runners: ["codex", "build-test"],
      models: ["m1", "m2"],
      tools: ["srv.*", "a.b"],
      onViolation: "ask",
    });
    const text = printed.join("\n");
    expect(text).toContain("does not sandbox what the runner does once started");
    expect(count(printed, "does not sandbox")).toBe(1);
    expect(count(printed, "build-test runner executes arbitrary")).toBe(1);
    expect(text).not.toContain("arbitrary code with your privileges");
  });

  it("restricted: blank models and tools stay unset, and no build-test warning without build-test", async () => {
    const { io, printed } = scripted(["restricted", "o/n", "grok", "", "", "deny"]);
    const policy = await runSetup(io);
    expect(policy).toEqual({ mode: "restricted", repos: ["o/n"], runners: ["grok"], onViolation: "deny" });
    expect("models" in policy).toBe(false);
    expect("tools" in policy).toBe(false);
    expect(printed.join("\n")).not.toContain("build-test runner");
  });

  it("re-asks on invalid repo, runner, tools and mode", async () => {
    const { io, printed } = scripted([
      "maybe",
      "restricted",
      "git@github.com:o/n",
      "o/n",
      "rm",
      "muse",
      "",
      "badtool",
      "a.b",
      "sometimes",
      "deny",
    ]);
    const policy = await runSetup(io);
    expect(policy).toEqual({ mode: "restricted", repos: ["o/n"], runners: ["muse"], tools: ["a.b"], onViolation: "deny" });
    expect(count(printed, "Invalid input")).toBe(5);
  });

  it("throws after 5 invalid answers", async () => {
    const { io, questions } = scripted(["x", "x", "x", "x", "x", "trusted"]);
    await expect(runSetup(io)).rejects.toThrow(/5 invalid answers/);
    expect(questions).toHaveLength(5);
  });
});

describe("fix round 1", () => {
  const ask = (over: Record<string, unknown> = {}) => restricted({ onViolation: "ask", ...over });

  it("structurally invalid input is a hard deny even with onViolation ask", () => {
    for (const repo of ["--upload-pack=x/y", "git@github.com:o/n", "http://github.com/o/n", "", "o/n/../x", "о/n"]) {
      expect(evaluateJob(ask(), job({ repo })).result, repo).toBe("deny");
    }
    expect(evaluateJob(ask(), job({ repo: 5 as unknown as string })).result).toBe("deny");
    expect(evaluateJob(ask(), job({ runner: "bash" as never })).result).toBe("deny");
    expect(evaluateJob(ask(), job({ model: 5 as unknown as string })).result).toBe("deny");
    expect(evaluateJob(ask(), null as unknown as JobSpec).result).toBe("deny");
    expect(evaluateJob(ask(), job({ repo: "--upload-pack=x/y" })).repo).toBeUndefined();
    const t = ask({ tools: ["a.b"] });
    expect(evaluateToolCall(t, "a.b", "c").result).toBe("deny");
    expect(evaluateToolCall(t, "", "c").result).toBe("deny");
    expect(evaluateToolCall(t, "a", "").result).toBe("deny");
    expect(evaluateToolCall(t, 1 as unknown as string, "c").result).toBe("deny");
    expect(evaluateToolCall(t, "a", null as unknown as string).result).toBe("deny");
    expect(evaluateToolCall(t, "a", "zz").result).toBe("ask");
  });

  it("lists every failing rule, including the build-test command, in ask mode", () => {
    const d = evaluateJob(ask(), job({ repo: "evil/x", runner: "build-test", command: "curl x|sh" }));
    expect(d.result).toBe("ask");
    expect(d.reason).toContain("repo rule failed");
    expect(d.reason).toContain("evil/x");
    expect(d.reason).toContain("runner rule failed");
    expect(d.reason).toContain("runs arbitrary command: ");
    expect(d.reason).toContain("curl x|sh");
    expect(d.repo).toBe("evil/x");
  });

  it("sanitizes and truncates the command line; listed build-test has no command line", () => {
    const d = evaluateJob(ask(), job({ runner: "build-test", command: `a\u001b[0m\n${"c".repeat(500)}` }));
    expect(d.reason).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(d.reason).not.toContain("c".repeat(101));
    const ok = evaluateJob(restricted({ runners: ["build-test"] }), job({ runner: "build-test", command: "make" }));
    expect(ok.result).toBe("allow");
    expect(ok.reason).not.toContain("arbitrary command");
  });

  it("reports a job failing only the model rule, and multiple failures together", () => {
    const d = evaluateJob(ask({ models: ["m1"] }), job({ model: "m2" }));
    expect(d.result).toBe("ask");
    expect(d.reason).toContain("model rule failed");
    expect(d.reason).not.toContain("repo rule failed");
    expect(d.reason).not.toContain("runner rule failed");
    const all = evaluateJob(ask({ models: ["m1"] }), job({ repo: "x/y", runner: "grok", model: "m2" }));
    for (const r of ["repo rule", "runner rule", "model rule"]) expect(all.reason).toContain(r);
  });

  it("Decision.repo carries the canonical repo on allow, ask and deny for a list miss", () => {
    const spec = job({ repo: "https://github.com/Owner/Name.git/" });
    expect(evaluateJob(restricted(), spec).repo).toBe("owner/name");
    expect(evaluateJob(restricted(), { ...spec, runner: "grok" }).repo).toBe("owner/name");
    expect(evaluateJob(ask(), job({ repo: "Other/Thing.GIT" })).repo).toBe("other/thing");
    expect(evaluateJob(restricted(), job({ repo: "Other/Thing" })).repo).toBe("other/thing");
  });

  it("a policy entry with .GIT matches the job without it", () => {
    expect(evaluateJob(restricted({ repos: ["O/N.GIT"] }), job({ repo: "o/n" })).result).toBe("allow");
  });

  it("strips additional invisible and bidi characters from reasons", () => {
    const junk = "؜᠎⁠⁡⁢⁣⁤⁪⁫⁬⁭⁮⁯";
    const d = evaluateJob(restricted(), job({ repo: `x${junk}y` }));
    expect(d.reason).toContain("xy");
    for (const ch of junk) expect(d.reason).not.toContain(ch);
  });

  it("a policy with a __proto__ key fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "hoistline-policy-"));
    try {
      const path = join(dir, "policy.json");
      writeFileSync(path, '{"__proto__":{"mode":"trusted"},"mode":"restricted","repos":[],"runners":[],"onViolation":"deny"}');
      expect(() => loadPolicy(path)).toThrow(PolicyFileError);
      expect(loadEffectivePolicy(path)).toEqual(DENY_ALL);
      writeFileSync(path, '{"__proto__":{"mode":"trusted"}}');
      expect(() => loadPolicy(path)).toThrow(PolicyFileError);
      expect(evaluateJob(JSON.parse('{"__proto__":{},"mode":"trusted"}'), job()).result).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trusted consequence mentions tool calls, keeps signatures, and prints once", async () => {
    const { io, printed } = scripted(["trusted"]);
    await runSetup(io);
    const text = printed.join(" ");
    expect(text).toContain("every direct-mode tool call");
    expect(text).not.toContain("Nothing will be checked");
    expect(text).toContain("signature");
    expect(printed).toHaveLength(1);
  });

  it("setup re-asks (no raw ZodError) when a list is over the limit", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `o/n${i}`).join(",");
    const { io, printed } = scripted(["restricted", many, "o/n", "grok", "", "", "deny"]);
    const policy = await runSetup(io);
    expect(policy).toMatchObject({ repos: ["o/n"] });
    expect(count(printed, "Invalid input")).toBe(1);
    const manyTools = Array.from({ length: 1001 }, (_, i) => `a.t${i}`).join(",");
    const s2 = scripted(["restricted", "o/n", "grok", "", manyTools, "a.b", "deny"]);
    expect(await runSetup(s2.io)).toMatchObject({ tools: ["a.b"] });
    const s3 = scripted(["restricted", many, many, many, many, many]);
    await expect(runSetup(s3.io)).rejects.toThrow(/invalid answers/);
  });
});

describe("fix round 2: never truncate what the owner approves", () => {
  const ask = (over: Record<string, unknown> = {}) => restricted({ onViolation: "ask", ...over });
  const bt = (command: string) => job({ runner: "build-test", command });
  const NOT_SHOWN = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb\\u{e0000}-\\u{e007f}]", "u");

  it("a normal short command is asked about, shown in full", () => {
    const d = evaluateJob(ask(), bt("curl x|sh"));
    expect(d.result).toBe("ask");
    expect(d.reason).toContain("curl x|sh");
  });

  it("a 500-char command is shown in full; 501 chars is a hard deny", () => {
    const cmd = `${"a".repeat(250)}${"b".repeat(250)}`;
    const d = evaluateJob(ask(), bt(cmd));
    expect(d.result).toBe("ask");
    expect(d.reason).toContain(cmd);
    const long = evaluateJob(ask(), bt(`${cmd}x`));
    expect(long.result).toBe("deny");
    expect(long.reason).toContain("command too long to review safely (501 chars)");
    expect(long.reason).not.toContain("a".repeat(101));
    expect(evaluateJob(restricted(), bt(`${cmd}x`)).result).toBe("deny");
  });

  it.each([
    ["newline", "make\nrm -rf /"],
    ["tab", "make\tx"],
    ["NUL", "make\u0000x"],
    ["RLO U+202E", "make ‮ gnp.exe"],
    ["zero-width U+200B", "ma​ke"],
    ["soft hyphen U+00AD", "ma­ke"],
    ["U+034F", "ma͏ke"],
    ["U+FFF9", "ma￹ke"],
    ["tag char U+E0041", "make\u{e0041}"],
  ])("a command with %s is a hard deny under ask", (_n, cmd) => {
    const d = evaluateJob(ask(), bt(cmd));
    expect(d.result).toBe("deny");
    expect(d.reason).toContain("command contains non-ASCII or control characters");
    expect(d.reason).not.toMatch(NOT_SHOWN);
    expect(d.repo).toBe("owner/name");
  });

  it("a listed build-test keeps allowing any command", () => {
    const p = ask({ runners: ["build-test"] });
    expect(evaluateJob(p, bt("a\nb")).result).toBe("allow");
    expect(evaluateJob(p, bt("x".repeat(600))).result).toBe("allow");
  });

  it("a non-string command is a hard deny", () => {
    expect(evaluateJob(ask(), { ...bt("x"), command: 5 as unknown as string }).result).toBe("deny");
  });

  it("repo shown in an ask reason is the full canonical value", () => {
    const repo = `${"A".repeat(39)}/${"B".repeat(100)}`;
    const d = evaluateJob(ask(), job({ repo: `https://github.com/${repo}.git` }));
    expect(d.result).toBe("ask");
    expect(d.reason).toContain(repo.toLowerCase());
    expect(d.reason).not.toContain("...");
  });

  it("a model that cannot be shown in full or safely is a hard deny, not ask", () => {
    const p = ask({ models: ["m1"] });
    expect(evaluateJob(p, job({ model: "m".repeat(100) })).result).toBe("ask");
    expect(evaluateJob(p, job({ model: "m".repeat(101) })).result).toBe("deny");
    expect(evaluateJob(p, job({ model: "m‮1" })).result).toBe("deny");
    expect(evaluateJob(p, job({ model: "m\n1" })).result).toBe("deny");
  });

  it("a tool name that cannot be shown in full or safely is a hard deny, not ask", () => {
    const p = ask({ tools: ["a.b"] });
    const s100 = "s".repeat(100);
    const d = evaluateToolCall(p, s100, "t".repeat(100));
    expect(d.result).toBe("ask");
    expect(d.reason).toContain(`${s100}.${"t".repeat(100)}`);
    expect(evaluateToolCall(p, "s".repeat(101), "t").result).toBe("deny");
    expect(evaluateToolCall(p, "s", "t".repeat(101)).result).toBe("deny");
    expect(evaluateToolCall(p, "s", "t‮").result).toBe("deny");
    expect(evaluateToolCall(p, "s\n", "t").result).toBe("deny");
    expect(evaluateToolCall(p, "s", "t\u{e0041}").result).toBe("deny");
  });

  it("strips U+00AD, U+034F, U+FFF9-U+FFFB and tag characters from reasons", () => {
    const junk = "­͏￹￺￻\u{e0000}\u{e0041}\u{e007f}";
    const d = evaluateJob(restricted(), job({ repo: `x${junk}y` }));
    expect(d.reason).toContain("xy");
    expect(d.reason).not.toMatch(NOT_SHOWN);
  });
});

describe("fix round 3: printable-ASCII allowlist for anything the owner may approve", () => {
  const ask = (over: Record<string, unknown> = {}) => restricted({ onViolation: "ask", ...over });
  const bt = (command: string) => job({ runner: "build-test", command });
  const SPOOFS: [string, string][] = [
    ["variation selector U+FE0F", "️"],
    ["variation selector supplement U+E0100", "\u{e0100}"],
    ["mongolian variation selector U+180B", "᠋"],
    ["hangul filler U+3164", "ㅤ"],
    ["hangul choseong filler U+115F", "ᅟ"],
    ["halfwidth hangul filler U+FFA0", "ﾠ"],
    ["braille blank U+2800", "⠀"],
    ["no-break space U+00A0", " "],
    ["en quad U+2000", " "],
    ["ideographic space U+3000", "　"],
    ["narrow no-break space U+202F", " "],
    ["combining mark", "é"],
    ["precomposed e-acute", "é"],
    ["Cyrillic homoglyph", "а"],
    ["emoji", "\u{1f600}"],
    ["lone surrogate", "\ud800"],
    ["DEL", "\x7f"],
    ["newline", "\n"],
  ];

  it.each(SPOOFS)("a command with %s is a hard deny under ask and deny, without echoing it", (_n, ch) => {
    for (const onViolation of ["ask", "deny"]) {
      const d = evaluateJob(restricted({ onViolation }), bt(`make${ch}test`));
      expect(d.result).toBe("deny");
      expect(d.reason).toContain("command contains non-ASCII or control characters");
      expect(d.reason).not.toContain(ch);
      expect(d.reason).not.toContain("make");
      expect(d.repo).toBe("owner/name");
    }
  });

  it.each(SPOOFS)("a model with %s is a hard deny under ask and deny, without echoing it", (_n, ch) => {
    for (const onViolation of ["ask", "deny"]) {
      const d = evaluateJob(restricted({ onViolation, models: ["m1"] }), job({ model: `m${ch}2` }));
      expect(d.result).toBe("deny");
      expect(d.reason).toContain("model contains non-ASCII or control characters");
      expect(d.reason).not.toContain(ch);
    }
  });

  it.each(SPOOFS)("an unlisted tool or server name with %s is a hard deny, without echoing it", (_n, ch) => {
    for (const onViolation of ["ask", "deny"]) {
      const p = restricted({ onViolation, tools: ["a.b"] });
      for (const [server, tool] of [
        ["s", `t${ch}x`],
        [`s${ch}x`, "t"],
      ] as const) {
        const d = evaluateToolCall(p, server, tool);
        expect(d.result).toBe("deny");
        expect(d.reason).toContain("tool or server name contains non-ASCII or control characters");
        expect(d.reason).not.toContain(ch);
      }
    }
  });

  it("a run of 8 spaces in a command is a hard deny; 7 spaces is still asked about in full", () => {
    const d8 = evaluateJob(ask(), bt(`echo ok${" ".repeat(8)}; rm -rf /`));
    expect(d8.result).toBe("deny");
    expect(d8.reason).toContain("command contains a long run of spaces");
    expect(d8.reason).not.toContain("rm -rf");
    expect(evaluateJob(restricted(), bt(`a${" ".repeat(20)}b`)).result).toBe("deny");
    const cmd = `echo ok${" ".repeat(7)}; rm -rf /`;
    const d7 = evaluateJob(ask(), bt(cmd));
    expect(d7.result).toBe("ask");
    expect(d7.reason).toContain(JSON.stringify(cmd));
    // Runs separated by other characters do not add up.
    expect(evaluateJob(ask(), bt(`a${" ".repeat(7)}b${" ".repeat(7)}c`)).result).toBe("ask");
  });

  it("a printable-ASCII command with quotes, backslashes, pipes, semicolons and $() is asked about, JSON-quoted", () => {
    const cmd = `echo "a" 'b' \\ | cat; $(id) \`x\` && ls`;
    const d = evaluateJob(ask(), bt(cmd));
    expect(d.result).toBe("ask");
    expect(d.reason).toContain(`runs arbitrary command: ${JSON.stringify(cmd)}`);
    const all = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
    expect(evaluateJob(ask(), bt(all)).reason).toContain(JSON.stringify(all));
  });

  it("an empty command and printable-ASCII model and tool names are still asked about", () => {
    expect(evaluateJob(ask(), bt("")).result).toBe("ask");
    expect(evaluateJob(ask({ models: ["m1"] }), job({ model: "gpt 5/x~" })).result).toBe("ask");
    expect(evaluateToolCall(ask({ tools: ["a.b"] }), "srv-1", "do_it!").result).toBe("ask");
  });

  it("a listed build-test still allows a non-ASCII command; trusted mode is unchanged", () => {
    const p = ask({ runners: ["build-test"] });
    expect(evaluateJob(p, bt("makeㅤé\u{1f600}")).result).toBe("allow");
    expect(evaluateJob(p, bt(`a${" ".repeat(20)}b`)).result).toBe("allow");
    expect(evaluateJob({ mode: "trusted" }, bt("makeㅤ")).result).toBe("allow");
    expect(evaluateToolCall({ mode: "trusted" }, "sㅤ", "t").result).toBe("allow");
  });

  it("a listed model or tool entry still allows (owner chose it); entries still reject whitespace and a missing dot", () => {
    // The schema forbids whitespace (incl. Unicode spaces) and requires server.tool, but does not forbid other
    // non-ASCII, so an owner can list such a name on purpose. Only unlisted values are subject to the allowlist.
    const p = ask({ models: ["mé"], tools: ["sé.t", "xㅤ.*"] });
    expect(evaluateJob(p, job({ model: "mé" })).result).toBe("allow");
    expect(evaluateToolCall(p, "sé", "t").result).toBe("allow");
    expect(evaluateToolCall(p, "xㅤ", "anything").result).toBe("allow");
    expect(evaluateToolCall(p, "sé", "other").result).toBe("deny");
    for (const tools of [["a b.c"], ["a　b.c"], ["a b.c"], ["nodot"]]) {
      expect(PolicySchema.safeParse({ ...ask(), tools }).success, JSON.stringify(tools)).toBe(false);
    }
  });

  it("the 500-char command and 100-char model/tool limits are unchanged", () => {
    expect(evaluateJob(ask(), bt("a".repeat(500))).result).toBe("ask");
    expect(evaluateJob(ask(), bt("a".repeat(501))).result).toBe("deny");
    expect(evaluateJob(ask({ models: ["m1"] }), job({ model: "m".repeat(100) })).result).toBe("ask");
    expect(evaluateJob(ask({ models: ["m1"] }), job({ model: "m".repeat(101) })).result).toBe("deny");
  });
});
