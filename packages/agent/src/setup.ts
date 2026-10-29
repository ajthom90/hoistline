import { RunnerName } from "@hoistline/protocol";
import { MAX_LIST_ENTRIES, MAX_MODEL_LENGTH, MAX_TOOL_ENTRY_LENGTH, PolicySchema, TOOL_ENTRY, type PolicyConfig } from "./policy.js";
import { canonicalRepo } from "./repo.js";

export interface SetupIO {
  ask(question: string): Promise<string>;
  print(text: string): void;
}

const MAX_ATTEMPTS = 5;

export const TRUSTED_CONSEQUENCE =
  "Trusted mode: every job the hub sends for any user signed in to this hub with access to this machine " +
  "(including users the machine is shared with) can run arbitrary code with your privileges on this computer. " +
  "Also, every direct-mode tool call is allowed. Job signatures from the hub are still verified, but no repo, " +
  "runner, model or tool allowlist is applied, and you will not be asked again. Your choice is honored from now on.";

export const RESTRICTED_NOTICE =
  "Restricted mode: this checks which repo, runner, model and tool a job uses; it does not sandbox what the " +
  "runner does once started. A runner you allow can still do anything your account can do.";

export const BUILD_TEST_WARNING =
  "Warning: the build-test runner executes arbitrary shell commands supplied in the job. Anyone who can send " +
  "jobs to this machine can run any command as you while build-test is allowed.";

type Parsed<T> = { value: T } | { error: string };

async function askValid<T>(io: SetupIO, question: string, parse: (answer: string) => Parsed<T>): Promise<T> {
  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = await io.ask(question);
    const result = parse(typeof answer === "string" ? answer.trim() : "");
    if ("value" in result) return result.value;
    lastError = result.error;
    io.print(`Invalid input: ${result.error}`);
  }
  throw new Error(`setup aborted after ${MAX_ATTEMPTS} invalid answers: ${lastError}`);
}

function splitList(answer: string): string[] {
  return answer
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Interactive policy setup. Returns the chosen policy; the caller saves it. */
export async function runSetup(io: SetupIO): Promise<PolicyConfig> {
  const mode = await askValid<"trusted" | "restricted">(io, "Mode (trusted or restricted)?", (a) => {
    const m = a.toLowerCase();
    return m === "trusted" || m === "restricted" ? { value: m } : { error: 'answer "trusted" or "restricted"' };
  });

  if (mode === "trusted") {
    io.print(TRUSTED_CONSEQUENCE);
    return { mode: "trusted" };
  }

  io.print(RESTRICTED_NOTICE);

  const repos = await askValid<string[]>(
    io,
    "Allowed repositories (comma-separated, owner/name or https://github.com/owner/name)?",
    (a) => {
      const items = splitList(a);
      if (items.length > MAX_LIST_ENTRIES) return { error: `at most ${MAX_LIST_ENTRIES} entries are allowed` };
      if (items.length === 0) return { error: "at least one repository is required" };
      const out: string[] = [];
      for (const item of items) {
        const c = canonicalRepo(item);
        if (c === null) return { error: `not a valid GitHub repository: ${JSON.stringify(item.slice(0, 100))}` };
        if (!out.includes(c)) out.push(c);
      }
      return { value: out };
    },
  );

  const names = RunnerName.options.join(", ");
  const runners = await askValid<RunnerName[]>(io, `Allowed runners (comma-separated from: ${names})?`, (a) => {
    const items = splitList(a);
    if (items.length === 0) return { error: "at least one runner is required" };
    const out: RunnerName[] = [];
    for (const item of items) {
      const r = RunnerName.safeParse(item);
      if (!r.success) return { error: `unknown runner ${JSON.stringify(item.slice(0, 100))}; choose from: ${names}` };
      if (!out.includes(r.data)) out.push(r.data);
    }
    return { value: out };
  });
  if (runners.includes("build-test")) io.print(BUILD_TEST_WARNING);

  const models = await askValid<string[] | undefined>(
    io,
    "Allowed models (comma-separated; leave blank to allow any model)?",
    (a) => {
      const items = splitList(a);
      if (items.length > MAX_LIST_ENTRIES) return { error: `at most ${MAX_LIST_ENTRIES} entries are allowed` };
      if (items.length === 0) return { value: undefined };
      return items.every((i) => i.length <= MAX_MODEL_LENGTH)
        ? { value: items }
        : { error: `model names must be ${MAX_MODEL_LENGTH} characters or fewer` };
    },
  );

  const tools = await askValid<string[] | undefined>(
    io,
    "Allowed direct-mode tools (comma-separated server.tool or server.*; leave blank to deny all tool calls)?",
    (a) => {
      const items = splitList(a);
      if (items.length > MAX_LIST_ENTRIES) return { error: `at most ${MAX_LIST_ENTRIES} entries are allowed` };
      if (items.length === 0) return { value: undefined };
      const bad = items.find((i) => i.length > MAX_TOOL_ENTRY_LENGTH || !TOOL_ENTRY.test(i));
      return bad === undefined
        ? { value: items }
        : { error: `use server.tool or server.*: ${JSON.stringify(bad.slice(0, 100))}` };
    },
  );

  const onViolation = await askValid<"deny" | "ask">(io, "When a job or tool call is not allowed: deny or ask?", (a) => {
    const v = a.toLowerCase();
    return v === "deny" || v === "ask" ? { value: v } : { error: 'answer "deny" or "ask"' };
  });

  const policy: Record<string, unknown> = { mode: "restricted", repos, runners, onViolation };
  if (models !== undefined) policy.models = models;
  if (tools !== undefined) policy.tools = tools;
  return PolicySchema.parse(policy) as PolicyConfig;
}
