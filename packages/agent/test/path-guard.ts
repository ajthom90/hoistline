/**
 * The PATH guard installed by setup.ts, the agent package's vitest setup file (see vitest.config.ts), before every
 * agent test file.
 *
 * The agent tests start runner CLIs by name, through PATH. A real `muse` or `codex` is a paid model run, and execvp
 * keeps searching PATH after a non-executable match, so one broken fake CLI was once enough to start a real one.
 * So the agent tests never see the owner's PATH: it is replaced with the system directories (plus git's directory
 * when git is not in them), and the run fails loudly if any of those holds an executable runner CLI. Tests prefix
 * their own fake-CLI directories under the OS temp dir, which the check exempts.
 */
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";

export const RUNNER_CLI_NAMES = ["muse", "codex", "grok", "cursor", "cursor-agent"] as const;

const SYSTEM_DIRS = ["/usr/bin", "/bin"];

function isExecutable(file: string): boolean {
  try {
    lstatSync(file);
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function tempRoots(): string[] {
  const roots = new Set([tmpdir()]);
  try {
    roots.add(realpathSync(tmpdir()));
  } catch {
    // keep the plain one
  }
  return [...roots];
}

/** Every executable runner CLI in the directories of `pathValue`, skipping directories under `exemptUnder`. */
export function findRunnerCLIs(pathValue: string, opts: { exemptUnder?: string[] } = {}): string[] {
  const exempt = opts.exemptUnder ?? tempRoots();
  const found: string[] = [];
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") continue;
    if (exempt.some((root) => dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep))) continue;
    for (const name of RUNNER_CLI_NAMES) {
      const file = join(dir, name);
      if (isExecutable(file)) found.push(file);
    }
  }
  return found;
}

let guarded: string | undefined;

/**
 * The PATH the agent tests run with: /usr/bin and /bin, plus the directory of the first `git` on the original PATH
 * when neither holds one. Computed once per process, from the PATH the process started with.
 */
export function guardedTestPath(): string {
  if (guarded !== undefined) return guarded;
  const dirs = [...SYSTEM_DIRS];
  if (!dirs.some((d) => isExecutable(join(d, "git")))) {
    const gitDir = (process.env.PATH ?? "").split(delimiter).find((d) => d !== "" && isExecutable(join(d, "git")));
    if (gitDir !== undefined && !dirs.includes(gitDir)) dirs.push(gitDir);
  }
  guarded = dirs.join(delimiter);
  return guarded;
}

/** Replaces PATH with guardedTestPath(), or throws when that PATH holds a runner CLI. */
export function installPathGuard(): void {
  // Windows has neither /usr/bin nor execute bits; the runJob tests are POSIX-only.
  if (process.platform === "win32") return;
  const path = guardedTestPath();
  // No temp-dir exemption here: nothing on this PATH was created by a test.
  const found = findRunnerCLIs(path, { exemptUnder: [] });
  if (found.length > 0) {
    throw new Error(
      `refusing to run the agent tests: ${found.join(", ")} ${found.length === 1 ? "is a runner CLI" : "are runner CLIs"} ` +
        `on the test PATH (${path}), so a test could start a real, paid model run. These directories are the ` +
        "system ones (and the one holding git). Run the agent tests where muse, codex, grok, cursor and " +
        "cursor-agent are not installed there: a container, a CI runner or another user account.",
    );
  }
  process.env.PATH = path;
}
