import { requireWorktree, wrapPrompt } from "./prompt.js";
import type { RunnerTemplate } from "./template.js";

/**
 * Codex CLI, headless: `codex exec`, its own sandbox in workspace-write mode rooted at the worktree, the wrapped
 * prompt read from stdin (`-`). See the invocations table in docs/runners.md for each flag.
 */
export const codexTemplate: RunnerTemplate = {
  file: "codex",
  args: (spec, ctx) => [
    "exec",
    "--json",
    "--ignore-user-config",
    // User and project execpolicy .rules files are repo/owner content that could loosen what Codex runs.
    "--ignore-rules",
    "--sandbox",
    "workspace-write",
    "-C",
    requireWorktree("codex", ctx),
    ...(spec.model !== undefined ? ["--model", spec.model] : []),
    "-",
  ],
  stdin: (spec) => wrapPrompt(spec.prompt),
};
