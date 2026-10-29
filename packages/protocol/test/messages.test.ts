import { describe, expect, it } from "vitest";
import { AgentToHub, HubToAgent } from "../src";

const signedJob = {
  spec: { jobId: "j", runner: "grok", repo: "o/r", baseBranch: "main", prompt: "p" },
  userId: "u",
  issuedAt: 1,
  signature: "sig",
};

const hubToAgent: unknown[] = [
  { type: "job.assign", job: signedJob },
  { type: "job.cancel", jobId: "j" },
  { type: "tools.list", callId: "c1" },
  { type: "tools.call", callId: "c1", server: "s", tool: "t", args: { a: 1 } },
];
const agentToHub: unknown[] = [
  {
    type: "hello",
    machineId: "m",
    agentVersion: "0.1.0",
    runners: ["muse", "build-test"],
    runningJobs: ["j"],
    servers: ["s"],
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
  it("rejects unknown type, unknown keys, agent-side types and bad specs", () => {
    expect(HubToAgent.safeParse({ type: "nope" }).success).toBe(false);
    expect(HubToAgent.safeParse({ type: "job.cancel", jobId: "j", x: 1 }).success).toBe(false);
    expect(HubToAgent.safeParse(agentToHub[0]).success).toBe(false);
    const badSpec = { ...signedJob, spec: { ...signedJob.spec, repo: "" } };
    expect(HubToAgent.safeParse({ type: "job.assign", job: badSpec }).success).toBe(false);
  });
});

describe("AgentToHub", () => {
  it.each(agentToHub)("round-trips %j", (m) => {
    expect(AgentToHub.parse(m)).toEqual(m);
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
    expect(AgentToHub.safeParse(hubToAgent[0]).success).toBe(false);
  });
});
