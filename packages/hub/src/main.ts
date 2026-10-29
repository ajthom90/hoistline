import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteOAuthProvider } from "./auth/sqlite-provider.js";
import { configFromEnv } from "./config.js";
import { createApp } from "./server.js";
import { Store } from "./store.js";

const { port, deps } = configFromEnv(process.env);
const login = deps.oidc ? `OIDC (${deps.oidc.issuer})` : "GitHub";

const databasePath = process.env.DATABASE_PATH?.trim() || "./data/hoistline.db";
mkdirSync(dirname(databasePath), { recursive: true });
const store = new Store(databasePath);
const oauthProvider = new SqliteOAuthProvider(store);

// Expired codes and tokens are also swept whenever new ones are issued; this covers idle periods.
const sweep = setInterval(() => {
  store.sweepExpired();
  oauthProvider.sweepExpired();
}, 60 * 60 * 1000);
sweep.unref();

createApp({ ...deps, oauthProvider, cookieSecret: store.getOrCreateSecret("cookie") }).listen(port, () => {
  console.log(`Hoistline hub listening on port ${port}`);
  console.log(`MCP endpoint: ${deps.publicUrl}/mcp (login via ${login}); database: ${databasePath}`);
});
