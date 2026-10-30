# Hoistline hub on TrueNAS SCALE

There is no Hoistline app in the TrueNAS catalog. You run the hub as a custom app from a compose YAML.

**Not verified on TrueNAS.** These steps follow the compose file that `scripts/smoke-docker.sh` tests on Docker, but
nobody has run them on a TrueNAS system yet, and menu names differ between TrueNAS versions. TrueNAS 24.10
(Electric Eel) and later run apps with Docker and accept compose YAML; earlier versions do not. The image's
healthcheck uses `--start-interval`, which needs Docker Engine 25 or later; check the version your TrueNAS release
ships (`docker version` in a host shell).

Before you start, create the GitHub OAuth app and pick the public hostname as in
[the quickstart](../../docs/quickstart.md), steps 1 and 2.

## 1. A dataset for the database

1. Create a dataset, for example `tank/apps/hoistline`.
2. Make it owned by uid 10001 and gid 10001 (the hub runs as that user). In the dataset's permissions editor you can
   enter the numeric ids; or from a shell on the TrueNAS host:

   ```sh
   chown 10001:10001 /mnt/tank/apps/hoistline
   ```

The hub keeps its SQLite database (`hoistline.db`, plus `-wal` and `-shm` files) there. Back up this dataset; it
holds users, machines, jobs, OAuth tokens and the hub's job-signing key.

## 2. Install via YAML

In Apps, choose the option to install a custom app from YAML (Discover Apps, then the menu next to Custom App, "Install
via YAML" in 24.10). Name it `hoistline` and paste this, with your values:

```yaml
services:
  hub:
    image: ghcr.io/ajthom90/hoistline-hub:latest   # pin a release version, e.g. :0.1.0
    restart: unless-stopped
    environment:
      PUBLIC_URL: https://hoistline.example.com
      GITHUB_CLIENT_ID: your-client-id
      GITHUB_CLIENT_SECRET: your-client-secret
      HOISTLINE_ALLOWED_USERS: github-id:12345678
    volumes:
      - /mnt/tank/apps/hoistline:/data
  cloudflared:
    image: cloudflare/cloudflared:latest           # pin a version tag
    restart: unless-stopped
    network_mode: "service:hub"
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: your-tunnel-token
    depends_on:
      - hub
```

- The environment variables are described in [`.env.example`](../../.env.example). For OIDC instead of GitHub,
  replace the two `GITHUB_*` lines with `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.
- **Set `HOISTLINE_ALLOWED_USERS`.** Without it, anyone with a GitHub account can sign in to your hub.
- No port is published: cloudflared reaches the hub over the shared network namespace. To reach the hub from your LAN
  for testing, add `ports: ["3000:3000"]` under `hub`, but do not forward that port from the internet.
- The YAML holds your secrets in the app's configuration. Anyone with admin access to TrueNAS can read them.

## 3. The tunnel

Create the tunnel in the Cloudflare dashboard with a public hostname pointing at `http://localhost:3000`, and use
its token above. See [docs/cloudflare-tunnel.md](../../docs/cloudflare-tunnel.md).

## 4. Check it

```sh
curl -s https://hoistline.example.com/.well-known/oauth-authorization-server
```

Then continue with the quickstart from "Connect claude.ai".

## Updating

Change the image tag in the app's YAML and save; TrueNAS pulls the new image and restarts the app. The database
migrates on start.
