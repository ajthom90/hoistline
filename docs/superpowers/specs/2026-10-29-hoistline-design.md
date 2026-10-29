# Hoistline — Design

Working directory name: `mcp-link`. Project name: **Hoistline** (chosen by the author; free on npm, PyPI and Docker Hub and with no matching GitHub repos as of 2026-10-29; a trademark check is still outstanding).

## Intent and why

Claude Code cloud sessions run in Anthropic's sandbox. They cannot reach the models and tools that live on the author's own machines: Codex, Muse, Cursor and Grok (all CLIs on the author's Mac), Xcode (a second Mac), and Windows app testing (an x64 Windows VM). The author wants to start cloud sessions (via Claude Duet, which cannot use Remote Control) that hand work to those tools and then have Claude review the result.

Concrete motivating case: a cloud session delegates subagent work to Codex/Muse/Cursor/Grok, and Claude models review what comes back.

Hoistline is a **single authenticated public MCP endpoint** that a cloud session connects to, and which routes work to **agents running on the user's own machines**. It will be released as a public open-source GitHub project, so other people can run their own hub and use it with their own machines.

## Goals

1. One public MCP endpoint, served by a hub running in Docker (the author runs it as a TrueNAS app), fronted by a Cloudflare Tunnel on a domain the author owns. The project itself needs no domain.
2. The hub federates to many machines (Mac with CLIs, Mac with Xcode, Windows VM, Linux). Adding a machine means installing an agent and pointing it at the hub.
3. Two modes, both supported:
   - **Task mode**: hand off a whole job ("run Muse on repo X, branch Y, with this prompt"; "build this branch and run the tests on Windows") and collect the result later.
   - **Direct mode**: a machine's local MCP servers (e.g. the Windows VM control tools) are proxied through the one endpoint with namespaced tool names, so the cloud session can drive them step by step.
4. Multi-user. Each user has their own login. A user's machines are visible only to them unless they share them.
5. Customizable permissions, enforced on each machine's agent, from fully trusted to tightly restricted.
6. Easy for a stranger to stand up: docker-compose and TrueNAS app definitions, a quick-start, and secure defaults.

## Non-goals

- No file sync between machines. Code travels through GitHub branches.
- Not a general VPN, tunnel or reverse proxy for arbitrary traffic.
- Not an agent framework; Hoistline does not decide what to delegate, Claude does.
- Not a hosted service operated by the author. Users run their own hub.

## Anti-goals (a failure even if it technically works)

- A compromised or malicious hub being able to run arbitrary commands on a machine in restricted mode.
- A setup that needs open inbound ports on the user's machines.
- A setup so involved that a stranger cannot get a first delegated task working in minutes.
- Static shared secrets as the only credential for a multi-user public project.

(The author was asked what would make them wince and answered "go"; no further anti-goals were stated. Those above are inferred from the conversation and marked as the builder's starting assumptions.)

## Architecture

### Hub (Docker)

- Serves the public MCP endpoint over Streamable HTTP, with OAuth login for Claude's remote connector.
- Accepts **outbound** connections from agents (agents dial in; machines expose no ports).
- Holds the registry of users, machines and sharing, plus a job queue with status, results and cancellation.
- Persists to SQLite on a mounted volume.

### Agent (one per machine)

- Single executable per OS (macOS, Windows, Linux), no Node install required.
- Connects outbound to the hub and advertises:
  - **Runners**: Codex, Muse, Cursor and Grok adapters, plus a generic "build and test" runner.
  - **Proxied MCP servers**: any local MCP server (e.g. VM control tools), exposed in direct mode.
- Enforces the owner's permission policy locally; the hub cannot override it.
- Uses the machine's own git credentials to clone, branch and push.

### Task flow

1. Cloud session calls `delegate_task(machine, runner, repo, branch, prompt, ...)`.
2. Hub authorizes the user, queues the job, and sends it to the chosen agent.
3. Agent checks policy, prepares a copy of the repo on a GitHub branch, runs the runner, and pushes the result branch.
4. Cloud session polls `task_status` / reads `task_result` and reviews the branch on GitHub.

### Tools exposed to Claude

`list_machines`, `delegate_task`, `task_status`, `task_result`, `cancel_task`, plus proxied tools named `<machine>.<server>.<tool>`. Both lists change as machines connect and disconnect.

### Permissions

Per machine, set by the owner on the agent:

- **Trusted mode (fully unrestricted)**: the person who sets up the agent may choose to allow everything. Any repo, runner, model and tool, any runner flags (including auto-approve modes such as `--yolo`), and no approval prompts. This is the owner's explicit choice, made at agent setup, and the agent must not nag or second-guess it. The setup flow should state the consequence once, in plain words, then honor the choice. If the machine is shared, shared users get the same unrestricted access, so the setup flow should say that too.
- **Restricted mode**: owner-defined rules, such as allowed repos, allowed runners/models and tools, and which actions need the owner's approval. Anything outside the rules is denied or held for approval.

Enforcement lives on the agent, not only the hub.

## Decided by the author

- Purpose, the two modes, hub on TrueNAS, Cloudflare Tunnel with their own domain, GitHub branches as the code path, open-source public release, multi-user, trusted-or-restricted permissions, and the name Hoistline.

- **Client integration:** Hoistline is added as a **custom connector in claude.ai**, which Claude Duet, Claude Code and other Claude clients then use. The hub must therefore satisfy claude.ai's remote-connector requirements for auth and transport.

- **Restricted-mode guarantee (v1):** allowlist only. The agent checks repo, runner, model and tool against the owner's rules before starting a job. It does not sandbox the runner; once started, a runner can do whatever that CLI can do. Sandboxing is explicitly out of scope for v1 and the docs must say so plainly, so users in restricted mode do not assume a stronger guarantee than they have.

## Decided by the assistant (author may overrule)

- TypeScript for hub and agents (one language for contributors); agents shipped as single executables.
- Streamable HTTP MCP transport; SQLite persistence.
- Agents dial out to the hub rather than the hub dialing in.
- Permissions enforced on the agent.
- The runner list (Codex, Muse, Cursor, Grok, generic build-and-test) and the tool names above.

## Further calls by the assistant after the builder check (author may overrule)

- **Identity:** GitHub OAuth is the default login for the hub, with generic OIDC configurable for other providers. The hub keeps no passwords. A user's first login is "sign in with GitHub".
- **Agent enrollment:** a pairing code shown by the hub is entered on the agent once. The agent then holds a per-machine key bound to that user, and the hub signs jobs so the agent can verify they came from an authorized user.
- **Sharing:** per machine, user-to-user only. A grantee can submit tasks only within the owner's policy, and the owner's approval rules apply to shared users' tasks.
- **Repo handling:** GitHub only in v1. The agent keeps a persistent bare clone and uses an ephemeral worktree per job. Result branches are named `hoistline/<job-id>`. Logs and test output come back through `task_result` with a size cap, and larger output stays on the machine.
- **Direct mode:** stdio MCP servers only in v1, each allowlisted per machine by its owner. A disconnect during a call returns an error. The builder must spike early whether Claude's MCP client refreshes the tool list as machines come and go. If it doesn't, fall back to static meta-tools such as `call_tool(machine, server, tool, args)`.
- **First spike:** how a cloud session authenticates to a custom MCP endpoint behind Cloudflare is the riskiest integration, so build it first.
- **Scale and phasing:** v1 targets a handful of users and machines, not abuse-hardened public hubs. Runner adapters share one command-template mechanism. Muse and Codex ship first, then Cursor and Grok.

## Left to the builder

Repo layout and tooling, the agent-to-hub wire protocol, the OAuth implementation details, how owner approvals are surfaced, the policy rule syntax, job queue semantics, logging, and the packaging and release process.
