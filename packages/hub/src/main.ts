import { configFromEnv } from "./config.js";
import { createApp } from "./server.js";

const { port, deps } = configFromEnv(process.env);
const login = deps.oidc ? `OIDC (${deps.oidc.issuer})` : "GitHub";

createApp(deps).listen(port, () => {
  console.log(`Hoistline hub listening on port ${port}`);
  console.log(`MCP endpoint: ${deps.publicUrl}/mcp (login via ${login})`);
});
