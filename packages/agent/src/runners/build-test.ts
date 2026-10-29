import type { RunnerTemplate } from "./template.js";

const windows = process.platform === "win32";

/**
 * Runs `spec.command` through the platform shell as one argument. This is the only runner that executes a shell
 * string, which is why a policy must list it explicitly. `buildCommand` refuses a build-test job without a command.
 */
export const buildTestTemplate: RunnerTemplate = {
  file: windows ? "cmd.exe" : "sh",
  args: (spec) => {
    if (!spec.command) throw new Error("build-test requires a command");
    return windows ? ["/d", "/s", "/c", spec.command] : ["-c", spec.command];
  },
};
