// A stub stdio MCP server for the direct-mode tests: newline-delimited JSON-RPC on stdin/stdout, no dependencies.
// argv[2] is a JSON config: { tools?: [{ name, description?, inputSchema? }], pidFile?: string }.
// Tool behaviour is chosen by name: echo (default), env, crash, hang, big ({ bytes }), image.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const config = JSON.parse(process.argv[2] ?? "{}");
const tools = config.tools ?? [{ name: "echo", description: "Echoes its arguments.", inputSchema: { type: "object" } }];
if (config.pidFile) appendFileSync(config.pidFile, `${process.pid}\n`);

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const text = (t) => ({ content: [{ type: "text", text: t }] });

function callTool(name, args) {
  if (name === "env") return text(JSON.stringify(process.env));
  if (name === "crash") process.exit(3);
  if (name === "hang") return undefined;
  if (name === "big") return text("x".repeat(Number(args?.bytes ?? 0)));
  if (name === "image") return { content: [{ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" }] };
  return text(JSON.stringify({ tool: name, args }));
}

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
    send({
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stub", version: "0.0.0" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({ id: msg.id, result: { tools: tools.map((t) => ({ inputSchema: { type: "object" }, ...t })) } });
  } else if (msg.method === "tools/call") {
    const result = callTool(msg.params?.name, msg.params?.arguments);
    if (result !== undefined) send({ id: msg.id, result });
  } else {
    send({ id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
rl.on("close", () => process.exit(0));
