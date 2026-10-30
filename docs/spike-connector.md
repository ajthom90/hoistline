# Connector spike: Hoistline hub as a claude.ai custom connector

Goal: confirm that claude.ai can add the hub as a custom connector, complete OAuth login
through the hub, and call the `ping` tool. Tasks 3 and later build on this, so the result gates them.

Status: **implemented and covered by automated tests; the manual check below is PENDING (to be run by the author).**

## What the hub serves

The hub is its own OAuth 2.1 authorization server (built on `mcpAuthRouter` from
`@modelcontextprotocol/sdk`). GitHub, or an OIDC provider, is used only to find out who the user is.

| Method and path | Purpose |
| --- | --- |
| `POST /mcp` | MCP over Streamable HTTP (stateless). Needs `Authorization: Bearer <hub access token>`; without it, returns 401 with `WWW-Authenticate: Bearer ..., resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource"`. `GET` and `DELETE` return 405. |
| `GET /.well-known/oauth-protected-resource` | Protected-resource metadata (RFC 9728). Also served at `/.well-known/oauth-protected-resource/mcp`. |
| `GET /.well-known/oauth-authorization-server` | Authorization-server metadata (RFC 8414). |
| `POST /register` | Dynamic client registration (RFC 7591). claude.ai registers itself here. |
| `GET /authorize` | Starts login: checks the client and PKCE, then shows the hub's consent page naming the client and its redirect host. If this browser already approved this client, it goes straight to GitHub (or the OIDC provider). |
| `POST /oauth/consent` | The consent page's Approve/Deny form (CSRF-protected). Approve redirects to GitHub/OIDC; Deny returns `error=access_denied` to the client. |
| `GET /oauth/callback` | Where GitHub/OIDC sends the browser back. It must be the same browser that started the login (checked with a cookie). The hub looks up the user, checks the allowlist, then redirects to the client's `redirect_uri` with the hub's own authorization code. |
| `POST /token` | Exchanges the code (PKCE S256) for a hub access token (1 hour) and refresh token (30 days, rotated on use). |
| `POST /revoke` | Not offered yet. |

The only tool is `ping`, which returns `pong`.

Why the consent page: any app can register itself at `/register`, and GitHub skips its own
consent screen for an app you already authorized. Without a hub consent step, a link to
`/authorize` from someone else's app could silently sign you in and hand your access to that app.
The hub sets two cookies, both HttpOnly, SameSite=Lax, and Secure when `PUBLIC_URL` is https:
`hl_login` ties a login in progress to your browser, and `hl_approved` (signed) remembers each
client and redirect URI you approved so you are not asked again for that exact pair. The signing
key is random per process, so a restart asks for consent again. The consent page cannot be framed
(`Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`).

State (clients, codes, tokens) is in memory for this spike: restarting the hub logs everyone out
and claude.ai must re-register. Task 3 moves it to SQLite.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | yes | The public https URL of the hub, no trailing path, e.g. `https://hoistline.example.com`. Used as OAuth issuer and to build the callback URL. |
| `PORT` | no (3000) | Local port the hub listens on. |
| `GITHUB_CLIENT_ID` | yes, unless OIDC is set | GitHub OAuth app client ID. |
| `GITHUB_CLIENT_SECRET` | yes, unless OIDC is set | GitHub OAuth app client secret. |
| `OIDC_ISSUER` | no | OIDC issuer URL. When all three `OIDC_*` are set, login uses OIDC discovery instead of GitHub. Setting only some of them is an error. |
| `OIDC_CLIENT_ID` | no | OIDC client ID. |
| `OIDC_CLIENT_SECRET` | no | OIDC client secret. |
| `HOISTLINE_ALLOWED_USERS` | no | Comma-separated list of users who may sign in. Anyone else gets `access_denied`. **When unset, every GitHub (or OIDC) account can sign in to the hub.** Set it for any hub reachable from the internet. Each entry is typed (see below); an untyped or unknown entry stops the hub at startup. |

Allowlist entry types:

| Entry | Matches | Notes |
| --- | --- | --- |
| `github-id:<numeric id>` | GitHub account id | **Recommended for GitHub.** Ids never change. Find yours with `curl -s https://api.github.com/users/<login> \| jq .id`. |
| `github:<login>` | GitHub login, case-insensitive | Logins can be renamed and a freed login can be claimed by someone else. |
| `email:<address>` | OIDC `email`, case-insensitive | Counts only when the provider returns `email_verified: true`. |
| `sub:<value>` | OIDC `sub` from the configured issuer, case-sensitive | Stable per issuer. |

A GitHub login only matches `github-id:` and `github:` entries; an OIDC login only matches `email:`
and `sub:` entries. OIDC `preferred_username` is never used to decide access.

The callback URL to register with GitHub or the OIDC provider is always `<PUBLIC_URL>/oauth/callback`.

OIDC limitation in this spike: the user's identity comes from the provider's `userinfo` endpoint
(called with the access token from a direct back-channel token request). The `id_token` is not verified.

## Inspecting the endpoints

```sh
HUB=https://hoistline.example.com   # your PUBLIC_URL

# Protected-resource metadata: resource and authorization_servers should both be $HUB/
curl -s $HUB/.well-known/oauth-protected-resource | jq
curl -s $HUB/.well-known/oauth-protected-resource/mcp | jq

# Authorization-server metadata: authorize, token and register endpoints under $HUB
curl -s $HUB/.well-known/oauth-authorization-server | jq

# Unauthenticated MCP call: expect 401 and a WWW-Authenticate header with resource_metadata
curl -si -X POST $HUB/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -5

# Dynamic client registration (what claude.ai does first)
curl -s -X POST $HUB/register -H 'content-type: application/json' \
  -d '{"redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"token_endpoint_auth_method":"none"}' | jq
```

## Manual checklist

**PENDING: to be run by the author.**

1. Pick the public hostname for the hub, e.g. `hoistline.example.com`, on a domain in your Cloudflare account. `PUBLIC_URL` is `https://hoistline.example.com`.
2. Create a GitHub OAuth app (GitHub, Settings, Developer settings, OAuth Apps, New OAuth App):
   - Homepage URL: `https://hoistline.example.com`
   - Authorization callback URL: `https://hoistline.example.com/oauth/callback`
   - Generate a client secret. Note the client ID and secret.
3. Build and run the hub:
   ```sh
   pnpm install && pnpm build
   PUBLIC_URL=https://hoistline.example.com PORT=3000 \
   GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
   HOISTLINE_ALLOWED_USERS=github-id:<your-github-numeric-id> \
   node packages/hub/dist/main.js
   ```
   Expect `Hoistline hub listening on port 3000`.
4. Run the tunnel to the hub (in another terminal):
   ```sh
   cloudflared tunnel login                                  # once
   cloudflared tunnel create hoistline                       # once
   cloudflared tunnel route dns hoistline hoistline.example.com   # once
   cloudflared tunnel run --url http://localhost:3000 hoistline
   ```
   (For a first look, `cloudflared tunnel --url http://localhost:3000` gives a random `trycloudflare.com` hostname; then `PUBLIC_URL` and the GitHub callback URL must use that hostname and the hub must be restarted.)
   The hub trusts `X-Forwarded-For` only from loopback, which is where cloudflared connects from. If cloudflared runs on another host, rate limiting will see that host as the client.
5. Run the curl commands in "Inspecting the endpoints" against `https://hoistline.example.com` and check the results match the comments.
6. In claude.ai: Settings, Connectors, Add custom connector. Name `Hoistline`, URL `https://hoistline.example.com/mcp`. Leave the OAuth client ID and secret fields empty (the hub supports dynamic registration).
7. Click Connect. Expected flow: claude.ai registers a client at `/register` (its `redirect_uris` should be `https://claude.ai/api/mcp/auth_callback`; note the actual value), the browser goes to `/authorize` and shows the Hoistline consent page naming the client (note the name and host claude.ai registers). Click Approve; the browser goes to GitHub. Approve the GitHub app. GitHub returns to `/oauth/callback`, then the browser lands back on claude.ai and the connector shows as connected.
8. In a claude.ai chat with the connector enabled, ask Claude to call the Hoistline `ping` tool. Expect `pong`.
9. From a Claude Code session using the same connector, call `ping` and expect `pong`.
10. Restart the hub and note what claude.ai does (in-memory state is gone, so the token is invalid; it should ask to reconnect).
11. Optional: repeat steps 3 to 8 with `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` set instead of the GitHub variables, with `https://hoistline.example.com/oauth/callback` registered as the redirect URI at the OIDC provider.
12. Write down what worked, what failed and any claude.ai quirks in "Findings" below. If claude.ai cannot complete the flow, stop before Task 3.

## PENDING: does claude.ai fetch the tool list again during a conversation?

Direct mode (see `docs/direct-mode.md`) offers the proxied tools of each online machine you own by name. The `/mcp` endpoint is
stateless, so the hub cannot send `notifications/tools/list_changed`; every `tools/list` request is answered with the
current tools, but only if the client asks again. **To be checked by the author:**

1. With the connector enabled in claude.ai (and in a Claude Code session using it), start a conversation with one
   machine online and note its `<machine>__<server>__<tool>` tools.
2. Bring a second machine with servers online during that conversation and ask Claude to use one of its tools.
3. Note whether the new tools appear by name without starting a new conversation, or only through `list_tools`
   and `call_tool`.

Until this is checked, `list_tools` plus `call_tool` is the documented reliable path.

## Findings

_Not yet run._
