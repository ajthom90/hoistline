import { chmod, lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
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
 */
export async function claimJob(cacheDir: string, jobId: string, now: number = Date.now()): Promise<boolean> {
  const id = validateJobId(jobId);
  const dir = join(cacheDir, "seen-jobs");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refusing to use ${dir}: not a plain directory`);
  if (process.platform !== "win32") await chmod(dir, 0o700);
  await prune(dir, now - SEEN_JOB_RETENTION_MS);
  try {
    // "wx" is O_CREAT | O_EXCL, which also refuses to follow a symlink planted at the marker path.
    await writeFile(join(dir, id), "", { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function prune(dir: string, cutoff: number): Promise<void> {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    try {
      const st = await lstat(path);
      if (!st.isDirectory() && st.mtimeMs < cutoff) await unlink(path);
    } catch {
      // Removed concurrently.
    }
  }
}
