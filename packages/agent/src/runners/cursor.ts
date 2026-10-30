import { requireWorktree, wrapPromptForArgv } from "./prompt.js";
import type { RunnerTemplate } from "./template.js";

/**
 * Cursor CLI, headless: `cursor-agent -p`. Its help does not document reading the prompt from stdin, so the wrapped
 * prompt is the one positional after `--`. `--force` is needed because a headless run cannot answer approval
 * prompts; no CLI sandbox flag is passed because its help does not say the sandbox leaves the workspace writable.
 * Never `--approve-mcps`, `--worktree`, `--resume` or `--continue`. See the invocations table in docs/runners.md.
 */
export const cursorTemplate: RunnerTemplate = {
  file: "cursor-agent",
  args: (spec, ctx) => [
    "-p",
    "--output-format",
    "stream-json",
    "--trust",
    "--force",
    "--workspace",
    requireWorktree("cursor", ctx),
    ...(spec.model !== undefined ? ["--model", spec.model] : []),
    "--",
    // Throws PromptTooLargeError above 120 KiB: Linux refuses a larger single argument (E2BIG).
    wrapPromptForArgv("cursor", spec.prompt),
  ],
};
