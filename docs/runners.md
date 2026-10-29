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

The runner runs inside the job's worktree (`<cacheDir>/work/<jobId>`, on branch `hoistline/<jobId>`), created by
`prepareWorktree(repo, baseBranch, jobId, cacheDir)` from a persistent bare mirror at
`<cacheDir>/repos/<owner>__<name>.git`. The result is pushed with `pushBranch(repo, jobId, cacheDir)`, and the worktree
is removed with `removeWorktree(repo, jobId, cacheDir)`.

The worktree shares the mirror's git directory, so a runner can write the mirror's config, `info/attributes` and
hooks, and it owns the worktree's `.git` file. The agent defends against that as follows:

- It never runs git through the worktree. Every git call uses `--git-dir=<mirror>`, and the push goes from the
  mirror, never from the worktree's `.git` file or with the worktree as the working directory.
- Before every fetch, every `worktree add` and every push, the mirror is reset. Its `config` is rewritten from a
  fixed template (`[core]`, `repositoryformatversion = 0`, `bare = true`, nothing else), and `info/attributes`,
  `config.worktree`, every `worktrees/*/config.worktree` and every hook are deleted.
- No remote is stored. The URL `https://github.com/<owner>/<name>.git`, derived only from the canonical repo, is
  passed explicitly to every fetch and push.
- Every git call also gets `-c` overrides: hooks pointed at an empty directory, fsmonitor off, submodule recursion
  off, fsck on transfer, and every transport except https disabled. Each git call runs with a scrubbed environment.
  The push never forces and never pushes tags.
- Network calls also abort a transfer that stays below 1 byte/s for 60 s. They have an overall timeout (5 minutes
  by default) that kills git's whole process tree: the process group on macOS and Linux, `taskkill /T` on Windows.

**Residual risk, stated plainly.** Restricted mode checks the repo, runner and model before the job starts. It does
not sandbox the runner. Once started, a runner can do whatever that CLI can do as the owner's user. In particular:

- It can modify `~/.gitconfig` and any other file the owner can write. That includes `include.path` and
  `includeIf` entries in the owner's global git config, which the agent reads (it needs the owner's credential
  helpers) and cannot control.
- It can push or otherwise use the owner's credentials directly.

The resets above stop a runner from steering the agent's own git calls through the shared repository. They do not
contain the runner.

## Invocations

| Runner | Added by | Executable | Exact non-interactive invocation | Prompt via | Model flag |
| --- | --- | --- | --- | --- | --- |
| Muse | Task 8 | _to be filled in by Task 8_ | _to be filled in by Task 8_ | | |
| Codex | Task 8 | _to be filled in by Task 8_ | _to be filled in by Task 8_ | | |
| Cursor | Task 13 | _to be filled in by Task 13_ | _to be filled in by Task 13_ | | |
| Grok | Task 13 | _to be filled in by Task 13_ | _to be filled in by Task 13_ | | |
| build-test | _later task_ | _to be filled in_ | _to be filled in_ | | n/a |
