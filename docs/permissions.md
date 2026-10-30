# Permissions

Every machine's owner sets its policy on the machine, with `hoistline-agent setup`. The agent enforces it; the hub
cannot change or override it. The policy is `policy.json` in the agent's home (`$HOISTLINE_AGENT_HOME`, default
`~/.hoistline`). See it with `hoistline-agent policy show`. The agent reads it for every job and tool call, so edits
apply without a restart (only the direct-mode tool list the hub shows waits for a restart or reconnect; see
[direct mode](direct-mode.md)). A missing or invalid policy file denies everything.

Every job (task mode) is signed by the hub, and the agent checks the signature before anything else, in restricted and
trusted mode alike. Direct-mode tool calls are not signed; the agent checks them against the policy on every call (see
[Residual risks](#residual-risks)).

## Restricted mode

Restricted mode checks each job's **repo**, **runner** and **model**, and each direct-mode **tool**, against the
owner's allowlist:

- `repos`: the GitHub repositories jobs may use.
- `runners`: which of `muse`, `codex`, `cursor`, `grok` and `build-test` may run.
- `models`: when set, a job must name one of these models. When unset, any model (or none) is allowed.
- `tools`: direct-mode tools, as `server.tool` or `server.*`. When unset, no tool calls are allowed.
- The build-test **command**: it runs only when `build-test` is in `runners`. The command itself is not checked
  against a list: once `build-test` is allowed, a job can run any shell command as you.

**Restricted mode does not sandbox the runner.** It decides which repo, runner, model and tool are used, not what
the runner does once it starts. An allowed runner runs with the owner's full privileges: it can read and write
anything your account can, use your credentials and reach the network. Some runner CLIs have their own sandbox
(see [runners.md](runners.md)); Hoistline adds none.

`onViolation` decides what happens to a job outside the rules: `deny` refuses it, `ask` holds it for your approval.

## Trusted mode

Trusted mode is **fully unrestricted**: any repo, runner, model and tool, with no approvals. Jobs are still
signature-checked, but nothing else is. The owner chooses it explicitly in `hoistline-agent setup`, which states the
consequence once and then honors the choice. If the machine is shared, the people you share it with get the same
unrestricted access.

## Approvals (`ask`)

With `onViolation: "ask"`, a job outside the rules waits (status `awaiting_approval`) until you decide, for up to an
hour; then it fails with `approval_timeout`. `hoistline-agent run` must be running. In another terminal on the
machine:

```sh
hoistline-agent approvals                 # list pending jobs
hoistline-agent approvals show <jobId>    # the full request: repo, branch, runner, model, command, prompt, spec hash
hoistline-agent approvals approve <jobId> # shows the request, then asks you to type the job id
hoistline-agent approvals deny <jobId>
```

Without a terminal (for example from a script), approve with both `--yes` and `--hash <spec hash>`, where the hash is
the request's **full** 64-character spec hash as `approvals show` prints it. Prefixes are not accepted. An approval
covers exactly that request: a different request under the same job id is refused.

Values that cannot be shown safely (non-ASCII or control characters, a command over 500 characters, very long names)
are never offered for approval; such a job is denied.

**Direct mode treats `ask` as `deny`.** A tool call cannot wait for approval. Add the tool to `tools` to allow it.

## Sharing

An owner can share a machine with another user of the same hub (in the web UI at `/ui`). The grantee's jobs and tool
calls run under **the owner's policy** and with **the owner's machine privileges**: the runner runs as the owner's
account, with the owner's git credentials. In trusted mode a grantee can do anything the owner can. Approvals for
a grantee's jobs come to the owner. Stopping sharing ends the grantee's access, including jobs in progress.

## Residual risks

**Runners are not sandboxed** from each other or from the owner's account. The agent hardens its git mirror and
worktrees against accidental or persistent tampering by a runner, but a malicious runner running at the same time as
another job can still interfere with it (a time-of-check to time-of-use gap that is accepted).

**Cursor and Grok run with approvals off and no CLI sandbox.** Anything a job's prompt asks, they can do as you.
`hoistline-agent policy show` and `run` warn when they are allowed.

**Prompts travel in argv for Muse, Cursor and Grok.** On a multi-user host, other local users can read a job's prompt
in the process list. Codex reads its prompt from stdin.

**Tool calls are not separately signed.** Jobs are signed; direct-mode `tools.call` messages are not. The agent
accepts them over its authenticated connection, so the hub can call any allowed tool with any arguments.

**The requester's login is not in the signed job.** `hoistline-agent approvals show` shows the requester's hub user
id, not their login. The hub's `/ui/jobs` page shows the login.

**A bare machine name can resolve to a shared machine.** If a name matches none of your own machines but matches one
shared with you, it resolves to that machine without a warning. Anyone can share a machine with you, so a lure name
is possible. Name shared machines by id or as `<owner>/<machine>`.

**On OIDC hubs, `<owner>/<machine>` works only for logins that are unique on the hub.** Logins come from the
provider and are not reserved: someone can sign in first with a login whose real owner has never signed in.

**Two of your machines with the same name** give an ambiguity error unless you use their ids.

**The hub operator can see job prompts and results.** They are stored in the hub's database. Direct-mode tool
arguments and results also pass through the hub.

**An unset `HOISTLINE_ALLOWED_USERS` lets anyone with a GitHub (or OIDC) account sign in** and use the hub with their
own machines. They cannot see or use yours unless you share them. Set the allowlist on any hub reachable from the
internet.
