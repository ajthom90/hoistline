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

  it("requires PUBLIC_URL and a login provider", () => {
    expect(() => configFromEnv({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "s" })).toThrow(/PUBLIC_URL/);
    expect(() => configFromEnv({ PUBLIC_URL: "https://hub.example.com" })).toThrow(/GITHUB_CLIENT_ID/);
    expect(() => configFromEnv({ ...github, OIDC_ISSUER: "https://issuer.example.com" })).toThrow(/OIDC_CLIENT_ID/);
  });
});
