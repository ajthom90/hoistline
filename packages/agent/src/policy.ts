import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RunnerName, type JobSpec } from "@hoistline/protocol";
import { z } from "zod";
import { agentHome, writePrivateFile } from "./identity.js";
import { canonicalRepo } from "./repo.js";

/** `server.tool` or `server.*`; the server part has no dot. */
export const TOOL_ENTRY = /^[^.\s]+\.\S+$/;
export const MAX_LIST_ENTRIES = 1000;
export const MAX_MODEL_LENGTH = 100;
export const MAX_TOOL_ENTRY_LENGTH = 300;

const RestrictedSchema = z
  .object({
    mode: z.literal("restricted"),
    repos: z
      .array(z.string().refine((r) => canonicalRepo(r) !== null, "invalid repository"))
      .max(MAX_LIST_ENTRIES),
    runners: z.array(RunnerName).max(20),
    models: z.array(z.string().min(1).max(MAX_MODEL_LENGTH)).max(MAX_LIST_ENTRIES).optional(),
    tools: z.array(z.string().max(MAX_TOOL_ENTRY_LENGTH).regex(TOOL_ENTRY)).max(MAX_LIST_ENTRIES).optional(),
    onViolation: z.enum(["deny", "ask"]),
  })
  .strict();

/** Strict schema for a policy; anything else (unknown keys, unknown modes) is invalid. */
export const PolicySchema = z.union([z.object({ mode: z.literal("trusted") }).strict(), RestrictedSchema]);

export type PolicyConfig =
  | { mode: "trusted" }
  | {
      mode: "restricted";
      repos: string[];
      runners: RunnerName[];
      models?: string[];
      tools?: string[];
      onViolation: "deny" | "ask";
    };

export interface Decision {
  result: "allow" | "deny" | "ask";
  reason: string;
  /**
   * The canonical `owner/name` of the job's repo, set whenever the repo was well-formed (allow, ask, and deny for
   * a list miss). Callers must clone this value and never the raw `spec.repo`. Absent when the repo is malformed.
   */
  repo?: string;
}

/** What an absent, unreadable or invalid policy means: nothing is allowed. */
export const DENY_ALL: PolicyConfig = { mode: "restricted", repos: [], runners: [], onViolation: "deny" };

/** Missing policy (null) or an invalid one means DENY_ALL, never trusted. Never throws. */
export function effectivePolicy(loaded: PolicyConfig | null): PolicyConfig {
  const parsed = PolicySchema.safeParse(loaded);
  return parsed.success ? (parsed.data as PolicyConfig) : DENY_ALL;
}

// Control chars, C1, invisible/zero-width/bidi marks, line/paragraph separators, BOM. Built from escaped text on purpose.
const UNSAFE_CHARS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff]",
  "g",
);

/** Renders an untrusted value for a reason string: control characters stripped, truncated to 100 chars. */
function show(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = "[unprintable]";
  }
  text = text.replace(UNSAFE_CHARS, "");
  return JSON.stringify(text.length > 100 ? `${text.slice(0, 100)}...` : text);
}

const ALLOW_TRUSTED: Decision = { result: "allow", reason: "trusted mode" };

function violation(policy: Extract<PolicyConfig, { mode: "restricted" }>, reason: string): Decision {
  return { result: policy.onViolation, reason };
}

const DENIED_INVALID: Decision = { result: "deny", reason: "policy is invalid or not configured; denying" };

/** Decides whether a (signature-verified) job may run. Never throws; an invalid policy denies. */
export function evaluateJob(policy: PolicyConfig, spec: JobSpec): Decision {
  try {
    const parsed = PolicySchema.safeParse(policy);
    if (!parsed.success) return DENIED_INVALID;
    const p = parsed.data as PolicyConfig;
    if (p.mode === "trusted") return ALLOW_TRUSTED;

    // Structurally invalid input (malformed repo, unknown runner, non-string model) is a hard deny regardless of
    // onViolation: an argument-injection-shaped value cannot be approved safely, so it is never offered for approval.
    const repo = typeof spec?.repo === "string" ? canonicalRepo(spec.repo) : null;
    if (repo === null) return { result: "deny", reason: `repo rule failed: ${show(spec?.repo)} is not a valid GitHub repository` };
    if (!RunnerName.safeParse(spec.runner).success) {
      return { result: "deny", reason: `runner rule failed: ${show(spec.runner)} is not a known runner`, repo };
    }
    if (spec.model !== undefined && typeof spec.model !== "string") {
      return { result: "deny", reason: `model rule failed: ${show(spec.model)} is not a string`, repo };
    }

    // Evaluate every rule so an owner asked to approve sees all of the reasons, not only the first.
    const failures: string[] = [];
    if (!p.repos.some((r) => canonicalRepo(r) === repo)) {
      failures.push(`repo rule failed: ${show(spec.repo)} is not in the allowed repos`);
    }
    if (!(p.runners as unknown[]).includes(spec.runner)) {
      failures.push(`runner rule failed: ${show(spec.runner)} is not in the allowed runners`);
      if (spec.runner === "build-test") {
        failures.push(`runs arbitrary command: ${show(spec.command ?? "(none)")}`);
      }
    }
    if (p.models !== undefined) {
      if (spec.model === undefined) failures.push("model rule failed: a model is required but none was given");
      else if (!p.models.includes(spec.model)) failures.push(`model rule failed: ${show(spec.model)} is not in the allowed models`);
    }
    if (failures.length > 0) return { result: p.onViolation, reason: failures.join("; "), repo };
    return { result: "allow", reason: "job matches the allowed repos, runners and models", repo };
  } catch {
    return DENIED_INVALID;
  }
}

/** Decides whether a direct-mode tool call may run. Restricted mode needs `tools` to list it. Never throws. */
export function evaluateToolCall(policy: PolicyConfig, server: string, tool: string): Decision {
  try {
    const parsed = PolicySchema.safeParse(policy);
    if (!parsed.success) return DENIED_INVALID;
    const p = parsed.data as PolicyConfig;
    if (p.mode === "trusted") return ALLOW_TRUSTED;

    if (typeof server !== "string" || typeof tool !== "string" || server === "" || tool === "" || server.includes(".")) {
      // Hard deny, never `ask`: malformed or ambiguous names cannot be approved safely.
      return { result: "deny", reason: `tool rule failed: ${show(`${server}.${tool}`)} is not a valid server and tool name` };
    }
    const name = `${server}.${tool}`;
    if (p.tools === undefined) return violation(p, `tool rule failed: ${show(name)} denied because no tools are allowed`);
    if (p.tools.includes(name) || p.tools.includes(`${server}.*`)) {
      return { result: "allow", reason: "tool is in the allowed tools" };
    }
    return violation(p, `tool rule failed: ${show(name)} is not in the allowed tools`);
  } catch {
    return DENIED_INVALID;
  }
}

export class PolicyFileError extends Error {
  constructor(path: string, cause: unknown) {
    super(`policy file ${path} is unreadable or invalid`, { cause });
    this.name = "PolicyFileError";
  }
}

/** `$HOISTLINE_AGENT_HOME/policy.json`, defaulting to `~/.hoistline/policy.json`. */
export function defaultPolicyPath(env: Record<string, string | undefined> = process.env): string {
  return join(agentHome(env), "policy.json");
}

/** Writes the policy as JSON (mode 0600, directory 0700). Throws if the policy is invalid. */
export function savePolicy(path: string, policy: PolicyConfig): void {
  const parsed = PolicySchema.parse(policy);
  writePrivateFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

/**
 * Returns null when the file does not exist (callers must treat that as "not configured": use
 * effectivePolicy, which denies everything). Throws PolicyFileError when it exists but cannot be read or is invalid.
 */
export function loadPolicy(path: string): PolicyConfig | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PolicyFileError(path, err);
  }
  try {
    return PolicySchema.parse(JSON.parse(text)) as PolicyConfig;
  } catch (err) {
    throw new PolicyFileError(path, err);
  }
}

/** loadPolicy plus effectivePolicy: missing, corrupt or invalid files all give DENY_ALL. Never throws. */
export function loadEffectivePolicy(path: string): PolicyConfig {
  try {
    return effectivePolicy(loadPolicy(path));
  } catch {
    return DENY_ALL;
  }
}
