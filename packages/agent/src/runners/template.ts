import type { JobSpec, RunnerName } from "@hoistline/protocol";

/** Where the job runs. `cwd` is the worktree; it is absent when a command is built without one (tests). */
export type RunnerContext = { cwd?: string };

/**
 * A runner adapter: how to turn a job into one child process. `args` and `stdin` receive a spec whose `model` is
 * already validated and whose `command` is stripped unless the runner is `build-test`, plus the context the job
 * runs in. Adapters must pass the prompt via stdin when the CLI supports it, else as a single positional after
 * `--`, and never inside a flag (see docs/runners.md).
 */
export type RunnerTemplate = {
  file: string;
  args: (spec: JobSpec, ctx: RunnerContext) => string[];
  stdin?: (spec: JobSpec, ctx: RunnerContext) => string;
  /** Windows only: pass the arguments to CreateProcess unescaped (spawn's windowsVerbatimArguments). */
  verbatimArgs?: boolean;
};

export type RunnerCommand = { file: string; args: string[]; stdin?: string; verbatimArgs?: true };

// Starts with an alphanumeric so a model can never look like a flag; no spaces, quotes or shell metacharacters.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

const registry = new Map<RunnerName, RunnerTemplate>();

export function registerRunner(name: RunnerName, template: RunnerTemplate): void {
  registry.set(name, template);
}

/** The names of the registered runners, in registration order. */
export function registeredRunners(): RunnerName[] {
  return [...registry.keys()];
}

/** @internal Test hook: empties the registry. */
export function _resetRunnersForTests(): void {
  registry.clear();
}

/** Builds the argument array (and optional stdin) for a job. Never builds a shell string. */
export function buildCommand(spec: JobSpec, ctx: RunnerContext = {}): RunnerCommand {
  const template = registry.get(spec.runner);
  if (!template) throw new Error(`runner_not_implemented: ${spec.runner}`);
  if (spec.model !== undefined && (typeof spec.model !== "string" || !MODEL.test(spec.model))) {
    throw new Error(`invalid model ${JSON.stringify(spec.model)}`);
  }
  // build-test is the one runner that executes a shell string, so it must have one.
  if (spec.runner === "build-test" && (typeof spec.command !== "string" || spec.command.length === 0)) {
    throw new Error("build-test requires a command");
  }
  const safe: JobSpec = { ...spec };
  if (spec.runner !== "build-test") delete safe.command;
  const context: RunnerContext = { ...ctx };

  const args = template.args(safe, context);
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    throw new Error(`runner ${spec.runner} produced a non-string argument`);
  }
  if (typeof template.file !== "string" || template.file.length === 0) {
    throw new Error(`runner ${spec.runner} has no executable`);
  }
  const command: RunnerCommand = { file: template.file, args: [...args] };
  if (template.stdin) command.stdin = template.stdin(safe, context);
  if (template.verbatimArgs === true) command.verbatimArgs = true;
  return command;
}
