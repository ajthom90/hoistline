/**
 * Typed allowlist entries. Each identity provider emits identifiers of its own types only,
 * so an entry can never match a value from a different source:
 * - `github-id:<numeric id>`: GitHub account id; never changes (recommended for GitHub).
 * - `github:<login>`: GitHub login, case-insensitive; logins can be renamed and later reused.
 * - `email:<address>`: OIDC email, case-insensitive; counted only when the provider says email_verified=true.
 * - `sub:<value>`: OIDC subject from the configured issuer, case-sensitive.
 */
const CASE_INSENSITIVE = new Set(["github", "email"]);
const TYPES = new Set(["github-id", "github", "email", "sub"]);

/** Builds a normalized identifier; `value` must already be valid for its type. */
export function identifier(type: "github-id" | "github" | "email" | "sub", value: string): string {
  return `${type}:${CASE_INSENSITIVE.has(type) ? value.toLowerCase() : value}`;
}

/** Validates and normalizes allowlist entries. Throws naming the first bad entry. */
export function parseAllowedUsers(entries: string[]): string[] {
  return entries.map((entry) => {
    const colon = entry.indexOf(":");
    const type = colon > 0 ? entry.slice(0, colon) : "";
    const value = colon > 0 ? entry.slice(colon + 1) : "";
    if (!TYPES.has(type) || !value || (type === "github-id" && !/^\d+$/.test(value))) {
      throw new Error(
        `Invalid allowed-user entry "${entry}": use github-id:<numeric id>, github:<login>, email:<address> or sub:<value>`,
      );
    }
    return identifier(type as Parameters<typeof identifier>[0], value);
  });
}
