# Remote CI: the ci role reads the hosted CI's verdict on what was pushed

Planned 2026-11-04 by the operator at the user's direction. Shared design for the three
`Remote CI` entries in PLANS.md. Siblings: plans/observer-roles.md (the observer scheduling the
ci role rides) and plans/feedback-role.md (the precedent for a role that talks to GitHub through
the operator's own `gh` login, with no GitHub client in the harness).

## The problem

The `ci` role ("CI parity runner", src/roles/role-catalog.ts) reads `.github/workflows/ci.yml`
and runs the workflow's `run:` steps on this machine at main's tip. Its `CI: <sha> — <verdict>`
line is recorded in the parity ledger (src/observer/ci-parity.ts), and the doctor's `ci parity`
row, the status badge and the next ci prompt read that ledger. Nothing asks GitHub whether
Actions passed. The role cannot see a failure that only happens on the hosted runner, and the
team does not learn that a pushed main is red on GitHub until someone looks there.

Measured 2026-11-04 on tumwater's own repo (`gh run list --repo znation/tumwater --workflow CI`):

- 47 of the last 100 GitHub CI runs failed (2026-10-08 to 11-04). Main was pushed 3–9 times a
  day; tumwater itself never pushes (`git push . <ref>:main` in src/merge/merge-git.ts is local).
- Most failures were reds main's own check also saw (comment width, unused exports, PLANS.md
  checks). The local main watch already knows those; GitHub just shows them again at push time.
- Some were not. `test/agent-backend.test.ts` "a synchronous backend invocation throw ends the
  append-log streams (no descriptor leak)" failed on GitHub on four pushes, 10-28 10:36 to 10-29
  07:45 UTC. GitHub's Linux runner leaves `TMPDIR` unset, and macOS always sets it. The bugfix
  role fixed it in f0b41f82e ("Delete TMPDIR when it was unset …"), but nothing told the team
  that GitHub was red in the meantime. The OS (`runs-on: ubuntu-latest`), the Node version
  (`lts/*`, and 22 for packaging) and the environment differ from this Mac's, and no local run
  can show those failures.
- At the last two releases, local main was 68 (11-02) and 85 (11-04) commits ahead of origin. The
  0.4.7 cut found 4 reds only when its push reached GitHub.

## Decisions (the user's, 2026-11-04)

1. **Watch only.** Tumwater does not push. The ci role reads GitHub's verdict on whatever the
   operator pushed. Pushing main's tip to a side branch, or keeping origin main in sync, was
   considered and declined.
2. **The model reads GitHub.** The harness gains no GitHub client and makes no network request
   for this. The ci role's own shell runs `gh` under the operator's login, the same channel the
   feedback role uses, and reports what it saw on a result line. The harness records that line
   in a ledger the way it records `CI:`, `FLOW:` and `FILED:`.
3. **On by default when detectable.** The harness renders the Remote CI block (and the charter's
   remote step applies) when the base branch's remote is on github.com and the repo has a
   workflow file. `roles.ci.remote: false` in tumwater.json turns it off. When `gh` is missing or
   not logged in, the role reports `unavailable` and the doctor row says so as information, not
   as a warning: the operator never opted in, so a missing `gh` is not a fault.

## Shape

**Detection** (harness, local only). `remoteCiTarget(root, config)` returns `{ repo, branch }` or
null. The branch is the base branch (`targetBranch`, as `currentCiParityState` resolves it). The
remote is `branch.<base>.remote`, defaulting to `origin`. Its URL comes from one
`git config --get remote.<name>.url`. `githubRepoOf(url)` parses `owner/name` from the https, scp
(`git@github.com:o/r.git`) and `ssh://` forms on github.com and returns null for any other host.
At least one `*.yml` or `*.yaml` file must be in `.github/workflows/`. Detection runs at the
start of a ci run and in doctor, never in a per-second status poll.

**The block** (appended to the ci prompt at run start). It holds facts and one read-only
command, never instructions. Detection spawns git, and `buildRoleRunPrompt` is synchronous, so
the block rides the ci-only async hook in src/runner/runner-run.ts that already appends the
`<main-red>` heal note. Like that note, it does not show in a prompt preview.

```
Remote CI (GitHub Actions on <owner/name>, branch <base>; from this team's own record):
  last checked <sha7> — <result> <age> ago
  Check it this run with: gh run list --repo <owner/name> --branch <base> --event push --limit 20 --json headSha,status,conclusion,workflowName,databaseId,url,createdAt
```

With no record yet, the second line reads `no result recorded yet`. An `unavailable` record shows
its reason.

**The charter** (role-catalog.ts, ci) gains a remote step that applies only when the block is
present. The parity block's `current` case still skips the suite, but not this one check.

1. Judge the newest pushed sha on the branch only. It is `pending` while any of its runs is
   queued or in progress. It is `failed` when any completed run concluded `failure`,
   `timed_out` or `startup_failure`; `cancelled` and `skipped` are not failures. Otherwise it is
   `passed`. If `gh` is missing, logged out or errors, report `unavailable` and carry on.
2. The same sha and verdict as the block's record means an earlier run already handled it.
   There is nothing new to do for it.
3. For a newly failed sha, read the failure with
   `gh run view <id> --repo <owner/name> --log-failed | tail -n 200` (never the whole log), then
   run the failing tests at main's tip:
   - They fail here too: it is a local red, and the role fixes it as the charter's step 2 says.
   - They pass here, and `git log --oneline <sha>..HEAD` shows a commit that already fixed it:
     nothing to do. The next push shows it.
   - Otherwise it is specific to the hosted runner: its OS (the workflow's `runs-on`), runtime
     version or environment (an unset `TMPDIR`, a case-sensitive filesystem, a missing tool).
     Reproduce that difference here when you can (e.g. `env -u TMPDIR <command>`) and fix it.
     When the cause cannot be shown, file ONE BUGS.md entry quoting the failing test, its
     assertion and the run URL, after checking that no open entry names that test.
   - A failing step that is not a test (install, build, packaging) is judged the same way.
4. `gh` is read-only for this role. It never re-runs, cancels or dispatches workflows, pushes, or
   comments on GitHub.

**The line.** The reply carries `REMOTE: <sha> — <passed|failed|pending>`, or
`REMOTE: unavailable — <reason>`, just before the `CI:` line. Parsing is fail-closed, like
`CI:`: a bare or truncated line records nothing.

**The ledger.** `.tumwater/state/remote-ci.json` holds one record:
`{ repo, sha?, result: "passed"|"failed"|"pending"|"unavailable", reason?, checkedAt }`. A run
records only when its own prompt carried the block, so a stray `REMOTE:` line is ignored. Unlike parity,
it is recorded on both dismissal paths (src/run/run-dismiss.ts), the changed run and the
no-change run. The record says what GitHub reported, which a run's own diff cannot make false,
so it is a book of its own result like `FLOW:` and `FILED:`. Recording it when a run commits a
fix stops the next run from fixing the same remote red again while the first fix is still
queued. A cut-off run records nothing. A failed write warns and the run keeps its outcome.

**Surfaces.** A `remote_ci_failed` notify event fires once per sha, when a record turns
`failed` for a sha not already recorded failed. A doctor `remote CI` row reads the ledger, with a
stall warn when no check has been recorded for 3 days (`CI_PARITY_STALE_MS`). A status, TUI and
dashboard badge sits beside the ci parity badge.

## Parts

- **1/3, the role reads GitHub**: detection, the block, the charter step, the `REMOTE:` line,
  the ledger, recording on both paths, the `roles.ci.remote` config key, docs and an invariant.
- **2/3, the operator hears about it**: the `remote_ci_failed` event and the doctor `remote CI`
  row with its stall predicate. Requires 1/3.
- **3/3, the glance surfaces**: the status line, TUI header and dashboard badge. Requires 1/3,
  and is independent of 2/3.

## How we will know it worked

- Within one ci interval (2 h by default) of a red push, the ledger records `failed` for that
  sha, doctor warns, and the notify hook pages `remote_ci_failed`.
- A remote-only red like the 10-28 TMPDIR one becomes a ci fix or one BUGS.md entry quoting the
  run URL, not a red that lasts across four pushes.
- Fewer releases find reds only when their push reaches GitHub, as the 0.4.7 cut did.

## Deliberately out of scope

- **Pushing** in any form (decision 1).
- **A harness-side GitHub client, token handling or polling** (decision 2). `gh` runs only in
  the model's shell. The harness reads git config and the workflow directory, nothing else.
- **Waking ci on a push.** The ci role's own clock (2 h by default) bounds the delay. A later
  plan could watch `refs/remotes/<remote>/<base>`, which a local `git push` updates, and queue a
  ci prompt a few minutes after it moves.
- **Other CI hosts and GitHub Enterprise.** The line, ledger and surfaces are host-neutral. Only
  `githubRepoOf` and the block's command are GitHub-specific, so another host would add a
  detector and a command.
- **Reproducing the hosted runner in a container.** The charter asks for the difference to be
  reproduced where it can be, not for a Linux VM.
