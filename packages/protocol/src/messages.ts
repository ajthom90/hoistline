import { z } from "zod";
import { RunnerName, SignedJobSchema } from "./signing.js";

const id = z.string().min(1).max(200);

/**
 * Messages sent from the hub to an agent.
 * - job.assign: run a signed job (the agent must verifyJob before acting)
 * - job.cancel: cancel a running job
 * - job.ack: the hub has recorded the job.result for this job; the agent may forget it (see the agent outbox)
 * - tools.list: request the agent's MCP tool inventory (answered by AgentToHub tools.list)
 * - tools.call: invoke an MCP tool on the agent (answered by AgentToHub tools.result)
 * - challenge: first message on a new connection; the agent answers with a signed hello
 *   (see agentAuthPayload)
 * - welcome: the hub accepted the hello; the connection is authenticated
 *
 * Trust model: tools.call carries the userId so the agent can apply per-user policy, but it is
 * not separately signed. The connection is machine-authenticated and the hub is the signer anyway.
 */
export const HubToAgent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("job.assign"), job: SignedJobSchema }).strict(),
  z.object({ type: z.literal("job.cancel"), jobId: id }).strict(),
  z.object({ type: z.literal("job.ack"), jobId: id }).strict(),
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
  z.object({ type: z.literal("challenge"), nonce: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("welcome") }).strict(),
]);
export type HubToAgent = z.infer<typeof HubToAgent>;

/** Exact bytes an agent signs with its machine key to answer a hub challenge. */
export function agentAuthPayload(machineId: string, nonce: string): Buffer {
  return Buffer.from(`hoistline-agent-auth-v1:${machineId}:${nonce}`, "utf8");
}

const ToolInfo = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Messages sent from an agent to the hub.
 * - hello: agent announces itself and its state, proving its machine key by signing the
 *   hub's challenge nonce (signature over agentAuthPayload, Ed25519, base64url)
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
      runningJobs: z.array(id).max(1000),
      servers: z.array(z.string().max(200)),
      signature: z.string().min(1).max(200),
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
      /** True when `output` is not the job's whole output. */
      truncated: z.boolean().optional(),
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
