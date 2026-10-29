# Hoistline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Hoistline: a Dockerized hub exposing one authenticated public MCP endpoint, plus per-machine agents that run delegated coding-CLI jobs and proxy local MCP servers.

**Architecture:** A pnpm TypeScript monorepo with three packages. `protocol` holds the wire messages and job signing. `hub` is the public MCP server, OAuth provider, SQLite store and WebSocket gateway. `agent` dials out to the hub, enforces the owner's policy locally, runs jobs in git worktrees and proxies stdio MCP servers.

**Tech Stack:** TypeScript, Node 22, pnpm workspaces, vitest, `@modelcontextprotocol/sdk`, `ws`, `zod`, SQLite via `better-sqlite3`, Docker. (The builder's choices, per the spec: everything except TypeScript, SQLite and Streamable HTTP.)

**Spec:** `docs/superpowers/specs/2026-10-29-hoistline-design.md`

## Global Constraints

- TypeScript for hub and agents; agents ship as single executables for macOS, Windows and Linux, no Node install needed.
- Public endpoint speaks Streamable HTTP MCP with OAuth; Hoistline is added as a custom connector in claude.ai.
- Login is GitHub OAuth by default, generic OIDC configurable; the hub stores no passwords.
- Agents connect outbound only; machines expose no inbound ports.
- Persistence is SQLite on a mounted volume.
- Tools exposed: `list_machines`, `delegate_task`, `task_status`, `task_result`, `cancel_task`; proxied tools are named `<machine>.<server>.<tool>`.
- Code travels via GitHub only (v1); result branches are named `hoistline/<job-id>`; agent uses a persistent bare clone and an ephemeral worktree per job.
- Pairing: one-time code entered on the agent, then a per-machine key bound to the user; the hub signs jobs and the agent verifies them.
- Sharing is per machine, user to user; shared users are bound by the owner's policy and approval rules.
- Permissions are enforced on the agent. Trusted mode is fully unrestricted by the owner's explicit choice (consequence stated once at setup, including for shared machines). Restricted mode is allowlist only (repo, runner, model, tool); there is no sandbox, and the docs must say so plainly.
- Direct mode proxies stdio MCP servers only, each allowlisted per machine by its owner; a disconnect during a call returns an error.
- `task_result` returns logs and test output with a size cap; larger output stays on the machine.
- Runner adapters share one command-template mechanism; Muse and Codex ship first, then Cursor and Grok.
- v1 targets a handful of users and machines, not abuse-hardened public hubs.

## Review Focus

1. Agent drops mid-job: the job must end as `failed` with reason `agent_disconnected`, never hang in `running`. (Task 9)
2. Hub restarts with jobs in flight: agents reconnect, report their running jobs, and the hub reconciles them. (Task 9)
3. Prompt or branch text with spaces, quotes, `$()`, `;` or a leading `-` reaches the runner as one argument, never through a shell. (Tasks 7, 8)
4. Repo or branch input shaped like a git option (`--upload-pack=...`) or a path traversal is rejected before any git call. (Task 7)
5. A user who guesses another user's machine or job id gets "not found", exactly like a nonexistent id. (Tasks 5, 9, 10)

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.github/workflows/ci.yml`, `packages/{protocol,hub,agent}/package.json`, `packages/{protocol,hub,agent}/tsconfig.json`, `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/smoke.test.ts`

**Interfaces:**
- Produces: workspace names `@hoistline/protocol`, `@hoistline/hub`, `@hoistline/agent`; root scripts `pnpm test`, `pnpm build`, `pnpm lint`.

- [ ] **Step 1:** Write `smoke.test.ts` asserting `import { PROTOCOL_VERSION } from "../src"` equals `1`.
- [ ] **Step 2:** Run `pnpm test`; expect FAIL (module missing).
- [ ] **Step 3:** Create the workspace files; export `PROTOCOL_VERSION = 1` from `packages/protocol/src/index.ts`; CI runs install, build, lint, test.
- [ ] **Step 4:** Run `pnpm test`; expect PASS across all packages.
- [ ] **Step 5:** Commit `chore: scaffold monorepo`.

### Task 2: Connector spike (do first; gates the rest)

**Files:**
- Create: `packages/hub/src/server.ts`, `packages/hub/src/main.ts`, `docs/spike-connector.md`
- Test: `packages/hub/test/mcp-endpoint.test.ts`

**Interfaces:**
- Produces: `createApp(deps: { publicUrl: string; github: GithubOAuthConfig }): express.Express` serving `POST /mcp` (Streamable HTTP) behind OAuth (SDK `mcpAuthRouter` with dynamic client registration, GitHub as the identity provider) and one `ping` tool returning `"pong"`. `GithubOAuthConfig = { clientId: string; clientSecret: string }`. The login provider is chosen by env: GitHub by default, or any OIDC provider when `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` are set (test the OIDC path against a stub issuer).

- [ ] **Step 1:** Write tests: unauthenticated `POST /mcp` returns 401 with a `WWW-Authenticate` header pointing at protected-resource metadata; `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` return JSON; an authenticated MCP client (SDK client with a test token) lists `ping` and calls it.
- [ ] **Step 2:** Run `pnpm --filter @hoistline/hub test`; expect FAIL.
- [ ] **Step 3:** Implement `createApp` and `main.ts` (reads `PUBLIC_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `PORT`). Use an in-memory OAuth provider for now.
- [ ] **Step 4:** Run tests; expect PASS.
- [ ] **Step 5 (manual gate):** Run the hub behind a Cloudflare Tunnel, add it in claude.ai as a custom connector, complete login, and call `ping` from a Claude Code session. Record what worked and any claude.ai quirks in `docs/spike-connector.md`. If claude.ai cannot complete the flow, stop and bring the findings to the author before Task 3.
- [ ] **Step 6:** Commit `feat(hub): MCP endpoint with OAuth, connector verified`.

### Task 3: Hub store (SQLite)

**Files:**
- Create: `packages/hub/src/store.ts`, `packages/hub/src/migrations/001_init.sql`
- Test: `packages/hub/test/store.test.ts`

**Interfaces:**
- Produces: `class Store { constructor(path: string); upsertUser(github: {id: string; login: string}): User; createPairingCode(userId: string): string; redeemPairingCode(code: string, machineName: string, publicKey: string): Machine | null; machinesFor(userId: string): Machine[]; getMachine(userId: string, machineId: string): Machine | null; shareMachine(ownerId: string, machineId: string, withLogin: string): void; unshareMachine(ownerId: string, machineId: string, withLogin: string): void; insertJob(job: JobRow): void; getJob(userId: string, jobId: string): JobRow | null; updateJob(jobId: string, patch: Partial<JobRow>): void; }` with types `User`, `Machine`, `JobRow` exported. It also persists OAuth clients, authorization codes and tokens through a `SqliteOAuthProvider` (implements the SDK's `OAuthServerProvider`) that replaces Task 2's in-memory provider; tokens survive a hub restart.

- [ ] **Step 1:** Write tests: redeeming a code returns a machine once and `null` the second time; an expired code (older than 10 minutes, clock injected) returns `null`; `machinesFor` includes owned and shared machines; `getMachine` for another user's unshared machine returns `null`; `getJob` for another user's job returns `null`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement `Store` with a migration runner.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat(hub): sqlite store`.

### Task 4: Protocol messages and job signing

**Files:**
- Create: `packages/protocol/src/messages.ts`, `packages/protocol/src/signing.ts`
- Test: `packages/protocol/test/signing.test.ts`, `packages/protocol/test/messages.test.ts`

**Interfaces:**
- Produces: `type RunnerName = "muse" | "codex" | "cursor" | "grok" | "build-test"`; `type JobSpec = { jobId: string; runner: RunnerName; repo: string; baseBranch: string; prompt: string; model?: string; command?: string }`; `type SignedJob = { spec: JobSpec; userId: string; issuedAt: number; signature: string }`; `signJob(spec: JobSpec, userId: string, hubPrivateKey: KeyObject, now?: number): SignedJob`; `verifyJob(job: SignedJob, hubPublicKey: KeyObject, now?: number): { spec: JobSpec; userId: string }` (throws on bad signature or `issuedAt` older than 5 minutes); zod schemas `HubToAgent` and `AgentToHub` as discriminated unions on `type`, covering `hello`, `job.assign`, `job.cancel`, `job.event`, `job.result`, `tools.list`, `tools.call`, `tools.result`.

- [ ] **Step 1:** Write tests: a signed job verifies; changing `spec.prompt` after signing throws; a job issued 6 minutes ago throws; each message type round-trips through its schema and an unknown `type` is rejected.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement with Ed25519 via `node:crypto`; signature covers canonical JSON of `{spec, userId, issuedAt}`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat(protocol): messages and job signing`.

### Task 5: Gateway, pairing and `list_machines`

**Files:**
- Create: `packages/hub/src/gateway.ts`, `packages/hub/src/tools/machines.ts`, `packages/agent/src/connection.ts`, `packages/agent/src/pair.ts`
- Test: `packages/hub/test/gateway.test.ts`, `packages/agent/test/pair.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 3), message schemas (Task 4).
- Produces: hub `class Gateway { constructor(store: Store, hubKey: KeyObject); attach(server: http.Server): void; isOnline(machineId: string): boolean; sendJob(machineId: string, job: SignedJob): void; onJobMessage(cb: (machineId: string, msg: AgentToHub) => void): void }` (WebSocket at `/agent`; agent proves its machine key by signing a server nonce); agent `pairMachine(hubUrl: string, code: string, name: string): Promise<AgentIdentity>` (the identity includes the machine key pair and the hub's public signing key, which `verifyJob` later uses) and `connect(identity: AgentIdentity, handlers: {...}): AgentConnection` that reconnects with backoff; MCP tool `list_machines` returning `{id, name, online, owner, shared}[]` for the calling user only.

- [ ] **Step 1:** Write tests: pairing with a valid code stores a machine and returns an identity; a reused code is rejected; a connection with a bad nonce signature is closed; `list_machines` for user B does not include user A's unshared machine; an agent that stops responding shows `online: false`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement gateway and agent connection (outbound only).
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: agent pairing, gateway and list_machines`.

### Task 6: Policy engine and setup flow

**Files:**
- Create: `packages/agent/src/policy.ts`, `packages/agent/src/setup.ts`
- Test: `packages/agent/test/policy.test.ts`

**Interfaces:**
- Produces: `type PolicyConfig = { mode: "trusted" } | { mode: "restricted"; repos: string[]; runners: RunnerName[]; models?: string[]; tools?: string[]; onViolation: "deny" | "ask" }`; `type Decision = { result: "allow" | "deny" | "ask"; reason: string }`; `evaluateJob(policy: PolicyConfig, spec: JobSpec): Decision`; `evaluateToolCall(policy: PolicyConfig, server: string, tool: string): Decision`; `runSetup(io: SetupIO): Promise<PolicyConfig>` which, on choosing trusted, prints the consequence once (including that shared users get the same access) and then honors the choice with no further prompting.

- [ ] **Step 1:** Write tests: trusted allows any job and any flags with no `ask`; restricted denies a repo not in `repos` with a reason naming the repo; `onViolation: "ask"` returns `ask` instead of `deny`; the consequence text prints exactly once during setup and never in `evaluateJob`; repo matching is exact on `owner/name`, case-insensitive.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement; persist the policy as JSON in the agent config dir.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat(agent): policy engine and setup`.

### Task 7: Git workspace and runner framework

**Files:**
- Create: `packages/agent/src/git.ts`, `packages/agent/src/runners/template.ts`, `packages/agent/src/runners/index.ts`, `docs/runners.md`
- Test: `packages/agent/test/git.test.ts`, `packages/agent/test/runner-template.test.ts`, `packages/agent/test/fixtures/fake-runner.mjs`

**Interfaces:**
- Produces: `validateRepo(repo: string): string` (accepts `owner/name` or an https GitHub URL, throws otherwise; returns canonical `owner/name`); `validateBranch(name: string): string` (rejects leading `-`, `..`, spaces, control characters); `prepareWorktree(repo: string, baseBranch: string, jobId: string, cacheDir: string): Promise<{ dir: string; branch: string }>` (persistent bare clone; worktree on branch `hoistline/<jobId>`); `pushBranch(dir: string, branch: string): Promise<void>`; `type RunnerTemplate = { file: string; args: (spec: JobSpec) => string[] }`; `buildCommand(spec: JobSpec): { file: string; args: string[] }` (uses `execFile`-style argument arrays, never a shell).

- [ ] **Step 1:** Write tests: `validateRepo("--upload-pack=x")` and `validateBranch("-x")`, `validateBranch("a/../b")` throw; `prepareWorktree` against a local bare repo fixture creates branch `hoistline/<jobId>`; `buildCommand` with prompt `a b "c" $(x); -y` yields that exact string as a single element of `args`; a fake runner script run via `buildCommand` receives it unchanged.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Read each CLI's `--help` and record the exact non-interactive invocation for Muse and Codex in `docs/runners.md`; do not guess flags.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat(agent): git workspace and runner templates`.

### Task 8: Muse and Codex adapters plus build-test runner

**Files:**
- Create: `packages/agent/src/runners/muse.ts`, `packages/agent/src/runners/codex.ts`, `packages/agent/src/runners/build-test.ts`
- Test: `packages/agent/test/runners.test.ts`

**Interfaces:**
- Consumes: `RunnerTemplate`, `buildCommand` (Task 7).
- Produces: `runJob(spec: JobSpec, dir: string, onOutput: (chunk: string) => void, signal: AbortSignal): Promise<{ exitCode: number }>`; the `build-test` runner executes `spec.command` inside the worktree.

- [ ] **Step 1:** Write tests using `fake-runner.mjs` on `PATH`: output chunks stream to `onOutput`; aborting the signal kills the process within 2 seconds; a nonzero exit code is returned, not thrown; a missing CLI yields a clear `runner_not_installed` error.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement adapters from the invocations recorded in `docs/runners.md`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat(agent): muse, codex and build-test runners`.

### Task 9: Job lifecycle (hub and agent)

**Files:**
- Create: `packages/hub/src/jobs.ts`, `packages/agent/src/executor.ts`
- Test: `packages/hub/test/jobs.test.ts`, `packages/agent/test/executor.test.ts`, `packages/hub/test/e2e.test.ts`

**Interfaces:**
- Consumes: `Store`, `Gateway`, `signJob`, `evaluateJob`, `prepareWorktree`, `runJob`.
- Produces: hub `class Jobs { constructor(store: Store, gateway: Gateway, hubKey: KeyObject); delegate(userId: string, req: DelegateRequest): JobRow; status(userId: string, jobId: string): JobStatus | null; result(userId: string, jobId: string): JobResult | null; cancel(userId: string, jobId: string): boolean; reconcile(machineId: string, running: string[]): void }`; `type JobStatus = "queued" | "awaiting_approval" | "running" | "succeeded" | "failed" | "cancelled"`; agent `execute(signed: SignedJob, deps: ExecutorDeps): Promise<void>` which verifies the signature, evaluates policy, runs the job, pushes the branch, and reports events and a result.

- [ ] **Step 1:** Write tests: a job for a machine that drops mid-run becomes `failed` with reason `agent_disconnected`; after a hub restart, `reconcile` marks jobs the agent no longer reports as `failed` and keeps the rest `running`; `status`/`result`/`cancel` on another user's job id return `null`/`false`; a tampered signed job is refused by the agent; a denied job reports `failed` with the policy reason; the end-to-end test (hub + agent + fake runner + local bare repo) ends `succeeded` with branch `hoistline/<job-id>` present.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement; job state lives in SQLite so a hub restart loses nothing.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: job lifecycle with signing and policy`.

### Task 10: Job tools and result size cap

**Files:**
- Create: `packages/hub/src/tools/jobs.ts`
- Modify: `packages/hub/src/server.ts`
- Test: `packages/hub/test/tools-jobs.test.ts`

**Interfaces:**
- Consumes: `Jobs` (Task 9).
- Produces: MCP tools `delegate_task({machine, runner, repo, branch, prompt, model?, command?})`, `task_status({jobId})`, `task_result({jobId})`, `cancel_task({jobId})`; `task_result` returns at most 64 KiB of output (the tail), with a `truncated: true` field and a note that the full log stays on the machine.

- [ ] **Step 1:** Write tests using an SDK client: delegating to an offline machine returns a clear error; output of 200 KiB comes back as 64 KiB with `truncated: true`; unknown and foreign job ids give the same "not found" error text.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Register the tools on the MCP server.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat(hub): task tools`.

### Task 11: Approvals and sharing UI

**Files:**
- Create: `packages/agent/src/approvals.ts`, `packages/agent/src/cli.ts`, `packages/hub/src/ui.ts`
- Test: `packages/agent/test/approvals.test.ts`, `packages/hub/test/ui.test.ts`

**Interfaces:**
- Produces: agent `hoistline-agent approvals` (list, approve, deny) over a local file queue; held jobs report `awaiting_approval`; hub pages (login required) `GET /ui` listing machines, `POST /ui/pair` showing a new pairing code, `POST /ui/share` and `POST /ui/unshare` taking a machine id and a GitHub login.

- [ ] **Step 1:** Write tests: an `ask` decision parks the job until approved, denied jobs finish `failed`; the approval applies to shared users' jobs too; `/ui` without login redirects; sharing by login makes the machine appear in the grantee's `list_machines`; a grantee cannot share or unshare the machine further.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement; server-rendered HTML, no frontend framework.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: approvals and sharing UI`.

### Task 12: Direct mode (proxied MCP servers)

**Files:**
- Create: `packages/agent/src/proxy.ts`, `packages/hub/src/tools/proxy.ts`
- Modify: `packages/hub/src/server.ts`
- Test: `packages/agent/test/proxy.test.ts`, `packages/hub/test/proxy.test.ts`

**Interfaces:**
- Consumes: `evaluateToolCall` (Task 6), `tools.list` / `tools.call` messages (Task 4).
- Produces: agent `class McpProxy { constructor(servers: Record<string, {command: string; args: string[]}>, policy: PolicyConfig); listTools(): Promise<ProxiedTool[]>; call(server: string, tool: string, args: unknown): Promise<unknown> }`; hub exposes each online machine's tools as `<machine>.<server>.<tool>` and emits `tools/list_changed` on connect and disconnect; fallback tool `call_tool({machine, server, tool, args})`.

- [ ] **Step 1:** Write tests with a stub stdio MCP server: tools appear namespaced; a tool not allowed by policy is denied; a machine disconnecting during a call returns an error within 5 seconds, not a hang; `call_tool` works for the same tool; a user cannot call tools on a machine they lack access to.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. **Manual spike:** from a Claude Code session via the claude.ai connector, connect a second machine and see whether the tool list refreshes; record the result in `docs/spike-connector.md`. If it does not refresh, make `call_tool` the documented primary path.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: direct mode`.

### Task 13: Cursor and Grok adapters

**Files:**
- Create: `packages/agent/src/runners/cursor.ts`, `packages/agent/src/runners/grok.ts`
- Modify: `docs/runners.md`
- Test: `packages/agent/test/runners.test.ts`

**Interfaces:**
- Consumes: `RunnerTemplate` (Task 7).

- [ ] **Step 1:** Extend the runner tests with `cursor` and `grok` cases against the fake runner (same assertions as Task 8).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Add the adapters from each CLI's `--help`, recorded in `docs/runners.md`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat(agent): cursor and grok runners`.

### Task 14: Packaging, docs and release

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `deploy/truenas/README.md`, `README.md`, `docs/quickstart.md`, `docs/permissions.md`, `docs/cloudflare-tunnel.md`, `scripts/build-agent.sh`, `.github/workflows/release.yml`, `LICENSE`
- Test: `scripts/smoke-docker.sh`

**Interfaces:**
- Produces: image `ghcr.io/ajthom90/hoistline-hub`; agent binaries `hoistline-agent-{darwin-arm64,darwin-x64,linux-x64,windows-x64}`.

- [ ] **Step 1:** Write `smoke-docker.sh`: builds the image, starts it with compose, and asserts `GET /.well-known/oauth-authorization-server` returns 200 and the SQLite file appears on the mounted volume.
- [ ] **Step 2:** Run it; expect FAIL (no Dockerfile).
- [ ] **Step 3:** Add the Dockerfile, compose and TrueNAS notes; build agent executables with `bun build --compile` (cross-compile for all four targets) and run `hoistline-agent --version` on the host; write the docs. `docs/permissions.md` must state that restricted mode checks repo, runner, model and tool but does not sandbox the runner, and that trusted mode is fully unrestricted. Pick an open-source license and tell the author which.
- [ ] **Step 4:** Run `scripts/smoke-docker.sh`; expect PASS.
- [ ] **Step 5:** Commit `chore: packaging, docs, release workflow`.
