# Portability & packaging — run tumwater anywhere, against anything

Planned 2026-09-14, requested by the user; audited against main `1384eeb` on 2026-09-15, 1/7
re-audited against `00501fa` on 2026-09-16, 2/7 against `e76c5d5` on 2026-09-17, 6/7 against
`94562d8` on 2026-09-18 (3/7–5/7 and 7/7 remain on `1384eeb`). Full plan
for the `Portability & packaging` entry in PLANS.md: seven independently landable sub-plans, each
with its own goal, design rationale, approach, files touched, and acceptance criteria. The problem
statement, invariants, and sequencing below are shared by all seven.

## The problem

tumwater has only ever run one way: as a checkout of its own repository, on its author's machine,
against a branch named `main`, driving one local MLX server and one 27B model, verified by
`npm test`. Every one of those is baked in somewhere:

- **Nothing is installable.** There is no `.github/`, no CI, and no LICENSE despite
  `"license": "MIT"`. `npm pack --dry-run` ships 230 files / 1.1 MB — PLANS.md (274 KB), BUGS.md,
  every `test/*.ts` and `src/*.ts`, and `tumwater.json` — while `dist/`, the only thing that
  matters, is gitignored and survives into the tarball solely through an npm 11 packlist quirk
  nobody controls.
- **The machine is in git.** The committed `tumwater.json` pins `provider: "omlx"`,
  `model: "Qwen3.8-27B-MLX-oQ4e-mtp"`, `maxConcurrent: 3` (that server's slot count),
  `tickTimeoutSeconds: 54000`, `quietTimeoutSeconds: 3600`, and `idleBackoff.maxSeconds: 36000`
  (all sized to ~8 tok/s local decode). README's `## Notes on local model servers` documents one
  rig down to its `~/.omlx` paths and API key.
- **Config changes ride the target repo's git history.** The director manages `customLoops` by
  editing `tumwater.json` in its worktree and shipping it through commit → review gate → merge
  (plans/user-defined-loops.md). That works only while the file is tracked, and it means an
  adopted third-party repo accrues fleet-authored config commits.
- **The toolchain is assumed.** `src/pi.ts` spawns a binary literally named `pi` on PATH.
  `src/build-check.ts` walks up for `package.json` + `node_modules` and runs `npm run
  test|typecheck|build` — so against a Python, Rust, or Go repo the review gate's build
  pre-check, the red-main baseline gate, and redeploy's green check all silently degrade to "no
  check". `src/prompt.ts` tells every tick its worktree "borrows the install at the repo root,
  two levels up (`../../node_modules`)", which is false anywhere else.
- **Init assumes it owns the repo.** `readInitialPrompt` reads the project brief only from
  README.md's managed markers, and `initProject` hard-fails when a README exists without them —
  so tumwater cannot be pointed at a codebase that already has one.
- **The root is the cwd.** `main()` sets `root = process.cwd()`, and `isGitRepo` passes from any
  subdirectory, so running from one reports "not initialized" for a repo that is initialized and
  would create `.tumwater/` in the wrong place.

What is *not* a problem, verified against this tree: the base branch is already a parameter at
every call site (`mainBranch` threads through loop.ts, orchestrator.ts, merge.ts, review.ts,
lander.ts, worktree.ts), `resolveMainBranch` already reads the checked-out branch rather than
assuming `main`, `ffMainTo` already handles the primary checkout being on another branch, and
`isSelfHosted` already stops a tumwater installed elsewhere from trying to redeploy a user's
project onto tumwater's own history.

## The decision

Make every one of those a runtime input with a sensible default, and publish the result. The
series is ordered so each entry is landable and green on its own, and so nothing is untracked or
untangled before the machinery that depends on it has moved.

## Invariants (none of the seven entries may break these)

1. **No machine in any history.** Nothing committed to any repository names a machine, a model
   server, a model id, an API endpoint, or a value sized to one machine's hardware.
2. **Installed-copy parity.** Every path the harness takes must work for a tumwater installed
   from npm, with no tumwater checkout present on the machine and no assumption that the target
   repo is tumwater. Custom loops included.
3. **The branch is whatever is checked out.** `main` is never assumed; the fleet never creates or
   renames a branch the user did not ask for.
4. **Config is not a commit.** A harness-driven change to fleet configuration never appears in a
   diff, a review prompt, or the target repo's history.
5. **No regression against the old shape.** An npm project on `main` with a tracked config behaves
   byte-identically — every existing test passes unmodified unless an entry names the test it
   changes and why.

## Sequencing

`1/7 → 2/7 → 3/7 → 4/7` is the critical path: 4/7 untracks the config, which silently breaks
custom-loop management until 3/7 has taken it off the commit path. `5/7`, `6/7`, and `7/7` depend
only on 2/7's root resolution and may land in any order after it. 1/7 is first because the other
six all change portability-sensitive behavior and want CI watching them.

---

## 1/7 — GitHub Actions CI and a publishable npm package

**Goal.** Make the harness installable on any machine (`npm i -g tumwater`, `npx tumwater`) and
prove every push green on a clean runner. No behavior change: packaging metadata, a licence, and
two workflows.

**Design (decided, with rationale).**
- **An explicit `files` allowlist, not packlist's gitignore fallback.** `"files": ["dist/src",
  "dist/build-info.json", "README.md", "LICENSE"]` makes both halves explicit — what ships and
  what does not — instead of depending on npm's undocumented treatment of a gitignored `dist/`
  (measured 2026-09-16 against main: a root checkout's `npm pack --dry-run` ships 633 files /
  2.8 MB — 384 untracked machine-local `.claude/` state files, 114 gitignored `dist/` files npm
  packs anyway, and the 135 packed tracked files; the allowlist makes the tarball identical on
  every machine). `dist/test` is deliberately excluded: `dist/src/test-runner.js` resolves it at
  runtime and already reports "run `npm run build` first" when absent, which is the right answer
  for an installed package.
- **`prepack` builds.** The tarball's entire value is `dist/`, which is gitignored, so a publish
  from a clean checkout would ship a package whose `bin` points at a missing file.
  `"prepack": "npm run build"` covers `npm pack`, `npm publish`, and a git-URL install in one
  place so the three cannot drift.
- **Build stamping already degrades correctly — no code change.** `scripts/stamp-build.mjs`
  stamps `dist/build-info.json` with the build checkout's HEAD and its absolute root. From CI
  that root is the runner's workspace, so `isSelfHosted(root, info)` (src/build-info.ts) is false
  for every user repo: `createRedeployer` still constructs, `buildStaleness` returns null for an
  unknown sha, and nothing tries to redeploy a user's project onto tumwater's history. That is
  exactly the documented contract, and the stamp still gives `tumwater doctor` a provenance line.
- **Linux + macOS only.** `npm run build` opens with `rm -rf dist`, and the harness's whole model
  is POSIX (`git worktree`, atomic `rename`, POSIX signals, lock dirs). Windows is out of scope
  and says so in `engines.os` rather than failing mysteriously.
- **Release is tag-driven, never push-to-main.** main is written by an autonomous fleet; every
  landing must not cut a release. A `v*` tag does, and the workflow refuses a tag whose name
  disagrees with `package.json`'s `version`.

**Approach.**
- package.json — add `files`, `prepack`, `repository`, `homepage`, `bugs`, `keywords`,
  `engines.os: ["darwin", "linux"]`; keep `bin` and `engines.node: ">=20"`. Replace `rm -rf dist`
  in `build` with a portable `node -e` removal.
- LICENSE (new) — MIT text; today's tarball carries a licence claim it cannot substantiate.
- .github/workflows/ci.yml (new) — `on: [push, pull_request]`; matrix
  `os: [ubuntu-latest, macos-latest]` x `node: [20, 22, 24]`; checkout, `actions/setup-node` with
  `cache: npm`, a `git config --global user.name/user.email` step (the suite's fixtures set their
  own identity today, but a runner with none must not be able to fail a future one), `npm ci`,
  `npm run build`, `npm test`. `concurrency` cancels superseded runs — the fleet pushes often.
  The suite is 1019 tests, ~1 min locally, so the matrix stays cheap.
- .github/workflows/release.yml (new) — `on: push: tags: ['v*']`;
  `permissions: { contents: write, id-token: write }`; checkout, setup-node with `registry-url`,
  `npm ci`, `npm test`, tag/version agreement check, `npm publish --provenance --access public`,
  then `gh release create` attaching `npm pack`'s tarball.
- README.md — rewrite `## Usage`'s opening: `npm install -g tumwater` (or `npx tumwater`) as the
  primary install, `npm install && npm run build && npm link` as the from-source path. CI badge.
- No new CLI test: test/cli.test.ts's existing "version prints the package version" (line 59)
  already execFiles the compiled `dist/src/cli.js` and asserts package.json's version — the
  exact pin this sub-plan wanted for the installed tarball.

**Files touched.** package.json, LICENSE (new), .github/workflows/ci.yml (new),
.github/workflows/release.yml (new), README.md. No source or test changes.

**Acceptance criteria.**
- `npm pack --dry-run` lists only `dist/src/**`, `dist/build-info.json`, `README.md`, `LICENSE`,
  and `package.json` — no PLANS.md, no BUGS.md, no `test/`, no `src/*.ts`, no config.
- `npm pack` in a checkout with no `dist/` still produces a working tarball (prepack built it);
  installing it globally on a machine with no tumwater checkout gives a `tumwater` on PATH whose
  `version`, `help`, and `doctor` all run.
- CI green on ubuntu-latest and macos-latest across Node 20/22/24 from a cold cache, with no
  global git identity beyond the workflow's own step. (The first run may surface Linux-only
  failures in a suite that has only ever run on macOS; fixing them is part of this entry.)
- Pushing tag `v0.1.1` while `package.json` says `0.1.0` fails the release workflow before
  anything is published.

**Refined 2026-09-16 (plan loop) — audited against main `00501fa` (build clean, suite 1019/1019 per the README's stamp at 10c8ae6; this series had no audit since `074e48f` wrote it on 2026-09-15, and no landing since then touches this sub-plan's anchors — the `--since=2026-09-13` log over package.json/tsconfig.json is empty, and the landings since are markdown, TUI-test, and orchestrator-only). Every load-bearing claim verified on this tree; two pins corrected in place (the redundant `version` test, the test count), and the tarball facts re-measured from a root checkout and a worktree.**

Verified as written: package.json — `files`, `prepack`, `repository`, `homepage`, `bugs`, `keywords`, and `engines.os` are all absent (the Approach adds them), `bin` is still `dist/src/cli.js`, `engines.node` is still ">=20", `build` still opens with `rm -rf dist` (the `node -e` replacement target), and `license: "MIT"` is declared with no LICENSE file on disk — "a licence claim it cannot substantiate" holds. No `.github/` directory and no `.npmignore`, so the packlist behavior the allowlist replaces is today's default. `scripts/stamp-build.mjs` stamps through build-info.ts' `stampBuild(root, dist, sha?)` — `dist/build-info.json` with the checkout's HEAD and `path.resolve(root)`, and no resolvable HEAD → no stamp at all — so the "build stamping already degrades correctly" bullet holds for a CI checkout. `isSelfHosted` (src/build-info.ts line 67) is false when the stamp's `root` differs from the run root or the sha is not in the repo's history — the "never redeploy a user's project" contract holds. `dist/src/test-runner.js` (src/test-runner.ts lines 39/46) reports "run `npm run build` first" when `dist/test` is absent — the dist/test exclusion rationale holds. The suite's fixtures set their own git identity (test/util.ts lines 25-26) — the runner-identity step's rationale holds. package-lock.json is tracked, so CI's `npm ci` and setup-node's `cache: npm` both work. `version`/`--version`/`-v` exists (src/cli.ts line 492) and reads `../../package.json` — present in every tarball, so an installed copy reports its version. README's `## Usage` (line 185) still opens with `npm install && npm run build` — the rewrite anchor holds.

Corrections (pinned in place):
1. **The `version` test already exists.** test/cli.test.ts line 59 ("version prints the package version") execFiles the compiled `dist/src/cli.js` and asserts package.json's version — the exact pin the old Approach bullet asked to add, already in the suite. The bullet is replaced with a pointer, test/cli.test.ts leaves Files touched, and "No source or test changes" is true; an implementer following the old text would have shipped a duplicate test.
2. **Test count 970 → 1019** (the ci.yml bullet) — the suite has grown since the series was written; the "matrix stays cheap" conclusion is unchanged.
3. **Tarball facts re-measured** (`npm pack --dry-run`, 2026-09-16): the PLANS.md entry's "230 files / 1.1 MB" is stale in both numbers, and the quirk is worse than "dist by a packlist quirk" — a root checkout packs 633 files / 2.8 MB: 384 untracked machine-local `.claude/` state files, 114 gitignored `dist/` files npm packs anyway, and the 135 packed tracked files (137 tracked, minus `.gitignore` and `package-lock.json`, which npm drops from the pack); a worktree checkout (no `dist/` on disk) packs those 135 / 866 kB. Without the allowlist, a publish from this machine ships `.claude/` — the Design bullet is strengthened with the measured numbers and the PLANS.md bullet corrected to match.

Sizing unchanged: one package.json edit block, a LICENSE, two workflow files, one README rewrite, no source or test changes. One run. No design question remains open.

---

## 2/7 — Resolve the repo root, and target any branch

**Goal.** Run the fleet against any repository, from anywhere inside it, targeting whatever branch
that repo's primary checkout is on. The branch plumbing is already parameterized end to end; what
is missing is a correct root, an explicit override, and the guards that keep a resolved branch
honest.

**Design (decided, with rationale).**
- **Root is the git toplevel, not `process.cwd()`.** From a subdirectory `isGitRepo(root)` still
  passes (`rev-parse --git-dir` works from anywhere), so `requireReadyRepo` fails with "not
  initialized" for a repo that IS initialized, `.tumwater/` would land in the subdirectory, and
  `readBranchHead`'s file fast path silently degrades to a subprocess every poll because
  `<subdir>/.git` is not a directory. Resolve once via `git rev-parse --show-toplevel`, falling
  back to cwd only when the probe fails so `doctor` outside a repo still reports why.
- **Base branch precedence: `--branch <name>` → `baseBranch` in config → the checked-out branch.**
  The default stays "whatever is checked out", which is what makes it branch-agnostic; the
  overrides exist for a fleet pointed at a long-lived integration branch while a human works
  elsewhere in the same checkout.
- **Validate the resolved branch before the first tick.** `resolveMainBranch` today only rejects a
  detached HEAD. An explicit override naming a branch that does not exist must fail at startup
  listing what does, not at the first `git worktree add`.
- **Warn, do not reconfigure, when the primary checkout moves.** The branch is resolved once at
  startup; if a human checks out something else mid-run the fleet keeps fast-forwarding the branch
  it started on — the safe behavior, since every role worktree is based on it. One edge-triggered
  `warning` event makes the divergence visible instead of mysterious.
- **`git init -b` honors the user's default.** src/init.ts hardcodes `-b main` for a brand-new
  repo. Use `--branch` when given, else git's own `init.defaultBranch`, else `main`.
- **No `mainBranch` → `baseBranch` rename.** Considered and deferred: the identifier is already a
  parameter at every call site, so a rename buys readability at the cost of a ~60-site diff across
  ten files plus the persisted `main_red` TickResult value and the `build_stale` event name, which
  are on-disk contracts. User-facing strings ("check out your main branch first") are corrected
  where this entry already touches them.

**Approach.**
- src/git.ts — `repoToplevel(dir): Promise<string | null>` and `branchExists(root, branch)`.
- src/cli.ts — `main()` resolves `root = (await repoToplevel(cwd)) ?? cwd` before dispatch;
  `resolveMainBranch(root, config, branchArg)` implements the precedence and validates existence
  — `branchArg` is the parsed `--branch` value, `string | null`; `run`'s flag spec gains
  `--branch <name>`: the `run` case's `rejectUnknownArgs("run", args, [])` (line 341) gains
  `{ names: ["--branch"], value: true, valueName: "<name>" }`, `cmdRun(root)` (line 109) gains
  the args and calls `parseBranchFlag(args)` there, the way the `wake` command calls
  `parseRoleFlag`; the help block's `run` line (line 49) gains the `--branch <name>` spelling
  the way `wake` shows `--role` (line 67); the start line prints the resolved root when it
  differs from cwd (it already prints the branch — line 135: `tumwater running on branch
  ${mainBranch}${build} — Ctrl+C to stop`).
- src/cli-args.ts — `parseBranchFlag(args)` beside `parseRoleFlag`, rejecting empty or
  `-`-leading values.
- src/types.ts + src/config-validation.ts — `baseBranch?: string` on TumwaterConfig and in
  `TOP_LEVEL_KEYS`, validated as a non-empty string.
- src/orchestrator.ts — once per poll, compare `currentBranch(root)` against the resolved base and
  log one `warning` on a change (edge-triggered via a local).
- src/init.ts — resolve the init branch as above; `initProject` takes an optional branch.
  `InitResult` (line 75) gains the branch the repo was created on, and `cmdInit`'s "initialized
  a new git repository on branch main" line (cli.ts line 103) prints it instead of the
  hardcoded `main`; the rationale comment at lines 107–108 ("a fresh repo has no history for an
  init.defaultBranch preference to protect") is superseded by the new behavior, which
  deliberately honors `init.defaultBranch`, and must be rewritten with it.
- src/doctor.ts — `checkRepo` reports the resolved toplevel and the branch the fleet would target,
  and fails when a configured `baseBranch` does not exist.
- Tests: test/git.test.ts (toplevel from a subdirectory; `branchExists`), test/cli.test.ts
  (commands from a subdirectory; `--branch` overrides; an unknown `--branch` fails listing what
  exists), test/orchestrator.test.ts (the branch-change warning fires exactly once),
  test/init.test.ts (`init.defaultBranch` respected), test/loop.test.ts (one end-to-end tick
  fixture on a repo whose only branch is `trunk`).

**Files touched.** src/git.ts, src/cli.ts, src/cli-args.ts, src/types.ts, src/config-validation.ts,
src/orchestrator.ts, src/init.ts, src/doctor.ts, test/git.test.ts, test/cli.test.ts,
test/orchestrator.test.ts, test/init.test.ts, test/loop.test.ts.

**Acceptance criteria.**
- `tumwater status` / `run` / `tui` / `doctor` behave identically from the repo root and from any
  subdirectory of it.
- A repo whose only branch is `trunk` (no `main` anywhere) runs a full tick → review → merge
  cycle, with the commit landing on `trunk`.
- `tumwater run --branch release/2.0` targets that branch; naming a nonexistent branch fails at
  startup listing the branches that exist.
- Checking out a different branch in the primary checkout mid-run logs exactly one warning and
  does not change what the fleet merges into.
- `tumwater init` in an empty directory with `init.defaultBranch=trunk` creates the repo on
  `trunk`.

**Refined 2026-09-17 (plan loop) — audited against main `e76c5d5` (build clean, suite 1021/1021 per the README's stamp; this sub-plan's last audit was the 2026-09-15 series write `074e48f` against `1384eeb`, thirty-five landings back). Since then the anchor files moved in a line-shifting wave — `6322625` (wake: cli.ts gains `cmdWake` below this entry's anchors), `4bf85cc`/`bdec4f1`/`776fa0f` (orchestrator.ts' drain and slot rework — nothing this entry touches), `4dba580` (types.ts +5), `a94c1e7` (cli.ts/doctor.ts two-line `shortSha` swaps, no line shift) — while src/git.ts, src/cli-args.ts, src/init.ts, and src/config-validation.ts took zero commits. Every load-bearing claim re-verified on this tree; two in-place corrections close the questions the write left open (the flag-parsing seam, and init's hardcoded "on branch main" output).**

Verified as written: src/cli.ts — `main()` still sets `root = process.cwd()` (line 335) as the single dispatch point every command's root flows through; `resolveMainBranch(root)` (line 78) still only rejects a detached HEAD ("check out your main branch first") and returns `currentBranch(root)` — the precedence and existence-validation work is still to do, as written; `requireReadyRepo(root)` (line 84) is the `isGitRepo` + tumwater.json + `hasCommits` gate, and its "not a git repository (run `git init` first)" message is exactly the misdiagnosis the root fix removes from subdirectories; the `run` case takes no flags today (`rejectUnknownArgs("run", args, [])`, line 341, `cmdRun(root)` at 342) and the `gui` case is the in-tree idiom for a valued flag (`rejectUnknownArgs` spec array, lines 350–353). src/git.ts — `readBranchHead` (line 97) is the file fast path the Problem section cites: `statSync(<root>/.git)` returns null when `.git` is absent (a subdirectory) or is a worktree-pointer file, so a subdirectory root silently degrades to a spawn per poll, as written; `isGitRepo(dir)` (line 138, `rev-parse --git-dir`) passes from any subdirectory; `currentBranch(root)` (line 178) is what both the precedence and the mid-run divergence check read; neither `repoToplevel` nor `branchExists` exists yet, so the two new exports collide with nothing. src/cli-args.ts — `parseRoleFlag(args, validIds?)` (line 44) is the template the entry names — `args.indexOf`, `fail` on a missing value, typed return — and `parsePortFlag` (line 30) is the value-side companion; `parseBranchFlag` beside them holds. src/init.ts — `git(root, "init", "-b", "main")` (line ~112) is still hardcoded with the now-superseded rationale comment at 107–108, `InitResult` (line 75) still has no branch field, and `cmdInit`'s "on branch main" output (cli.ts line 103) still hardcodes it. src/doctor.ts — `checkRepo(root)` (line 50) is the reported site. src/types.ts — `TumwaterConfig` (line 63) is where `baseBranch?: string` lands; the no-rename bullet's on-disk contracts both survive: the `main_red` TickResult (line 132) and the `build_stale` event (line 255). src/config-validation.ts — `TOP_LEVEL_KEYS` (lines 33–53, ending `"customLoops", "roles"`) is where `"baseBranch"` goes, validated non-empty beside the other top-level rules. src/orchestrator.ts — `RunOptions` already carries `mainBranch` (line 71), so the poll loop's (line 378) once-per-poll divergence check compares against the resolved base with no signature change. The Problem section's "not a problem" half holds: `mainBranch` still threads loop/orchestrator/merge/review/lander/worktree, and `ffMainTo`'s detached-primary arm is untouched. All six named test files exist (test/git.test.ts, test/cli-args.test.ts, test/cli.test.ts, test/orchestrator.test.ts, test/init.test.ts, test/loop.test.ts).

Corrections (pinned in place):
1. **The flag-parsing seam.** The write said "`run`'s flag spec gains `--branch <name>`" and "src/cli-args.ts — parseBranchFlag(args)" without saying who calls what, and its `resolveMainBranch(root, config, args)` signature left open whether `args` is raw command args or a parsed value. Pinned: `rejectUnknownArgs` validates the spelling in `main()`, `cmdRun` receives the args and calls `parseBranchFlag(args)` (the `parseRoleFlag` idiom), and `resolveMainBranch` takes the parsed value as `branchArg`.
2. **Init's "on branch main" output.** The write's init bullet did not name `cmdInit`'s hardcoded output line, `InitResult`, or the rationale comment; an implementer could land the branch resolution and leave "initialized a new git repository on branch main" lying. Pinned: `InitResult` gains the created branch, `cmdInit` prints it, and the superseded comment is rewritten with the change.

Sizing unchanged: src/git.ts ~20 lines (repoToplevel + branchExists), src/cli.ts ~25 (root resolution, precedence + existence validation, the flag, the help line, the init output), src/cli-args.ts ~10, types/config-validation ~5, src/orchestrator.ts ~10 (the edge-triggered warning local), src/init.ts ~15, src/doctor.ts ~10, and the six test files ~150, the `trunk` end-to-end fixture in test/loop.test.ts the largest. One run. No design question remains open.

---

## 3/7 — Harness-mediated config writes: take custom loops off the commit path

**Goal.** Make `customLoops` management independent of whether the config file is tracked, of
whether the target repo is tumwater's own, and of the review/merge cycle — so custom loops work on
an installed copy of tumwater against any repository, exactly as invariant 2 requires.

Today the director edits `<worktree>/tumwater.json` and the edit reaches the primary checkout only
by commit → review gate → merge (plans/user-defined-loops.md, "Shared design" and invariant 4).
That ties a configuration change to the target repo's git history in three ways that each break
portability: **the file must be tracked** — an untracked or gitignored file does not exist in a
`git worktree add` checkout at all, and `git add -A` skips a gitignored path, so the edit vanishes
silently; **an adopted third-party repo accrues fleet-authored config commits**; and **a rejected
or conflicted director tick silently drops an explicit user instruction**, which is the only
reason `tumwater.json` had to be added to `review.exemptPaths` in the first place.

**Design (decided, with rationale).**
- **A request file inside the director's own worktree.** After its pi run the director may leave
  `.tumwater-config-request.json` at its worktree root: `{ "customLoops": [ { "name", "task" }, … ] }`
  — the whole array, replacing the current one, which is exactly the edit shape the director
  already produces today. It writes inside its worktree, so COMMON_RULES' "stay inside your
  worktree; never write above it" rule is untouched and no new write permission is carved out.
- **Consumed before the commit, never committed.** The director's tick path reads the request
  immediately after the pi run and before `commitAll`: validate → apply → delete. Deleting before
  `git add -A` means the request never enters a diff, never reaches the review gate, and never
  lands in the project's history (invariant 4). A tick that made no other change ends `no_change`.
- **Applied atomically to the live config**, reusing `setDailyBudgetUsd`'s existing idiom in
  src/config.ts — fresh `loadConfig` (bypassing the stat cache, since a writer must see the latest
  file), merge only the permitted key, then `writeJsonAtomic`. The orchestrator's ~2 s live reload then
  starts the new loop with no restart and no merge: strictly faster and more reliable than today's
  commit → review → merge → reload chain.
- **The permitted key set is enforced in code, not only in prose.** Today "every other key in that
  file stays untouched" is a sentence in the director's prompt, and the review exemption means
  nothing catches a model that ignores it — it could rewrite the budget or disable roles.
  `applyConfigRequest` accepts `customLoops` and nothing else, and logs a warning naming any other
  key it discarded.
- **Validation before apply; last-known-good on failure.** The merged candidate goes through
  `validateConfig` before the write; on failure nothing is written, one warning event names the
  problems, and the request file is deleted anyway so a malformed request cannot retry forever.
  Same degradation the live reload already guarantees.
- **`tumwater.json` leaves `review.exemptPaths`.** The config can no longer appear in any diff, so
  the exemption — added solely to stop the gate discarding director config edits — has nothing
  left to exempt, and removing it closes the path where a director tick could land a mixed
  doc-plus-config diff unreviewed.
- **plans/user-defined-loops.md is updated as part of this landing.** Its "the edit lands like any
  other director change: commit → review gate → merge → live reload" bullet, its
  `review.exemptPaths` bullet, and invariant 4 all describe the superseded mechanism. Invariant
  4's *substance* — only the director changes `customLoops`, and only `customLoops` — is preserved
  and now enforced by `applyConfigRequest` rather than by prompt text alone.

**Approach.**
- src/paths.ts — `configRequestPath(wt)` = `<wt>/.tumwater-config-request.json`.
- src/config.ts — `applyConfigRequest(root, wt): { applied: string[]; ignored: string[]; error?: string } | null`
  (null when no request exists): read, permit-filter, validate, atomic write, delete. The atomic
  writer already exists and is already shared — `writeJsonAtomic(file, value, trailingNewline)` in
  src/json-files.ts, which `setDailyBudgetUsd` was moved onto by 1963677 — so this adds a second
  caller, not a new helper.
- src/loop.ts — call it in the director tick path between the pi run and `commitAll`; log
  `config_changed` (applied names) or `warning` (rejected/ignored).
- src/types.ts — `config_changed` in `HarnessEvent["type"]`; src/ui/event-format.ts — one case.
- src/prompt.ts — replace the director-only "you may edit tumwater.json" exception with the
  request-file contract and a worked example; COMMON_RULES' blanket "never touch the .tumwater
  directory or tumwater.json" now applies to the director too, with no exception.
- src/config.ts `defaultConfig()` — drop `"tumwater.json"` from `review.exemptPaths`.
- plans/user-defined-loops.md — supersede the three bullets named above.
- Tests: test/config.test.ts (permitted key applied; a disallowed key ignored with a warning; an
  invalid candidate leaves the file untouched; the request file is always deleted),
  test/loop.test.ts (a director tick with a request adds a loop without producing a commit; the
  request never appears in a diff), test/prompt.test.ts (the director prompt names the request
  file and no longer grants a tumwater.json exception), test/event-format.test.ts.

**Files touched.** src/paths.ts, src/config.ts, src/loop.ts, src/types.ts, src/prompt.ts,
src/ui/event-format.ts, plans/user-defined-loops.md, test/config.test.ts, test/loop.test.ts,
test/prompt.test.ts, test/event-format.test.ts.

**Acceptance criteria.**
- Prompting the director "add a loop named docs that keeps the examples current" adds it to the
  config and starts it ticking within ~2 s, with no commit on the target branch and no
  review-gate run.
- The same prompt works identically when the config file is gitignored and absent from every
  worktree — the state 4/7 makes the default.
- A request naming `maxDailyCostUsd` changes nothing, logs a warning naming the ignored key, and
  still applies `customLoops`.
- A request whose entry fails name/task validation writes nothing and leaves the previous config
  live; the fleet keeps running.
- The request file never appears in a commit, a diff, or a review prompt.
- `review.exemptPaths` no longer lists `tumwater.json`, and the existing user-defined-loop tests
  pass with only the documented changes.

---

## 4/7 — Untrack the config; ship a template

**Goal.** Take every machine- and model-specific value out of version control (invariant 1).
Depends on 3/7: until the director is off the commit path, untracking the config silently breaks
custom-loop management.

**Design (decided, with rationale).**
- **One untracked config, one tracked template.** `tumwater.json` is gitignored in every project
  (`init`'s `ensureGitignore` adds it beside `.tumwater/`); `tumwater.example.json` is tracked and
  is the project's shareable baseline. `tumwater init` seeds `tumwater.json` from the example when
  one exists, else from `defaultConfig()`. **No second config file and no overlay:** with the whole
  file per-machine there is nothing left for a `tumwater.local.json` to separate, and one file
  means one live-reload path, one validator, one writer. (An earlier draft of this plan proposed a
  tracked/untracked split purely to preserve the director's commit path; 3/7 removes that
  constraint, and with it the need for the split.)
- **The template is the project's shared config, including `customLoops`.** A team that wants
  everyone running the same loops, review settings, and check command commits them to
  `tumwater.example.json`; a collaborator's `init` picks them up, and their own machine keys go in
  their untracked copy. A loop the director adds lands in the live config only — promoting it to
  the template stays a deliberate human act, which is right: one person's experiment should not
  become everyone's loop by accident.
- **`doctor` reports template drift.** Keys present in `tumwater.example.json` but absent from the
  local `tumwater.json` are reported at `warn` with their values, so a project baseline that gains
  a `check.command` or a new custom loop is visible on every machine instead of silently missing.
  Never auto-merged: the local file belongs to the user.
- **The repo's own `tumwater.json` is removed from tracking** (`git rm --cached`), its generic half
  becomes `tumwater.example.json`, and its machine half survives only in the untracked working
  copy.
- **README's `## Notes on local model servers` becomes `docs/backends.md`** — what tumwater needs
  from a backend (an OpenAI-compatible endpoint pi can reach; a context window large enough for a
  tick prompt), how to point `provider`/`model` at it, and how `fleetModelsFree()` reads pi's
  `models.json` costs to decide the budget badge. The concrete oMLX numbers survive there as one
  clearly labelled worked example, not as "the current backend".

**Approach.**
- src/paths.ts — `exampleConfigPath(root)`.
- src/config.ts — `seedConfig(root)` (example → defaults) and `exampleDrift(root)` for doctor.
- src/init.ts — seed from the example; `ensureGitignore` also adds `tumwater.json`; the config
  leaves the committed file list while `created` still reports it so the user sees it was made.
- src/doctor.ts — `checkInit` reports which file seeded the config, and any drift.
- tumwater.json (`git rm --cached`), tumwater.example.json (new), .gitignore, docs/backends.md
  (new), README.md.
- Tests: test/init.test.ts (seeds from the example; gitignored; never committed; falls back to
  defaults with no example), test/config.test.ts (drift detection), test/doctor.test.ts.

**Files touched.** src/paths.ts, src/config.ts, src/init.ts, src/doctor.ts, tumwater.json
(untracked), tumwater.example.json (new), .gitignore, docs/backends.md (new), README.md,
test/init.test.ts, test/config.test.ts, test/doctor.test.ts.

**Acceptance criteria.**
- `git ls-files` shows no `tumwater.json`; `git log -p` over a repo tumwater has worked in shows
  nothing naming a machine, a server, a model, or a concurrency sized to one GPU.
- A fresh clone with no `tumwater.json` runs `tumwater init`, gets the project's
  `tumwater.example.json` baseline, and runs on pi's own default provider/model until the user
  sets one.
- Adding a custom loop through the director (3/7) works with the config gitignored and absent from
  every worktree.
- `doctor` warns, naming the keys, when the example has moved ahead of the local file, and never
  rewrites the local file.
- **Operational note for whoever lands this:** the repo's current `provider`, `model`,
  `maxConcurrent: 3`, `tickTimeoutSeconds: 54000`, `quietTimeoutSeconds: 3600` and `idleBackoff`
  must already be present in the untracked working copy before this lands, or the dogfood fleet's
  ticks start timing out at the 1800 s default mid-run.

---

## 5/7 — Make the agent binary configurable

**Goal.** Stop assuming the agent CLI is a binary literally named `pi` on `PATH`. src/pi.ts spawns
`spawn("pi", …)`, and both src/cli.ts's `cmdRun` preflight and src/doctor.ts's `checkPiBinary`
gate on `findOnPath("pi")` — so a non-PATH install, a wrapper script, or two pi builds side by
side are all impossible.

**Design (decided, with rationale).**
- **Resolution order: `TUMWATER_PI_BIN` → `agentBin` in config → `"pi"`.** An absolute or
  `./`-relative value is used as given; a bare name is resolved on PATH. The env variable exists
  for one-off runs and for CI, where the value differs per job.
- **This is deliberately NOT an agent-CLI abstraction.** The argv pi accepts (`--print --mode json
  --session-dir --continue -n --provider --model --thinking`) and its JSON event protocol are
  woven through pi.ts's stream parser, review.ts's verdict contract, and the resume path. What
  this entry buys is a different *install* of pi: a non-PATH location, a wrapper that sets env or
  picks a host, a second build for A/B. A general "any agent CLI" adapter is a separate, much
  larger design, recorded here only so nobody reads this entry as having delivered it.
- **Errors name what was actually resolved.** `SPAWN_ERROR_PREFIX`'s message, `cmdRun`'s fail text,
  and doctor's line all print the resolved binary and where the value came from (env, config,
  default) — a wrong `agentBin` must not read as "pi is not installed".

**Approach.**
- src/types.ts + src/config-validation.ts — `agentBin?: string` on TumwaterConfig and in
  `TOP_LEVEL_KEYS`, validated as a non-empty string.
- src/pi.ts — `resolveAgentBin(config): { bin: string; source: "env" | "config" | "default" }`;
  `spawn(resolved, …)`; the spawn-error message names it.
- src/cli.ts — `cmdRun`'s preflight resolves through the same helper instead of
  `findOnPath("pi")`, and its failure names the resolved value and source.
- src/doctor.ts — `checkPiBinary` becomes `checkAgentBinary`, printing the resolved path and
  source; the install hint stays for the default case.
- tumwater.example.json — a commented `agentBin` entry (4/7 owns the template).
- Tests: test/pi.test.ts (env beats config beats default; an absolute path bypasses PATH; the
  spawn-error message names the resolved binary), test/cli.test.ts (preflight failure text),
  test/doctor.test.ts (all three sources).

**Files touched.** src/types.ts, src/config-validation.ts, src/pi.ts, src/cli.ts, src/doctor.ts,
tumwater.example.json, test/pi.test.ts, test/cli.test.ts, test/doctor.test.ts.

**Acceptance criteria.**
- With `pi` absent from PATH but `agentBin` set to an absolute path, `tumwater run` starts and
  ticks normally; `doctor` reports the resolved path and `config` as its source.
- `TUMWATER_PI_BIN` overrides `agentBin` for one invocation without editing any file.
- A wrapper script at `agentBin` that exports an env var and execs the real pi produces
  byte-identical tick behavior (the existing `fakePi` test helper already installs a stub at the
  front of PATH and exercises this shape).
- With none of the three resolving to an executable, `run` and `doctor` both fail naming the
  resolved value, its source, and the install hint.

---

## 6/7 — Make the project's verification command configurable

**Goal.** Stop assuming the target project is an npm project. `detectBuildCheck`/`runBuildCheck`
walk up for a directory holding both `package.json` and `node_modules`, then run
`npm run test|typecheck|build`. Against a Python, Rust, or Go repo the walk finds nothing, so the
review gate's deterministic pre-check, the red-main baseline gate (src/main-red.ts), and
redeploy's `mainGreen` all degrade to "no check" — an entire safety layer silently off.

**Design (decided, with rationale).**
- **`check` is a project key** — `{ "command": "pytest -q", "cwd": ".", "timeoutSeconds": 300 }` —
  because the right way to verify a repo is a property of the repo, not of the machine, and so it
  belongs in the shareable `tumwater.example.json` baseline. When absent, today's npm
  auto-detection runs unchanged, so no existing project changes behavior.
- **Run through a shell, in the worktree.** A real project check is often compound
  (`cargo fmt --check && cargo test`), so `command` goes to the shell with `cwd` resolved relative
  to the worktree. `timeoutSeconds` defaults to the existing `BUILD_CHECK_TIMEOUT_MS` (300 s).
- **Outcome classification is unchanged.** `BuildCheckOutcome` keeps its three states and their
  reasoning: killed or timed out → `skipped` (environmental, never fail-closed, so a hung check
  cannot wedge every code tick into the three-strike discard); a started process exiting nonzero →
  `failed` (a deterministic rejection with the clipped output tail as reasons, no pi run
  consumed); a spawn failure → `skipped` with a `skipReason`. Only the *shape* of a check becomes
  a discriminated union; the policy around it is untouched.
- **The tick prompt stops asserting npm.** COMMON_RULES currently states "Your worktree has no
  node_modules of its own; it borrows the install at the repo root, two levels up
  (`../../node_modules`)" — false and actively misleading in a repo with no node_modules anywhere
  — and vaguely offers "if it has a build or test command, run it after your change". Replace both
  with a line derived from the resolved check: name the actual command when one is configured or
  detected ("verify with `pytest -q`"), and emit the node_modules sentence only when the resolved
  check is the npm one.
- **Doctor says when there is no check at all**, at `warn` with the consequence spelled out ("the
  review gate's build pre-check and the red-main gate are off"). A silently absent safety layer is
  the failure this entry exists to close.

**Approach.**
- src/types.ts + src/config-validation.ts — `check?: { command: string; cwd?: string; timeoutSeconds?: number }`,
  a `CHECK_KEYS` list, and the `TOP_LEVEL_KEYS` entry.
- src/build-check.ts — `BuildCheck` becomes `{ kind: "npm"; rootDir; script }` |
  `{ kind: "command"; command; cwd; timeoutMs }`; `detectBuildCheck(startDir, config)` returns the
  configured command first and falls back to the existing walk-up; `runBuildCheck` dispatches on
  `kind` with the classification above; `describeCheck(check)` returns the human/prompt-facing
  string. `clipBuildTail`'s npm-banner filter stays (harmless elsewhere).
- src/prompt.ts — thread `describeCheck` into COMMON_RULES; drop the unconditional node_modules
  sentence.
- Threading config to `detectBuildCheck` reaches three call sites, not two: `runScopedBuildCheck(root,
  role, scope, wt, timeoutMs)` in build-check.ts calls `detectBuildCheck(wt)` itself and serves the
  `gate` (src/review.ts:157), `landing` (src/merge.ts:151) and `batch` (src/lander.ts:376) scopes;
  `checkMainBaseline` (src/main-baseline.ts:137) calls `detectBuildCheck(wt)` + `runBuildCheck` at
  line 159; and src/doctor.ts:145 calls it directly. Add the config parameter to all three, plus
  `config: TumwaterConfig` on `MergeContext` (src/merge.ts:42, set at src/loop.ts:230 — review.ts
  and lander.ts already hold it). src/redeploy.ts reaches the check through `checkMainBaseline`, so
  it needs no change beyond what it already hands down.
- src/doctor.ts — a `project check` line: configured command, detected npm script, or the warn
  case.
- Tests: test/build-check.test.ts (a configured command passing, failing with its tail as reasons,
  and timing out to `skipped`; `cwd` honored; npm fallback byte-identical), test/prompt.test.ts
  (the node_modules sentence appears only for an npm check; a configured command is named
  verbatim), test/review.test.ts + test/main-red.test.ts (a configured command gates a merge and a
  red baseline), test/doctor.test.ts.

**Files touched.** src/types.ts, src/config-validation.ts, src/build-check.ts, src/prompt.ts,
src/review.ts, src/merge.ts, src/lander.ts, src/main-baseline.ts, src/loop.ts, src/doctor.ts,
test/build-check.test.ts, test/prompt.test.ts, test/review.test.ts, test/main-baseline.test.ts,
test/doctor.test.ts.

**Acceptance criteria.**
- A repo with `check.command = "pytest -q"` and no `package.json` anywhere has its check run at
  the review gate, at the red-main baseline, and in redeploy's green check; a failing check
  rejects the diff with the command's output tail as the reasons.
- A repo with no `check` and a `package.json` behaves exactly as today (pinned by the existing
  build-check tests passing unmodified).
- A configured command that hangs is killed at `timeoutSeconds`; at the `gate` scope it is
  classified `skipped` and the tick proceeds to model review with a warning, while at
  `landing`/`batch` it is remapped to `failed` with the "tree is unverified" reason and rejects the
  merge (the existing `MERGE_SCOPES` policy, unchanged).
- Tick prompts in a non-npm repo never mention `node_modules`, and name the configured command
  where they used to say "if it has a build or test command".
- `doctor` warns, naming the consequence, when neither a configured command nor an npm script is
  found.

**Refined 2026-09-18 (plan loop) — 6/7 audited against main `94562d8` (README stamp is behind at
`2ab6f0d`). The last audit was the 2026-09-15
series write against `1384eeb`, and three landings since moved the threading surface this entry
describes: `8a3e6a1` (merge queue 5/5: the new `batch` scope), `0394c6d` (the baseline split into
src/main-baseline.ts), and `5b125c4` (the `MERGE_SCOPES` timeout rejection). (`ecad7e2`'s
`runScopedBuildCheck` predates the audit and is already reflected in the write.) Every anchor
re-verified; the "two-site change"
claim is now wrong in three ways, and one acceptance criterion contradicts existing merge-scope
policy. Corrected in place above; the pins follow.**

Verified as written: src/prompt.ts's node_modules sentence is still lines 74–76 and the vague
"if it has a build or test command" line 78; `detectBuildCheck` (src/build-check.ts:114) still
walks up for `package.json` + `node_modules` and prefers test → typecheck → build via the private
`buildCheckFrom` (line 71); `BUILD_CHECK_TIMEOUT_MS` is 300_000 (line 140); `BuildCheckOutcome`
(line 150) keeps `passed|failed|skipped` with `skipReason: "timeout" | "no-npm" | "toolchain"`;
src/doctor.ts:145 still calls `detectBuildCheck(root)` directly; `TOP_LEVEL_KEYS`
(src/config-validation.ts:33) has no `check`, and `checkKnownKeys` (line 136) is the guard that
rejects unknown keys. Capability absence re-confirmed: `grep -rn '"check"\|check:' src/types.ts
src/config-validation.ts` finds nothing, and no prompt or template mentions a configured check.

Corrections (pinned; the three stale spots are already corrected in place):
1. **`checkMainBaseline` is in src/main-baseline.ts, not build-check.ts — and main-red.ts needs
   no change.** `checkMainBaseline` (src/main-baseline.ts:137) calls `detectBuildCheck(wt)` +
   `runBuildCheck(wt, check)` itself (line 159), so it is a third `detectBuildCheck` site the plan
   must thread; src/main-red.ts only imports it (`checkMainBaseline, failureHeadline`, line 4) and
   passes an `onRun` hook, and src/redeploy.ts:469 calls it too. The files bullet now names
   `src/main-baseline.ts` in place of `src/main-red.ts` and `test/main-baseline.test.ts` in place of
   `test/main-red.test.ts`.
2. **The threading surface is three `detectBuildCheck` sites plus a new `batch` scope, not
   "two".** `runScopedBuildCheck(root, role, scope, wt, timeoutMs)` (src/build-check.ts:302) now
   serves `gate` (src/review.ts:157), `landing` (src/merge.ts:151) and `batch` (src/lander.ts:376);
   `BuildCheckScope`/`MERGE_SCOPES` (lines 269/281) postdate the last audit. Config must reach
   `detectBuildCheck` at src/build-check.ts:309, src/main-baseline.ts:159, and src/doctor.ts:145.
   Pinned mechanism: add `config` as an explicit parameter to `runScopedBuildCheck` (review.ts and
   lander.ts already hold it; `MergeContext` does not — add `config: TumwaterConfig` to
   src/merge.ts:42 and set it beside `exemptPaths` at its construction site, src/loop.ts:230) and
   to `checkMainBaseline` and `detectBuildCheck`. Prefer this over `loadConfig(root)` inside the
   helper: tests build configs in memory, and a hidden disk read makes detection untestable in
   isolation.
3. **`detectBuildCheck`'s second positional is `maxLevels`.** `detectBuildCheck(startDir,
   maxLevels = WALK_UP_LEVELS)` already spends its 2nd argument, and four tests pass it there
   (test/build-check.test.ts:276/287/288, test/review.test.ts:424). Pin the new signature as
   `detectBuildCheck(startDir, config?, maxLevels = WALK_UP_LEVELS)` and update those four call
   sites to `(dir, undefined, N)`.
4. **Configured timeout precedence was unnamed.** `runScopedBuildCheck` takes an explicit
   `timeoutMs`, and src/review.ts:157 passes `ctx.buildCheckTimeoutMs ?? BUILD_CHECK_TIMEOUT_MS`
   — which would override a configured `check.timeoutSeconds`. Pin the order: explicit per-scope
   argument > `check.timeoutSeconds * 1000` > `BUILD_CHECK_TIMEOUT_MS`; `runScopedBuildCheck`'s
   default and main-baseline.ts's `runBuildCheck(wt, check)` call both read the configured value,
   while the review gate's explicit override still wins.
5. **The "classified skipped" acceptance criterion contradicted merge-scope policy.** A timeout at
   `landing`/`batch` is remapped to `failed` by `MERGE_SCOPES` (build-check.ts), with the "the tree
   is unverified" reason and a warning — by design, since a landing check that times out must not
   merge unverified (BUGS.md 2026-09-18). Corrected in place: gate → `skipped` + proceed; landing/
   batch → `failed` + reject, for the configured command exactly as for npm.
6. **`tumwater.example.json` does not exist yet.** It is 4/7's deliverable and 4/7 is unlanded, so
   6/7 cannot require it. Pinned: 6/7's required surfaces are config + validation + code + prompt +
   doctor + README; the example's `check` entry is a one-line optional edit only when the file
   already exists (i.e. after 4/7), otherwise 4/7's template carries it. `tumwater.example.json` is
   not added to 6/7's files touched.
7. **`BuildCheck` is private.** The plan's union replaces the private `interface BuildCheck`
   (src/build-check.ts:42, today `{ rootDir; script }`), whose only constructor is `buildCheckFrom`
   (line 71). Pin: export the union type so `describeCheck` and the tests can name the configured
   variant; no other module constructs a `BuildCheck` directly.

Sizing: unchanged apart from the wider threading surface — build-check.ts ~60 lines (union +
`buildCheckFrom` variant + dispatch + `describeCheck`), main-baseline.ts ~5, doctor.ts ~10,
prompt.ts ~15, review/merge/lander ~10, loop.ts ~2 (MergeContext wiring), config-validation/types
~10, tests ~180. One run. No design question remains open.

---

## 7/7 — Adopt an existing repository without hijacking its README

**Goal.** Let `tumwater init` run against a repo that already exists and already has a README.
Today it hard-fails when `README.md` exists without the `tumwater:prompt` markers ("your prompt
would be lost"), because `readInitialPrompt` (src/readme.ts) reads the project brief only out of
README.md's managed section — and the readme role then owns a `## Status` block inside the
project's own README. For an existing codebase that is a non-starter, and it is why tumwater has
only ever been pointed at repos it created itself.

**Design (decided, with rationale).**
- **A dedicated brief file, `TUMWATER.md`, with README as the compatibility path.**
  `readInitialPrompt(root)` resolves in order: `TUMWATER.md`'s prompt markers → `README.md`'s
  prompt markers. Every repo tumwater created keeps working with no migration. `TUMWATER.md`
  carries the same two managed sections the README template does — the prompt block and the readme
  role's status block — so that role needs no behavior change beyond which file it writes.
- **`tumwater init --adopt`, and the same path taken automatically when `README.md` exists without
  markers** (replacing today's hard failure with one informational line): write `TUMWATER.md`,
  leave README.md untouched entirely, and create only the backlog files that are missing.
  `PLANS.md` / `BUGS.md` / `QUESTIONS.md` / `PRINCIPLES.md` keep today's create-if-absent rule, so
  a repo with its own `PLANS.md` is never overwritten.
- **An ecosystem-neutral `PRINCIPLES.md` template.** init writes this file into someone else's
  repo, and two of its four seeded principles carry a JS flavour ("Keep every module under ~500
  lines" is arbitrary outside this codebase). Trim to principles that hold anywhere, and say in
  the file that the list is a starting point the director and steward own.
- **`--dry-run`.** Print exactly what init would create and what it would leave alone, then exit 0
  without writing. It is the first thing anyone pointing this at a repo they care about will want,
  and it is nearly free given init already builds its `created` list.

**Approach.**
- src/paths.ts — `briefCandidates(root)` (the `TUMWATER.md`-then-`README.md` pair).
- src/readme.ts — `readInitialPrompt` resolves over the candidates; `briefFile(root)` returns
  whichever file owns the managed sections (for the readme role and for doctor);
  `briefTemplate(projectName, prompt)`; the status markers become exported so the readme role
  writes to the resolved file.
- src/init.ts — `--adopt` and automatic adoption; today's README-without-markers error becomes
  that path plus one informational line; `--dry-run`; the trimmed PRINCIPLES template.
- src/cli-args.ts — `parseInitArgs` gains `--adopt` and `--dry-run`.
- src/roles.ts + src/prompt.ts — the readme role's instructions and the orientation rules name
  "the project brief (`TUMWATER.md`, or `README.md` in repos tumwater created)" instead of
  README.md.
- src/doctor.ts — report which file holds the brief.
- Tests: test/init.test.ts (adopt against a repo with its own README and PLANS.md; `--dry-run`
  writes nothing and exits 0; a tumwater-created repo still round-trips through README.md),
  test/readme.test.ts (resolution order; a `TUMWATER.md` wins over a marked README),
  test/prompt.test.ts (the resolved brief file is what the prompt names), test/doctor.test.ts.

**Files touched.** src/paths.ts, src/readme.ts, src/init.ts, src/cli-args.ts, src/roles.ts,
src/prompt.ts, src/doctor.ts, test/init.test.ts, test/readme.test.ts, test/prompt.test.ts,
test/doctor.test.ts.

**Acceptance criteria.**
- `tumwater init --adopt "<brief>"` in a clone of an unrelated repo (existing README.md, existing
  PLANS.md, no node_modules) creates only `TUMWATER.md`, `QUESTIONS.md`, `PRINCIPLES.md`,
  `tumwater.json` and the `.gitignore` entries — README.md and PLANS.md byte-identical afterwards.
- Every loop's prompt carries the brief from `TUMWATER.md`; the readme role keeps its status
  section current in that file and never edits the project's README.
- A repo tumwater created before this change keeps reading its brief from README.md with no
  migration step.
- `tumwater init --dry-run` prints the file list and exits 0 having written nothing.

---

## Series close-out

With 1/7–7/7 landed: a Python repo on a branch named `trunk`, cloned to a second machine that has
never held a tumwater checkout, driven by a tumwater installed from npm, with `check.command` in
its tracked `tumwater.example.json` and `provider`/`model` only in its untracked `tumwater.json`,
runs a full tick → review → merge cycle landing a commit on `trunk`; a custom loop added from the
director prompt box starts ticking within ~2 s; and `git log -p` over that repo shows nothing
naming a machine, a server, or a model.

## Deliberately out of scope

- **A general agent-CLI adapter.** 5/7 makes pi's *location* configurable, not its protocol.
  Supporting a different agent CLI means abstracting argv, the JSON event stream, session
  resumption, and the reply contract — its own plan.
- **Windows.** 1/7 declares `engines.os` rather than pretending.
- **One fleet across several repositories.** Everything here keeps the one-root model.
- **Auto-merging `tumwater.example.json` into a user's live config.** 4/7 reports drift; applying
  it stays the user's decision.
- **Promoting a director-added custom loop into the tracked template.** A deliberate human act by
  design (4/7).
