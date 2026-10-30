# Other MCP clients

The hub's endpoint is standard MCP over Streamable HTTP at `<PUBLIC_URL>/mcp` (POST only; the hub keeps no session),
protected by OAuth 2.1. Clients that support remote MCP servers with OAuth (metadata discovery, dynamic client
registration at `/register`, PKCE) connect the same way claude.ai does: give them the URL and sign in. See
[spike-connector.md](spike-connector.md) for the OAuth endpoints.

## Personal access tokens

For clients that can only send a static `Authorization: Bearer` header:

1. Sign in to `<PUBLIC_URL>/ui` and open **Access tokens** (`/ui/tokens`).
2. Create a token with a name (1 to 64 characters) and a lifetime of 1 to 365 days (default 90). You can have at
   most 20 live tokens.
3. Copy it: it starts with `hl_pat_` and is shown once. The hub stores only its SHA-256 hash.
4. Configure the client with the URL `<PUBLIC_URL>/mcp` and the header `Authorization: Bearer hl_pat_...`.

A token acts as you, with everything your account can do on the hub: delegate tasks to your machines and those
shared with you, and call their tools. **Treat it like a password.** Revoke it at `/ui/tokens` when you no longer need
it. A token stops working when it expires, when you revoke it, or when you no longer pass the hub's
`HOISTLINE_ALLOWED_USERS` allowlist.

Example check with curl:

```sh
curl -s -X POST https://hoistline.example.com/mcp \
  -H "Authorization: Bearer $HOISTLINE_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping","arguments":{}}}'
```

It should answer with `pong`.
