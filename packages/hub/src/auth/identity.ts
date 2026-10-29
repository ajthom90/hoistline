/**
 * Upstream identity providers. The hub is its own OAuth authorization server for MCP
 * clients; GitHub (default) or a generic OIDC provider only answers "who is this user".
 */

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/** The user as identified by the upstream provider. */
export interface UserIdentity {
  provider: "github" | "oidc";
  /** Stable id at the provider (GitHub numeric id, OIDC `sub`). */
  subject: string;
  /** Human-readable name (GitHub login, OIDC preferred_username or email). */
  name: string;
  /** Values an allowlist entry may match: GitHub login; OIDC preferred_username, email and sub. */
  identifiers: string[];
}

export interface IdentityProvider {
  /** URL to send the browser to; the provider redirects back to the hub callback with `code` and `state`. */
  authorizationUrl(state: string): Promise<string>;
  /** Exchanges the provider's code for the user's identity. Throws on any failure. */
  resolveCode(code: string): Promise<UserIdentity>;
}

export type FetchFn = typeof fetch;

async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string, what: string): string {
  const value = body[key];
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return String(value);
  const reason = typeof body.error === "string" ? `: ${body.error}` : "";
  throw new Error(`${what} returned no ${key}${reason}`);
}

export class GithubIdentityProvider implements IdentityProvider {
  constructor(
    private readonly config: GithubOAuthConfig,
    private readonly callbackUrl: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async authorizationUrl(state: string): Promise<string> {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.callbackUrl,
      scope: "read:user",
      state,
      allow_signup: "false",
    }).toString();
    return url.href;
  }

  async resolveCode(code: string): Promise<UserIdentity> {
    // GitHub answers HTTP 200 with {error} on a bad code, so the body is checked, not just the status.
    const tokenRes = await this.fetchFn("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.callbackUrl,
      }),
    });
    const accessToken = requireString(await readJson(tokenRes, "GitHub token exchange"), "access_token", "GitHub");
    // api.github.com refuses requests without a User-Agent.
    const userRes = await this.fetchFn("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "hoistline-hub",
      },
    });
    const user = await readJson(userRes, "GitHub user lookup");
    const login = requireString(user, "login", "GitHub user");
    return {
      provider: "github",
      subject: requireString(user, "id", "GitHub user"),
      name: login,
      identifiers: [login],
    };
  }
}

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

/**
 * Generic OIDC via discovery. Identity comes from the userinfo endpoint (called with the
 * access token from a direct back-channel token request), not from a verified id_token.
 */
export class OidcIdentityProvider implements IdentityProvider {
  private discovery?: Promise<OidcDiscovery>;

  constructor(
    private readonly config: OidcConfig,
    private readonly callbackUrl: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private discover(): Promise<OidcDiscovery> {
    this.discovery ??= (async () => {
      const url = `${this.config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
      const body = await readJson(await this.fetchFn(url), "OIDC discovery");
      return {
        authorization_endpoint: requireString(body, "authorization_endpoint", "OIDC discovery"),
        token_endpoint: requireString(body, "token_endpoint", "OIDC discovery"),
        userinfo_endpoint: requireString(body, "userinfo_endpoint", "OIDC discovery"),
      };
    })().catch((err: unknown) => {
      this.discovery = undefined; // retry discovery on the next login
      throw err;
    });
    return this.discovery;
  }

  async authorizationUrl(state: string): Promise<string> {
    const url = new URL((await this.discover()).authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.callbackUrl);
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", state);
    return url.href;
  }

  async resolveCode(code: string): Promise<UserIdentity> {
    const endpoints = await this.discover();
    const tokenRes = await this.fetchFn(endpoints.token_endpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.callbackUrl,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }).toString(),
    });
    const accessToken = requireString(await readJson(tokenRes, "OIDC token exchange"), "access_token", "OIDC");
    const infoRes = await this.fetchFn(endpoints.userinfo_endpoint, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    const info = await readJson(infoRes, "OIDC userinfo");
    const subject = requireString(info, "sub", "OIDC userinfo");
    const strings = (...values: unknown[]) => values.filter((v): v is string => typeof v === "string" && v !== "");
    const name = strings(info.preferred_username, info.email, info.name)[0] ?? subject;
    return {
      provider: "oidc",
      subject,
      name,
      // An email the provider marks as unverified is not trusted for the allowlist.
      identifiers: strings(info.preferred_username, info.email_verified === false ? undefined : info.email, subject),
    };
  }
}
