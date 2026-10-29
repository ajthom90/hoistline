import type { JobSpec, RunnerName } from "@hoistline/protocol";

/**
 * A runner adapter: how to turn a job into one child process. `args` and `stdin` receive a spec whose `model` is
 * already validated and whose `command` is stripped unless the runner is `build-test`. Adapters must pass the
 * prompt via stdin when the CLI supports it, else as a single positional after `--`, and never inside a flag
 * (see docs/runners.md).
 */
export type RunnerTemplate = {
  file: string;
  args: (spec: JobSpec) => string[];
  stdin?: (spec: JobSpec) => string;
};

export type RunnerCommand = { file: string; args: string[]; stdin?: string };

// Starts with an alphanumeric so a model can never look like a flag; no spaces, quotes or shell metacharacters.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

const registry = new Map<RunnerName, RunnerTemplate>();

export function registerRunner(name: RunnerName, template: RunnerTemplate): void {
  registry.set(name, template);
}

/** Builds the argument array (and optional stdin) for a job. Never builds a shell string. */
export function buildCommand(spec: JobSpec): RunnerCommand {
  const template = registry.get(spec.runner);
  if (!template) throw new Error(`runner_not_implemented: ${spec.runner}`);
  if (spec.model !== undefined && (typeof spec.model !== "string" || !MODEL.test(spec.model))) {
    throw new Error(`invalid model ${JSON.stringify(spec.model)}`);
  }
  const safe: JobSpec = { ...spec };
  if (spec.runner !== "build-test") delete safe.command;

  const args = template.args(safe);
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    throw new Error(`runner ${spec.runner} produced a non-string argument`);
  }
  if (typeof template.file !== "string" || template.file.length === 0) {
    throw new Error(`runner ${spec.runner} has no executable`);
  }
  const command: RunnerCommand = { file: template.file, args: [...args] };
  if (template.stdin) command.stdin = template.stdin(safe);
  return command;
}
