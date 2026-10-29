const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const URL_PREFIX = "https://github.com/";
const MAX_OWNER = 39;
const MAX_NAME = 100;

/**
 * Canonicalizes a GitHub repository reference to lowercase `owner/name`, or returns null.
 *
 * Accepts exactly `owner/name` or `https://github.com/owner/name`, each with an optional `.git` suffix; the URL
 * form also allows one trailing slash. Everything else (other hosts, http, ssh/scp-style, `ext::`, userinfo,
 * query strings, whitespace, option-like values starting with `-`, non-ASCII) is rejected, so a canonical value
 * is safe to hand to git as a repository argument.
 */
export function canonicalRepo(repo: string): string | null {
  if (typeof repo !== "string" || repo.length === 0 || repo.length > 200) return null;
  let rest = repo;
  if (rest.startsWith(URL_PREFIX)) {
    rest = rest.slice(URL_PREFIX.length);
    if (rest.endsWith("/")) rest = rest.slice(0, -1);
  }
  if (rest.endsWith(".git")) rest = rest.slice(0, -4);
  const parts = rest.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (owner.length > MAX_OWNER || name.length > MAX_NAME) return null;
  if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return null;
  if (owner.endsWith(".") || name.endsWith(".") || name.endsWith(".git")) return null;
  return `${owner}/${name}`.toLowerCase();
}
