import type { RunnerTemplate } from "./template.js";

/**
 * Runs `spec.command` through the platform shell as one argument. This is the only runner that executes a shell
 * string, which is why a policy must list it explicitly. `buildCommand` refuses a build-test job without a command.
 *
 * On Windows, Node would escape inner double quotes MSVC-style, which `cmd.exe /s /c` does not understand. So, like
 * Node's own `shell: true`, the command is wrapped in one pair of quotes and passed verbatim (`/s` strips exactly
 * that outer pair).
 */
export function buildTestTemplateFor(platform: NodeJS.Platform): RunnerTemplate {
  if (platform === "win32") {
    return {
      file: "cmd.exe",
      args: (spec) => ["/d", "/s", "/c", `"${requireCommand(spec.command)}"`],
      verbatimArgs: true,
    };
  }
  return { file: "sh", args: (spec) => ["-c", requireCommand(spec.command)] };
}

function requireCommand(command: string | undefined): string {
  if (!command) throw new Error("build-test requires a command");
  return command;
}

export const buildTestTemplate: RunnerTemplate = buildTestTemplateFor(process.platform);
