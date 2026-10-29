// Vitest setup file for the agent package: no agent test ever sees the owner's PATH (see path-guard.ts).
import { installPathGuard } from "./path-guard.js";

installPathGuard();
