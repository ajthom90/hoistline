# Quickstart

From nothing to a first delegated task. You need:

- a host with Docker and Docker Compose for the hub;
- a domain on a Cloudflare account (for the tunnel);
- a GitHub account (or an OIDC provider);
- a machine to run jobs on, with `git` and at least one runner CLI (Muse, Codex, Cursor or Grok) installed and
  logged in.

The examples use `https://hoistline.example.com` as the hub's public URL.

## 1. Create a GitHub OAuth app

GitHub, Settings, Developer settings, OAuth Apps, New OAuth App:

- Homepage URL: `https://hoistline.example.com`
- Authorization callback URL: `https://hoistline.example.com/oauth/callback`

Generate a client secret and note the client ID and secret.

Find your numeric GitHub id for the allowlist:

```sh
curl -s https://api.github.com/users/<your-login> | jq .id
```

(For OIDC instead: register `https://hoistline.example.com/oauth/callback` as a redirect URI and use the `OIDC_*`
variables below.)

## 2. Deploy the hub

You need `docker-compose.yml` and `.env.example` from this repository.

```sh
cp .env.example .env
```

Edit `.env`:

```sh
PUBLIC_URL=https://hoistline.example.com
GITHUB_CLIENT_ID=<client id>
GITHUB_CLIENT_SECRET=<client secret>
HOISTLINE_ALLOWED_USERS=github-id:<your numeric id>
```

**Set `HOISTLINE_ALLOWED_USERS`.** When it is empty, anyone with a GitHub account can sign in to your hub (they can
use only their own machines, not yours). Entries are comma-separated: `github-id:<id>` (recommended),
`github:<login>`, `email:<verified OIDC email>`, `sub:<OIDC subject>`. A malformed entry stops the hub at startup.

The database lives in `./data` (set `HUB_DATA_DIR` to change it). The hub runs as uid 10001, so that directory must
be writable by it. On Linux:

```sh
mkdir -p data && sudo chown 10001:10001 data
```

Start it:

```sh
docker compose up -d
docker compose logs hub     # expect "Hoistline hub listening on port 3000"
```

`docker compose up` pulls `ghcr.io/ajthom90/hoistline-hub`. If no release has been published yet, build the image
from a checkout of this repository first with `docker compose build`.

The hub listens on `127.0.0.1:3000` on the host only. On TrueNAS, see
[deploy/truenas/README.md](../deploy/truenas/README.md).

## 3. Put it behind the tunnel

Follow [cloudflare-tunnel.md](cloudflare-tunnel.md). Then check:

```sh
curl -s https://hoistline.example.com/.well-known/oauth-authorization-server
```

## 4. Connect claude.ai

In claude.ai: Settings, Connectors, Add custom connector. Name it `Hoistline` and set the URL to
`https://hoistline.example.com/mcp`. Leave the OAuth client ID and secret empty (the hub supports dynamic client
registration). Click Connect: the hub shows a consent page naming the client; approve it, then sign in with GitHub.

Ask Claude to call the Hoistline `ping` tool; it should answer `pong`. (This flow is covered by automated tests but
the manual claude.ai check is still pending; see [spike-connector.md](spike-connector.md).)

Other MCP clients, including ones that only accept a static bearer token: see [clients.md](clients.md).

## 5. Pair a machine

**Read [permissions.md](permissions.md) first.** A paired machine runs jobs that you, and anyone you share it with,
send through the hub.

1. Download the agent for the machine from the GitHub release: `hoistline-agent-darwin-arm64`,
   `hoistline-agent-darwin-x64`, `hoistline-agent-linux-x64` or `hoistline-agent-windows-x64.exe`. Check it against
   `SHA256SUMS`, make it executable and put it on your PATH as `hoistline-agent`.
   (Or build them from source with `scripts/build-agent.sh`, which needs bun.)
   The binaries are not notarized or Authenticode-signed. On macOS you may need
   `xattr -d com.apple.quarantine hoistline-agent` after downloading; Windows SmartScreen may warn. Not verified.
2. Open `https://hoistline.example.com/ui`, sign in, and click **Create a pairing code**. The page shows a command
   with a one-time code valid for 10 minutes.
3. Run that command on the machine:

   ```sh
   hoistline-agent pair https://hoistline.example.com <code> --name laptop
   ```

   Without `--name`, the machine's hostname is used. Names cannot contain `/`. The agent's identity is saved in
   `~/.hoistline` (or `$HOISTLINE_AGENT_HOME`).

## 6. Set the policy

```sh
hoistline-agent setup
hoistline-agent policy show
```

`setup` asks for trusted or restricted mode. Restricted mode asks for the allowed repos, runners, models and
direct-mode tools, and whether a job outside them is denied or held for your approval. Until you run `setup`, the
agent denies everything.

The machine's `git` must be able to fetch from and push to the allowed repos over `https://github.com/` without a
prompt (for example after `gh auth login` and `gh auth setup-git`). Results are pushed to branches named
`hoistline/<job-id>`.

For direct mode (proxying the machine's stdio MCP servers), see [direct-mode.md](direct-mode.md).

## 7. Run the agent

```sh
hoistline-agent run
```

It prints `connected to the hub` and reconnects by itself. `hoistline-agent status` shows the pairing, the policy and
pending approvals.

To keep it running, run it as a service under your own user account (not root), so runners use your CLI logins and
git credentials. These are outlines and were not tested:

- **Linux (systemd user unit)** `~/.config/systemd/user/hoistline-agent.service`:

  ```ini
  [Unit]
  Description=Hoistline agent

  [Service]
  ExecStart=%h/.local/bin/hoistline-agent run
  Restart=on-failure

  [Install]
  WantedBy=default.target
  ```

  Then `systemctl --user enable --now hoistline-agent` (and `loginctl enable-linger $USER` to run without a login).
  Runner CLIs must be on the service's PATH; add `Environment=PATH=...` if needed.
- **macOS (launchd)**: a LaunchAgent plist in `~/Library/LaunchAgents` with `ProgramArguments` set to the agent's
  path and `run`, `KeepAlive` true, and an `EnvironmentVariables` `PATH` that includes your runner CLIs. Load it
  with `launchctl bootstrap gui/$(id -u) <plist>`.
- **Windows**: a Task Scheduler task that runs `hoistline-agent-windows-x64.exe run` at log on, as your user.

## 8. A first task

In claude.ai, with the Hoistline connector enabled, ask for example:

> Use Hoistline: list my machines, then delegate a task to `laptop` with runner `codex` on repo
> `you/your-repo`, branch `main`, prompt "Add a test for the date parser". Poll its status until it finishes and
> show me the result.

Claude calls `list_machines`, then `delegate_task` (machine, runner, repo, branch, prompt, and optionally model),
which returns a job id at once. It polls `task_status`, then reads `task_result`: the status, exit code, the last
64 KiB of the runner's output, and the pushed branch `hoistline/<job-id>`. Review the branch on GitHub.
`cancel_task` stops a job. The hub's `/ui/jobs` page lists your jobs too.

If the job is outside a restricted policy with `ask`, it waits for you: run `hoistline-agent approvals` on the
machine (see [permissions.md](permissions.md)).
