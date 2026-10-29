import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { removeWorktree, validateJobId, validateRepo } from "./git.js";

/** Work directories younger than this are left alone: a job may be setting one up right now. */
export const ORPHAN_WORK_MIN_AGE_MS = 3600_000;

/**
 * Removes `<cacheDir>/work/<jobId>` directories left behind by a crash: those of no job in `keep`, older than an hour,
 * and owned (per `<cacheDir>/jobs/<jobId>`) by a repository. Removal goes through removeWorktree, with all of its
 * ownership checks; anything else (symlinks, files, directories without an ownership record) is left untouched. Never
 * throws.
 */
export async function sweepOrphanWork(
  cacheDir: string,
  opts: { keep: (jobId: string) => boolean; now: number; minAgeMs?: number },
): Promise<void> {
  const work = join(cacheDir, "work");
  const jobs = join(cacheDir, "jobs");
  try {
    const root = await lstat(work);
    if (root.isSymbolicLink() || !root.isDirectory()) return;
    const records = await lstat(jobs);
    if (records.isSymbolicLink() || !records.isDirectory()) return;
    for (const name of await readdir(work)) {
      try {
        const id = validateJobId(name);
        if (opts.keep(id)) continue;
        const st = await lstat(join(work, id));
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
        if (opts.now - st.mtimeMs < (opts.minAgeMs ?? ORPHAN_WORK_MIN_AGE_MS)) continue;
        const record = join(jobs, id);
        const rst = await lstat(record);
        if (!rst.isFile() || rst.size > 1024) continue;
        const repo = validateRepo((await readFile(record, "utf8")).trim());
        // Checked again right before removing: a job may have been admitted meanwhile.
        if (opts.keep(id)) continue;
        await removeWorktree(repo, id, cacheDir);
      } catch {
        // Not a job's work directory, or not removable: left for the owner.
      }
    }
  } catch {
    // No work directory yet.
  }
}
