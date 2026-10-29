// Test fixture: a stand-in for the `muse` and `codex` CLIs, installed on PATH by runners.test.ts through a small sh
// wrapper. Behavior is set by FAKECLI_* variables (not GIT_* / HOISTLINE_*, which runJob strips):
//   FAKECLI_RECORD  path: write {argv, stdin, cwd, env, pid} there as JSON once stdin has ended
//   FAKECLI_PIDS    path: write {pid, child?} there at startup, before anything else
//   FAKECLI_MODE    one of: record (default), sleep, exit, big, bigutf8, escape, ignoreterm, signal
//   FAKECLI_CODE    exit code for mode=exit
//   FAKECLI_MB      megabytes to print for mode=big / bigutf8
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.env.FAKECLI_MODE ?? "record";
const pids = { pid: process.pid };

if (mode === "ignoreterm") {
  process.on("SIGTERM", () => undefined);
  // A same-group child that also ignores SIGTERM: only the SIGKILL to the whole group stops it.
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  pids.child = child.pid;
}
if (mode === "escape") {
  // A descendant that leaves the process group (setsid) and keeps stdout/stderr open.
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.unref();
  pids.child = child.pid;
}
if (process.env.FAKECLI_PIDS) writeFileSync(process.env.FAKECLI_PIDS, JSON.stringify(pids));

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  if (process.env.FAKECLI_RECORD) {
    writeFileSync(
      process.env.FAKECLI_RECORD,
      JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), env: process.env, pid: process.pid }),
    );
  }
  switch (mode) {
    case "sleep":
    case "ignoreterm":
      setInterval(() => undefined, 1000);
      break;
    case "exit":
      process.exit(Number(process.env.FAKECLI_CODE ?? "1"));
      break;
    case "big":
    case "bigutf8": {
      const mb = Number(process.env.FAKECLI_MB ?? "4");
      const unit = mode === "big" ? "x".repeat(1024 * 1024) : "é漢🙂a".repeat(1024 * 1024 / 10);
      let left = mb;
      const write = () => {
        while (left > 0) {
          left--;
          if (!process.stdout.write(unit)) return void process.stdout.once("drain", write);
        }
        process.stderr.write("done\n");
      };
      write();
      break;
    }
    case "signal":
      process.kill(process.pid, "SIGTERM");
      setInterval(() => undefined, 1000);
      break;
    case "escape":
      process.stdout.write("leader done\n");
      process.exit(0);
      break;
    default:
      process.stdout.write("ok\n");
  }
});
