import { buildTestTemplate } from "./build-test.js";
import { codexTemplate } from "./codex.js";
import { cursorTemplate } from "./cursor.js";
import { grokTemplate } from "./grok.js";
import { museTemplate } from "./muse.js";
import { registerRunner } from "./template.js";

/** Registers the runners this version ships. Safe to call more than once. */
export function registerBuiltinRunners(): void {
  registerRunner("muse", museTemplate);
  registerRunner("codex", codexTemplate);
  registerRunner("cursor", cursorTemplate);
  registerRunner("grok", grokTemplate);
  registerRunner("build-test", buildTestTemplate);
}
