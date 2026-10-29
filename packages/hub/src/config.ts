import type { AppDeps } from "./server.js";

export interface HubConfig {
  port: number;
  deps: AppDeps;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string, why: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required ${why}`);
  return value;
}

/** Reads hub settings from the environment. Throws with the missing variable's name. */
export function configFromEnv(env: Env): HubConfig {
  const publicUrl = required(env, "PUBLIC_URL", "(the hub's public https URL)").replace(/\/+$/, "");
  const port = env.PORT ? Number(env.PORT) : 3000;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a port number, got ${env.PORT}`);

  const allowedUsers = (env.HOISTLINE_ALLOWED_USERS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const config = loginConfig(env, publicUrl, port);
  if (allowedUsers.length) config.deps.allowedUsers = allowedUsers;
  return config;
}

function loginConfig(env: Env, publicUrl: string, port: number): HubConfig {
  const oidcVars = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"];
  if (oidcVars.some((name) => env[name]?.trim())) {
    const why = "when any OIDC_* variable is set";
    return {
      port,
      deps: {
        publicUrl,
        github: { clientId: env.GITHUB_CLIENT_ID ?? "", clientSecret: env.GITHUB_CLIENT_SECRET ?? "" },
        oidc: {
          issuer: required(env, "OIDC_ISSUER", why),
          clientId: required(env, "OIDC_CLIENT_ID", why),
          clientSecret: required(env, "OIDC_CLIENT_SECRET", why),
        },
      },
    };
  }

  const why = "for GitHub login (or set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET)";
  return {
    port,
    deps: {
      publicUrl,
      github: {
        clientId: required(env, "GITHUB_CLIENT_ID", why),
        clientSecret: required(env, "GITHUB_CLIENT_SECRET", why),
      },
    },
  };
}
