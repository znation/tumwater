# Write guard on Codex: refuse an `apply_patch` outside the run's worktree

Planned 2026-10-23 · requested by user. Shared design for the nine `Write guard on Codex N/9`
entries in PLANS.md. It extends the write guard that pi, claude and OpenCode runs already carry
(src/agent/write-guard.ts, INV-CW1–CW3) to the codex backend (plans/codex-backend.md).

## Goal

A codex run that patches a file under the team root but outside its own worktree, such as the
primary checkout's copy or another slot's, is refused before the patch applies. The refusal is
the shared `strayWriteRefusal` text, which names the same file inside the worktree, and the model
gets it as the tool's error and goes on.

## Why codex needs its own mechanism

- Every run's checkout sits inside the primary checkout (`<root>/.tumwater/worktrees/<name>`). A
  model that drops that part of an absolute path writes a real file there and nothing complains.
  The other three backends refuse that write at the tool: a pi extension, a claude PreToolUse hook
  passed through `--settings`, and an OpenCode permission plugin.
- Codex 0.163.0 has PreToolUse hooks shaped like claude's. Codex runs a hook only when it is
  trusted, and trust is recorded against a hash of the hook's definition.
- plans/codex-backend.md decided that tumwater never passes `--dangerously-bypass-hook-trust`,
  because that flag would also run the target repo's own `.codex` hooks unreviewed. This design
  keeps that decision.

## Findings, verified live 2026-10-23 (Codex CLI 0.163.0)

1. **A hook passed with `-c` is a hook source.** `-c 'hooks.PreToolUse=[{matcher=…,hooks=[{type="command",command=…,timeout=30}]}]'`
   loads as source `sessionFlags` under `--ignore-user-config`. Without trust it is skipped
   silently. With `--dangerously-bypass-hook-trust` it runs, and the `--json` stream then carries
   an `error` item ("`--dangerously-bypass-hook-trust` is enabled…") on every run.
2. **Trust can ride the same layer.** `-c 'hooks.state={"<key>"={trusted_hash="<hash>"}}'`, passed
   next to the hook, makes it `trusted`. The dotted spelling
   `hooks.state."<key>".trusted_hash=…` does not work: codex reports "ignoring 1 unrecognized
   configuration setting", because the key itself contains dots.
3. **The key and hash come from codex.** `codex app-server` (stdio JSON-RPC: `initialize`,
   `initialized`, `hooks/list {cwds}`) lists each hook with `key`, `currentHash`, `source` and
   `trustStatus`. The first session-flag PreToolUse group's key was
   `/<session-flags>/config.toml:pre_tool_use:0:0`, and its hash was `sha256:<hex>`.
   - The call needs no login and makes no model request; an empty, logged-out `CODEX_HOME` works.
   - The hash covers the definition only: the same hook from another cwd hashed the same, and a
     `timeout` of 31 instead of 30 hashed differently.
   - The hash is not a digest of any simple JSON or command spelling that was tried. Read it from
     `hooks/list`; never compute it.
4. **Production flags keep hooks running.** With tumwater's exact `codexArgs` (including
   `--dangerously-bypass-approvals-and-sandbox` and `--ignore-user-config`), model `gpt-6-luna`,
   the trusted hook ran. Its payload:
   - `{session_id, turn_id, transcript_path, cwd, hook_event_name: "PreToolUse", model,
     permission_mode: "bypassPermissions", tool_name: "apply_patch", tool_use_id,
     tool_input: {command: "*** Begin Patch\n*** Update File: <path>\n@@\n-old\n+new\n*** End Patch"}}`;
   - `cwd` is the run's worktree;
   - the model wrote the absolute primary path first, then the bare `notes.md` after the refusal.
5. **A deny blocks the patch and the model reads why.** The hook printed
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`
   and exited 0. The patch did not apply, and the primary file was untouched.
   - The model received "Tool call blocked by PreToolUse hook: <reason>. Command: <patch>",
     quoted the reason, and retried at the path the reason named.
   - The `--json` stream showed no hook event and no item for the blocked patch, so the stream
     translator (codex-stream.ts) needs no change.
6. **Shell writes are not `apply_patch`.** Codex reports shell calls as `Bash`.
   plans/codex-backend.md's probes saw models edit through the shell (`printf >>`) unless the
   prompt asked for `apply_patch`. The guard only sees `apply_patch`, so the codex dialect should
   send edits there (part 7).
7. **Side effect of a probe:** each run in a new cwd appends a `[projects."<cwd>"] trust_level`
   entry to `$CODEX_HOME/config.toml` (plans/codex-backend.md finding 10). This is unchanged by the
   guard.

## Design

### The hook (parts 1–2)

- `patchWritePaths(patch)` (src/agent/codex/codex-patch-paths.ts, new) lists the paths an
  `apply_patch` text writes: every line that begins at column 0 with `*** Add File: `,
  `*** Delete File: `, `*** Update File: ` or `*** Move to: `.
  - A hunk line (`+`, `-`, space, `@@`) never counts, even when its text looks like a header.
  - Paths are kept as written, relative or absolute.
- `codexWriteRefusal(payload)` (src/agent/codex/codex-write-guard.ts, new) reads only
  `tool_name: "apply_patch"`. It takes the run's directory from the payload's `cwd`: Codex's
  session cwd, which a shell `cd` cannot move, since every shell call is its own `zsh -lc`. It
  returns `strayWriteRefusal(path, cwd)` for the first refused path, or null.
- The hook entry (src/agent/codex/write-guard-hook.ts, new) prints a `deny` decision for a refusal
  and nothing otherwise, and exits 0 either way. Any failure of its own, such as bad stdin or no
  `cwd`, prints nothing, so a broken hook cannot stop every edit.
- **Why `cwd` and not an argument:** the trust hash covers the hook's command line. A per-worktree
  argument, as claude's hook takes, would need a trust lookup per slot. A command that is constant
  per build needs one lookup per build.

### The flags (part 3)

- The definition: matcher `^apply_patch$`, timeout 30, and a command that runs the compiled hook
  with this process's node, falling back to `node` on PATH as the notes shim does:
  `n='<execPath>'; [ -x "$n" ] || n=node; exec "$n" '<dist>/src/agent/codex/write-guard-hook.js'`.
  The hook path resolves from the module, so a staged build (`.tumwater/build/<sha>`) runs its own
  copy and gets its own hash.
- `codexWriteGuardArgs(definition, trust)` returns the two `-c` values of findings 1 and 2. TOML
  basic strings come from one quoting helper.
- An operator `-c`/`--config` passthrough whose key is `hooks` or starts with `hooks.` is refused,
  as the other harness-set keys are (HARNESS_CODEX_CONFIG_KEYS). Codex is last-wins, so it could
  otherwise replace the guard or its trust. `--dangerously-bypass-hook-trust` is already reserved.

### Trust (parts 4–5)

- `lookupCodexHookTrust` (src/agent/codex/codex-hook-trust.ts, new) asks `codex app-server` for
  `hooks/list` with the guard's `-c` flag:
  - under the run's env (`CODEX_HOME`), bounded at 15 s, killing the child either way;
  - it returns the `sessionFlags` / `preToolUse` entry whose command equals the guard's.
- `codexHookTrust(root, …)` caches `{key, hash}` in `.tumwater/state/codex-hook-trust.json`, keyed
  by `codex --version` and the definition. A cache hit spawns nothing, so the lookup runs once per
  build and Codex version, not once per run.
- The codex adapter's `invocation` is synchronous, so the lookup happens earlier, in a new
  optional async `prepare(run)` step on `AgentBackend`. `runAgent` awaits it before
  `invocation()` and never fails a run on its error.
  - Codex's `prepare` is single-flight per process and definition.
  - A failed lookup turns the guard off for the process and logs one `warning`:
    `codex write guard off: <reason>`. Runs still start.

### Runs (part 6)

- When `prepare` has trust, `codexArgs` gets both `-c` values (hook and trust), after the
  harness's own keys and before `-m`, on fresh and resumed runs alike.
- With the guard off it gets neither. An untrusted hook would be skipped anyway, and tumwater never
  passes `--dangerously-bypass-hook-trust`.

### Coverage (part 7)

The codex dialect gains a backend rule: edit and create files with `apply_patch`, not shell
redirection (`>`, `>>`, `tee`) or `sed -i` (finding 6).

### Visibility (parts 8–9)

- Doctor's codex group (from Codex backend part 9/9) gets a `write guard` row:
  - pass: trusted, with the hash's first 12 characters;
  - warn: off, with the reason.
- `smoke:codex` gets a live step: an `apply_patch` to the primary's absolute path is refused and
  then made in the worktree.
  - Its throwaway team keeps its session dir under `<fake root>/.tumwater/sessions`. A session dir
    outside any `.tumwater` root made the OpenCode adapter create a phantom `$TMPDIR/.tumwater` on
    2026-10-23, which turned the host's `full-output` tests red.

## Rejected

- **`--dangerously-bypass-hook-trust`:** it would also run the target repo's own `.codex` hooks
  unreviewed, against plans/codex-backend.md's decision. It also adds an `error` item to every
  run's stream (finding 1).
- **Persisting trust in `$CODEX_HOME/config.toml`:** team runs pass `--ignore-user-config`, so that
  layer is not read. The session layer carries hook and trust together and leaves nothing on disk.
- **Computing the hash:** its input is not documented and did not match simple spellings
  (finding 3). Asking codex survives a Codex change to the hash.
- **A `.codex/hooks.json` in the worktree:** it would be committed with the run's work, and it would
  still need trust.
- **Guarding `Bash`:** a shell command's writes cannot be read from its text, the same gap as
  every other backend. Part 7 narrows it instead.

## Risks

- **`hooks/list` is app-server API, which Codex marks experimental.** A Codex release that changes
  it fails the lookup. The guard then turns off with a warning (part 5) and a doctor warn row
  (part 8), never silently.
- **A Codex release could stop honoring session-flag trust.** The lookup would still succeed while
  the hook is skipped. The smoke step (part 9) is the check for that after each Codex upgrade.
- **Shell writes stay unguarded on codex,** as on every backend. runner-run.ts's stray-write
  warning still reports new paths in the primary checkout after the run.

## Phases

1. **Write guard on Codex 1/9: the paths an `apply_patch` text writes.**
2. **Write guard on Codex 2/9: the hook refuses a stray `apply_patch`.** Requires 1/9.
3. **Write guard on Codex 3/9: the hook's definition and `-c` flags; `hooks` keys reserved.**
   Requires 2/9.
4. **Write guard on Codex 4/9: ask codex for the hook's trust key and hash, and cache them.**
   Requires 3/9.
5. **Write guard on Codex 5/9: an async `prepare` step resolves the trust before a codex run.**
   Requires 4/9.
6. **Write guard on Codex 6/9: codex runs carry the trusted hook.** Requires 5/9.
7. **Write guard on Codex 7/9: the codex dialect sends file edits through `apply_patch`.**
   Requires 6/9.
8. **Write guard on Codex 8/9: doctor's codex group reports the guard.** Requires 6/9 and Codex
   backend 9/9.
9. **Write guard on Codex 9/9: the live smoke step and the docs.** Requires 6/9 and Codex backend
   9/9.
