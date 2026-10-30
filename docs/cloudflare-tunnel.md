# Cloudflare Tunnel

The hub speaks plain HTTP on port 3000. Put it on the internet only through a Cloudflare Tunnel (or another
TLS-terminating proxy). **Never publish the hub's port to the internet directly.** `docker-compose.yml` publishes it
on `127.0.0.1` only.

You need a domain on your Cloudflare account. The examples use `hoistline.example.com`.

## 1. Set `PUBLIC_URL`

In `.env`, set `PUBLIC_URL` to the tunnel hostname, with no trailing slash:

```sh
PUBLIC_URL=https://hoistline.example.com
```

The hub uses it as its OAuth issuer, in its OAuth metadata, for the login callback
(`<PUBLIC_URL>/oauth/callback`) and in the pairing command it shows. Restart the hub after changing it.

## 2. Run the tunnel

**Recommended: cloudflared in the compose project.**

1. In the Cloudflare dashboard (Zero Trust, Networks, Tunnels), create a tunnel and copy its token.
2. Add a public hostname `hoistline.example.com` with service `http://localhost:3000`.
3. Put `TUNNEL_TOKEN=<token>` in `.env`, uncomment the `cloudflared` service in `docker-compose.yml`, and pin its
   image to a version tag.
4. `docker compose up -d`.

The service uses `network_mode: "service:hub"`: it shares the hub container's network namespace, so `localhost:3000`
is the hub and the hub sees cloudflared's connections as loopback (see below).

**Alternative: cloudflared on the Docker host.**

```sh
cloudflared tunnel login                                        # once
cloudflared tunnel create hoistline                             # once
cloudflared tunnel route dns hoistline hoistline.example.com    # once
cloudflared tunnel run --url http://127.0.0.1:3000 hoistline
```

This works, but the hub sees connections through Docker's published port as coming from a Docker address, not
loopback, so all clients share the rate-limit buckets (below).

Check the hub through the tunnel:

```sh
curl -s https://hoistline.example.com/.well-known/oauth-authorization-server
```

It should print JSON whose `issuer` is your `PUBLIC_URL` with a trailing `/`.

## Trust proxy and rate limits

The hub has no trust-proxy setting. It is fixed in code (`app.set("trust proxy", "loopback")` in
`packages/hub/src/server.ts`): the hub uses `X-Forwarded-For` only when the connection comes from loopback.
Otherwise it uses the connection's own address.

These routes are rate limited per client IP (`req.ip`):

| Route | Limit | Set by |
| --- | --- | --- |
| `POST /pair` | 10 per minute | the hub (`packages/hub/src/pairing.ts`) |
| `/authorize` | 100 per 15 minutes | the MCP SDK's OAuth router |
| `POST /token` | 50 per 15 minutes | the MCP SDK's OAuth router |
| `POST /register` | 20 per hour | the MCP SDK's OAuth router |
| `POST /revoke` | 50 per 15 minutes | the MCP SDK's OAuth router |

(SDK limits as of `@modelcontextprotocol/sdk` 1.32.2.)

If cloudflared does not reach the hub over loopback, every client appears to come from one address, so **all
clients share each of these buckets**: 10 pairing attempts a minute, 20 client registrations an hour, and so on, for
everyone together. For a hub with a handful of users this mostly means an occasional retry after the window, but one
client (or a misbehaving MCP client that keeps re-registering) can use up a bucket for everyone. The recommended
compose setup above reaches the hub over loopback and avoids this.

Checked on Docker Desktop for Mac with the hub image: twelve `POST /pair` requests with different `X-Forwarded-For`
values got `429` from the 11th on through the published port, and none through loopback inside the hub's network
namespace. Not checked on a Linux Docker host, where the result through the published port is expected to be the
same. The SDK routes were not measured; they key on the same `req.ip`.

With cloudflared on loopback, per-client buckets rely on Cloudflare sending the client's address in
`X-Forwarded-For`. That was not checked here.

The other routes (including `POST /mcp`, `/oauth/callback`, `/oauth/consent` and the web UI) are not rate limited
by IP.
