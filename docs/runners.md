# Runners

A runner is a CLI the agent starts on the owner's machine to work on a job (Muse, Codex, Cursor, Grok, and a
generic build-and-test runner). Every runner is an adapter on one shared command-template mechanism in
`packages/agent/src/runners/template.ts`.

## The template mechanism

An adapter is a `RunnerTemplate`:

```ts
type RunnerTemplate = {
  file: string;                          // the executable
  args: (spec: JobSpec) => string[];     // the argument array
  stdin?: (spec: JobSpec) => string;     // optional text written to the child's stdin
};
```

Adapters are registered with `registerRunner(name, template)`. `buildCommand(spec)` turns a signed job into
`{ file, args, stdin? }`. A runner that has no registered adapter fails with `runner_not_implemented`.

## Rules every adapter must follow

Job fields come from a signed job but are still untrusted text. These rules keep that text from changing what the
runner does:

1. **Arrays only, never a shell.** The child is started with `execFile`/`spawn` and an argument array. No adapter
   builds a command string, and nothing runs through `sh -c`, `cmd /c` or `shell: true`.
2. **The prompt goes in via stdin when the CLI supports it.** If the CLI cannot read the prompt from stdin, the
   prompt is one positional argument placed **after a `--`**, so a prompt that starts with `-` can never be read as
   a flag.
3. **Never interpolate the prompt into a flag.** No `--prompt=${prompt}`, no `-p${prompt}`, and no splitting the
   prompt into several arguments. The prompt reaches the child exactly as given: spaces, quotes, `$()`, backticks,
   `;`, newlines and very long text included.
4. **Model names are validated before the adapter sees them.** `buildCommand` rejects any `model` that does not
   match `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$`, so a model can never look like a flag or carry shell syntax. Pass
   it as the value of the CLI's model flag in its own array element (for example `["--model", spec.model]`).
5. **`command` is for `build-test` only.** `buildCommand` strips `spec.command` before calling any other adapter.
6. **No guessed flags.** Each row in the table below records the exact non-interactive invocation, taken from that
   CLI's own `--help` or documentation at the time the adapter was written.

## Workspace and push

Every job goes through four steps in this order, all keyed by the canonical repo and the job id:

1. `prepareWorktree(repo, baseBranch, jobId, cacheDir)` creates the worktree `<cacheDir>/work/<jobId>` on a new branch
   `hoistline/<jobId>` from the persistent bare mirror `<cacheDir>/repos/<owner>__<name>.git`.
2. The runner runs with the worktree as its working directory.
3. `commitWorktree(repo, jobId, cacheDir, { message? })` commits everything in the worktree onto `hoistline/<jobId>`.
   It returns `{ committed: true, sha }`, or `{ committed: false }` when there is nothing to commit; a runner that
   commits by itself leaves its commits on the branch. The author is `Hoistline <hoistline@users.noreply.github.com>`
   and the default message is `hoistline: job <jobId>`.
4. `pushBranch(repo, jobId, cacheDir)` pushes `hoistline/<jobId>` to the same branch on GitHub.

`removeWorktree(repo, jobId, cacheDir)` deletes the worktree afterwards. The branch stays in the mirror, so a job id
can never be reused.

The worktree shares the mirror's git directory, so a runner can write the mirror's config, `info/attributes` and
hooks, and it owns the worktree's `.git` file. The agent defends against that as follows:

- It never runs git through the worktree's `.git` file. Mirror operations use `--git-dir=<mirror>`, with `GIT_DIR`
  and `GIT_COMMON_DIR` pinned to the mirror in the environment, so a planted `commondir` cannot redirect git to
  another repository. The push goes from the mirror.
- The commit finds the worktree's record `<mirror>/worktrees/<name>` by its `gitdir` file and runs with
  `GIT_DIR=<that record>`, `GIT_COMMON_DIR=<mirror>` and `GIT_WORK_TREE=<worktree>`. It requires exactly one record
  whose HEAD is `hoistline/<jobId>`.
- Before every fetch, `worktree add`, commit, push and prune, the mirror is reset, without ever following a
  symlink:
  - Its `config` is unlinked and written fresh from a fixed template: `[core]`, `repositoryformatversion = 0`,
    `bare = true`, nothing else.
  - `hooks` is removed and recreated as an empty real directory.
  - These files are deleted: `commondir`, `gitdir`, `config.worktree`, every `worktrees/*/config.worktree`,
    `info/attributes`, `objects/info/alternates` and `objects/info/http-alternates`.
  - A symlink found in place of `info`, `objects/info`, `worktrees` or a `worktrees/<entry>` is removed, never
    followed.
- No remote is stored. The URL `https://github.com/<owner>/<name>.git`, derived only from the canonical repo, is
  passed explicitly to every fetch and push.
- Every git call also gets `-c` overrides: hooks pointed at an empty directory, fsmonitor off, submodule recursion
  off, fsck on transfer, and every transport except https disabled. Each git call runs with a scrubbed environment.
  The push never forces and never pushes tags.
- Network calls also abort a transfer that stays below 1 byte/s for 60 s. They have an overall timeout (5 minutes
  by default) that kills git's whole process tree: the process group on macOS and Linux, `taskkill /T` on Windows.

**Accepted residual risk, stated plainly.** Restricted mode checks the repo, runner and model before the job
starts. It does not sandbox the runner. Runners run as the owner, so a runner can do whatever that CLI can do as the
owner's user. In particular:

- It can modify `~/.gitconfig` and any other file the owner can write. That includes `include.path` and
  `includeIf` entries in the owner's global git config, which the agent reads (it needs the owner's credential
  helpers) and cannot control.
- It can push or otherwise use the owner's credentials directly.
- A runner still running during another job's git operation can race the mirror: it can write between the reset
  and the git call that follows it.

The hardening above protects against accidental or prompt-injected runner behavior, and against poison left in the
shared mirror carrying over from one job into the next. It does not protect against a deliberately malicious runner.

**Rules for adapters:**

- Do not rely on a CLI's own sandbox to isolate one job from another.
- Never add the shared mirror (`<cacheDir>/repos/...`) to a CLI sandbox's writable roots. Note that a worktree's git
  metadata lives in the mirror, so a sandbox that lets the runner commit already has write access to it.

## Invocations

| Runner | Added by | Executable | Exact non-interactive invocation | Prompt via | Model flag |
| --- | --- | --- | --- | --- | --- |
| Muse | Task 8 | _to be filled in by Task 8_ | _to be filled in by Task 8_ | | |
| Codex | Task 8 | _to be filled in by Task 8_ | _to be filled in by Task 8_ | | |
| Cursor | Task 13 | _to be filled in by Task 13_ | _to be filled in by Task 13_ | | |
| Grok | Task 13 | _to be filled in by Task 13_ | _to be filled in by Task 13_ | | |
| build-test | _later task_ | _to be filled in_ | _to be filled in_ | | n/a |
