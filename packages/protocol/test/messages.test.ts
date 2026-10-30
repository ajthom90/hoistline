import { describe, expect, it } from "vitest";
import { AgentToHub, HubToAgent } from "../src";

const signedJob = {
  machineId: "m",
  spec: { jobId: "j", runner: "grok", repo: "o/r", baseBranch: "main", prompt: "p" },
  userId: "u",
  issuedAt: 1,
  signature: "sig",
};

const hubToAgent: unknown[] = [
  { type: "job.assign", job: signedJob },
  { type: "job.cancel", jobId: "j" },
  { type: "tools.list", callId: "c1" },
  { type: "tools.call", callId: "c1", userId: "u", server: "s", tool: "t", args: { a: 1 } },
  { type: "challenge", nonce: "bm9uY2U" },
  { type: "welcome" },
];
const agentToHub: unknown[] = [
  {
    type: "hello",
    machineId: "m",
    agentVersion: "0.1.0",
    runners: ["muse", "build-test"],
    runningJobs: ["j"],
    servers: ["s"],
    signature: "c2ln",
  },
  { type: "job.event", jobId: "j", stream: "stdout", data: "hi" },
  { type: "job.event", jobId: "j", stream: "status", data: "running" },
  { type: "job.result", jobId: "j", status: "succeeded" },
  {
    type: "job.result",
    jobId: "j",
    status: "failed",
    exitCode: 1,
    reason: "r",
    branch: "b",
    output: "o",
  },
  { type: "job.result", jobId: "j", status: "cancelled" },
  { type: "tools.list", callId: "c1", servers: [{ name: "s", tools: [{ name: "t" }] }] },
  { type: "tools.result", callId: "c1", ok: true, result: { x: 1 } },
  { type: "tools.result", callId: "c1", ok: false, error: "boom" },
];

describe("HubToAgent", () => {
  it.each(hubToAgent)("round-trips %j", (m) => {
    expect(HubToAgent.parse(m)).toEqual(m);
  });
  it("requires userId on tools.call", () => {
    const noUser = { ...(hubToAgent[3] as Record<string, unknown>) };
    delete noUser.userId;
    expect(HubToAgent.safeParse(noUser).success).toBe(false);
  });
  it("rejects unknown type, unknown keys, agent-side types and bad specs", () => {
    expect(HubToAgent.safeParse({ type: "nope" }).success).toBe(false);
    expect(HubToAgent.safeParse({ type: "job.cancel", jobId: "j", x: 1 }).success).toBe(false);
    expect(HubToAgent.safeParse({ type: "welcome", x: 1 }).success).toBe(false);
    expect(HubToAgent.safeParse({ type: "challenge" }).success).toBe(false);
    expect(HubToAgent.safeParse(agentToHub[0]).success).toBe(false);
    const badSpec = { ...signedJob, spec: { ...signedJob.spec, repo: "" } };
    expect(HubToAgent.safeParse({ type: "job.assign", job: badSpec }).success).toBe(false);
  });
});

describe("AgentToHub", () => {
  it.each(agentToHub)("round-trips %j", (m) => {
    expect(AgentToHub.parse(m)).toEqual(m);
  });
  it("rejects oversized fields", () => {
    const big = (n: number) => "x".repeat(n + 1);
    const bad: unknown[] = [
      { type: "job.event", jobId: "j", stream: "stdout", data: big(65_536) },
      { type: "job.result", jobId: "j", status: "failed", output: big(1_048_576) },
      { type: "job.result", jobId: "j", status: "failed", reason: big(2000) },
      { type: "job.result", jobId: "j", status: "failed", branch: big(255) },
      { type: "tools.result", callId: "c", ok: false, error: big(10_000) },
      {
        type: "tools.list",
        callId: "c",
        servers: Array.from({ length: 51 }, () => ({ name: "s", tools: [] })),
      },
      {
        type: "tools.list",
        callId: "c",
        servers: [{ name: "s", tools: Array.from({ length: 501 }, () => ({ name: "t" })) }],
      },
      { type: "tools.list", callId: "c", servers: [{ name: "s", tools: [{ name: big(200) }] }] },
      {
        type: "tools.list",
        callId: "c",
        servers: [{ name: "s", tools: [{ name: "t", description: big(2000) }] }],
      },
    ];
    for (const m of bad) expect(AgentToHub.safeParse(m).success).toBe(false);
  });
  it("tools.result is exclusive on ok", () => {
    const both = { type: "tools.result", callId: "c", ok: true, result: 1, error: "e" };
    expect(AgentToHub.safeParse(both).success).toBe(false);
    const bothFalse = { type: "tools.result", callId: "c", ok: false, result: 1, error: "e" };
    expect(AgentToHub.safeParse(bothFalse).success).toBe(false);
    expect(AgentToHub.safeParse({ type: "tools.result", callId: "c", ok: false }).success).toBe(
      false,
    );
  });
  it("rejects unknown type, unknown keys, bad enums", () => {
    expect(AgentToHub.safeParse({ type: "nope" }).success).toBe(false);
    const badStream = { type: "job.event", jobId: "j", stream: "other", data: "" };
    expect(AgentToHub.safeParse(badStream).success).toBe(false);
    expect(AgentToHub.safeParse({ type: "job.result", jobId: "j", status: "weird" }).success).toBe(
      false,
    );
    const hello = agentToHub[0] as object;
    expect(AgentToHub.safeParse({ ...hello, extra: 1 }).success).toBe(false);
    expect(AgentToHub.safeParse({ ...hello, runners: ["bogus"] }).success).toBe(false);
    const unsigned: Record<string, unknown> = { ...hello };
    delete unsigned.signature;
    expect(AgentToHub.safeParse(unsigned).success).toBe(false);
    expect(AgentToHub.safeParse(hubToAgent[0]).success).toBe(false);
  });
});

describe("job lifecycle additions", () => {
  it("has a strict job.ack from the hub", () => {
    expect(HubToAgent.parse({ type: "job.ack", jobId: "j" })).toEqual({ type: "job.ack", jobId: "j" });
    expect(HubToAgent.safeParse({ type: "job.ack", jobId: "j", x: 1 }).success).toBe(false);
    expect(HubToAgent.safeParse({ type: "job.ack" }).success).toBe(false);
  });
  it("lets job.result carry a truncated flag", () => {
    const msg = { type: "job.result", jobId: "j", status: "succeeded", truncated: true };
    expect(AgentToHub.parse(msg)).toEqual(msg);
    expect(AgentToHub.safeParse({ ...msg, truncated: "yes" }).success).toBe(false);
  });
  it("accepts an optional hello.os of up to 64 printable ASCII characters", () => {
    const hello = agentToHub[0] as Record<string, unknown>;
    expect(hello.os).toBeUndefined();
    expect(AgentToHub.safeParse(hello).success).toBe(true);
    expect(AgentToHub.parse({ ...hello, os: "darwin-arm64" })).toMatchObject({ os: "darwin-arm64" });
    expect(AgentToHub.safeParse({ ...hello, os: "x".repeat(64) }).success).toBe(true);
    for (const os of ["", "x".repeat(65), "linux\nx64", "linux\u0000", "lïnux", "linux\u007f", 7]) {
      expect(AgentToHub.safeParse({ ...hello, os }).success, JSON.stringify(os)).toBe(false);
    }
  });
  it("caps hello.runningJobs at 1000", () => {
    const hello = agentToHub[0] as Record<string, unknown>;
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `j${i}`);
    expect(AgentToHub.safeParse({ ...hello, runningJobs: ids(1000) }).success).toBe(true);
    expect(AgentToHub.safeParse({ ...hello, runningJobs: ids(1001) }).success).toBe(false);
  });
});

describe("job.assign with a NUL in the spec", () => {
  it.each(["jobId", "repo", "baseBranch", "prompt", "model", "command"])("is rejected for %s", (field) => {
    const clean = { ...signedJob.spec, model: "m", command: "c" };
    expect(HubToAgent.safeParse({ type: "job.assign", job: { ...signedJob, spec: clean } }).success).toBe(true);
    const spec = { ...clean, [field]: "a\0b" };
    expect(HubToAgent.safeParse({ type: "job.assign", job: { ...signedJob, spec } }).success).toBe(false);
  });
});
