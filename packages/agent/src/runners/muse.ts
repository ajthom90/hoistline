import { requireWorktree, wrapPrompt } from "./prompt.js";
import type { RunnerTemplate } from "./template.js";

/**
 * Muse Code, headless: `muse exec`. Muse cannot read the prompt from stdin, so the wrapped prompt is the one
 * positional after `--`. Its sandbox and approval policy stay on; `--approval-mode never` keeps a headless run from
 * waiting on an approval prompt. See the invocations table in docs/runners.md for each flag.
 */
export const museTemplate: RunnerTemplate = {
  file: "muse",
  args: (spec, ctx) => [
    "exec",
    "--json",
    "--approval-mode",
    "never",
    "--disable-request-user-input",
    "--workspace",
    requireWorktree("muse", ctx),
    ...(spec.model !== undefined ? ["--model", spec.model] : []),
    "--",
    wrapPrompt(spec.prompt),
  ],
};
