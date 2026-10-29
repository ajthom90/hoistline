import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateJobId } from "./git.js";

/**
 * How long a claimed job id is remembered. verifyJob refuses jobs older than MAX_JOB_AGE_MS plus the clock skew
 * allowance, so anything far beyond that can be forgotten without reopening a replay window.
 */
export const SEEN_JOB_RETENTION_MS = 24 * 3600_000;

/**
 * Claims `jobId` durably: an exclusively created marker `<cacheDir>/seen-jobs/<jobId>` (mode 0600, directory 0700).
 * Returns true the first time, false for a job id already claimed, also by an earlier process. Markers older than
 * 24 hours are pruned. Throws for an unsafe job id or a seen-jobs path that is not a real directory.
 *
 * Synchronous, so a job can be claimed in the same tick it is admitted.
 */
export function claimJobSync(cacheDir: string, jobId: string, now: number = Date.now()): boolean {
  const id = validateJobId(jobId);
  const dir = join(cacheDir, "seen-jobs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refusing to use ${dir}: not a plain directory`);
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  prune(dir, now - SEEN_JOB_RETENTION_MS);
  try {
    // "wx" is O_CREAT | O_EXCL, which also refuses to follow a symlink planted at the marker path.
    writeFileSync(join(dir, id), "", { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** claimJobSync as a promise. */
export async function claimJob(cacheDir: string, jobId: string, now: number = Date.now()): Promise<boolean> {
  return claimJobSync(cacheDir, jobId, now);
}

function prune(dir: string, cutoff: number): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (!st.isDirectory() && st.mtimeMs < cutoff) unlinkSync(path);
    } catch {
      // Removed concurrently.
    }
  }
}
