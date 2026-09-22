# Portability & packaging — run tumwater anywhere, against anything

Planned 2026-09-14, requested by the user; audited against main `1384eeb` on 2026-09-15, 1/7
re-audited against `00501fa` on 2026-09-16 and refined against `58b1a27` on 2026-09-21, 2/7
against `e76c5d5` on 2026-09-17, 6/7 against
`94562d8` on 2026-09-18, 3/7 against `44a037c` on 2026-09-18, 4/7 against `2714022` on 2026-09-19 —
re-audited and split into 4a/7, 4b/7 and 4c/7 (5/7 re-audited against `f52cac9` on 2026-09-19;
7/7 re-audited against `5a99627` on 2026-09-18; 4a/7 re-audited against `c2ff74b` on 2026-09-21;
4c/7 landed as `dfa6d26` on 2026-09-21). Full plan
for the `Portability & packaging` entry in PLANS.md: eight independently landable sub-plans (4/7
became three, and 4c/7 has since landed), each with its own goal, design rationale, approach, files touched, and acceptance
criteria. The problem statement, invariants, and sequencing below are shared by all of them.

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

## Invariants (none of the entries may break these)

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

`1/7 → 2/7 → 3/7 → 4a/7 → 4b/7` is the critical path: 4a/7 makes a new project's config untracked
and 4b/7 untracks this repo's own, which silently breaks custom-loop management until 3/7 has
taken it off the commit path. `4c/7` is markdown-only and independent. `5/7`, `6/7`, and `7/7`
depend only on 2/7's root resolution and may land in any order after it. 1/7 is first because the
rest all change portability-sensitive behavior and want CI watching them.

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
  and says so in `engines.os` rather than failing mysteriously — which is also why that `rm -rf`
  stays as it is: the only platform without a POSIX `rm` is already excluded, so a portable
  removal would edit a working line for no portability gain (correction 2).
- **Release is tag-driven, never push-to-main.** main is written by an autonomous fleet; every
  landing must not cut a release. A `v*` tag does, and the workflow refuses a tag whose name
  disagrees with `package.json`'s `version`.

**Approach.**
- package.json — add `files`, `prepack`, `keywords`, `engines.os: ["darwin", "linux"]`; keep
  `bin`, and raise `engines.node` to `">=20.3"` rather than keeping `">=20"`:
  `AbortSignal.any` (src/loop.ts:150, src/orchestrator.ts:165) landed in Node 20.3.0, so a
  20.0–20.2 install would throw (correction 1). Do NOT add `repository`/`homepage`/`bugs` — each
  needs a real remote URL and this repo has none (correction 3). Leave the `build` script's
  `rm -rf dist` unchanged (correction 2).
- LICENSE (new) — MIT text; today's tarball carries a licence claim it cannot substantiate.
- .github/workflows/ci.yml (new) — `on: [push, pull_request]`; matrix
  `os: [ubuntu-latest, macos-latest]` x `node: [20, 22, 24]`; checkout, `actions/setup-node` with
  `cache: npm`, a `git config --global user.name/user.email` step (the suite's fixtures set their
  own identity today, but a runner with none must not be able to fail a future one), `npm ci`,
  `npm run build`, `npm test`. `concurrency` cancels superseded runs — the fleet pushes often.
  The suite is 1241 tests (~40 s locally, per the README stamp), so the matrix stays cheap. The
  bare `20` in the matrix resolves to the newest 20.x, so `engines.node` is what states the floor
  (correction 1).
- .github/workflows/release.yml (new) — `on: push: tags: ['v*']`;
  `permissions: { contents: write, id-token: write }`; checkout, setup-node with `registry-url`,
  `npm ci`, `npm test`, tag/version agreement check, `npm publish --access public` (a
  `# add --provenance once the repo is public` comment, not the flag: provenance needs a public
  GitHub repo whose `repository` field matches, and this tree has neither — correction 3), then
  `gh release create` attaching `npm pack`'s tarball. Like CI, this workflow ships as a file and
  its first run is a human step once a remote exists (correction 4).
- README.md — rewrite `## Usage`'s opening (line 214 today: `npm install && npm run build`):
  `npm install -g tumwater` (or `npx tumwater`) as the primary install, `npm install && npm run
  build && npm link` as the from-source path. No CI badge (correction 3).
- test/packaging.test.ts (new) — the landing gate runs `npm test`, which today verifies nothing
  about a metadata-only diff, so pin the intent deterministically (correction 5). Read
  `package.json` with the `fs.readFileSync(new URL("../../package.json", import.meta.url))` idiom
  test/cli.test.ts:59 already uses and assert: `files` deep-equals `["dist/src",
  "dist/build-info.json", "README.md", "LICENSE"]` and has no entry under `test/`, `src/`,
  `plans/`, or `docs/`, nor equal to `PLANS.md`, `BUGS.md`, `PRINCIPLES.md`, `tsconfig.json`, or
  `tumwater.json`; `prepack === "npm run build"`; `engines.os` includes `darwin` and `linux` and
  not `win32`; `engines.node === ">=20.3"`; `bin.tumwater` starts with `dist/`. Then assert the two
  workflow files exist and carry only the stable triggers — `ci.yml` matches `pull_request`,
  `ubuntu-latest`, `macos-latest`; `release.yml` matches `v*` — so a later step edit does not have
  to touch the test. The existing "version prints the package version" (test/cli.test.ts:59)
  already covers the installed-version path; this file does not duplicate it.

**Files touched.** package.json, LICENSE (new), .github/workflows/ci.yml (new),
.github/workflows/release.yml (new), test/packaging.test.ts (new), README.md. No `src/` change;
the one new test file is assertions over the packaged metadata and the workflow triggers
(correction 5).

**Acceptance criteria.**
- `npm pack --dry-run --json` lists only `dist/src/**`, `dist/build-info.json`, `README.md`,
  `LICENSE`, and `package.json` — no PLANS.md, no BUGS.md, no `test/`, no `src/*.ts`, no
  `tumwater.json`, no `plans/` (today, on a clean worktree: 314 files / 1.6 MB — correction 7).
- `npm pack` in a checkout with no `dist/` still produces a working tarball (prepack built it);
  installing it into a scratch prefix gives a `tumwater` on PATH whose `version`, `help`, and
  `doctor` all run.
- `engines.node` reads `">=20.3"`, the `build` script is byte-identical, and `files` / `prepack`
  / `keywords` / `engines.os` are present — asserted by `npm test` through the new
  test/packaging.test.ts.
- `npm test` green on macOS with test/packaging.test.ts passing. **The workflows cannot be run
  from this worktree** — this repo has no remote and the landing gate runs only `npm test` — so
  CI's first real run and the release workflow's tag check are post-push steps (correction 4). A
  Linux-only failure CI surfaces is recorded as a new BUGS.md entry naming that run as its repro,
  never fixed blind here.

**Refined 2026-09-16 (plan loop) — audited against main `00501fa` (build clean, suite 1019/1019 per the README's stamp at 10c8ae6; this series had no audit since `074e48f` wrote it on 2026-09-15, and no landing since then touches this sub-plan's anchors — the `--since=2026-09-13` log over package.json/tsconfig.json is empty, and the landings since are markdown, TUI-test, and orchestrator-only). Every load-bearing claim verified on this tree; two pins corrected in place (the redundant `version` test, the test count), and the tarball facts re-measured from a root checkout and a worktree.**

Verified as written: package.json — `files`, `prepack`, `repository`, `homepage`, `bugs`, `keywords`, and `engines.os` are all absent (the Approach adds them), `bin` is still `dist/src/cli.js`, `engines.node` is still ">=20", `build` still opens with `rm -rf dist` (the `node -e` replacement target), and `license: "MIT"` is declared with no LICENSE file on disk — "a licence claim it cannot substantiate" holds. No `.github/` directory and no `.npmignore`, so the packlist behavior the allowlist replaces is today's default. `scripts/stamp-build.mjs` stamps through build-info.ts' `stampBuild(root, dist, sha?)` — `dist/build-info.json` with the checkout's HEAD and `path.resolve(root)`, and no resolvable HEAD → no stamp at all — so the "build stamping already degrades correctly" bullet holds for a CI checkout. `isSelfHosted` (src/build-info.ts line 67) is false when the stamp's `root` differs from the run root or the sha is not in the repo's history — the "never redeploy a user's project" contract holds. `dist/src/test-runner.js` (src/test-runner.ts lines 39/46) reports "run `npm run build` first" when `dist/test` is absent — the dist/test exclusion rationale holds. The suite's fixtures set their own git identity (test/util.ts lines 25-26) — the runner-identity step's rationale holds. package-lock.json is tracked, so CI's `npm ci` and setup-node's `cache: npm` both work. `version`/`--version`/`-v` exists (src/cli.ts line 492) and reads `../../package.json` — present in every tarball, so an installed copy reports its version. README's `## Usage` (line 185) still opens with `npm install && npm run build` — the rewrite anchor holds.

Corrections (pinned in place):
1. **The `version` test already exists.** test/cli.test.ts line 59 ("version prints the package version") execFiles the compiled `dist/src/cli.js` and asserts package.json's version — the exact pin the old Approach bullet asked to add, already in the suite. The bullet is replaced with a pointer, test/cli.test.ts leaves Files touched, and "No source or test changes" is true; an implementer following the old text would have shipped a duplicate test.
2. **Test count 970 → 1019** (the ci.yml bullet) — the suite has grown since the series was written; the "matrix stays cheap" conclusion is unchanged.
3. **Tarball facts re-measured** (`npm pack --dry-run`, 2026-09-16): the PLANS.md entry's "230 files / 1.1 MB" is stale in both numbers, and the quirk is worse than "dist by a packlist quirk" — a root checkout packs 633 files / 2.8 MB: 384 untracked machine-local `.claude/` state files, 114 gitignored `dist/` files npm packs anyway, and the 135 packed tracked files (137 tracked, minus `.gitignore` and `package-lock.json`, which npm drops from the pack); a worktree checkout (no `dist/` on disk) packs those 135 / 866 kB. Without the allowlist, a publish from this machine ships `.claude/` — the Design bullet is strengthened with the measured numbers and the PLANS.md bullet corrected to match.

Sizing unchanged: one package.json edit block, a LICENSE, two workflow files, one README rewrite, no source or test changes. One run. No design question remains open.

**Refined 2026-09-21 (plan loop) — 1/7 re-audited against main `58b1a27` (build clean, suite
1241/1241 per the README stamp). This was the series' first member and carried its oldest audit
(`00501fa`, 2026-09-16, ~100 landings back); its anchors survived, but seven corrections — three
factual errors and two genuinely open questions — close what the write left open. It is also the
entry the feature loop will meet first, so a stale or unbounded plan here costs the whole series.**

Verified as written: no `.github/` and no `.npmignore` on this tree, so the packlist the allowlist
replaces is today's default; package.json still has no `files`, `prepack`, `repository`,
`homepage`, `bugs`, `keywords`, or `engines.os`; `bin` is still `dist/src/cli.js`;
`engines.node` is still `">=20"`; `build` still opens with `rm -rf dist`; and `license: "MIT"` is
declared with no LICENSE on disk. `dist/src/cli.js` opens with `#!/usr/bin/env node`, so the packed
shim is executable. `scripts/stamp-build.mjs` still calls `stampBuild(root, path.join(root,
"dist"))`, and `isSelfHosted` is still src/build-info.ts:67 — the CI-degradation bullet holds.
`dist/src/test-runner.js` still answers "run `npm run build` first" at src/test-runner.ts:39/:46 —
the `dist/test` exclusion rationale holds. test/cli.test.ts:59 still execFiles the compiled CLI and
asserts package.json's version. npm 11.19.1.

Corrections (pinned in place):
1. **`engines.node` must be `">=20.3"`, not `">=20"`.** `AbortSignal.any` — used at src/loop.ts:150
   and src/orchestrator.ts:165 — was added in Node 20.3.0, so "keep `engines.node: >=20`" would
   ship a package that throws on 20.0–20.2. No API above 20.0 other than this one is used: grep for
   `fs.glob`, `Promise.withResolvers`, `Object.groupBy`, `Array.fromAsync`, `import.meta.dirname`,
   and `process.getBuiltinModule` is empty across src/ and test/ (node:test's `t.mock.method`, in
   test/inbox.test.ts, is 18.13+). The CI matrix's bare `20` resolves to the newest 20.x and cannot
   catch this, so `engines.node` — not the matrix — is where the floor is stated.
2. **The `rm -rf dist` → `node -e` replacement is dropped.** With `engines.os: ["darwin", "linux"]`
   the one platform without a POSIX `rm` is already excluded, so the edit removes a working line
   for no portability gain. The `build` script is untouched, shrinking the diff.
3. **`repository`/`homepage`/`bugs` and the README CI badge are dropped (open question closed).**
   All four need a real remote URL, and this repo has no remote (`/Users/zach/tumwater` names only
   a local directory), so every value would have been invented. The package stays publishable
   without them; `--provenance` goes the same way, since it requires a public GitHub repo whose
   `repository` field matches. Adding them is a human follow-up once a remote exists.
4. **The unbounded Linux clause is bounded (open question closed).** "fixing Linux-only suite
   failures the first run surfaces is part of this entry" made an unknown amount of work part of a
   one-run plan, and no worktree here can run Linux. Audited hazards (2026-09-21): the suite shells
   out only through `#!/bin/sh` shims (test/util.ts:48, :65), `findOnPath` gates on `X_OK`
   (src/files.ts:55), temp dirs come from `fs.mkdtempSync(os.tmpdir())` (test/util.ts:14), and no
   test or source invokes `timeout`, `sed -i`, `readlink -f`, `stat -f`, `date -r`, `shuf`,
   `nproc`, `pkill`, or `setsid` — the usual macOS↔Linux divergences are absent, and `git init -b`
   (git 2.28+) is satisfied by ubuntu-latest. So this entry ships the workflow and pins its
   content; a Linux failure the first CI run surfaces becomes a new BUGS.md entry naming that run
   as its repro, never a blind fix here.
5. **The metadata-only diff gains a deterministic check.** Nothing in `npm test` reads
   package.json or `.github/`, so the landing gate could not see a broken allowlist or a missing
   `prepack`. The new test/packaging.test.ts pins the allowlist, `prepack`, `engines.os`,
   `engines.node`, `bin`, and the two workflow triggers — it is why test/ now appears in Files
   touched. This does not contradict the old "No new CLI test" bullet, which was about not
   duplicating the installed-version test.
6. **Drifted pins.** test/util.ts's git-identity lines are now :26–:27 (the 2026-09-16 note said
   :25–:26), and the suite count is 1241, not that note's 1019.
7. **Tarball facts re-measured** on this clean worktree (`58b1a27`, 2026-09-21): `npm pack
   --dry-run --json` ships 314 files / 1.6 MB packed / 5.2 MB unpacked — PLANS.md, BUGS.md,
   PRINCIPLES.md, docs/ 1, plans/ 15, src/ 77, test/ 67, scripts/ 3, tsconfig.json, tumwater.json,
   and 144 `dist/` files. The 144 is the gitignore fallback in the flesh: npm packs a gitignored
   directory anyway. (The 2026-09-16 note's 633 files / 2.8 MB was a root checkout carrying 384
   untracked `.claude/` files; the clean-worktree figure is the reproducible one.)

Sizing now: one package.json edit block, a LICENSE, two workflow files, one README rewrite, and
test/packaging.test.ts (~80 lines, assertions only). One run. No design question remains open: the
parts that cannot be verified from the worktree (a CI run, a tag push) are named as post-push human
steps, not as criteria the implementer is expected to satisfy.

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
src/orchestrator.ts, src/init.ts, src/doctor.ts, test/git.test.ts, test/cli-args.test.ts,
test/cli.test.ts, test/orchestrator.test.ts, test/init.test.ts, test/doctor.test.ts,
test/loop.test.ts.

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

**Refined 2026-09-21 (plan loop) — 2/7 re-audited against main `423cc78`. This entry carried the series' oldest audit (`e76c5d5`, 2026-09-17, ~53 landings back), and it gates 3/7, 5/7, 6/7 and 7/7. The design holds unchanged; every load-bearing claim was re-verified, three seams the write left open are pinned (a branch-list helper, doctor's config access, and whether `init` resolves the root), two Files-touched omissions are corrected, and every drifted line anchor is re-pinned here.**

Verified as written: `src/cli.ts` — `main()` still sets `const root = process.cwd()` as the single dispatch point (now **:187**, was :335); `resolveMainBranch(root)` (now **:85**, was :78) still only rejects a detached HEAD and returns `currentBranch(root)`, and it has exactly one caller, `cmdRun` at **:128**, reached right after `loadConfig(root)` at **:127** — so the planned `resolveMainBranch(root, config, branchArg)` fits with no other call site to thread. `requireReadyRepo(root)` is **:91** (was :84); the `run` case is `rejectUnknownArgs("run", args, [])` **:193** then `cmdRun(root)` **:194** (was :341/:342); the `gui` valued-flag spec is the in-tree idiom at **:202–205** (was :350–353); the start line still prints the branch at **:142** (was :135); the help block's `run` line is **:52** and `wake`'s `--role` spelling **:74** (were :49/:67); `cmdInit`'s hardcoded output is **:110** (was :103). `src/git.ts` took zero commits since the last audit: `readBranchHead` **:97**, `isGitRepo` **:138**, `currentBranch` **:178** are unchanged, and neither `repoToplevel` nor `branchExists` exists — the `branchExists` at src/worktree.ts:42 is a function-local const, not a colliding export, and its `gitTry(root, "rev-parse", "--verify", refs/heads/<branch>)` body is the idiom to copy. `src/cli-args.ts` — `parseRoleFlag` is **:47** (was :44), `parsePortFlag` **:33** (was :30); `parseBranchFlag` is still absent, with `parseInitArgs` (:115) and `parsePromptArgs` (:151) as new neighbours from unrelated extractions. `src/init.ts` — `InitResult` **:78** (was :75), `initProject` **:89**, the hardcoded `git(root, "init", "-b", "main")` **:112** with its now-superseded comment at **:110–111** (was :107–108). `src/doctor.ts` — `checkRepo` **:88** (was :50), called once at **:246**; `checkInit` **:99** already loads the config itself. `src/types.ts` — `TumwaterConfig` **:78** (was :63); the no-rename bullet's on-disk contracts both survive (`main_red` **:165**, was :132; `build_stale` **:296**, was :255). `src/config-validation.ts` — `TOP_LEVEL_KEYS` **:40–62** (was :33–53) now holds 21 keys (`landBatchMax`, `toolCallStallSeconds`, `thrashTurns`, `thrashMinutes` landed since) and still has no `baseBranch`; `checkString` (:167) is the non-empty-string validator `baseBranch` uses. `src/orchestrator.ts` — `RunOptions` **:101** with `mainBranch` **:104** (was :71); the poll loop is `while (!signal.aborted)` **:330** and computes `mainHead` at **:405**, with the one-shot per-poll locals (`prevGate`, `prevUserPaused`, `lastMaxConcurrent`, …) at **:264–292** — that is where the edge-triggered branch-divergence local belongs, read beside the `branchHead` call at :405.

Corrections (pinned in place):
1. **A branch-list helper is needed and was unnamed.** "fails at startup listing the branches that exist" requires a git call the Approach never names. Add `listBranches(root): Promise<string[]>` to src/git.ts (`git for-each-ref --format=%(refname:short) refs/heads`), used by the `--branch`/`baseBranch` failure message, and unit-test it in test/git.test.ts.
2. **`checkRepo`'s config seam.** `checkRepo(root)` (src/doctor.ts:88) has no config, so "fails when a configured `baseBranch` does not exist" cannot be met as written. Pinned: `checkRepo(root, config?: TumwaterConfig)` reports the resolved toplevel and the target branch and fails on a missing configured one; `runDoctor` loads the config once behind a guard (`let config: TumwaterConfig | null = null; try { config = loadConfig(root) } catch {}`) and passes it, so a malformed file is still reported by `checkInit` rather than throwing out of `checkRepo`. `run`'s `--branch` override is `run`-only, so doctor's precedence is `baseBranch → checked-out`.
3. **`init` participates in root resolution (question closed).** `main()` resolves the toplevel before dispatch for every command, `init` included, so `tumwater init` from a subdirectory of an existing repo seeds that repo's root and reports "already initialized" rather than creating a nested document set; in a non-repo directory `repoToplevel` returns null and cwd is used as before. Pinned as an acceptance bullet so the behavior is deliberate, not incidental.
4. **Files-touched omissions.** The Approach changes `checkRepo`'s signature and adds `parseBranchFlag`, but the entry omitted test/doctor.test.ts and test/cli-args.test.ts. Both are added: test/doctor.test.ts:107 currently `deepEqual`s `checkRepo(makeRepo())` to `{ level: "ok", detail: "on branch main" }` and must follow the new detail, and the new `parseBranchFlag` needs unit tests beside `parseRoleFlag`'s.
5. **Drifted pins** are the re-pinned numbers above; the 2026-09-17 note's "six named test files" list is correct (all six exist).

Sizing now: src/git.ts ~30 lines (`repoToplevel`, `branchExists`, `listBranches`), src/cli.ts ~25, src/cli-args.ts ~10, types/config-validation ~5, src/orchestrator.ts ~12 (the edge-triggered local + check), src/init.ts ~15, src/doctor.ts ~15 (the config seam), and the test files ~180 — test/git.test.ts, test/cli-args.test.ts, test/cli.test.ts, test/orchestrator.test.ts, test/init.test.ts, test/doctor.test.ts, and the `trunk` end-to-end fixture in test/loop.test.ts. One run. No design question remains open.

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
  worktree — the state 4a/7 makes the default.
- A request naming `maxDailyCostUsd` changes nothing, logs a warning naming the ignored key, and
  still applies `customLoops`.
- A request whose entry fails name/task validation writes nothing and leaves the previous config
  live; the fleet keeps running.
- The request file never appears in a commit, a diff, or a review prompt.
- `review.exemptPaths` no longer lists `tumwater.json`, and the existing user-defined-loop tests
  pass with only the documented changes.

**Refined 2026-09-18 (plan loop) — 3/7 audited against main `44a037c` (HEAD; the README stamp is
behind at `dcce4f2`; this sub-plan's last audit was the series write `1384eeb` on 2026-09-15, the
oldest in the series, and ~40 landings have happened since). Every anchor verified on this tree;
one real implementation gap and four seams pinned. Landable after 2/7; no dependency on 4a/7.**

Verified as written: `setDailyBudgetUsd` (src/config.ts:185) is the idiom and it is on
`writeJsonAtomic` (src/json-files.ts:50) — the call is `writeJsonAtomic(file, { ...cfg,
maxDailyCostUsd: value }, true)` at src/config.ts:200. `defaultConfig().review.exemptPaths` still
lists `"tumwater.json"` (src/config.ts:61), and this repo's own `tumwater.json` sets no `review`
key, so the default governs and dropping the entry takes effect here. The director-only exception
is verbatim at src/prompt.ts:223–226 and the custom-loop routing bullet at src/prompt.ts:210–215;
COMMON_RULES' "Never touch the .tumwater directory or tumwater.json" is src/prompt.ts:84 (resume
variant :318). `HarnessEvent["type"]` is src/types.ts:258–294 with the index signature, and
src/ui/event-format.ts is a `switch (e.type)` ending at `default:` :156. `validateConfig` is
exported (src/config-validation.ts:99) and already validates `customLoops` (name regex, collision,
uniqueness, task cap) at :227–263. `isDirty` is `git status --porcelain` (src/git.ts:185) and
`commitAll` is `git add -A` (src/git.ts:361); `DIRECTOR_ROLE` is src/roles.ts:11. `.gitignore`
lists only `.tumwater/`, `node_modules/`, `dist/`, so `.tumwater-config-request.json` at the
worktree root is NOT ignored — `git status` reports it and `git add -A` stages it.

Pinned seams (all on this tree):

1. **The consume seam, and why "after the pi run" needs a line.** In `runTick` the pi run is
   src/loop.ts:591; the branches that follow are `aborted` (:595, returns and discards),
   `pendingUserPrompt = null` (:596), `quietKilled` (:597), `timedOut` (:606), `refused` (:616,
   `handleRefusal` → `merge` → `git add -A`), `isDirty` (:629), and `commitAll` (:713). Call
   `applyConfigRequest(this.root, wt)` immediately after `:596` and before the `quietKilled`
   branch. Rationale: (a) it must precede `isDirty`, or the untracked request file alone makes the
   worktree dirty and the tick takes the commit path; (b) it must precede `refused`/`commitAll`
   because both stage the worktree; (c) placing it after the `aborted` return means a deliberate
   `tumwater abort` still discards an unfulfilled request (matching abort's "work discarded"),
   while a quiet-kill/timeout/refusal applies the request pi wrote before returning. The call is
   guarded by `this.role === DIRECTOR_ROLE`, so role ticks pay one boolean.
2. **The orphaned `roles.<id>` entry — the plan's one real gap.** `validateConfig` cross-checks
   every `roles.<id>` key against `allRoleIds()` ∪ the request's `customLoops` names and rejects an
   id that is neither (src/config-validation.ts:273–278). `loadConfig` seeds `merged.roles[c.name]`
   for each current custom loop (src/config.ts:98–99), and the merged object is what gets written,
   so a removal that leaves the old loop's `roles` entry behind fails validation and the removal
   never applies. `applyConfigRequest` must delete `candidate.roles[name]` for every name in the
   old `customLoops` array and absent from the request, before validating. Adding a loop needs no
   roles edit: `loadConfig` seeds it enabled.
3. **Validation and deletion.** Build `candidate = { ...loadConfig(root), customLoops:
   request.customLoops }`, strip orphaned role entries (pin 2), then `validateConfig(candidate)`.
   On failure write nothing, log one `warning` naming the problems, and delete the request anyway
   (the plan's no-retry-forever rule). Deletion is unconditional and attempted on every path — a
   failed unlink is itself logged, or the file survives to be committed by `commitAll`. On
   success, log `config_changed` with the applied names; the orchestrator's ~2 s reload starts the
   loop, so no in-process config mutation is needed.
4. **Permitted-key filtering is structural.** Read the request as `unknown`; if it is not a plain
   object or `customLoops` is not an array, reject into the `{ error }` shape. Collect every other
   top-level key into `ignored` and drop it before building the candidate, so "accepts
   `customLoops` and nothing else" holds by construction and the warning names the ignored keys.
5. **The prompt rewrite has two sites, not one.** Replace the exception paragraph
   (src/prompt.ts:223–226) with the request-file contract — path,
   `{ "customLoops": [ { name, task } ] }` shape, "write it and stop; the harness consumes and
   deletes it; the array replaces the current one" — and change the routing bullet
   (src/prompt.ts:210–215) from "execute it by editing tumwater.json's customLoops array" to
   "write `.tumwater-config-request.json` in your worktree". COMMON_RULES is unchanged: the file
   sits at the worktree root, so both "never touch tumwater.json" and "never write above your
   worktree" still hold and now bind the director too.

Files correction: no change to the plan's list; `test/prompt.test.ts` is the home of the
director-prompt contract tests (the split 6/7 and 7/7 pinned).

Sizing unchanged and still one run: config.ts ~55 lines (the function + the orphan strip),
loop.ts ~12, prompt.ts ~20, paths.ts ~5, types.ts ~2, event-format.ts ~4, tests ~150 across the
four named files.

**Refined 2026-09-21 (plan loop) — 3/7 re-audited against main `ee53364`. This entry carried the
series' oldest un-re-audited audit (`44a037c`, 2026-09-18, 197 landings back), and since then a
landed feature moved onto this plan's own ground: the live config-change event (`1767778`, done
2026-09-19) added the very event plumbing this plan said to create, plus new config helpers. The
design holds unchanged; two corrections SHRINK the diff, one new seam is pinned, and every
drifted line anchor is re-pinned here.**

Verified as written: `defaultConfig().review.exemptPaths` still lists `"tumwater.json"`
(src/config.ts:69; was :61), and this repo's own tumwater.json sets no `review` key, so the
default governs. `setDailyBudgetUsd` is still the idiom, now src/config.ts:229 (was :185) with the
fresh-`loadConfig` + `writeJsonAtomic(file, { ...cfg, ... }, true)` call at :244 (was :200);
`writeJsonAtomic` is src/json-files.ts:51. The director-only exception is src/prompt.ts:234–236
(was :223–226) and the custom-loop routing bullet :220 (was :210–215); COMMON_RULES' "Never touch
the .tumwater directory or tumwater.json" is :85 and the resume variant :329 (were :84/:318).
`validateConfig` is src/config-validation.ts:156 (was :99); the customLoops entry validation is
:331–356; the orphaned `roles.<id>` check is :381–387 (was :273–278) — pin 2's real gap still
exists exactly as described. `loadConfig` still seeds `merged.roles[c.name]` per custom loop
(src/config.ts:107; was :98–99). `DIRECTOR_ROLE` is src/roles.ts:11; `commitAll` is still
`git add -A` (src/git.ts) and `isDirty` still `git status --porcelain`. paths.ts still has no
`configRequestPath` (`configPath` is :11). plans/user-defined-loops.md still carries both
superseded bullets (:52 "commit → review gate → merge → live reload"; :53 the exemptPaths bullet).
All of test/config.test.ts, test/loop.test.ts, test/prompt.test.ts, test/event-format.test.ts
exist.

Corrections (pinned in place):

1. **`config_changed` already exists — src/types.ts and src/ui/event-format.ts LEAVE Files
   touched.** `HarnessEvent` has `"config_changed"` (src/types.ts:305) and event-format.ts renders
   it (:133–137). Better still, the applied case needs NO new emission anywhere: the orchestrator's
   ~2 s reload already diffs the previous live config against the new one and logs one
   `config_changed` naming the keys (src/orchestrator.ts:341, via `changedConfigKeys`,
   src/config.ts:196, which names each `roles.<id>` separately) — so once `applyConfigRequest`
   writes the file, the announcement of what changed is automatic. loop.ts keeps only the rejection
   path: one `warning` event (the shared `this.warn`, src/loop.ts:110) naming the ignored keys or
   the validation problems.
2. **`saveConfig` is NOT the writer.** The config-change landing also added `saveConfig`
   (src/config.ts:170, validate-then-write) — tempting as the reuse — but it is a plain
   `fs.writeFileSync`: non-atomic. `applyConfigRequest` keeps `setDailyBudgetUsd`'s shape: fresh
   `loadConfig` (bypass the stat cache — a writer must see the latest file), `validateConfig`, then
   `writeJsonAtomic`, because readers poll the file every ~2 s and two dashboards can save
   concurrently.
3. **The consume seam re-pinned against today's `runTick`** (src/loop.ts:543). The pi run's branch
   order is now: `aborted` → `finishAbortedTick` (:658), `pendingUserPrompt = null` (:659),
   `quietKilled` (:660), `timedOut` (:669), `refused` (:679), `isDirty` (:692), `commitAll` (:780)
   — were :595/:596/:597/:606/:616/:629/:713. The call site is unchanged in substance: call
   `applyConfigRequest(this.root, wt)` immediately after :659 and before the `quietKilled` branch,
   guarded by `this.role === DIRECTOR_ROLE`, for the same three reasons pin 1 of the 2026-09-18
   note gave (precede `isDirty`'s dirtiness; precede the staging paths; abort still discards).
4. **New interplay pinned: `requeueUnfulfilledPrompt`.** Since the audit, `quietKilled` and
   `timedOut` director ticks requeue the prompt to run fresh (src/loop.ts:664/:672). Consuming
   BEFORE those branches remains right: a complete request applies, and the re-run re-writes the
   same request — replace semantics make the double-apply harmless; a torn one fails validation,
   is deleted with a warning, and the re-run starts clean. Consuming AFTER them would LOSE a
   timed-out tick's request outright: its "half-done edits are discarded by the reset"
   (src/loop.ts:671) deletes the untracked file unread. The `aborted` branch still discards it
   deliberately (`finishAbortedTick` — work discarded), as pinned in 2026-09-18.
5. **Drifted pins** are the re-pinned numbers above; nothing else moved materially.
   test/config.test.ts's exemptPaths assertions (:352–406) keep their shape.

Sizing now, smaller than the 2026-09-18 estimate: config.ts ~55 (the function + the orphan
strip), loop.ts ~10 (the guarded call + the rejection warning — no event plumbing), prompt.ts ~20,
paths.ts ~5, tests ~150 across test/config.test.ts, test/loop.test.ts, test/prompt.test.ts.
src/types.ts and src/ui/event-format.ts drop out entirely. One run. No design question remains
open.

---

## 4a/7 — Seed an untracked config from a tracked template

**Goal.** Every project tumwater initializes gets an untracked, gitignored `tumwater.json`:
seeded from a tracked `tumwater.example.json` when the project ships one, from `defaultConfig()`
when it does not; `doctor` reports where the two have drifted. This repo's own config keeps its
tracking until 4b/7 — untracking it needs 4b/7's landing fix first.

**Design (decided, with rationale).**
- **One untracked config, one tracked template; no overlay.** `tumwater.json` is gitignored in
  every project (`init`'s `ensureGitignore` adds it beside `.tumwater/`); `tumwater.example.json`
  is tracked and is the project's shareable baseline (roles, intervals, review settings, a future
  `check.command`, `customLoops`). A collaborator's `init` picks it up; their machine keys live
  only in their untracked copy. **No second config file and no merge:** with the whole file
  per-machine there is nothing left for a `tumwater.local.json` to separate, and one file means
  one live-reload path, one validator, one writer. A loop the director adds lands in the live
  config only — promoting it to the template stays a deliberate human act, which is right: one
  person's experiment should not become everyone's loop by accident.
- **`init` is the only seeder.** `loadConfig` (src/config.ts:73) and `loadConfigCached`
  (src/config.ts:154) keep returning `defaultConfig()` for a missing file; nothing seeds at run
  time. A fresh clone of an initialized project therefore runs `tumwater init` first, and until
  then `doctor`'s existing "init" check fails with `NOT_INITIALIZED_MESSAGE`
  (src/readiness.ts:10) — unchanged.
- **`seedConfig` never throws.** An example that is unparseable or fails `validateConfig` falls
  back to `defaultConfig()`: `init` must not die on a bad template, and the user's own file is
  what validation protects.
- **`exampleDrift` compares top-level keys and never merges.** Keys set in the example and absent
  from the local file are reported with the example's values. Sub-objects (`roles`, `idleBackoff`)
  are compared whole-key only — deep diffing is a bigger design than this entry needs.
- **`doctor` folds drift into the existing "init" check.** The report's check names are pinned
  (test/doctor.test.ts:221) and the valid-config detail is pinned as `"N roles enabled"`
  (test/doctor.test.ts:124), so `checkInit` keeps that detail when there is no drift and returns
  `level: "warn"` naming the drifted keys when there is (`CheckOutcome` is `ok | warn | fail`,
  src/doctor.ts:31; a warn never affects the exit code).

**Approach.**
- src/paths.ts — `exampleConfigPath(root)` beside `configPath` (src/paths.ts:11).
- src/config.ts — `seedConfig(root)` (example → defaults) and `exampleDrift(root)`.
- src/init.ts — seed through `seedConfig`; and two traps that must be fixed together:
  1. `ensureGitignore` (src/init.ts:66–73) returns early as soon as *one* entry matches (line 70)
     — it must test `.tumwater/` and `tumwater.json` independently, and still return true when it
     adds only the second.
  2. `created` is both the commit pathspec (src/init.ts:134,139) and the `created …` line the CLI
     prints (src/cli.ts:107–114), and `git add -- tumwater.json` **fails** on a path the
     just-written `.gitignore` ignores. Keep `tumwater.json` in the reported list, drop it from
     the add/commit pathspec, and skip the add/commit entirely when that leaves the list empty
     (`git add --` with no pathspec exits 1) — a repo that only gains a config reports
     "created tumwater.json" and stays uncommitted.
- tumwater.example.json (new, tracked) — this repo's generic half: `piArgs`,
  `minTickIntervalSeconds`, `landBatchMax`, `logMaxBytes`, `sessionRetentionDays`, `thrashTurns`,
  `thrashMinutes`, `autoRestart`, `review`, `customLoops`, `roles`; it omits `provider`, `model`,
  `fallbackModel`, `maxDailyCostUsd`, `maxConcurrent`, `tickTimeoutSeconds`,
  `quietTimeoutSeconds`, `idleBackoff`.
- Tests: test/init.test.ts (seeds from an example the test writes; defaults without one; an
  invalid example falls back without throwing; `.gitignore` carries both entries; `git ls-files`
  omits the config while `created` still reports it; the existing creation and idempotence tests
  keep passing), test/config.test.ts (`seedConfig`, `exampleDrift`), test/doctor.test.ts (drift
  warns and names the keys; the ok detail is unchanged; the local file is never rewritten).
- README.md — one line in `## Usage` naming `tumwater.example.json` as the tracked baseline an
  untracked `tumwater.json` is seeded from (the residual of the landed 4c/7; writable only once
  this entry creates the file).

**Files touched.** src/paths.ts, src/config.ts, src/init.ts, src/doctor.ts, tumwater.example.json
(new), README.md, test/init.test.ts, test/config.test.ts, test/doctor.test.ts. No behavior change for a
project with no example (defaults, as today).

**Acceptance criteria.**
- `init` in a fresh repo with `tumwater.example.json` seeds the local config from it; without one,
  from defaults; with a malformed one, from defaults and no throw.
- In the freshly initialized repo `git ls-files` lists no `tumwater.json`, `.gitignore` lists both
  `.tumwater/` and `tumwater.json`, `git status --porcelain` is empty, and the CLI output still
  names `tumwater.json` as created.
- `doctor` warns naming the drifted keys when the example has moved ahead, never rewrites the local
  file, and keeps `"N roles enabled"` + exit 0 when there is no drift.
- README's `## Usage` names `tumwater.example.json` as the tracked baseline an untracked
  `tumwater.json` is seeded from (4c/7's residual).
- Full suite green.

**Refined 2026-09-19 (plan loop) — the old 4/7 re-audited against main `2714022` and split (see
the series header).** Verified on this tree: no `exampleConfigPath`/`seedConfig`/`exampleDrift`
and no `tumwater.example.json` anywhere (`grep -rn` empty); `initProject` writes the config with
`saveConfig(root, defaultConfig())` (src/init.ts:122–128) and commits through the single `created`
list (133–141); `.gitignore` is written by `ensureGitignore` (66–73) with its first-entry early
return at line 70; `doctor`'s check names are pinned at test/doctor.test.ts:221 and `checkInit`
(src/doctor.ts:90–99) is the "init" entry. Corrections: the two src/init.ts traps above (the old
text said "the config leaves the committed file list while `created` still reports it" without the
mechanism, and missed that `git add` on an ignored path fails); doctor drift folds into the pinned
"init" check rather than adding a check entry; and the "repo's own config is removed from
tracking" and "Operational note" halves move to 4b/7, where the landing hazard they gesture at is
actually solved.

**Refined 2026-09-21 (plan loop) — 4a/7 re-audited against main `c2ff74b`, and 4c/7's residual
`## Usage` line folded in here.** Every anchor from the 2026-09-19 audit had drifted, so all are
re-pinned on this tree: `ensureGitignore` (src/init.ts:69, its one-entry early return now :73),
`initProject` (:89), the `created` list (:116), `saveConfig(root, defaultConfig())` (:130) with
`created.push("tumwater.json")` (:131), the `.gitignore` push (:133), `git add -- …created` (:137)
and the commit (:142); `configPath` (src/paths.ts:11); `defaultConfig` (src/config.ts:13),
`loadConfig` (:77), `loadConfigSafe` (:118), `loadConfigCached` (:158, default fallback :163);
`NOT_INITIALIZED_MESSAGE` (src/readiness.ts:10); `checkRepo` (src/doctor.ts:88), `checkInit`
(:99), and the report's check list (:243–247, `{ name: "init", … }` at :247); the CLI's `created`
line is src/cli.ts:105–112. Test pins: `"N roles enabled"` (test/doctor.test.ts:118/125) and the
check-name list (test/doctor.test.ts:274). Capability absence re-confirmed: `grep -rn` for
`exampleConfigPath`, `seedConfig`, or `exampleDrift` over `src/` is empty, and no
`tumwater.example.json` exists anywhere. The single addition since the split is one README.md line,
moved here from the now-landed 4c/7 (`dfa6d26`): 4c/7's goal said it depended on nothing, but that
line names a file only this entry creates, so it was never implementable there.

## 4b/7 — Untrack this repo's own config without deleting it (depends on 4a/7)

**Goal.** This repo stops tracking `tumwater.json`, so no future commit carries a machine, a model
id, or a concurrency sized to one GPU (invariant 1) — and the running fleet keeps its live config
through the landing that removes it.

**Why the split, and why a code change.** The landing fast-forwards the *primary checkout's*
working tree — `ffMainTo` (src/merge.ts:314) runs `git merge --ff-only <sha>` when the checkout is
on main — so the commit that removes the tracked config deletes the live file out from under the
fleet. The next ~2 s config poll then reads `defaultConfig()`: no `provider`/`model` (pi's own
default instead of the budgeted API model), `maxConcurrent` 6 against a 3-slot server, and
`maxDailyCostUsd` 50 instead of 10 — exactly the degradation the old "Operational note" tried to
prevent with "keep the values in the untracked working copy before this lands", which cannot
work: the merge deletes the tracked file regardless. No operator timing can prevent it either —
the drain runs while the fleet is paused, so the untracking lands unattended whether a human is
watching or not. The preserve step below makes the landing safe by construction.

**Design (decided).**
- **`ffMainTo` preserves the live config across a landing that untracks it.** Before the
  working-tree merge: if the config file exists, is tracked in the current HEAD
  (`git ls-files --error-unmatch`), and is absent from the incoming ref
  (`git cat-file -e <ref>:tumwater.json`, the path from `path.relative(root, configPath(root))`),
  read its bytes. After a successful merge, write those bytes back. `ffMainTo` is the single helper
  both landing paths go through — the single-change path (src/merge.ts:108) and the batched stack
  (`ffStackToMain`, :297) — so one helper covers both; the detached arm
  (`push . <ref>:<main>`) never touches the working tree and needs nothing.
- **The implementation deletes the file; it does not run git.** Loop prompts forbid state-changing
  git commands, and the old text's `git rm --cached` is one: deleting `tumwater.json` in the
  worktree is enough, because `commitAll` (src/git.ts:366–370) runs `git add -A` and stages the
  deletion. `.gitignore` must gain `tumwater.json` in the same commit — that is what keeps the
  restored file out of `git status` and out of the next `git add -A`.
- **A dirty root copy keeps today's behavior.** If the root's `tumwater.json` has uncommitted edits,
  `git merge --ff-only` refuses as it always has (merge_blocked, landing retried) and the preserve
  step cannot run. Recovery: save the edits, `git checkout -- tumwater.json`, and the landing
  retries; the machine values come back from HEAD's blob through the preserve step.
- **No value is lost.** The machine half (provider, model, fallbackModel, cost cap, timeouts,
  concurrency, idleBackoff) lives on in the restored untracked file; the generic half is
  `tumwater.example.json` from 4a/7.

**Approach.** src/merge.ts (the preserve helper plus its call in the working-tree arm),
`.gitignore` (`tumwater.json`), `tumwater.json` (deleted in the worktree), test/merge.test.ts (a
landing commit that deletes and ignores the config leaves the root's file byte-identical,
untracked, ignored, and `git status --porcelain` clean; a landing that does not touch the config
leaves it untouched; an absent config is not an error).

**Files touched.** src/merge.ts, .gitignore, tumwater.json (untracked), test/merge.test.ts.

**Acceptance criteria.**
- After the landing: `git ls-files` lists no `tumwater.json`; the root file exists with the exact
  pre-landing bytes; `.gitignore` lists it; `git status --porcelain` is empty.
- `loadConfig(root)` after the landing still returns this fleet's `provider`, `model`,
  `fallbackModel`, `maxConcurrent`, `tickTimeoutSeconds`, `quietTimeoutSeconds` and `idleBackoff`
  (the test compares the parsed config before and after).
- A landing whose tree keeps the config, and one on a repo with no config, both leave the working
  tree untouched and `ffMainTo` still returns true.
- Full suite green.

## 4c/7 — Move README's rig notes into docs/backends.md (markdown only)

**Goal.** README stops being one machine's notebook (invariant 1's documentation half): its
`## Notes on local model servers` section becomes `docs/backends.md`, and README's `## Usage`
gains one line naming `tumwater.example.json` as the tracked baseline an untracked
`tumwater.json` is seeded from.

**Design (decided, with rationale).** `docs/backends.md` states what tumwater needs from a backend
(an OpenAI-compatible endpoint pi can reach; a context window large enough for a tick prompt), how
`provider`/`model`/`fallbackModel` point at it, and how `fleetModelsFree()` reads pi's
`models.json` costs to decide the budget badge. The concrete oMLX/LM Studio numbers move there
verbatim as one clearly labelled worked example ("one machine's measurements, 2026-09"), not as
"the current setup". README keeps a two-line pointer to the document.

**Files touched.** README.md, docs/backends.md (new). No source or test changes — this is why it is
independent and may land in any order.

**Acceptance criteria.** No section of README names a machine path, a model id, a server URL, or a
value sized to one GPU (the moved text is the only place they appear); README links
`docs/backends.md`; the worked example is labelled as an example; the suite is untouched.

**Landed 2026-09-21 (feature loop) against main `58b1a27` — commit `dfa6d26`.** README's
`## Notes on local model servers` section (160 lines) became `docs/backends.md` (181 lines), with
a short `## Backends` pointer left in README; the oMLX/LM Studio numbers are explicitly one
machine's measurements. Verified on `c2ff74b`: a case-insensitive grep over README.md for `omlx`,
`lm studio`, `qwen`, `gguf`, `huggingface`, `deepseek` is empty (the only host literal left is the
generic `http://127.0.0.1:7180` GUI default), `docs/backends.md` exists, and no source or test file
changed. The `## Usage` line naming `tumwater.example.json` (the second criterion above) could not
be written before that file exists, so it moved to 4a/7.

---

## 5/7 — Make the agent binary configurable

**Goal.** Stop assuming the agent CLI is a binary literally named `pi` on `PATH`. src/pi.ts spawns
`spawn("pi", …)`, and both src/cli.ts's `cmdRun` preflight and src/doctor.ts's `checkPiBinary`
gate on `findOnPath("pi")` — so a non-PATH install, a wrapper script, or two pi builds side by
side are all impossible.

**Design (decided, with rationale).**
- **Resolution order: `TUMWATER_PI_BIN` → `agentBin` in config → `"pi"`.** A value containing a
  path separator is used as given (absolute, or relative to the process cwd); a bare name is left
  to PATH resolution. The env variable exists for one-off runs and for CI, where the value differs
  per job.
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
- tumwater.example.json — a commented `agentBin` entry (4a/7 owns the template).
- Tests: test/pi.test.ts (env beats config beats default; an absolute path bypasses PATH; the
  spawn-error message names the resolved binary), test/cli.test.ts (preflight failure text),
  test/doctor.test.ts (all three sources).

**Files touched.** src/types.ts, src/config-validation.ts, src/pi.ts, src/readiness.ts, src/cli.ts,
src/doctor.ts, test/pi.test.ts, test/cli.test.ts, test/doctor.test.ts, test/config.test.ts; and
`tumwater.example.json` only when 4a/7 has already created it (see correction 6 below).

**Acceptance criteria.**
- With `pi` absent from PATH but `agentBin` set to an absolute path, `tumwater run` starts and
  ticks normally; `doctor` reports the resolved path and `config` as its source.
- `TUMWATER_PI_BIN` overrides `agentBin` for one invocation without editing any file.
- A wrapper script at `agentBin` that exports an env var and execs the real pi produces
  byte-identical tick behavior (the existing `fakePi` test helper already installs a stub at the
  front of PATH and exercises this shape).
- With none of the three resolving to an executable, `run` and `doctor` both fail naming the
  resolved value, its source, and the install hint.

**Refined 2026-09-19 (plan loop) — 5/7 audited against main `f52cac9` (build clean, suite
1179/1179 per the README stamp). This was the series' last member never re-audited — its only
pass was the series write `074e48f` against `1384eeb` on 2026-09-15, and ~60 landings have
happened since. Every load-bearing claim re-verified on this tree; six corrections, the first
four load-bearing.**

Verified as written: `spawn("pi", …)` is still the single pi spawn (src/pi.ts:113), the
`SPAWN_ERROR_PREFIX` constant sits at src/pi.ts:81, and `grep -rn 'findOnPath("pi")' src/`
returns exactly the two named gates — src/cli.ts:122 in `cmdRun` and src/doctor.ts:102 in
`checkPiBinary`. `TumwaterConfig` is src/types.ts:78 and `TOP_LEVEL_KEYS` src/config-validation.ts:27;
`findOnPath` is src/files.ts:55. Capability absence re-confirmed: `grep -rn
'agentBin\|TUMWATER_PI_BIN\|resolveAgentBin\|checkAgentBinary' src/ test/` is empty.

Corrections:

1. **The missing-binary message is one shared constant, not a per-caller string.**
   `PI_MISSING_MESSAGE` lives in `src/readiness.ts:11` and both `src/cli.ts:24` and
   `src/doctor.ts:14` import it; readiness.ts's own doc comment promises the two surfaces "cannot
   drift". Naming the resolved binary + source therefore cannot be done at the two call sites:
   add a builder (`piMissingMessage(resolved)`) beside `PI_MISSING_MESSAGE` in readiness.ts and
   add **src/readiness.ts** to Files touched. Keep the default-source text byte-identical to
   today's — `test/cli.test.ts:388` and `:1121` match `/pi not found on PATH/` and
   `test/doctor.test.ts:78` pins the install hint — so only a non-default source gains the
   "resolved `<bin>` from `TUMWATER_PI_BIN`/`agentBin`" clause.
2. **`runPi` already receives the config.** `PiRunOptions.config: TumwaterConfig` exists
   (src/pi.ts:24), so the spawn site resolves `resolveAgentBin(opts.config)` with **no signature
   change** in loop.ts/merge.ts/review.ts — thread nothing. Pin this so the implementer does not
   add an `agentBin` field to `PiRunOptions`.
3. **`resolveAgentBin` is precedence only; a bare name is not pre-resolved.** Return
   `{ bin, source }` from `TUMWATER_PI_BIN` → `agentBin` → `"pi"`; an empty or whitespace env
   value falls through to config (so `TUMWATER_PI_BIN= tumwater run` cannot wedge the fleet), and
   a value containing a path separator is used as given (relative to the process cwd). Keep
   `resolveAgentBin` free of filesystem calls so it is trivially unit-testable, and test
   resolvability at the two preflight sites instead: a bare name through `findOnPath`, a path
   through `fs.accessSync(X_OK)`. Note `findOnPath` is POSIX-only (`X_OK` + `isFile()`, no
   PATHEXT, src/files.ts:55) and the spawn keeps the raw bare name so the OS resolves it exactly
   as today.
4. **`cmdRun` must load the config before its preflight.** Today the `findOnPath("pi")` check
   (src/cli.ts:122) precedes `const config = loadConfig(root)` (~src/cli.ts:130). Hoist the
   `loadConfig` line above the check — `requireReadyRepo` has already gated on tumwater.json
   existing, and `loadConfig` returns defaults when the file is absent (src/config.ts:74), so the
   move is behavior-preserving on the default path. Leave the supervised early return where it is
   (one extra parse in a path that reads the config moments later).
5. **doctor resolves the config itself, safely.** `checkPiBinary(pathEnv)` (src/doctor.ts:101)
   takes only a PATH string and is called from `runDoctor` (src/doctor.ts:201) with no config;
   make it `checkAgentBinary(root, pathEnv)`, resolving through `loadConfigSafe(root)`
   (src/config.ts:113) so a malformed tumwater.json cannot throw inside a check (checkInit already
   reports that failure separately, src/doctor.ts:87-95). **Keep the user-visible check label `pi
   binary`** — `test/doctor.test.ts:221,243` and `test/cli.test.ts:1121,1148` pin it, as does
   README's doctor line — and rename only the function and its detail text.
6. **The example-config line is order-dependent.** `tumwater.example.json` does not exist on this
   tree; 4a/7 creates it. Since this entry lands independently after 2/7 only, keep the file in
   Files touched but make the edit conditional: add the commented `agentBin` entry only if the
   template is present (and 4a/7's template carries it otherwise). It is not an acceptance
   criterion. Top-level key validation is pinned in **test/config.test.ts:383** (there is no
   `test/config-validation.test.ts`), so `agentBin`'s validation test joins that file.

Sizing unchanged: src/pi.ts ~20 lines, src/readiness.ts ~8, src/cli.ts ~5, src/doctor.ts ~8,
src/types.ts + src/config-validation.ts ~4, tests ~40. No design question remains open; landable
after 2/7.

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
  review gate's build pre-check, the red-main baseline, and redeploy's green check are all off").
  This deliberately supersedes `checkBuildCheck`'s 2026-09-05 "none declared is informational"
  stance (doctor.ts:187): that decision predates non-npm projects being a supported target, when a
  warn would have been noise no operator could act on. Once `check.command` exists the warning is
  actionable, so the branch flips to `warn`, its stale comment is rewritten, and doctor's exit code
  is unchanged (warn does not fail — the `checkFallbackModel` precedent). A silently absent safety
  layer is the failure this entry exists to close.

**Approach.**
- src/types.ts + src/config-validation.ts — `check?: { command: string; cwd?: string; timeoutSeconds?: number }`,
  a `CHECK_KEYS` list, and the `TOP_LEVEL_KEYS` entry.
- src/build-check.ts — `BuildCheck` becomes `{ kind: "npm"; rootDir; script }` |
  `{ kind: "command"; command; cwd; timeoutMs }`; `detectBuildCheck(startDir, config?, maxLevels =
  WALK_UP_LEVELS)` returns the configured command first and falls back to the existing walk-up;
  `runBuildCheck` dispatches on `kind` with the classification above; `describeCheck(check)`
  returns the human/prompt-facing string. `clipBuildTail` (:235) keeps its npm-banner filter and
  its message-line retention — the error-message line above the ten-line window is kept so
  `failureHeadline` (:255, moved here from main-red.ts by d39e426) can name the failure — and both
  operate on arbitrary output text, so a configured command's output is classified unchanged.
- src/prompt.ts — thread `describeCheck` into COMMON_RULES; drop the unconditional node_modules
  sentence.
- Threading config to `detectBuildCheck` reaches three call sites, not two: `runScopedBuildCheck(root,
  role, scope, wt, config, timeoutMs = BUILD_CHECK_TIMEOUT_MS)` (build-check.ts:368) calls
  `detectBuildCheck(wt)` itself and serves the `gate` (src/review.ts:161), `landing`
  (src/merge.ts:151) and `batch` (src/lander.ts:394) scopes; `checkMainBaseline`
  (src/main-baseline.ts:123 — its signature grows to `checkMainBaseline(wt, config, onRun?,
  reverifyRed?)`, config required in the 2nd position: detection needs it, and an optional
  trailing parameter would let future callers skip it) calls `detectBuildCheck(wt)` +
  `runBuildCheck` at :145/:148; and `checkBuildCheck` (src/doctor.ts:184) calls it at :185. Add the
  config parameter to all three, plus `config: TumwaterConfig` on `MergeContext` (src/merge.ts:42,
  set beside `exemptPaths` in the object literal inside `LoopRunner.merge` — src/loop.ts:257–264;
  review.ts (:61) and lander.ts (:50/:71) already hold it). `checkMainBaseline`'s three callers
  thread it too: src/main-red.ts's `mainRedGate` passes the `cfg` it already loads (:87) at its
  :89 call, `bugfixMainRedNote` (:68) gains the same `loadConfigCached(root).config ??
  defaultConfig()` load for its :69 call, and src/redeploy.ts's `mainIsGreen(mirrorWt, config,
  onRun?)` (:432) takes config, with the production wiring at createRedeployer (:458) reading the
  live config per call — so src/main-red.ts and src/redeploy.ts join this entry's files.
- src/doctor.ts — a `project check` line: configured command, detected npm script, or the warn
  case.
- Tests: test/build-check.test.ts (a configured command passing, failing with its tail as reasons,
  and timing out to `skipped`; `cwd` honored; npm fallback byte-identical), test/prompt.test.ts
  (the node_modules sentence appears only for an npm check; a configured command is named
  verbatim), test/review.test.ts (a configured command gates a merge) + test/main-baseline.test.ts
  (a configured command runs at the red-main baseline — and its ~25 `checkMainBaseline(...)` call
  sites gain the config argument mechanically), test/redeploy.test.ts (its four `mainIsGreen(...)`
  call sites likewise, plus one test that a configured check — no npm anywhere — makes the green
  check run it), test/main-red.test.ts passes unmodified (neither exported signature changes; the
  internal config load degrades to defaults in a tmp repo), test/doctor.test.ts.

**Files touched.** src/types.ts, src/config-validation.ts, src/build-check.ts, src/prompt.ts,
src/review.ts, src/merge.ts, src/lander.ts, src/main-baseline.ts, src/main-red.ts, src/redeploy.ts,
src/loop.ts, src/doctor.ts, test/build-check.test.ts, test/prompt.test.ts, test/review.test.ts,
test/main-baseline.test.ts, test/redeploy.test.ts, test/doctor.test.ts.

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
   must thread; src/main-red.ts imports only `checkMainBaseline` from it (now line 5; `failureHeadline` comes from
   build-check.ts) and
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
6. **`tumwater.example.json` does not exist yet.** It is 4a/7's deliverable and 4a/7 is unlanded, so
   6/7 cannot require it. Pinned: 6/7's required surfaces are config + validation + code + prompt +
   doctor + README; the example's `check` entry is a one-line optional edit only when the file
   already exists (i.e. after 4a/7), otherwise 4a/7's template carries it. `tumwater.example.json` is
   not added to 6/7's files touched.
7. **`BuildCheck` is private.** The plan's union replaces the private `interface BuildCheck`
   (src/build-check.ts:42, today `{ rootDir; script }`), whose only constructor is `buildCheckFrom`
   (line 71). Pin: export the union type so `describeCheck` and the tests can name the configured
   variant; no other module constructs a `BuildCheck` directly.

Sizing: unchanged apart from the wider threading surface — build-check.ts ~60 lines (union +
`buildCheckFrom` variant + dispatch + `describeCheck`), main-baseline.ts ~5, doctor.ts ~10,
prompt.ts ~15, review/merge/lander ~10, loop.ts ~2 (MergeContext wiring), config-validation/types
~10, tests ~180. One run. No design question remains open.

**Refined 2026-09-21 (plan loop) — 6/7 re-audited against main `ada3948` (README's stamp is
behind at `c2ff74b`). This entry carried the series' oldest audit (`94562d8`, 2026-09-18, ~222
landings back; of the three 09-18-dated entries 6/7's anchor files took by far the most churn —
~43 commits across its src files, 7 of them in build-check.ts alone, including three post-audit
semantic changes). The design holds unchanged; two seams the 09-18 audit left open are closed
below, and every drifted line anchor is re-pinned.**

Verified as written: no `check` key exists anywhere in src/types.ts or src/config-validation.ts,
so the capability is still absent. `src/build-check.ts` — `BuildCheck` is still the private
`{ rootDir; script }` interface (:43, was :42), `buildCheckFrom` (:72, was :71, hardened by
5da2e2c to reject a non-object package.json and a whitespace-only script), `WALK_UP_LEVELS` :54,
`detectBuildCheck(startDir, maxLevels = WALK_UP_LEVELS)` :130 (was :114), `BUILD_CHECK_TIMEOUT_MS`
300_000 :156 (was :140), `BuildSkipReason` now a standalone exported type :162 (extracted by
f4c4d0b, shared with main-baseline.ts's check), `BuildCheckOutcome` :172 (was :150) with the same
three states and the same timeout-remap policy, `clipBuildTail` :235, `failureHeadline` :255,
`runBuildCheck(wt, check, timeoutMs = BUILD_CHECK_TIMEOUT_MS)` :269, `BuildCheckScope` :320 /
`SCOPE_WORDS` :325 / `MERGE_SCOPES` :337 (were :269/:281), `runScopedBuildCheck` :368 (was :302)
whose internal `detectBuildCheck(wt)` is :375 and `runBuildCheck` :378. The three scopes serve
`gate` (src/review.ts:161, was :157, still passing `ctx.buildCheckTimeoutMs ??
BUILD_CHECK_TIMEOUT_MS` at :166), `landing` (src/merge.ts:151, unchanged) and `batch`
(src/lander.ts:394, was :376). `src/prompt.ts` — COMMON_RULES (:53) still carries the
unconditional node_modules sentence (:75–77, was 74–76) and the vague "if it has a build or test
command" bullet (:79, was :78). `src/doctor.ts` — the direct `detectBuildCheck(root)` call now
lives in `checkBuildCheck` (:184, was :145) at :185, and its no-check branch still returns `ok`
(:187). `MergeContext` (src/merge.ts:42) still has no `config`; its single construction site is
the object literal inside `LoopRunner.merge` at src/loop.ts:257–264 (`exemptPaths` at :261; was
:230 — loop.ts:297 is the lander's context, which already carries config, and :588 is
recoverLeftover's). `review.ts` (:61) and `lander.ts` (:50/:71) still hold config.
maxLevels-as-second-positional test call sites are now test/build-check.test.ts:274/:285/:286 and
test/review.test.ts:475 (were :276/:287/:288/:424).

Corrections (pinned in place):
1. **checkMainBaseline's callers must thread config — the 09-18 note's "redeploy needs no
   change beyond what it already hands down" claim is false under the explicit-parameter design.**
   `checkMainBaseline` gained a third parameter, `reverifyRed` (landed by 0394c6d, before that
   audit, but never pinned), and its three production callers are src/main-red.ts:69
   (`bugfixMainRedNote`, which loads no config today — it gains the two-line
   `loadConfigCached(root).config ?? defaultConfig()` idiom mainRedGate already uses at :87),
   src/main-red.ts:89 (`mainRedGate`, passing its existing `cfg`), and src/redeploy.ts:438 inside
   `mainIsGreen` (:432), whose only production wiring is createRedeployer's `mainGreen` dep
   (:458 — `root` is in closure scope; read the live config per call so a mid-run
   `check.command` edit applies). Pin the new signatures: `checkMainBaseline(wt, config, onRun?,
   reverifyRed?)` and `mainIsGreen(mirrorWt, config, onRun?)`. The acceptance criterion "its check
   run at the red-main baseline and in redeploy's green check" is exactly what this threading
   implements — an optional trailing config parameter would silently exempt those two gates.
   test/main-red.test.ts needs no change (neither exported signature moves; the internal load
   degrades to defaults in a tmp repo).
2. **Doctor's no-check stance flips from informational to warn, superseding the 2026-09-05
   decision** (landed by 784d487, before every audit of this entry, yet never reconciled with the
   entry's `warn` criterion): pre-portability a non-npm target was out of scope, so "none
   declared is informational" was honest; with `check.command` available the warning is
   actionable and its absence is precisely the silently-off safety layer this entry exists to
   close. The branch at doctor.ts:187 flips to `warn` with the consequence spelled out, the stale
   comment is rewritten, doctor's exit code stays 0 (warn does not fail), and doctor.test.ts's
   no-check expectation follows. `checkBuildCheck` gains the config parameter runDoctor already
   holds (2/7 lands first and pins runDoctor's single guarded load).
3. **Post-audit build-check.ts facts absorbed.** a3ee4d9 gave `clipBuildTail` message-line
   retention (≤11 lines) so `failureHeadline` names the failing test rather than a stack frame;
   d39e426 moved `failureHeadline` into build-check.ts beside it; f4c4d0b extracted the shared
   `BuildSkipReason` type and skip-warning helper. All three are npm-agnostic and untouched by
   this entry's union — the old "`clipBuildTail`'s npm-banner filter stays (harmless elsewhere)"
   phrasing is replaced in the Approach with the fuller statement so an implementer does not
   simplify the tail logic away while switching on `kind`.
4. **The Tests bullet and Files-touched disagreed** (the bullet named test/main-red.test.ts, the
   file list test/main-baseline.test.ts, from the 09-18 swap). Resolved: the red-baseline test
   lives at the checkMainBaseline level in test/main-baseline.test.ts (the changed seam);
   test/main-red.test.ts is out (passes unmodified); test/redeploy.test.ts is in (four
   `mainIsGreen` call sites at :725/:756/:759/:788 plus one configured-check test).

Sizing now: build-check.ts ~60 (union + `buildCheckFrom` variant + dispatch + `describeCheck`),
main-baseline.ts ~5, main-red.ts ~3 (the load + two call sites), redeploy.ts ~10 (signature +
wiring), doctor.ts ~12, prompt.ts ~15, review/merge/lander ~10, loop.ts ~2 (MergeContext wiring),
config-validation/types ~10, and tests ~230 (mechanical parameter threading across
main-baseline.test.ts and redeploy.test.ts plus the new configured-check tests). One run. No
design question remains open.

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

**Refined 2026-09-18 (plan loop) — 7/7 audited against main `5a99627` (HEAD; the README's stamp
is four landings behind at `8fd6a85`, and none of the landings since touches an anchor here).
Every anchor verified on this tree; three files are missing from the Files-touched list, one
claim is wrong, and eight implementation questions the write left open are pinned below.**

Verified as written: `src/readme.ts` is 47 lines — `PROMPT_START`/`PROMPT_END` exported (lines
7–8), `STATUS_START`/`STATUS_END` module-private (10–11), `readmeTemplate(projectName,
initialPrompt)` (15) and `readInitialPrompt(root)` (38), the latter reading only
`path.join(root, "README.md")` and searching the close marker only after the open one.
`readInitialPrompt` has exactly two production call sites — `src/loop.ts:145` (feeding both
`buildTickPrompt` and `buildDirectorPrompt`) and `src/init.ts:99` — plus test imports, so the
resolution change is contained. `src/init.ts`: `initProject(root, initialPrompt)` at 86; the
README-without-markers guard at 99–104 throws; `write()` (create-if-absent) at 112;
`ensureGitignore` (66); `saveConfig` only when `configPath` is absent; the `created` list drives
`git add`/commit and `cmdInit`'s output (`src/cli.ts:95–108`). `src/cli-args.ts`:
`parseInitArgs(args): string` at 112 rejects every `--` token except `--file` (114–116), and the
no-`--file` path returns `args.join(" ")` at 135 — free-form prompt text. `src/prompt.ts`:
`COMMON_RULES` (52) names README.md at 56 ("First read README.md in full") and 85 ("Never edit
the initial prompt block in README.md"), and is embedded by BOTH `buildTickPrompt` (172) and
`buildDirectorPrompt` (221); `TickPromptInput` is at 142, `buildTickPrompt` at 163, and
`buildDirectorPrompt(userPrompt, initialPrompt, principles)` is the shape `loop.ts:154` calls.
`src/roles.ts`: `readme.find` names README.md and the status markers at 108; `plan.find` says
"its initial prompt in README.md" at 94. `src/doctor.ts`: checks are an array in `runDoctor` (203)
with `checkInit` at 207; `renderDoctor` pads the name column to 12 (222–224). Tests:
`test/readme.test.ts` (78 lines, every case through a `writeReadme` helper that writes README.md),
`test/init.test.ts` (116; the refusal test at 67, the PRINCIPLES seed assertions at 32–42),
`test/cli-args.test.ts` (341), `test/doctor.test.ts`, `test/prompt.test.ts`. Capability absence
re-confirmed: `grep -rn 'TUMWATER.md\|briefFile\|briefCandidate\|--adopt\|--dry-run' src/` is empty.

Corrections (pinned in place):
1. **`parseInitArgs` gains the flags and must stop baking them into the prompt.** Its own doc
   comment (109–111) exists to keep a misspelled flag out of the injected prompt, yet the
   no-`--file` path joins *every* token: `tumwater init --adopt "brief"` would embed "--adopt
   brief". Pinned: `--adopt` and `--dry-run` are boolean flags, each at most once, stripped from
   the text before the join; the return type becomes `{ prompt: string; adopt: boolean; dryRun:
   boolean }` and `cmdInit` destructures. The `--file` path's `failStrayArg` (100) claimed set
   widens from `{fileFlag, fileFlag+1}` to those plus every boolean occurrence, so `--file` +
   booleans combine while any other token still fails by name; a duplicate boolean fails by name;
   single-dash positionals stay prompt content.
2. **The brief filename must be threaded into the prompts, and `COMMON_RULES` is shared with the
   director.** `COMMON_RULES` is one constant used by both builders, so it cannot keep naming
   README.md once an adopted repo's brief is TUMWATER.md. Pinned: `TickPromptInput` gains
   `briefFile?: string` and `buildDirectorPrompt` gains a trailing `briefFile?: string`;
   `loop.ts`'s `tickPrompt()` computes `const brief = briefFile(this.root) ?? "README.md"` once
   (line 145 region) and passes it to BOTH branches. `COMMON_RULES` becomes
   `commonRules(briefFile: string)` with lines 56 and 85 interpolating it; the fallback keeps a
   tumwater-created repo's prompts byte-identical, so every existing `test/prompt.test.ts` pin
   holds. Line 56 gains the README caveat (an adopted repo's own README is its real
   documentation): "read the project brief (`<briefFile>`) in full, plus QUESTIONS.md when
   present, and README.md too when the brief is not itself README.md". `readme.find`
   (roles.ts:108) and `plan.find` (roles.ts:94) drop their hardcoded README.md and point at "the
   project brief named in your prompt".
3. **Resolution lives in `readInitialPrompt`/`briefFile`, and the status markers need no export.**
   Pinned: `briefCandidates(root)` (pure, `src/paths.ts`) returns `["TUMWATER.md", "README.md"]`;
   `readInitialPrompt(root)` returns the first candidate whose marker block parses; new
   `briefFile(root): string | null` returns the marked candidate or null. The write's Files bullet
   claim ("the status markers become exported so the readme role writes to the resolved file") is
   wrong and is dropped: the readme role writes through pi, and nothing in `src/` reads the status
   markers (`grep -rn 'STATUS_START\|tumwater:status' src/` names only readme.ts) —
   `readmeTemplate` already embeds them into whichever file, so `briefTemplate` is dropped and
   `readmeTemplate` is reused verbatim for `TUMWATER.md`.
4. **A fresh repo still gets README.md; `TUMWATER.md` is the adoption-only path.** To keep the
   compatibility path meaningful and fresh behavior unchanged, `write("README.md",
   readmeTemplate(...))` stays exactly as today when neither candidate is marked (`test/init.test.ts:14`
   keeps passing). The adopt path (README.md present without markers, or `--adopt`) writes
   `TUMWATER.md` with `readmeTemplate(...)`, leaves README.md byte-identical, and creates only the
   missing backlog files. `--adopt` against an already-marked brief is today's "already
   initialized; nothing to do". Edge case pinned: a marker-less `TUMWATER.md` is never overwritten
   (`write` is create-if-absent) and, when no marked brief exists anywhere, init fails with an
   actionable message naming the `TUMWATER.md` markers — generalizing today's README guard rather
   than running every loop blind.
5. **An existing test asserts the old hard failure and must invert.** `test/init.test.ts:67`
   ("initProject refuses to drop the initial prompt when README has no tumwater markers") pins
   `assert.rejects(…, /tumwater:prompt/)`. Automatic adoption turns that into: README.md
   byte-identical, `TUMWATER.md` created, `readInitialPrompt(repo)` round-trips from TUMWATER.md,
   `created` excludes README.md. The refusal guard it covered moves to the
   marker-less-`TUMWATER.md` case, which gets its own test.
6. **`--dry-run` semantics pinned.** `initProject(root, initialPrompt, opts?: { adopt?: boolean;
   dryRun?: boolean })`; the same validation (git binary, non-empty prompt, brief guard) runs and
   the same `created` list is computed, but nothing is written or committed and no `git init` is
   issued — `repoInitialized` is read from `isGitRepo` without creating one, and `InitResult`
   carries `dryRun`. `cmdInit` prints `dry run — would create: <list or "nothing">` then `nothing
   written; re-run without --dry-run to apply` and exits 0; the non-dry output lines are
   unchanged. Acceptance sharpened: `git status --porcelain` and every tracked file are
   byte-identical afterwards.
7. **The PRINCIPLES template trim pinned.** Surviving bullets: "Prefer the standard library over
   a new dependency.", "Every behavior change ships with a test.", "Small, complete, and correct
   beats big and half-done: one focused change per tick.", and a language-neutral rewrite of the
   size rule — "Keep each file focused on one responsibility, and small enough to read in one
   sitting." The preamble gains "This list is a starting point: the director and steward own it
   and will tune it to this project." `test/init.test.ts:32`'s two regexes both survive; it gains
   an assertion that the ~500-line wording is gone and the starting-point sentence is present.
8. **Doctor's brief line pinned.** New `checkBrief(root)` immediately after `init` in
   `runDoctor`'s array (name "brief" fits the 12-char column): `ok <file>` when `briefFile` is
   non-null, `fail no project brief (run tumwater init)` when it is null — which is exactly why
   `briefFile` returns null rather than falling back (loop.ts owns the fallback).

Sizing: unchanged in kind, ~40 lines over the write's estimate (the `briefFile` threading through
loop.ts/prompt.ts, the flag plumbing in cli-args.ts/cli.ts, the dry-run branch in init.ts). Files
touched gains `src/loop.ts`, `src/cli.ts`, and `test/cli-args.test.ts`; `briefTemplate` is dropped.
Still one run, no design question left open.

**Refined 2026-09-23 (plan loop) — 7/7 re-audited against main `e6a4228` (the README's own stamp;
the 2026-09-18 audit was against `5a99627`, ~30 landings back). The design and all eight pinned
corrections hold unchanged. Every anchor re-verified and re-pinned below; one stale claim
corrected (readme.ts grew, and `readInitialPrompt` gained a length cap the resolution change must
not disturb); one new pre-adopt validation step named; two test anchors re-pinned.**

Verified as written:
- `src/readme.ts` is now 60 lines (was 47): since the audit it gained the exported
  `INITIAL_PROMPT_MAX_CHARS = 4096` (:12) and a truncation backstop inside `readInitialPrompt`
  (:58–60) — a hand-edited README with an over-long prompt truncates with a visible note instead
  of injecting unbounded text into every tick. The resolution change needs no new seam: both
  candidates share the same two markers, and the candidate parse + trim + cap all stay inside
  `readInitialPrompt`; `briefFile(root)` only names which file owns the marked section. The
  end-marker-after-open ordering guard (:49–52) applies verbatim to whichever candidate parses.
- `src/init.ts` is now 163 lines: `InitResult` :84 (still no adopt/dryRun fields),
  `initProject(root, initialPrompt)` :95, the pure-validation preamble :99–117 now includes — new
  since the audit — the over-long-prompt reject (:114–117), which adoption keeps unchanged; the
  README-without-markers guard is :118–122, its message built from `PROMPT_START`/`PROMPT_END`;
  `git init -b main` :128 with the now-superseded `init.defaultBranch` comment at :125–127; the
  `write` create-if-absent helper ~:135; `ensureGitignore` :75; the commit path :151–160.
- `src/cli.ts` (381 lines): `root = process.cwd()` :187; `cmdInit` :102 (still
  `parseInitArgs(args)` returning a bare string); its hardcoded `initialized a new git repository
  on branch main` :110; `cmdRun` :116; the `run` case's `rejectUnknownArgs("run", args, [])` :193
  with `cmdRun(root)` :194; the `gui` valued-flag spec :201–205 (the idiom unchanged); the help
  block's `run` line :52.
- `src/cli-args.ts` (182 lines): `parseInitArgs` :115, shape unchanged — the `--file`-only rule
  (:117–118), the duplicate check (:123), `failStrayArg` (:126) — correction 1 lands as written.
- `src/prompt.ts` (442 lines): `COMMON_RULES` :53, naming README.md at :57 and :86;
  `TickPromptInput` :144; `buildTickPrompt` :169 (embeds COMMON_RULES :180);
  `buildDirectorPrompt` :185 (embeds :232). `test/prompt.test.ts:525` pins
  `/First read README\.md in full/` — correction 2's byte-identical fallback
  (`briefFile(this.root) ?? "README.md"`) keeps it green; the file gains one adopted-brief
  variant whose prompt names TUMWATER.md instead.
- `src/roles.ts` (412 lines): `plan.find` names "its initial prompt in README.md" at :135;
  `readme.find` :151 names README.md and the status markers. Correction 2's rewrite of both holds.
- `src/loop.ts` (818 lines): `readInitialPrompt(this.root)` :160 and the
  `buildDirectorPrompt(userPrompt, initialPrompt, principles)` call :169 — correction 2's
  `const brief = briefFile(this.root) ?? "README.md"` computes beside :160 and feeds both branches.
- `src/doctor.ts` (268 lines): `checkInit` :99; `runDoctor` :237 with the checks array :243
  (`checkInit` entry :247); the name column is `padEnd(12)` :265 — correction 8's `checkBrief`
  slot holds.
- Tests re-pinned: `test/init.test.ts` is 166 lines; the old-failure test ("initProject refuses
  to drop the initial prompt when README has no tumwater markers") is now :108–113 (correction 5
  inverts it); the PRINCIPLES-seed assertions ("seeds PRINCIPLES.md with positive starter
  principles") are :33–44 (correction 7's added assertions join them). `test/readme.test.ts` is
  94 lines, every case through the `writeReadme` helper (:14) — it gains the resolution-order
  cases.
- Capability absence re-confirmed: `grep -rn 'TUMWATER.md\|briefFile\|briefCandidate\|--adopt\|--dry-run\|adopt:\|dryRun' src/` is empty.

One claim corrected: the 09-18 note's "src/readme.ts is 47 lines" and its implication that
`readInitialPrompt` returns the raw prompt — it now caps at `INITIAL_PROMPT_MAX_CHARS`, so an
adopted repo's `TUMWATER.md` gets the same backstop protection with zero additional code.

Sizing unchanged. No design question remains open.

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
- **Auto-merging `tumwater.example.json` into a user's live config.** 4a/7 reports drift; applying
  it stays the user's decision.
- **Promoting a director-added custom loop into the tracked template.** A deliberate human act by
  design (4a/7).
