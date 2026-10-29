import { z } from "zod";
import { RunnerName, SignedJobSchema } from "./signing.js";

const id = z.string().min(1).max(200);

/**
 * Messages sent from the hub to an agent.
 * - job.assign: run a signed job (the agent must verifyJob before acting)
 * - job.cancel: cancel a running job
 * - tools.list: request the agent's MCP tool inventory (answered by AgentToHub tools.list)
 * - tools.call: invoke an MCP tool on the agent (answered by AgentToHub tools.result)
 *
 * Trust model: tools.call carries the userId so the agent can apply per-user policy, but it is
 * not separately signed. The connection is machine-authenticated and the hub is the signer anyway.
 */
export const HubToAgent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("job.assign"), job: SignedJobSchema }).strict(),
  z.object({ type: z.literal("job.cancel"), jobId: id }).strict(),
  z.object({ type: z.literal("tools.list"), callId: id }).strict(),
  z
    .object({
      type: z.literal("tools.call"),
      callId: id,
      userId: z.string().min(1).max(100),
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
    description: z.string().max(2000).optional(),
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
 *
 * Size bounds: string and array fields are capped here; the WebSocket maxPayload is the bound
 * for the unvalidated `result` and `inputSchema` values.
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
      data: z.string().max(65_536),
    })
    .strict(),
  z
    .object({
      type: z.literal("job.result"),
      jobId: id,
      status: z.enum(["succeeded", "failed", "cancelled"]),
      exitCode: z.number().int().optional(),
      reason: z.string().max(2000).optional(),
      branch: z.string().max(255).optional(),
      output: z.string().max(1_048_576).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tools.list"),
      callId: id,
      servers: z
        .array(
          z
            .object({ name: z.string().max(200), tools: z.array(ToolInfo).max(500) })
            .strict(),
        )
        .max(50),
    })
    .strict(),
  z.discriminatedUnion("ok", [
    z
      .object({ type: z.literal("tools.result"), callId: id, ok: z.literal(true), result: z.unknown() })
      .strict(),
    z
      .object({
        type: z.literal("tools.result"),
        callId: id,
        ok: z.literal(false),
        error: z.string().max(10_000),
      })
      .strict(),
  ]),
]);
export type AgentToHub = z.infer<typeof AgentToHub>;
