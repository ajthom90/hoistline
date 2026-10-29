import { buildTestTemplate } from "./build-test.js";
import { codexTemplate } from "./codex.js";
import { museTemplate } from "./muse.js";
import { registerRunner } from "./template.js";

/** Registers the runners this version ships (cursor and grok come later). Safe to call more than once. */
export function registerBuiltinRunners(): void {
  registerRunner("muse", museTemplate);
  registerRunner("codex", codexTemplate);
  registerRunner("build-test", buildTestTemplate);
}
