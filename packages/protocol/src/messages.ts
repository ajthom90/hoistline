import { z } from "zod";
import { RunnerName, SignedJobSchema } from "./signing.js";

const id = z.string().min(1).max(200);

/**
 * Messages sent from the hub to an agent.
 * - job.assign: run a signed job (the agent must verifyJob before acting)
 * - job.cancel: cancel a running job
 * - tools.list: request the agent's MCP tool inventory (answered by AgentToHub tools.list)
 * - tools.call: invoke an MCP tool on the agent (answered by AgentToHub tools.result)
 */
export const HubToAgent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("job.assign"), job: SignedJobSchema }).strict(),
  z.object({ type: z.literal("job.cancel"), jobId: id }).strict(),
  z.object({ type: z.literal("tools.list"), callId: id }).strict(),
  z
    .object({
      type: z.literal("tools.call"),
      callId: id,
      server: z.string().min(1).max(200),
      tool: z.string().min(1).max(200),
      args: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);
export type HubToAgent = z.infer<typeof HubToAgent>;

const ToolInfo = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Messages sent from an agent to the hub.
 * - hello: agent announces itself and its state
 * - job.event: streamed output or status line for a job
 * - job.result: terminal outcome of a job
 * - tools.list: response to HubToAgent tools.list
 * - tools.result: response to HubToAgent tools.call
 */
export const AgentToHub = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      machineId: id,
      agentVersion: z.string().min(1).max(100),
      runners: z.array(RunnerName),
      runningJobs: z.array(id),
      servers: z.array(z.string().max(200)),
    })
    .strict(),
  z
    .object({
      type: z.literal("job.event"),
      jobId: id,
      stream: z.enum(["stdout", "stderr", "status"]),
      data: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("job.result"),
      jobId: id,
      status: z.enum(["succeeded", "failed", "cancelled"]),
      exitCode: z.number().int().optional(),
      reason: z.string().optional(),
      branch: z.string().optional(),
      output: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tools.list"),
      callId: id,
      servers: z.array(z.object({ name: z.string().max(200), tools: z.array(ToolInfo) }).strict()),
    })
    .strict(),
  z
    .object({
      type: z.literal("tools.result"),
      callId: id,
      ok: z.boolean(),
      result: z.unknown().optional(),
      error: z.string().optional(),
    })
    .strict(),
]);
export type AgentToHub = z.infer<typeof AgentToHub>;
