# Runners

A runner is a CLI the agent starts on the owner's machine to work on a job (Muse, Codex, Cursor, Grok, and a
generic build-and-test runner). Every runner is an adapter on one shared command-template mechanism in
`packages/agent/src/runners/template.ts`.

## The template mechanism

An adapter is a `RunnerTemplate`:

```ts
type RunnerTemplate = {
  file: string;                          // the executable
  args: (spec: JobSpec, ctx: RunnerContext) => string[];  // the argument array
  stdin?: (spec: JobSpec, ctx: RunnerContext) => string;  // optional text written to the child's stdin
};
type RunnerContext = { cwd?: string };   // the worktree the job runs in
```

Adapters are registered with `registerRunner(name, template)`. `buildCommand(spec, ctx?)` turns a signed job into
`{ file, args, stdin? }`. A runner that has no registered adapter fails with `runner_not_implemented`. `ctx.cwd` is
the absolute worktree path; Muse and Codex put it in their own workspace flag and refuse to build without it.
`registerBuiltinRunners()` registers `muse`, `codex` and `build-test` (idempotent; Cursor and Grok come in Task 13).

## Rules every adapter must follow

Job fields come from a signed job but are still untrusted text. These rules keep that text from changing what the
runner does:

1. **Arrays only, never a shell.** The child is started with `execFile`/`spawn` and an argument array. No adapter
   builds a command string, and nothing runs through `sh -c`, `cmd /c` or `shell: true`. The one exception is the
   `build-test` runner, whose whole purpose is to run the job's `command` string: it passes that string as one
   argument to `sh -c` (Windows: `cmd.exe /d /s /c`). That is why a policy must list `build-test` explicitly.
2. **The prompt goes in via stdin when the CLI supports it.** If the CLI cannot read the prompt from stdin, the
   prompt is one positional argument placed **after a `--`**, so a prompt that starts with `-` can never be read as
   a flag.
3. **Never interpolate the prompt into a flag.** No `--prompt=${prompt}`, no `-p${prompt}`, and no splitting the
   prompt into several arguments. The prompt reaches the child exactly as given: spaces, quotes, `$()`, backticks,
   `;`, newlines and very long text included.
4. **Model names are validated before the adapter sees them.** `buildCommand` rejects any `model` that does not
   match `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$`, so a model can never look like a flag or carry shell syntax. Pass
   it as the value of the CLI's model flag in its own array element (for example `["--model", spec.model]`).
5. **`command` is for `build-test` only.** `buildCommand` strips `spec.command` before calling any other adapter,
   and refuses a `build-test` job whose `command` is missing or empty (`build-test requires a command`).
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

`removeWorktree(repo, jobId, cacheDir)` deletes the worktree afterwards. The branch and the job's ownership record
stay, so a job id can never be reused.

The worktree shares the mirror's git directory, so a runner can write anything in the mirror (config, hooks, refs,
metadata files, symlinks), and it owns the worktree's `.git` file. The agent defends against that as follows:

- It never runs git through the worktree's `.git` file. Mirror operations use `--git-dir=<mirror>`, with `GIT_DIR`
  and `GIT_COMMON_DIR` pinned to the mirror in the environment, so a planted `commondir` cannot redirect git to
  another repository. The push goes from the mirror.
- Cache layout: before `git init`, `worktree add` or any cleanup, `<cacheDir>`, `<cacheDir>/repos`,
  `<cacheDir>/work`, `<cacheDir>/jobs` and the mirror path (if present) must be real directories, not symlinks.
  `<cacheDir>` itself is checked again by every prepare, commit, push and remove.
- Job ids: a job id is claimed for one repository by an ownership record `<cacheDir>/jobs/<jobId>` (the canonical
  repo), created exclusively. A per-job-id lock across the whole cache is taken before the per-repo lock, so two
  repos preparing the same job id at once cannot both get it. The agent creates `<cacheDir>/work/<jobId>` itself
  (refusing one that exists) before `worktree add`, and a failed prepare removes only the record and directory that
  call created. `removeWorktree` removes a directory only when the ownership record names the same repository.
- The commit finds the worktree's record `<mirror>/worktrees/<name>` by its `gitdir` file and runs with
  `GIT_DIR=<that record>`, `GIT_COMMON_DIR=<mirror>` and `GIT_WORK_TREE=<worktree>`. It requires exactly one record
  whose HEAD is `hoistline/<jobId>`.
- Symbolic refs: commit and push refuse a `hoistline/<jobId>` that is a symbolic ref (`git symbolic-ref -q` must
  fail), so a runner cannot redirect them to another job's branch. The push sends the validated object id
  (`<sha>:refs/heads/hoistline/<jobId>`). Before the fetch, `refs/remotes/origin/<base>` is deleted with
  `update-ref -d --no-deref`, so a symbolic fetch destination cannot move another branch.
- Base branch components: before the fetch and again before `worktree add`, each directory component of
  `refs/remotes/origin/<base>` (such as `refs/remotes/origin/a` for base `a/b`) must be a real directory. A symlink
  is refused. A regular file there is the stale tracking ref of a former base branch `a`; it is deleted with
  `update-ref -d --no-deref`.
- Before every fetch, `worktree add`, commit, push and prune, the mirror is reset, without ever following a
  symlink:
  - Its `config` is unlinked and written fresh from a fixed template: `[core]`, `repositoryformatversion = 0`,
    `bare = true`, plus the platform values described below, nothing else.
  - `hooks` is removed and recreated as an empty real directory.
  - These are deleted: `commondir`, `gitdir`, `config.worktree`, `FETCH_HEAD`, `shallow`, `logs`,
    `info/attributes`, `info/exclude`, `info/grafts`, `refs/replace`, `objects/info/alternates`,
    `objects/info/http-alternates`, and every `worktrees/*/config.worktree` and `worktrees/*/logs`. (`shallow` and
    `info/grafts` rewrite commit ancestry; `FETCH_HEAD` and reflogs are written through whatever is in place.)
  - A symlink found in place of `info`, `objects/info`, `worktrees` or a `worktrees/<entry>` is removed, never
    followed. More than 10,000 entries in `worktrees` is refused.
  - `refs`, `refs/heads`, `refs/heads/hoistline`, `refs/remotes`, `refs/remotes/origin` and `objects/pack` must be
    real directories, because git writes refs and packs through them; missing ones are created. A symlink or other
    non-directory there is refused.
- The fetch runs with `--no-write-fetch-head`, and every git call with `-c core.logAllRefUpdates=false`. That flag
  alone does not stop git appending to a reflog file that already exists, which is why `logs` is deleted.
- Platform values: once per cache directory the agent runs `git init --template=` (so the owner's
  `init.templateDir` cannot supply them) in a throwaway directory under the cache, keeps only `core.ignorecase`,
  `core.precomposeunicode`, `core.filemode` and `core.symlinks` (each only if present, and only as `true` or
  `false`), and deletes the directory. Those values go into the mirror template and are passed as `-c` to the
  commit, so a case-only rename on macOS is not committed as a second file.
- Replacement objects are off for every git call: `GIT_NO_REPLACE_OBJECTS=1` in the environment and
  `-c core.useReplaceRefs=false`, which also covers replace refs packed into `packed-refs` that the reset cannot see.
  The commit-graph file is ignored (`-c core.commitGraph=false`).
- Control files the agent reads itself (`worktrees/*/gitdir`, the record's `HEAD`, ownership records) are read only
  when they are regular files of at most 4 KiB, never through a symlink.
- The commit flow:
  1. Check the branch is not symbolic and resolve its commit; find the worktree record.
  2. Delete the record's operation state, without following symlinks: `MERGE_HEAD`, `MERGE_MSG`, `MERGE_MODE`,
     `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, `AUTO_MERGE`, `SQUASH_MSG`, `sequencer/`, `rebase-merge/`,
     `rebase-apply/`, `COMMIT_EDITMSG` and `logs/`. (A planted `MERGE_HEAD` pulls another job's commit into the
     branch; `CHERRY_PICK_HEAD` sets the author.)
  3. Build a fresh index: a temporary `GIT_INDEX_FILE` under the cache, filled by `git read-tree <branch commit>`.
     The runner's own index, with any staged entries or `assume-unchanged` / `skip-worktree` flags, is never used.
  4. `git add --all` into it. If that fails, the agent names the first nested repository that is not git-ignored
     (`git check-ignore`); if there is none, it rethrows git's own error.
  5. Refuse a new gitlink (mode 160000, a nested repository with commits), with `--ignore-submodules=none` so a
     `.gitmodules` `ignore = all` cannot hide it. The error is `nested repository at <path> cannot be committed;
     remove its .git directory or add it to .gitignore`.
  6. On a case-insensitive filesystem, `git add --all` cannot see a case-only rename (the index entry still matches
     the file), so tracked paths whose on-disk spelling differs only in case are restaged under the on-disk name
     (gitlinks excluded; more than 200,000 tracked paths is refused). The gitlink check then runs again.
  7. Check for staged changes by exit code (`git diff --cached --quiet --ignore-submodules=none`), so a large change
     set cannot overflow an output buffer, then commit and delete the temporary index.
- No remote is stored. The URL `https://github.com/<owner>/<name>.git`, derived only from the canonical repo, is
  passed explicitly to every fetch and push.
- Every git call also gets `-c` overrides: fsmonitor off, submodule recursion off, fsck on transfer, automatic
  maintenance and gc off (`maintenance.auto=false`, `gc.auto=0`; fetch and commit otherwise start them, and a
  detached gc can keep writing after the repo lock is released), and every transport except https disabled. Each git call runs with a scrubbed environment. The push never forces and never
  pushes tags.
- Hooks: `core.hooksPath=/dev/null` on macOS and Linux, which cannot hold a hook. On Windows, each git call gets a
  directory created empty for it under the cache and removed afterwards (best effort: a failed removal never hides
  git's result or error). Hooks such as `post-checkout`,
  `reference-transaction` and `prepare-commit-msg` run even with `--no-verify`, so this is the only switch.
- Network calls also abort a transfer that stays below 1 byte/s for 60 s. They have an overall timeout (5 minutes
  by default) that kills git's whole process tree: the process group on macOS and Linux, `taskkill /T` on Windows.
  A descendant that left the process group can keep git's output pipes open; after the kill the agent waits at
  most 5 seconds more, then closes the pipes and fails the call, so the repo lock is always released.

**Accepted residual risk, stated plainly.** Restricted mode checks the repo, runner and model before the job
starts. It does not sandbox the runner. Runners run as the owner, so a runner can do whatever that CLI can do as the
owner's user. In particular:

- It can modify `~/.gitconfig` and any other file the owner can write. That includes `include.path` and
  `includeIf` entries in the owner's global git config, which the agent reads (it needs the owner's credential
  helpers) and cannot control.
- It can push or otherwise use the owner's credentials directly.
- A runner still running during another job's git operation can race the mirror: it can write between the reset
  (or a check such as the symbolic-ref check) and the git call that follows it. The same applies to files git
  writes during a call, such as `COMMIT_EDITMSG`, if a symlink is planted after they were deleted.
- A process the runner started can keep running after a timed-out git call; the agent stops waiting for it but
  cannot kill it once it has left git's process group.
- File names are not Unicode-normalized by the agent beyond what git does.
- A runner can write into the shared object store and its metadata: corrupt or substitute packs, loose objects,
  pack indexes or the commit-graph file. Ignoring the commit-graph and replace refs removes the easy routes, but
  only a per-job git directory (no shared object store) would close this. That is not adopted in v1.

**Git LFS is unsupported in v1.** The commit runs with the reset mirror template, but the owner's global config still
applies, so on a machine with git-lfs installed its clean filter runs when the commit stages LFS-tracked files. The
push runs with hooks disabled, so git-lfs's pre-push hook never uploads the LFS objects, and the pushed branch would
point at LFS objects GitHub does not have.

The hardening above protects against accidental or prompt-injected runner behavior, and against poison left in the
shared mirror carrying over from one job into the next. It does not protect against a deliberately malicious runner.

**Rules for adapters:**

- Do not rely on a CLI's own sandbox to isolate one job from another.
- Never add the shared mirror (`<cacheDir>/repos/...`) to a CLI sandbox's writable roots. Note that a worktree's git
  metadata lives in the mirror, so a sandbox that lets the runner commit already has write access to it.

## Running a job: `runJob`

`runJob(spec, dir, onOutput, signal, opts?)` in `packages/agent/src/runners/run.ts` builds the command with
`buildCommand(spec, { cwd: dir })` and runs it:

- `spawn` with `shell: false` and `cwd = dir`. On macOS and Linux the runner is `detached`, so it leads its own
  process group.
- Stdin gets the template's `stdin` text (if any) and is then closed, so no CLI waits on a terminal.
- Environment: the owner's own (the CLIs need their logins and credentials) minus every variable whose name starts
  with `GIT_` or `HOISTLINE_` (compared case-insensitively). The agent's git pinning or an inherited `GIT_DIR` never
  reaches the runner, and nothing in it can steer the runner's git.
- Output goes to `onOutput(chunk, "stdout" | "stderr")` as it arrives, in pieces of at most 16 KiB of UTF-8, never
  splitting a character. If `onOutput` throws, the exception is caught and counted (`outputErrors` in the result)
  and the job carries on, so a bad callback cannot crash or hang a job.
- Abort (`signal`) and the maximum runtime (`opts.timeoutMs`, default 60 minutes) take the same path: SIGTERM to
  the whole process group, then SIGKILL to the group after `opts.termGraceMs` (default 2 s), even if the leader has
  already exited. On Windows: `taskkill /T /F`.
- After the runner exits, the agent waits at most `opts.killGraceMs` (default 5 s) for the output pipes to close,
  then closes them itself, so a descendant that left the process group and holds the pipes cannot hang the job.
- Result: `{ exitCode, timedOut?, aborted?, outputErrors? }`. `exitCode` is the exit code, or 128 + the signal
  number when the runner was killed by a signal (143 for SIGTERM, 137 for SIGKILL). A timeout gives exit code 124
  and `timedOut: true`; an abort gives `aborted: true`. A nonzero exit is a value, never an exception. A signal that
  is already aborted when `runJob` is called spawns nothing and gives `{ exitCode: 130, aborted: true }`.
- Errors: a CLI that is not on `PATH` throws `RunnerNotInstalledError` (`runner_not_installed: <file>`). A `dir`
  that is not a directory, or any other failure to start (for example `E2BIG`, see Muse below), throws a plain
  `Error`.

## Prompt preamble

Muse and Codex never see the user's prompt alone. Their adapters send `RUNNER_PREAMBLE + PROMPT_DELIMITER + prompt`
(constants in `packages/agent/src/runners/prompt.ts`). The preamble tells the CLI to work only inside the current
directory, not to run `git commit`, `git push`, `git config` or `git remote`, not to modify git configuration or
files outside the working directory, and to leave its changes uncommitted (the agent commits afterwards). The
delimiter is `\n\n===== TASK =====\n\n`; the user's prompt follows it byte for byte. This is an instruction to a
model, not a control: the sandbox notes below and the hardening above are what actually limit a runner.
`build-test` gets no preamble.

## Invocations

| Runner | Added by | Executable | Exact non-interactive invocation | Prompt via | Model flag |
| --- | --- | --- | --- | --- | --- |
| Muse | Task 8 | `muse` (Muse Code 1.4.14) | `muse exec --json --approval-mode never --disable-request-user-input --workspace <worktree> [--model <model>] -- <preamble + prompt>` | one positional after `--` (no stdin form) | `--model <model>` |
| Codex | Task 8 | `codex` (codex-cli 0.161.0) | `codex exec --json --ignore-user-config --sandbox workspace-write -C <worktree> [--model <model>] -` | stdin (`-`) | `--model <model>` |
| Cursor | Task 13 | _to be filled in by Task 13_ | _to be filled in by Task 13_ | | |
| Grok | Task 13 | _to be filled in by Task 13_ | _to be filled in by Task 13_ | | |
| build-test | Task 8 | `sh` (Windows: `cmd.exe`) | `sh -c <command>` (Windows: `cmd.exe /d /s /c <command>`) | none; `command` is the one argument after `-c` | n/a |

Sources: `muse --help`, `muse exec --help`, `codex --help` and `codex exec --help` on the owner's machine
(2026-10-29), and the owner's `muse-build` and `codex-build` skills. No model call was made to check them.

**Muse.** `muse exec` runs one prompt headless. It takes the prompt as a positional or `--prompt-file`; it has no
stdin form (`--api-key-stdin` reads a key, not the prompt), so the prompt is the one positional after `--`.
`--prompt-file` was not used: it would mean writing the prompt to a file, and the owner's skill notes the file
belongs inside the workspace, where the runner can rewrite it and it would be committed.

- `--json`: machine-readable JSONL events on stdout (the owner's convention; the final `run.terminal.completed`
  record carries the summary and `run.usage` the tokens), for later tasks to parse.
- `--approval-mode never`: a headless run must not wait on an approval prompt. The help states approval and the
  sandbox are both on by default; this flag changes only approvals. The OS sandbox stays on with its default network
  mode (`proxy-only`). This is the owner's own headless setting.
- `--disable-request-user-input`: withholds the ask-the-user tool, so a run cannot block on a question nobody sees.
- `--workspace <worktree>`: roots Muse's policy-gated workspace tools at the worktree (it is also the `cwd`).
- Not used: `--yolo`, `--disable-sandbox`, `--disable-approval` (each turns safety off, and a safer documented
  mode exists); `--trust-workspace` (it loads the repository's own skills and rules, which are untrusted repo
  content; the owner's skill uses it for their own repos, but a job can name any allowed repo); `-w`/`--worktree`
  (the agent already made the worktree).
- `--` is assumed to end option parsing as in every clap-based CLI; the help does not mention it and it was not
  run.
- Limit: Linux caps one argument at 128 KiB (`MAX_ARG_STRLEN`). A 100,000-character prompt of multi-byte text
  plus the preamble can exceed that; the spawn then fails with `E2BIG` and `runJob` throws a plain error (not
  `runner_not_installed`). macOS has no per-argument cap below its total limit.

**Codex.** `codex exec` reads the prompt from stdin when the prompt argument is `-` (documented in its help), so
the wrapped prompt goes on stdin and nothing from the job reaches the argument list except the validated model.

- `--json`: JSONL events on stdout (the owner's convention).
- `--sandbox workspace-write`: Codex's own sandbox, writable only in the workspace. The help also lists `read-only`
  and `danger-full-access`; `--dangerously-bypass-approvals-and-sandbox` is never used.
- `-C <worktree>`: the sandbox's working root is the worktree. No `--add-dir`: the shared mirror and every other
  directory stay outside the writable roots. A worktree's `.git` is a file pointing into the mirror, so Codex can
  edit files but not commit, which is what the agent wants.
- Network: not enabled. Workspace-write has network access off unless configured, and nothing here turns it on.
- `--ignore-user-config`: does not load `~/.codex/config.toml` (auth still uses `CODEX_HOME`), so the owner's
  interactive settings (extra writable roots, network access, MCP servers with auto-approval, a different default
  sandbox or model) cannot widen a job's sandbox. Consequence: without `--model` the job uses Codex's built-in
  default model, not the owner's configured one.
- Not used: `--skip-git-repo-check` (the worktree is a git checkout; not verified against a worktree whose `.git`
  is a file, so a later task should confirm with a real run), `--approve-for-me`, `--worktree`, `--add-dir`.

**build-test.** `command` reaches the shell as exactly one argument (`["sh", ["-c", command]]`, Windows
`["cmd.exe", ["/d", "/s", "/c", command]]`) in the worktree, with the same environment, output, abort and timeout
handling as every runner. On Windows, Node quotes that argument for `CreateProcess` and `cmd.exe` has its own
quoting rules, so a command with embedded quotes needs checking there (not tested on Windows).
