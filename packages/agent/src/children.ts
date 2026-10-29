import { execFile } from "node:child_process";

/*
 * Every runner and git process group this process started and has not finished with yet, so a forced stop (a second
 * Ctrl-C) can kill them all at once. Process-wide: the agent runs one executor.
 */
const live = new Set<number>();

/** Records a process group (its leader's pid); call the returned function once the group is done with. */
export function trackProcessGroup(pid: number | undefined): () => void {
  if (pid === undefined) return () => undefined;
  live.add(pid);
  return () => {
    live.delete(pid);
  };
}

/**
 * Sends SIGKILL to every tracked process group, synchronously, and forgets them. On Windows (no process groups) it
 * starts `taskkill /T /F` for each tree, which completes asynchronously. Returns how many groups were signalled.
 */
export function killTrackedProcessGroups(): number {
  const pids = [...live];
  live.clear();
  for (const pid of pids) {
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
      continue;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  return pids.length;
}
