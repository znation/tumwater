# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Reviewer as a regular role, part 2/4: Post-merge review at fleet scale — the merge poll keeps up and the revert path holds under bugfix volume (planned 2026-10-23 by user; design in plans/reviewer-as-role.md "What lands" item 2 and "Risks"; requires part 1/4 landed; touches src/review/post-merge-review.ts src/merge/merge-slot.ts and their tests)

**Needs review 2026-10-23 by feature: too large for one run**

**Goal.** Post-merge review was built for three slow maintenance roles; part 1/4 moves bugfix's volume onto it. The merge poll's one-at-a-time when-a-permit-is-free cadence and the revert-after-merge path must hold: no unreviewed merged commit waits indefinitely, and a rejection of an already-archived entry does not strand the entry.

**Approach.**
- src/review/post-merge-review.ts: verify (and pin with a test) the review schedule under a sustained merge rate — the poll picks the oldest unreviewed merged commit, and a role whose changes merge faster than they are reviewed accrues at most one pending review per role (the per-role key), never an unbounded backlog.
- The revert slot's routing (`settlePostReview` → revert → author revision) gains a test for the archive race: a change whose PLANS/BUGS entry was archived on merge, then rejected post-merge, re-opens or re-adds its entry so the author has something to fix (today only the clean/dedupe/coverage roles hit this, and their entries are usually self-referential).
- POST_REVIEW_FAILURE_LIMIT (3) behavior is reviewed, not changed: three verdict-less reviews drop the change with the same exhaustion bookkeeping as the pre-merge path's REVIEW_FAILURE_LIMIT — confirm a dropped post-merge change leaves main holding it (already merged, already green-checked) and only logs, which is correct for a failure of the *reviewer*, not the change.

**Acceptance criteria.**
- A test merges N=10 changes across 4 roles with fake reviews resolving on a controlled clock: every merged commit is eventually reviewed, none reviewed twice, and the per-role pending count never exceeds one.
- The archive-race test above passes; `npm run test:gate` passes.

### Check-permit priority, part 2/2: Measure after the reviewer plan lands, then decide whether the cap rises (planned 2026-10-23 by user; design in plans/check-permit-priority.md "What lands" item 2; requires reviewer-as-role parts 1/4 and 3/4 landed (post-merge review removes the demoted roles' pre-merge gate checks; the convergence rule removes the 3–6-round tail that multiplies one item into a dozen checks); touches tumwater.json docs/config.md)

**Refused 2026-10-23 by feature: executing the decision now needs one week of post-reviewer-plan `check_wait` data, but reviewer-as-role parts 1/4 and 3/4 are still under `## Planned` (not landed), so no evidence exists and raising the cap 3→4 now would be the theory-knob this plan's "not a knob raised on theory" decision rejects**

**Goal.** The 24-min waits were burst-driven and demand-driven; both causes land as fixes elsewhere. This part is the decision procedure that says whether any capacity change is still needed — not a knob raised on theory.

**Approach.**
- After reviewer-as-role parts 1/4 and 3/4 have run for one week, read the week's `check_wait` events and the day report's `checkWaitMedianMs`: if no `check_wait` carries waitedMs ≥ CHECK_WAIT_EVENT_MS (30 s), the cap stays 3 and this plan's outcome is "no change needed" — recorded in PLANS-DONE when the part closes.
- Otherwise raise `maxConcurrentChecks` 3 → 4 in tumwater.json and the default stays 2 (src/config/config.ts) — a dogfood decision, not a default change — and watch the load-storm signal: `merge_blocked` events naming "host load average" (as 10-21's feature-7 and bugfix-4 did at load 20 on 18 cores). The doctor's `checkCheckContention` already warns and names the knob; the feedback loop exists.

**Acceptance criteria.**
- The decision (either branch) is recorded with its evidence in PLANS-DONE.md when closed; a raised cap is accompanied by one week of load-watch in the dogfood instance.
- `npm run test:gate` passes (config change only; no code).

### Interlock relief, part 1/2: The merge-queue interlock holds only what the feedback contract needs — a queued author whose change is approved may run (planned 2026-10-23 by user; design in plans/interlock-relief.md "The decision" and "What lands"; evidence: queue waits before landing ran median 5 min, max 3 h 17 m over 58 h, and the interlock parks the author for the whole window; requires reviewer-as-role part 1/4 landed (one switch: `afterMerge` opts a role into both post-merge review and this relief); touches src/merge/merge-queue.ts src/orchestrator/orchestrator-scheduling.ts and their tests)

**Goal.** plans/merge-queue.md invariant 3 ("a loop with a queued or landing change is not eligible to tick") exists to preserve the `state.lastReview` feedback contract. For post-merge-review roles that contract no longer needs the pre-merge pipeline: scope the interlock per role and per stage, so an author whose change is approved-and-waiting or in the fast-forward is not parked, while the stages that actually race the author's branch stay exclusive.

**Approach.**
- src/merge/merge-queue.ts: `queuedMergeRoles` (or its scheduler-side caller) gains the entry's stage. The scheduling skip (src/orchestrator/orchestrator-scheduling.ts, the `queuedRoles.has(runner.role)` skip) applies to a role whose entry is pre-approval (under review or checks) or in a conflict/`main_red` hold (`resolve-wait`, `resolving`, a held pin) — not to one approved-and-waiting or in the merge's fast-forward.
- The per-role tiering follows `review.afterMerge` exactly: a role on that list gets the scoped interlock; a pre-merge-review role keeps today's full interlock (its rejection must reach the runner before it authors again — that is the contract's original case).
- The queue's own per-runner cap is unchanged: a role with a queued change still cannot queue a second (invariant 3's "no change accumulates more than one commit ahead of main"); an author whose new run finishes while its previous change is queued holds the new commit on the branch until the entry drains. The author's next run starts from `reset --hard main` as always, so a queued-approved change does not block its author's tree.
- plans/merge-queue.md invariant 3's text is updated to the scoped form with a pointer to plans/interlock-relief.md; docs/glossary.md's `waiting to merge` row keeps its meaning (it names the queue, not the run gate).

**Acceptance criteria.**
- A post-merge-review role with an approved queued entry starts its next run in the same poll it would have started in with an empty queue; the same role with an entry in `resolve-wait` or under review does not start (test over both stages).
- A pre-merge-review role (feature) with any queued entry still does not start — today's behavior, test unchanged.
- `npm run test:gate` passes.

### Interlock relief, part 2/2: Docs state which roles wait on their merge and which do not (planned 2026-10-23 by user; design in plans/interlock-relief.md "What lands" item 2; requires part 1/2 landed; touches docs/how-it-works.md docs/glossary.md plans/merge-queue.md)

**Goal.** An operator reading the merge-pipeline section can predict which roles author through a queued change and which park, and why the split follows `review.afterMerge`.

**Approach.**
- docs/how-it-works.md, the merge-pipeline/scheduling sections: the interlock paragraph states the two tiers and the stage exclusions (pre-approval, conflict, main-red) as behavior, one paragraph, no new terms.
- docs/glossary.md: the `waiting to merge` status row gains the half-sentence "for pre-merge-review roles, this also holds the role's next run" — the scoped behavior is the row's whole difference.
- plans/merge-queue.md's invariant text carries the final wording (part 1/2 edits it; this part reconciles any drift from review).

**Acceptance criteria.**
- The three docs agree on the tiers and the excluded stages; grep finds no remaining unscoped "a role with a queued change never runs" claim outside plans/ as historical record.
- `npm run test:gate` passes (docs only).

### Backlog hold convergence: A needs-review/needs-replan entry that ping-pongs blocks its entry for the operator after three holds (planned 2026-10-23 by user; from the flow audit — feature↔plan is a genuine role-to-role loop with no convergence backstop: feature's `Needs review` note holds the entry until plan splits it, feature can mark it again, and nothing bounds the cycle; the reviewer's reject→revise loop got REVISION_BACKSTOP and REVISION_FINAL_ON_REPEAT (plans/revise-rejected.md), this loop got nothing; touches src/backlog/backlog-eligibility.ts src/roles/role-catalog.ts src/doctor/doctor-backlog-bugs.ts and their tests)

**Goal.** The `needs-review`/`needs-replan` hold (feature's note that a plan is too large for one run, or must be rewritten) is a hand-off to the plan role, and the plan role's split or rewrite is the lift. The cycle has no backstop: a plan that feature keeps marking and plan keeps splitting unproductively ties up both roles' attention and the entry, invisibly — unlike a rejected change, which visibly exhausts its revision cap. Give it the same convergence the reject loop got: after the third consecutive hold on one entry, the entry blocks for the operator with the history of holds.

**Approach.**
- src/backlog/backlog-eligibility.ts: `entryHold` already parses the note from the entry body; the hold text gains a counter the way `lastReview`'s reasons carry `(prior N)` tags — the note's writer (feature) appends `(held N)` when re-marking an entry whose previous hold was lifted without a landing (the marker is the entry body, so the count survives like every other note; a re-marked entry whose plan landed in between resets, because the new hold answers a different plan).
- On `held 3`, the hold renders as blocked-for-operator: the plan role no longer picks it (its charter skips entries the index block marks `[blocked: …]`), and the stale-backlog visibility that already exists surfaces it — the dashboard's refused-entry alert (src/ui/team-alerts.ts) is the model: a held entry with `(held 3)` shows the operator the entry, the surviving disagreement, and `tumwater plan --release` as the way out.
- The plan role's lift path is unchanged for the first two holds: a split or rewrite that answers the note lifts it as today.
- Left out deliberately: any prompt-level instruction for feature to mark differently. The counter is harness state, not a behavior ask — the same split between mechanism and verdict that plans/revise-rejected.md drew.

**Acceptance criteria.**
- An entry marked, lifted by a split, and marked again reads `(held 1)`, not `(held 2)` (the landing reset); marked three times without a landing between, it reads `(held 3)`, the plan role's eligibility test excludes it, and the operator alert names it.
- `tumwater plan --release` lifts it and clears the counter, as it lifts every other hold today.
- `npm run test:gate` passes.

### Codex backend, part 9a/9: Doctor's Codex rows — install, login, home, models, account, leaks and sessions size (planned 2026-10-20 by user; split 2026-10-23 by the plan role out of the too-large part 9/9; requires part 8/9 landed; independent sibling of parts 9b/9, 9c/9 and 9d/9 — any of the four may land first; design in plans/codex-backend.md "CODEX_HOME and sessions", "Spend, free-ness, window, images" and "Hand steps"; touches src/doctor/doctor-codex-checks.ts (new) src/doctor/doctor-model-checks.ts src/doctor/doctor.ts src/doctor/doctor-check-names.ts src/agent/codex/codex-backend.ts test/fakes/fake-codex.ts test/doctor-checks.test.ts)

**Goal.** An operator can set Codex up from `tumwater doctor` alone: whether the binary is new enough, whether the configured `CODEX_HOME` is logged in the supported way, and what the home shares or leaks.

**Approach.**
- src/agent/codex/codex-backend.ts: export `CODEX_MIN_VERSION = "0.163.0"`, the sibling of `OPENCODE_MIN_VERSION` (src/agent/opencode/opencode-backend.ts) and `CLAUDE_MIN_VERSION` (src/agent/claude/claude-backend.ts).
- src/doctor/doctor-model-checks.ts: add `codexSeamsInUse(config)` beside `claudeSeamsInUse`/`opencodeSeamsInUse` (both built on `seamPairs`), the gate every codex row reads to stand down on a pi-only team.
- src/doctor/doctor-codex-checks.ts (new; the twin of doctor-opencode-checks.ts and doctor-claude-checks.ts): one exported check function per row, each returning null when `!codexSeamsInUse(config)`.
  - install/version: resolve the codex bin as a run would (the run's `TUMWATER_CODEX_BIN`/config dir) and read `codex --version`; below `CODEX_MIN_VERSION` fails.
  - login: `codex login status` under the run's `CODEX_HOME`; ChatGPT passes; an API-key login fails with the startup-gate message; not logged in fails naming `CODEX_HOME=<home> codex login --device-auth`.
  - home: `backends.codex.configDir` unset warns that team runs share the operator's `~/.codex` (trust entries, sessions in the resume picker, skills, a global `AGENTS.md`).
  - models: each routed codex model is in the home's catalog, with its window and any thinking level it lacks.
  - account: `credits.has_credits` true warns that a run crossing a limit may spend credits tumwater cannot count (design §7).
  - leaks: the home's `AGENTS.md`, `skills/` beyond `.system`, `hooks`, and the target repo's `.codex/config.toml` MCP servers, each named.
  - sessions size: report the size of the home's `sessions/`.
- src/doctor/doctor.ts: import the new check functions from doctor-codex-checks.ts and register the rows in the check list (as it imports checkOpencode from doctor-opencode-checks.ts); src/doctor/doctor-check-names.ts: add each row's name to `DOCTOR_CHECK_NAMES`.
- test/fakes/fake-codex.ts: extend the PATH shim beyond its `exec` case to answer `--version`, `login status` and the catalog read, and to shape `$CODEX_HOME` files, so every row runs offline against the fake (never a real codex).

**Acceptance criteria.**
- On the fake: `>= 0.163.0` passes and a lower version fails; ChatGPT login passes; an API-key login fails with the startup-gate message; a logged-out home fails naming the login command; unset `configDir` warns naming what the shared home exposes; a routed model missing from the catalog and a `has_credits` account warn; each leak path is named; a pi-only team shows no codex row.
- `npm run test:gate` passes.

### Codex backend, part 9b/9: Session retention — prune expired Codex sessions with `codex delete --force` (planned 2026-10-20 by user; split 2026-10-23 by the plan role out of the too-large part 9/9; requires part 8/9 landed; independent sibling of parts 9a/9, 9c/9 and 9d/9; design in plans/codex-backend.md "CODEX_HOME and sessions"; touches src/agent/session-ledger.ts src/orchestrator/retention.ts test/session-ledger-prune.test.ts test/retention.test.ts)

**Goal.** The team's Codex sessions age out on `sessionRetentionDays` like every other backend's, so a team's `CODEX_HOME` does not grow forever; the same prune reports what it deleted.

**Approach.**
- src/agent/session-ledger.ts: add `pruneCodexSessions(sessionsRoot, days, { bin, env })`, the twin of `pruneOpencodeSessions`: read the expired codex ledger records first and run `codex delete --force <id>` under the run's `CODEX_HOME` env, bounded at 10 s. Without `--force` Codex refuses to delete without a terminal (design finding 21), so `--force` is part of the command.
- When a delete fails or the binary is unusable, remove that session's rollout file under `$CODEX_HOME/sessions/` as the fallback (the OpenCode spill-file fallback's twin), so the ledger line and rollout do not outlive the window.
- src/orchestrator/retention.ts: in `RetentionPruner.prune`, call `pruneCodexSessions` beside `pruneOpencodeSessions` when a codex seam is configured (resolve the codex bin as a run would), before `pruneOldFiles` ages the ledger out, and warn one `deleted N expired codex session(s)` event when it deleted anything.

**Acceptance criteria.**
- A test with an expired codex ledger record and a fake codex on PATH sees exactly one `codex delete --force <id>` for it and its rollout gone; a fresh record is kept and gets no delete.
- A fake codex whose delete exits nonzero leaves that session's rollout removed by the fallback.
- `npm run test:gate` passes.

### Codex backend, part 9c/9: Codex docs — a backends.md section, the config keys and the README backend list (planned 2026-10-20 by user; split 2026-10-23 by the plan role out of the too-large part 9/9; requires part 8/9 landed; independent sibling of parts 9a/9, 9b/9 and 9d/9; design in plans/codex-backend.md "The decisions" and "Hand steps"; touches docs/backends.md docs/config.md README.md)

**Goal.** The Codex backend is documented where the other backends are, so an operator can configure and trust it from the docs alone.

**Approach.**
- docs/backends.md: a "Codex (`backend: "codex"`)" section — what it runs, the home and its one login, subscription-only billing, the windows and reserve, what is disabled and why (no sandbox, API-key login refused), sessions, and the sandbox choice — naming `backends.codex.configDir`, `codex login --device-auth` and `windowReserve`.
- docs/config.md: the `backends.codex` keys (`configDir`, `windowReserve`, `args`).
- README.md: add Codex to the backends list (the Backends paragraph; never the brief block between the `tumwater:prompt` markers).

**Acceptance criteria.**
- docs/backends.md's Codex section names `backends.codex.configDir`, `codex login --device-auth` and `windowReserve`; docs/config.md names the `backends.codex` keys; README's backend list names Codex.
- `npm run test:gate` passes.

### Codex backend, part 9d/9: The opt-in `smoke:codex` live check (planned 2026-10-20 by user; split 2026-10-23 by the plan role out of the too-large part 9/9; requires part 8/9 landed; independent sibling of parts 9a/9, 9b/9 and 9c/9; design in plans/codex-backend.md "Hand steps" and "Risks"; touches scripts/smoke-codex.mjs (new) package.json)

**Goal.** After a Codex upgrade, one live command proves the production invocation still works — the same hand check `smoke:claude` and `smoke:opencode` give.

**Approach.**
- scripts/smoke-codex.mjs (new; the twin of scripts/smoke-opencode.mjs and scripts/smoke-claude.mjs), run through a new `"smoke:codex"` script in package.json; it is not part of `npm test`.
- It runs the exact production invocation in a throwaway git repo and lists every step under `--help`/a dry-run without spawning codex: a fresh run that edits a file and runs a command; a resume that recalls it; a SIGTERM mid-command after which no marked process is left; an end-of-run note through `tumwater-notes`; an assertion that the first request is under 10,000 input tokens (8,059 on 0.163.0), catching an isolation regression; a 90-second command polled to completion with no `codex_command_abandoned`; and an assertion that the rollout gave a `five_hour` and a `seven_day` reading.

**Acceptance criteria.**
- `npm run smoke:codex --help` (or the dry-run flag) prints its steps without spawning codex.
- `npm run test:gate` passes.

### Write guard on Codex, part 4/9: Ask codex for the hook's trust key and hash through `hooks/list`, and cache them per build and Codex version (planned 2026-10-23 by user; requires part 3/9 landed; design in plans/codex-write-guard.md "Trust (parts 4–5)" and finding 3; touches src/agent/codex/codex-hook-trust.ts (new) src/paths.ts test/fakes/fake-codex.ts docs/invariants.md test/codex-hook-trust.test.ts (new))

**Goal.** Codex runs a session-flag hook only with the right `trusted_hash`. The hash is opaque: no simple digest of the definition matched (finding 3). So tumwater asks Codex for it, once per build and Codex version.

**Approach.**
- src/agent/codex/codex-hook-trust.ts (new): `lookupCodexHookTrust({ bin, env, cwd, definition, timeoutMs = 15_000 }): Promise<{ key: string; hash: string }>`.
  - It spawns `<bin> -c <codexHookArg(definition)> app-server` in `cwd` with `env`, using the harness's own spawn helper with process-group kill. It kills the group when done, on timeout and on error.
  - Over stdio, one JSON object per line, it sends `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"tumwater","version":<tumwater version>}}}`, then `{"jsonrpc":"2.0","method":"initialized"}`, then `{"jsonrpc":"2.0","id":2,"method":"hooks/list","params":{"cwds":[cwd]}}`.
  - It reads the reply to id 2 and returns the first hook in `result.data[*].hooks` with `source: "sessionFlags"`, `eventName: "preToolUse"` and `command` equal to `definition.command`, giving `{ key, hash: currentHash }`. It never hardcodes the key, which was `/<session-flags>/config.toml:pre_tool_use:0:0` on 0.163.0.
  - It rejects on timeout, on child exit before the reply, on a JSON-RPC error, and on "codex listed no session-flag PreToolUse hook with this command". It needs no login and makes no model request (verified with an empty `CODEX_HOME`).
- `codexHookTrust({ root, bin, env, cwd, definition })` caches in `codexHookTrustPath(root)` (new in src/paths.ts: `.tumwater/state/codex-hook-trust.json`).
  - The cache key is the trimmed output of `<bin> --version` plus `JSON.stringify(definition)`, each entry `{ key, hash, checkedAt }`.
  - A hit returns without spawning `app-server`. A miss looks up and writes the entry through `writeJsonAtomic`.
  - With `root` undefined (a hand run with no `.tumwater` root) it looks up and caches nothing. It never creates a `.tumwater` directory: a hand run once minted a phantom `$TMPDIR/.tumwater` and reddened every suite on the host (plans/codex-write-guard.md "Visibility").
- test/fakes/fake-codex.ts: the shim answers `app-server`.
  - It reads the JSON-RPC lines and answers `initialize` with `{}` and `hooks/list` with one sessionFlags preToolUse hook whose `command` is parsed from the `-c hooks.PreToolUse=` argument and whose `currentHash` is `sha256:` plus the sha256 of that command.
  - It appends each app-server start to a calls file the test can count. A test switch makes it hang, for the timeout case.
- docs/invariants.md: the next free `INV-CW` id. It is "the trust key and hash come from Codex's own `hooks/list` for the exact definition, are cached per Codex version and definition, and a lookup that times out leaves no child behind", pinned by the tests below.

**Tests.** test/codex-hook-trust.test.ts, on the fake:
- a lookup returns the fake's key and `sha256:` hash;
- a second `codexHookTrust` with the same version and definition starts no `app-server` (the calls file has one line);
- a changed `timeout` or a changed `--version` output looks up again;
- a hanging fake rejects within `timeoutMs` (set to 500 ms in the test), and the child's pid is gone afterwards;
- a fake whose list holds no matching hook rejects with the message above;
- `root` undefined writes no file.

**Acceptance criteria.**
- No Codex run's argv changes yet, and no code path calls the lookup outside the tests.
- `npm run test:gate` passes.

### Write guard on Codex, part 5/9: An async `prepare` step on agent backends; codex's resolves the guard's trust before a run (planned 2026-10-23 by user; requires part 4/9 landed; design in plans/codex-write-guard.md "Trust (parts 4–5)"; also edited by the open Codex backend part 9a/9 in other functions of src/agent/codex/codex-backend.ts, so whichever lands later rebases; touches src/agent/agent-backend.ts src/agent/run-agent.ts src/agent/codex/codex-backend.ts test/agent-backend.test.ts test/codex-run.test.ts)

**Goal.** `AgentBackend.invocation()` is synchronous, but the trust lookup spawns `codex app-server`. Resolve it in an awaited step before the invocation is built, without blocking the event loop and without one `app-server` per run.

**Approach.**
- src/agent/agent-backend.ts: `AgentBackend` gains optional `prepare?(run: AgentRunSpec): Promise<void>`, documented as "work the invocation needs that cannot be synchronous; never throws a run away".
- src/agent/run-agent.ts: right before `backend.invocation(runSpec)` (today around line 304), `await backend.prepare?.(runSpec)` inside a try/catch. A throw is logged as a `warning` (source `tumwater`) through `logEventBestEffort` on the run's root (`nearestTumwaterRoot(opts.sessionDir)`, skipped with no root), and the run continues.
- src/agent/codex/codex-backend.ts: `prepare(run)` resolves the guard's trust for `codexWriteGuardDefinition()` under the run's codex env (`CODEX_HOME` as `invocation` computes it).
  - It goes through `codexHookTrust` with `root = nearestTumwaterRoot(run.sessionDir)` and `cwd = run.cwd`.
  - It is single-flight: one in-flight promise per process per (home, definition), shared by concurrent runs.
  - The result is a module-level state that `invocation` reads synchronously: `{ trust }` or `{ off: reason }`.
  - A failed lookup records `off` and logs one `warning` per process per (home, definition): `codex write guard off: <reason>`.
- Nothing uses the stored trust yet. This part only warms it, so a codex run now starts one `app-server` per new build and Codex version, and none on a cache hit.

**Tests.**
- test/agent-backend.test.ts (or a run-agent test beside it): a backend whose `prepare` throws still spawns its run and logs one warning; a backend without `prepare` behaves as before.
- test/codex-run.test.ts, on the fake:
  - two codex runs started together start one `app-server`;
  - a hanging `app-server` lets both runs start after the bounded wait and logs `codex write guard off:` once across three runs;
  - a pi run and a claude run start no `app-server`.

**Acceptance criteria.**
- No backend's argv changes.
- A failing lookup never fails or delays a run beyond the 15 s bound.
- `npm run test:gate` passes.

### Write guard on Codex, part 6/9: Codex runs carry the trusted write-guard hook (planned 2026-10-23 by user; requires part 5/9 landed; design in plans/codex-write-guard.md "Runs (part 6)" and findings 1, 2 and 5; also edited by the open Codex backend part 9a/9 in other functions of src/agent/codex/codex-backend.ts; touches src/agent/codex/codex-args.ts src/agent/codex/codex-backend.ts docs/invariants.md test/codex-args.test.ts test/codex-run.test.ts)

**Goal.** Turn the guard on. A codex run whose `apply_patch` would land under the team root but outside its worktree is refused with the shared refusal, as pi, claude and OpenCode runs are.

**Approach.**
- src/agent/codex/codex-args.ts: `CodexArgOptions` gains `guardArgs?: string[]`. codexArgs inserts it after the harness's own `-c` keys and before `-m`, on fresh and resumed (`exec resume`) runs alike. The passthrough cannot override it, because part 3/9 reserved `hooks`.
- src/agent/codex/codex-backend.ts: `invocation` reads the state `prepare` stored.
  - With `{ trust }` it passes `guardArgs: ["-c", codexHookArg(definition), "-c", codexHookTrustArg(trust)]`.
  - With `{ off }`, or no state, it passes neither. An untrusted hook would be skipped silently anyway.
  - It never passes `--dangerously-bypass-hook-trust`. That flag would run the target repo's own `.codex` hooks unreviewed and add an `error` item to every run's stream (findings 1 and 4).
- docs/invariants.md: the next free `INV-CW` id. It is "a codex run carries the guard's hook and its trust entry together or neither, and never `--dangerously-bypass-hook-trust`", pinned by the tests below.

**Tests.**
- test/codex-args.test.ts: `guardArgs` lands between the last harness `-c` and `-m` for both a fresh and a resumed run, and is absent when unset.
- test/codex-run.test.ts, on the fake:
  - a fresh run and a resumed run each carry both `-c` values with the fake's key and hash;
  - with the lookup failing, neither appears;
  - no argv ever contains `--dangerously-bypass-hook-trust`.

**Acceptance criteria.**
- With trust available, every codex run's argv carries the hook and its trust; without it, the argv is exactly today's.
- The codex stream translator is unchanged: a blocked patch adds no stream item (finding 5).
- `npm run test:gate` passes.

### Write guard on Codex, part 7/9: Codex's prompt dialect sends file edits through `apply_patch` (planned 2026-10-23 by user; requires part 6/9 landed; design in plans/codex-write-guard.md "Coverage (part 7)" and finding 6; touches src/prompt/dialect.ts test/prompt-dialect.test.ts)

**Goal.** The guard sees only `apply_patch`. plans/codex-backend.md's probes saw codex models edit through the shell (`printf >>`) unless the prompt asked for `apply_patch`, so ask for it.

**Approach.**
- src/prompt/dialect.ts: `CODEX_DIALECT.backendRules` gains one rule: "Edit and create files with the `apply_patch` tool, not shell redirection (`>`, `>>`, `tee`) or `sed -i`."
- Update the `CODEX_DIALECT` doc comment to say why: the write guard checks only `apply_patch` (plans/codex-write-guard.md).

**Tests.** test/prompt-dialect.test.ts:
- a codex run prompt contains the rule exactly once;
- the pi, claude and OpenCode run prompts do not contain it;
- the codex prompt's other backend rule (the `write_stdin` polling rule) is still present.

**Acceptance criteria.**
- Only codex prompts change, by exactly that rule.
- `npm run test:gate` passes.

### Write guard on Codex, part 8/9: Doctor's codex group reports whether codex runs carry the write guard (planned 2026-10-23 by user; requires part 6/9 and Codex backend 9a/9 landed; design in plans/codex-write-guard.md "Visibility (parts 8–9)"; touches src/doctor/doctor-model-checks.ts test/doctor-model-checks.test.ts)

**Goal.** An operator can see from `tumwater doctor` whether codex edits are guarded, and why not when they are not.

**Approach.**
- src/doctor/doctor-model-checks.ts: in the codex check rows Codex backend part 9a/9 adds (each shown when any job routes to codex), add a `write guard` row.
- The row runs `codexHookTrust` for the run env's home and the current build's definition, bounded at 10 s like the group's other Codex calls.
  - pass: `trusted (sha256:<first 12 hex>)`;
  - warn: `off: <reason> — codex runs edit without the worktree check`.
- Doctor stays read-only apart from the cache file, which `codexHookTrust` already writes.

**Tests.** test/doctor-model-checks.test.ts, on the fake:
- a fake that lists the hook gives the pass row with the hash prefix;
- a fake whose list is empty gives the warn row naming the reason;
- a pi-only team shows no codex group, so no row.

**Acceptance criteria.**
- Both rows render as above.
- `npm run test:gate` passes.

### Write guard on Codex, part 9/9: The live `smoke:codex` step for the guard, and the docs (planned 2026-10-23 by user; requires part 6/9 and Codex backend 9c/9 and Codex backend 9d/9 landed; design in plans/codex-write-guard.md "Visibility (parts 8–9)" and "Risks"; touches scripts/smoke-codex.mjs docs/how-it-works.md docs/backends.md plans/codex-backend.md)

**Goal.** After a Codex upgrade, one live command proves the guard still blocks. Session-flag trust could stop working while the `hooks/list` lookup still succeeds ("Risks"). The docs should say which backends are guarded and how.

**Approach.**
- scripts/smoke-codex.mjs (added by Codex backend part 9d/9) gains a `write guard` step.
  - Build a throwaway team layout: a git repo `<T>/repo`, its worktree `<T>/repo/.tumwater/worktrees/_slot-1`, and the same `notes.md` text in both. Keep the session dir under `<T>/repo/.tumwater/sessions`, never outside a `.tumwater` root.
  - Run the production invocation through `runAgent`, asking the model to use `apply_patch` to change `notes.md` at the primary's absolute path, and to follow any refusal.
  - Assert three things: the primary's `notes.md` is unchanged, the worktree's `notes.md` changed, and the run's rollout holds "blocked by PreToolUse hook".
  - The step is listed by the script's `--help`/dry-run.
- docs/how-it-works.md, "A run" step 2: the guarded tools name codex's `apply_patch`, through a trusted hook. Shell writes stay unchecked on every backend.
- docs/backends.md, Codex section:
  - the guard is a PreToolUse hook passed with `-c`, trusted through the same session-flag layer with the hash Codex reports;
  - `codex-hook-trust.json` caches the hash;
  - `--dangerously-bypass-hook-trust` is never used.
- plans/codex-backend.md: under "never passes `--dangerously-bypass-hook-trust`", add one sentence: tumwater trusts only its own write-guard hook, through the session-flag layer (plans/codex-write-guard.md).

**Tests.** None beyond the script's dry-run listing. The live step runs by hand: `npm run smoke:codex`.

**Acceptance criteria.**
- `npm run smoke:codex -- --help` (or the script's dry-run flag) lists the `write guard` step.
- The docs name codex among the guarded backends and its `apply_patch`-only coverage.
- `npm run test:gate` passes.

### Feedback role, part 2/2: the FILED reply line, the per-install filing ledger, and the issue_filed event (planned 2026-10-23 by user; requires part 1/2 landed; design in plans/feedback-role.md "Shape" → "Part 2" and "Invariants" 3-5; touches src/verdict/reply-contract.ts src/runner/runner-run.ts src/run/feedback-filings.ts (new) src/paths.ts src/prompt/prompt.ts src/run/run-prompt.ts src/run/run-verdict.ts src/run/run-stage.ts src/events/events.ts src/events/event-format.ts src/events/event-labels.ts src/roles/role-catalog.ts test/reply-contract.test.ts test/feedback-filings.test.ts (new) test/run-prompt.test.ts test/run-verdict.test.ts test/event-format.test.ts test/event-labels.test.ts)

**Goal.** Every feedback run starts a fresh session, so the only durable record of what this install already filed must live in harness state — exactly the qa flow-coverage problem (plans/observer-roles.md 2/2). Add the model-reported result line, the ledger it persists to, the next run's injected "previously filed" block, and the event that makes a filing visible in the operator's activity feed.

**Approach.**
- src/verdict/reply-contract.ts: `extractFiled(text)` beside `extractFlow` — `labeledLine(text, "FILED")`, then `/^#(\d+)\s*[—-]\s*(.+)$/`; null on no match, a missing number, or an empty title, so a truncated run never records a result it never declared.
- src/runner/runner-run.ts: `const filed = ctx.baseRole === "feedback" ? extractFiled(pi.finalText) : null;` beside the qa flow extraction (line 731), threaded into the verdict context.
- src/run/feedback-filings.ts (new, mirroring qa-coverage.ts): the `{ filings: [{ issue, title, filedAt }] }` ledger capped at the newest 100; read (malformed → empty), atomic record, and a `renderFilingsBlock` that returns undefined when empty and renders `#<n> <title> (<age>)` newest-first otherwise.
- src/paths.ts: `feedbackFilingsPath(root)` = `.tumwater/state/feedback-filings.json` with the qaCoveragePath-style doc comment.
- src/prompt/prompt.ts: `RunPromptInput.filings?: string` rendered beside the digest block; src/run/run-prompt.ts injects it for feedback only, in the qa coverage block's try/catch shape.
- src/run/run-verdict.ts + src/run/run-stage.ts: record beside qa's `recordFlow` — a non-cut-off `ctx.filed` writes the ledger and logs the `issue_filed` event (best-effort; a failed ledger write warns and never fails the run); a feedback run that also changed the tree still records its filing.
- src/events: `issue_filed` joins the event type union, rendered `filed issue #<n> <title> on znation/tumwater` in the feed, label `issue filed`.
- src/roles/role-catalog.ts: the charter's dedupe step names the injected "previously filed" block.

**Tests.**
- test/reply-contract.test.ts: `extractFiled` parses `FILED: #12 — title`; a line without a number, a mid-sentence mention, and a truncated `FILED: #12 — tit` yield null.
- test/feedback-filings.test.ts (new): ledger round-trip, the 100-entry cap keeps the newest, a malformed file reads empty, an empty ledger renders no block, the block renders newest-first with ages.
- test/run-prompt.test.ts: a feedback prompt over a non-empty ledger carries the filings block; no other role ever does.
- test/run-verdict.test.ts: a no_change feedback run with `filed` records the ledger entry and a cut-off run records nothing, mirroring the qa flow tests' shape (lines 156-183); a failed ledger write warns without failing the run.
- test/event-format.test.ts and test/event-labels.test.ts: the `issue_filed` rendering and label.

**Acceptance criteria.**
- A fulfilled feedback run's reply carrying `FILED: #<n> — <title>` persists to `.tumwater/state/feedback-filings.json`, renders in the next run's prompt as the previously-filed block, and logs `issue_filed` to the event feed; a truncated or malformed line records nothing.
- The run's outcome is unchanged (`no_change`, clean worktree, no warning): recording is bookkeeping that never fails the run.
- `npm run test:gate` passes.

### Split orchestrator-scheduling.ts's pollRunnerReasons pass into a scope/skip/admit structure (planned 2026-10-23 by the organize role, plan-only; the pass is one 444-line function, ~73% of the 611-line module, so it is not splittable in one run — this plan lands the target structure for a later organize run)

**Goal.** `src/orchestrator/orchestrator-scheduling.ts` is the largest splittable module left: its exported `pollRunnerReasons` (lines 114-557) is a single function that runs the whole per-poll scheduling pass — the one-poll precompute (merge-queue interlock, director pin, per-base claim groups and their release loop, the team-gate block predicates, the multi-runner `writing` count and admission order), then a per-runner loop folding the skip gates and once settlement, then the claim-assignment and stand-down admission. The file's other exports (`reviewHoldKey`, `pollDeferralInputs`) are small. Splitting the pass into three focused modules by phase, with `pollRunnerReasons` kept as the thin binder, makes the WHY-due policy each phase computes addressable on its own screen, the way the config-validation split did for `validateConfig`.

**Approach.**
- New `src/orchestrator/scheduling-scope.ts` — phase A (the one-poll precompute, current lines ~145-288): returns a `SchedulingScope` struct carrying `queuedRoles`, `pinnedDirector`, `claimGroups` (including the claim-release side loop that mutates runner state and persists), the gate-block predicate closures (`budgetHolds`, `operatorPauseBlocks`, `hasDemand`, `bootstrapHeldNow`, `maintenanceQuotaOverLine`), the `writing` counts, `ordered` runners, and the `eligibleMemo` map.
- New `src/orchestrator/scheduling-skip.ts` — phase B (the per-runner verdict loop, ~289-460): given a runner and the scope, returns `{ verdict: SkipReason }` or "due", folding once-mode settlement, the pause/cost-cap/maintenance/bootstrap gates, the director's window hold, inbox due, conflict-pin hand-back, need-based deferral, the merge-queue interlock, and the `instances` limit. It writes the skipped entries into the `reasons` map it is passed.
- New `src/orchestrator/scheduling-admit.ts` — phase C (~461-552): claim assignment for multi-runner groups (the hold/eligible/held rules) and the stand-down turn-down, returning the assigned/stood-down verdict for the runner.
- `src/orchestrator/orchestrator-scheduling.ts` shrinks to: build the scope via scheduling-scope, then loop `ordered` runners calling scheduling-skip and (when "due") scheduling-admit, assembling the `reasons` map; it keeps `SchedulingPassCtx`, `reviewHoldKey`, and `pollDeferralInputs`. The pass-level doc comment (lines 1-13) and each phase's inline invariants move with the code they explain.
- `src/scheduling/scheduling.ts` etc. keep the shared helpers they already own; nothing new is exported beyond the three modules' phase functions.

**Files touched.** src/orchestrator/orchestrator-scheduling.ts; new src/orchestrator/scheduling-scope.ts, src/orchestrator/scheduling-skip.ts, src/orchestrator/scheduling-admit.ts; orchestrator-scheduling.test.ts and orchestrator.test.ts only if an import path changes.

**Acceptance criteria.**
- `pollRunnerReasons` produces a byte-identical `reasons` map for identical input and state: this is a pure code-move restructure, no behavior change (the interlock-relief and cooldown-scope plans change behavior and will touch this file; this split must rebase behind them, not change what they set).
- A grep over src, test and docs finds no stale reference to any moved or renamed symbol; the file-level doc comment still names the pass and each phase module.
- `npm run test:gate` passes.

## Done
