import { isAbsolute } from "node:path";
import type { RunnerContext } from "./template.js";

/**
 * Fixed text put in front of every Muse and Codex prompt. The agent commits and pushes the worktree itself, so the
 * CLI must leave git alone and stay inside its working directory. This is an instruction to the model, not a
 * sandbox (see docs/runners.md).
 */
export const RUNNER_PREAMBLE =
  "You are running unattended for Hoistline. Work only inside the current directory, the repository checkout you " +
  "were started in. Do not run git commit, git push, git config or git remote commands, and do not modify git " +
  "configuration or any file outside the current directory. Leave your changes uncommitted in the working tree; " +
  "they are committed for you afterwards. The task follows the line below, exactly as the user wrote it.";

/** Separates the preamble from the user's prompt, which follows it byte for byte. */
export const PROMPT_DELIMITER = "\n\n===== TASK =====\n\n";

export function wrapPrompt(prompt: string): string {
  return RUNNER_PREAMBLE + PROMPT_DELIMITER + prompt;
}

/** The worktree a CLI is scoped to; required because it goes into the CLI's own workspace flag. */
export function requireWorktree(runner: string, ctx: RunnerContext): string {
  if (typeof ctx.cwd !== "string" || !isAbsolute(ctx.cwd)) {
    throw new Error(`runner ${runner} needs an absolute working directory`);
  }
  return ctx.cwd;
}
