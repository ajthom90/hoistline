import { describe, expect, it } from "vitest";
import { configFromEnv } from "../src/config.js";

const github = {
  PUBLIC_URL: "https://hub.example.com",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
};

describe("configFromEnv", () => {
  it("reads GitHub login settings and defaults PORT to 3000", () => {
    expect(configFromEnv(github)).toEqual({
      port: 3000,
      deps: {
        publicUrl: "https://hub.example.com",
        github: { clientId: "id", clientSecret: "secret" },
      },
    });
  });

  it("uses OIDC when all three OIDC variables are set", () => {
    const config = configFromEnv({
      PUBLIC_URL: "https://hub.example.com/",
      PORT: "8080",
      OIDC_ISSUER: "https://issuer.example.com",
      OIDC_CLIENT_ID: "oid",
      OIDC_CLIENT_SECRET: "osecret",
    });
    expect(config.port).toBe(8080);
    expect(config.deps.publicUrl).toBe("https://hub.example.com");
    expect(config.deps.oidc).toEqual({
      issuer: "https://issuer.example.com",
      clientId: "oid",
      clientSecret: "osecret",
    });
  });

  it("reads HOISTLINE_ALLOWED_USERS as a comma-separated list", () => {
    const config = configFromEnv({
      ...github,
      HOISTLINE_ALLOWED_USERS: " github:octocat, email:ada@example.com ,, github-id:42, sub:user-7",
    });
    expect(config.deps.allowedUsers).toEqual(["github:octocat", "email:ada@example.com", "github-id:42", "sub:user-7"]);
    expect(configFromEnv({ ...github, HOISTLINE_ALLOWED_USERS: "" }).deps.allowedUsers).toBeUndefined();
  });

  it("rejects untyped, unknown-prefix or malformed allowlist entries at startup", () => {
    const withAllow = (value: string) => () => configFromEnv({ ...github, HOISTLINE_ALLOWED_USERS: value });
    expect(withAllow("github:octocat, octocat")).toThrow(/"octocat"/);
    expect(withAllow("gitlab:octocat")).toThrow(/"gitlab:octocat"/);
    expect(withAllow("github-id:octocat")).toThrow(/"github-id:octocat"/);
    expect(withAllow("email:")).toThrow(/"email:"/);
  });

  it("requires PUBLIC_URL and a login provider", () => {
    expect(() => configFromEnv({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "s" })).toThrow(/PUBLIC_URL/);
    expect(() => configFromEnv({ PUBLIC_URL: "https://hub.example.com" })).toThrow(/GITHUB_CLIENT_ID/);
    expect(() => configFromEnv({ ...github, OIDC_ISSUER: "https://issuer.example.com" })).toThrow(/OIDC_CLIENT_ID/);
  });
});
