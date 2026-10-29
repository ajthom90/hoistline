#!/usr/bin/env node
import { createInterface } from "node:readline";
import { main } from "./cli.js";

/** Lines from stdin, read only when a command asks something (so `run` never holds stdin open). */
const stdin: AsyncIterable<string> = {
  [Symbol.asyncIterator]() {
    return createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  },
};

const code = await main(process.argv.slice(2), {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  stdin,
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  env: process.env,
});
// Exit explicitly once output is flushed: `run` may leave timers or sockets behind after its bounded shutdown.
process.stdout.write("", () => process.exit(code));
