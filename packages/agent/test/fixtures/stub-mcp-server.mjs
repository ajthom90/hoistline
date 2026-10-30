// A stub stdio MCP server for the direct-mode tests: newline-delimited JSON-RPC on stdin/stdout, no dependencies.
// argv[2] is a JSON config:
//   tools?: [{ name, description?, inputSchema? }]
//   pidFile?: string          append this process's pid (and a grandchild's, with grandchild) to the file
//   junk?: boolean            write a junk line just before each response, in the same write
//   noInit?: boolean          read requests but never answer initialize
//   flood?: boolean           never read stdin; flood stdout with ping requests
//   exitAtStart?: boolean     exit right away (a server that never starts)
//   spewAtStart?: number      write this many bytes to stdout with no newline at start, then serve as usual
//   endlessPages?: number     answer tools/list after this many ms, always with a next cursor
//   grandchild?: boolean      start a long-lived child process in this process group (its pid goes to pidFile)
// Tool behaviour is chosen by name: echo (default), env, crash, hang, big ({ bytes }), image,
// spew ({ bytes }: writes that many bytes to stdout with no newline and never answers).
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const config = JSON.parse(process.argv[2] ?? "{}");
const tools = config.tools ?? [{ name: "echo", description: "Echoes its arguments.", inputSchema: { type: "object" } }];
if (config.pidFile) appendFileSync(config.pidFile, `${process.pid}\n`);
if (config.exitAtStart) process.exit(4);
if (config.spewAtStart) process.stdout.write("x".repeat(config.spewAtStart));
if (config.grandchild) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (config.pidFile) appendFileSync(config.pidFile, `${child.pid}\n`);
}

if (config.flood) {
  let id = 0;
  setInterval(() => {
    let out = "";
    for (let i = 0; i < 500; i++) out += `${JSON.stringify({ jsonrpc: "2.0", id: `p${id++}`, method: "ping" })}\n`;
    process.stdout.write(out);
  }, 5);
} else {
  const send = (msg) =>
    process.stdout.write(`${config.junk ? "this is not json\n" : ""}${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  const text = (t) => ({ content: [{ type: "text", text: t }] });

  const callTool = (name, args) => {
    if (name === "env") return text(JSON.stringify(process.env));
    if (name === "crash") process.exit(3);
    if (name === "hang") return undefined;
    if (name === "spew") {
      process.stdout.write("x".repeat(Number(args?.bytes ?? 0)));
      return undefined;
    }
    if (name === "big") return text("x".repeat(Number(args?.bytes ?? 0)));
    if (name === "image") return { content: [{ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" }] };
    return text(JSON.stringify({ tool: name, args }));
  };

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === undefined) return; // a notification
    if (msg.method === "initialize") {
      if (config.noInit) return;
      send({
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "stub", version: "0.0.0" },
        },
      });
    } else if (msg.method === "tools/list") {
      const list = { tools: tools.map((t) => ({ inputSchema: { type: "object" }, ...t })) };
      if (config.endlessPages !== undefined) {
        setTimeout(() => send({ id: msg.id, result: { ...list, nextCursor: "more" } }), config.endlessPages);
      } else {
        send({ id: msg.id, result: list });
      }
    } else if (msg.method === "tools/call") {
      const result = callTool(msg.params?.name, msg.params?.arguments);
      if (result !== undefined) send({ id: msg.id, result });
    } else {
      send({ id: msg.id, error: { code: -32601, message: "method not found" } });
    }
  });
  rl.on("close", () => process.exit(0));
}
