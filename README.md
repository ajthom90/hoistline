# Hoistline

Hoistline gives an MCP client, such as Claude on claude.ai or a Claude Code cloud session, one authenticated MCP
endpoint that reaches your own machines. You run the **hub** (a small server in Docker) behind a Cloudflare Tunnel,
and an **agent** on each machine. Agents connect out to the hub, so your machines open no inbound ports.

Status: v0.1, not yet used in production.

## Two modes

- **Task mode.** `delegate_task` hands a whole job to a machine: "run Codex on repo X, branch Y, with this prompt",
  or "build this branch and run the tests on Windows". The agent checks its policy, works in a fresh git worktree,
  runs the chosen runner (Muse, Codex, Cursor, Grok, or a build-and-test command) and pushes the result to the
  branch `hoistline/<job-id>` on GitHub. `task_status`, `task_result` and `cancel_task` follow the job. See
  [docs/runners.md](docs/runners.md).
- **Direct mode.** The agent proxies the stdio MCP servers you list on the machine. The hub offers their tools as
  `<machine>__<server>__<tool>` (your own machines), and through `list_tools` and `call_tool`. See
  [docs/direct-mode.md](docs/direct-mode.md).

`list_machines` shows the machines you can use: your own and those shared with you.

## Architecture in brief

```
MCP client ──HTTPS──> Cloudflare Tunnel ──> hub (Docker, SQLite) <──WebSocket── agent (your machine) ──> runners, git, MCP servers
```

- **Hub** (`packages/hub`): Streamable HTTP MCP at `/mcp`, its own OAuth 2.1 server for MCP clients, login through
  GitHub (default) or a generic OIDC provider, a web UI at `/ui`, and SQLite on a mounted volume. It stores no
  passwords. It signs every job.
- **Agent** (`packages/agent`): one executable per OS (`hoistline-agent`), no Node needed. It pairs with the hub
  once using a one-time code, then connects with its own key. It verifies each job's signature and enforces the
  owner's policy locally. The hub cannot override the policy.
- **Protocol** (`packages/protocol`): the messages between hub and agent, and job signing.

## Docs

- [Quickstart](docs/quickstart.md): deploy the hub, connect claude.ai, pair a machine, run a first task.
- [Permissions](docs/permissions.md): trusted and restricted mode, approvals, sharing, and residual risks.
  **Read it before you pair a machine.**
- [Cloudflare Tunnel](docs/cloudflare-tunnel.md) and [TrueNAS](deploy/truenas/README.md).
- [Other MCP clients](docs/clients.md): personal access tokens.
- [Runners](docs/runners.md) and [direct mode](docs/direct-mode.md).
- [Connector checks](docs/spike-connector.md): the hub's OAuth endpoints, and claude.ai checks still pending.

## Building from source

Node 22 and pnpm 9:

```sh
pnpm install
pnpm build && pnpm lint && pnpm test
docker build -t hoistline-hub .          # the hub image
scripts/build-agent.sh                   # agent executables in dist-bin/ (needs bun)
scripts/smoke-docker.sh                  # builds the image, starts it with compose, checks it, cleans up
```

Releases: pushing a `v*` tag runs `.github/workflows/release.yml`, which publishes the image
`ghcr.io/ajthom90/hoistline-hub` (amd64 and arm64) and a GitHub release with the four agent executables and
`SHA256SUMS`.

## Follow-ups

- Put the requester's login in the signed job, so the agent's `approvals show` can show it (today it shows the
  user id; the hub's `/ui/jobs` shows the login).
- `notifications/tools/list_changed`: the `/mcp` endpoint is stateless and cannot send it, so new direct-mode tools
  appear only when the client lists tools again.
- The manual claude.ai connector checks marked PENDING in [docs/spike-connector.md](docs/spike-connector.md).
- A first real run of the Cursor and Grok runners (their invocations come from the CLIs' help text only).
- Sandboxing runners. Today an allowed runner runs with the owner's full privileges.
- The release workflow has not run yet, and the agent executables were only checked on macOS arm64.

## License

[Apache-2.0](LICENSE).
