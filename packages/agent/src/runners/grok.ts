import { requireWorktree, wrapPromptForArgv } from "./prompt.js";
import type { RunnerTemplate } from "./template.js";

/**
 * Grok Build CLI, headless: `grok --single`. Its help documents no stdin form, so the wrapped prompt is passed as
 * the one argv element `--single=<prompt>`. In that form clap cannot read the value as a separate flag, so a prompt
 * beginning with `--` stays the value (the one allowed exception to "never inside a flag"). No `--sandbox` profile
 * is documented, so none is passed. Never `--worktree`, `--continue` or `--resume`. See docs/runners.md.
 */
export const grokTemplate: RunnerTemplate = {
  file: "grok",
  args: (spec, ctx) => [
    "--output-format",
    "streaming-json",
    "--cwd",
    requireWorktree("grok", ctx),
    "--always-approve",
    ...(spec.model !== undefined ? ["-m", spec.model] : []),
    // Throws PromptTooLargeError above 120 KiB: Linux refuses a larger single argument (E2BIG).
    `--single=${wrapPromptForArgv("grok", spec.prompt)}`,
  ],
};
