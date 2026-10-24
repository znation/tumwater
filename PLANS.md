# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Check-permit priority, part 2/2: Measure after the reviewer plan lands, then decide whether the cap rises (planned 2026-10-23 by user; design in plans/check-permit-priority.md "What lands" item 2; requires reviewer-as-role parts 1/4 and 3/4 landed (post-merge review removes the demoted roles' pre-merge gate checks; the convergence rule removes the 3–6-round tail that multiplies one item into a dozen checks); touches tumwater.json docs/config.md)

**Refused 2026-10-23 by feature: executing the decision now needs one week of post-reviewer-plan `check_wait` data, but reviewer-as-role parts 1/4 and 3/4 are still under `## Planned` (not landed), so no evidence exists and raising the cap 3→4 now would be the theory-knob this plan's "not a knob raised on theory" decision rejects**

**Prerequisite landed 2026-10-23 by the steward: reviewer-as-role parts 1/4 and 3/4 both landed today (their PLANS-DONE.md entries stamp done 2026-10-23), so the refusal's stated cause — "parts 1/4 and 3/4 are still under `## Planned` (not landed)" — no longer holds. The plan's remaining gate is the week of post-reviewer-plan `check_wait` data the approach requires, which cannot exist before ~2026-10-30; the refusal is not lifted here — releasing a Refused note is an operator/director call — but the record is corrected so the real gate (the data week, not the parts) is what blocks.**

**Goal.** The 24-min waits were burst-driven and demand-driven; both causes land as fixes elsewhere. This part is the decision procedure that says whether any capacity change is still needed — not a knob raised on theory.

**Approach.**
- After reviewer-as-role parts 1/4 and 3/4 have run for one week, read the week's `check_wait` events and the day report's `checkWaitMedianMs`: if no `check_wait` carries waitedMs ≥ CHECK_WAIT_EVENT_MS (30 s), the cap stays 3 and this plan's outcome is "no change needed" — recorded in PLANS-DONE when the part closes.
- Otherwise raise `maxConcurrentChecks` 3 → 4 in tumwater.json and the default stays 2 (src/config/config.ts) — a dogfood decision, not a default change — and watch the load-storm signal: `merge_blocked` events naming "host load average" (as 10-21's feature-7 and bugfix-4 did at load 20 on 18 cores). The doctor's `checkCheckContention` already warns and names the knob; the feedback loop exists.

**Acceptance criteria.**
- The decision (either branch) is recorded with its evidence in PLANS-DONE.md when closed; a raised cap is accompanied by one week of load-watch in the dogfood instance.
- `npm run test:gate` passes (config change only; no code).

### A post-merge rejection stops reverting, part 1/3: the merge drain hands the reviewer's reasons to the authoring role instead of filling the revert slot (planned 2026-10-24 by the plan role, split from the held single fix-forward entry; gated on the `## Planned` accounting plan "Every post-merge rejection reaches one accounted terminal state…" landing first — it adds `recordForwardedChange` and the runner routing this part calls; touches src/merge/merge-post-review.ts src/merge/merge-drain.ts src/baseline/main-revert.ts docs/invariants.md test/post-merge-review.test.ts test/merge-drain.test.ts test/main-revert.test.ts)

**Refused 2026-10-24 by feature: superseded — the user's 2026-10-24 "Forward, never back" plan deletes this part's machinery (`sendReviewToRole`, the `recordForwardedChange` routing and the whole revert subsystem), replacing it with the reviewer fixing the finding itself, and the prerequisite accounting plan that would add `recordForwardedChange` has not landed; implementing it would land the direction the user decided against**

**Previously held 1**

**Follow-up 2026-10-24 by the operator:** feature runners claim this entry every minute (48 claims so far) and have landed nothing, and its direction — forward the reviewer's reasons to the commit's authoring role — is replaced by "Forward, never back" below, where the reviewer that found the issue fixes it itself. Leave whatever is in flight as it is: the seam this part builds (`sendReviewToRole`, the reasons payload, the runner routing) is what the newer plan reuses to land the reviewer's own fix, so a landed part is not wasted and nothing landed should be undone. Reconcile the hand-back target when that plan lands.

**Goal.** A rejected post-merge review should cost one follow-up fix, not a revert cycle. Today `drainPostReviews` (src/merge/merge-post-review.ts) builds a revert-slot culprit (`postReview: { reasons }`), so a rejection pays a revert commit, a gate run on that revert inside the single merge slot, an authoring run that re-applies the whole patch from `refs/tumwater/rejected/<role>`, and then the follow-up's own gate, merge and second review. The reviewer's reasons never reach the author as a fix on top of main, where the commit already is. This part makes forwarding the only path `drainPostReviews` takes and leaves `runMainRevert` its red-main job.

**Approach.**
- src/merge/merge-post-review.ts `drainPostReviews`: for a rejected entry, forward the reviewer's numbered reasons to the commit's authoring role through `sendReviewToRole` (the prerequisite plan routes it through `recordForwardedChange`), then `settlePostReview(ctx.root, rejected.commit, null)`. Delete the `skipChecks` WeakSet, the `revertSkipReason` import and call, the `postReview` culprit construction and the `p.revert = culprit` assignment: the entry exists to carry the reasons to a fix, not to wait for a revert. A rejection with no free runner is parked by the prerequisite routing and stays in post-review.json until assigned. The unreviewed-entry arm and the one-review-at-a-time behaviour are unchanged.
- src/merge/merge-drain.ts: `sendReviewToRole` becomes the primary forward, not the failed-revert fallback — keep its "A review after merging rejected your commit <sha> on <branch>. It is still on main. Fix what the reviewer found in a new change:" text, drop its `reason` parameter and the "it could not be reverted" clause, and drop the `c.postReview === undefined` guard. `revertReasons`' `if (c.postReview)` branch, `handBackReverted`'s post-review handling, `startRevert`'s `(c, reason) => sendReviewToRole(...)` argument and its `if (culprit.postReview) settlePostReview(...)` line go with their only producers.
- src/baseline/main-revert.ts: delete `MainCulprit.postReview` and every read of it — `heal`'s `toReviewer`/`onFailed` branch, the post-merge-rejection wording in the revert message, and `reason: c.postReview ? "post-review" : "main-red"`, which becomes the constant `reason: "main-red"`. Delete `runMainRevert`'s `onFailed` parameter. Keep the `main_revert.reason` field and its readers (`revertGuardrail` and the report, run-detail and failure surfaces): events written before this change still carry `post-review`, and that value must keep reading as a post-merge rejection.
- docs/invariants.md: delete INV-BT2's pin "a rejecting post-merge review reverts the commit and hands it back as a revision" with the path it pins; state the new guarantee (a rejected entry is forwarded to its authoring role and leaves post-review.json with no revert). Correct the INV-C3 paragraph so `reason: "post-review"` reads as a legacy event value no new revert carries, not a live one.
- No change to `recordForwardedChange` (prerequisite-owned), `POST_MERGE_REJECT_WARN`, the churn alert, the red-main watch, or the revert-skip check's other callers.

**Files touched.** src/merge/merge-post-review.ts src/merge/merge-drain.ts src/baseline/main-revert.ts docs/invariants.md test/post-merge-review.test.ts test/merge-drain.test.ts test/main-revert.test.ts

**Acceptance criteria.**
- A rejecting post-merge review hands its numbered reasons to the commit's authoring role, naming that commit and the branch, settles the entry out of post-review.json, and starts no revert: no `main_revert` event and the merge slot is free for the next queued change on the same poll.
- A rejection whose reasons cannot be delivered leaves the commit on main and logs one warning; no revert is attempted and no entry is silently dropped.
- A red-main culprit revert is unchanged end to end except that its `main_revert.reason` is always `main-red`; a pre-existing `reason: "post-review"` event still reads as a post-merge rejection on every reader.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review.test.ts: replace "a rejecting post-merge review reverts the commit and hands it back as a revision" with `a rejecting post-merge review forwards the reasons and starts no revert` — seed a merged afterMerge change, reject it, and assert the authoring role's inbox/pending record carries the reasons and the commit sha, the entry left post-review.json, and no revert was started. Keep the torn-entry, failed-write and git-could-not-start cases.
- test/merge-drain.test.ts: `a post-merge rejection never fills the revert slot` — run two polls with a rejected entry and an idle merge slot and assert the slot stays free for a queued change while the entry leaves post-review.json once forwarded.
- test/main-revert.test.ts: move the failed-delivery assertion to the primary path — a rejection whose reasons cannot be delivered warns and leaves the commit on main with no revert attempted; the red-main culprit revert's existing cases are unchanged.

### A post-merge rejection stops reverting, part 2/3: `tumwater reviews` and the shared renderer name the forwarded follow-up, not a revert (planned 2026-10-24 by the plan role, split from the held single fix-forward entry; requires part 1/3 landed, since the entry it renders no longer waits on a revert; touches src/review/post-merge-review-render.ts src/review/post-merge-review-accept.ts src/cli/cli-review-commands.ts src/cli/help.ts docs/cli.md test/post-merge-review-render.test.ts test/cli-reviews.test.ts)

**Previously held 1**

**Follow-up 2026-10-24 by the operator:** this entry's surfaces change again under "Forward, never back" below — a rejected entry reads `fixed — <finding> (fix <sha>)`, and the accept affordances go entirely rather than being re-worded — so land it only as far as it goes; its wording half (no "waiting to revert", no "let the revert run") is what the newer plan keeps, and whatever is in flight now stays as it is.

**Goal.** The shared renderer `postReviewStatusLabel` still prints `[rejected — waiting to revert: …]`, and `cmdReviewsAccept` still refuses a rejected entry with "waiting on its revert". After part 1/3 there is no revert to wait for: a rejected entry is forwarded to its author, or parked until a runner can take it. Name the forwarding state instead.

**Approach.**
- src/review/post-merge-review-render.ts `postReviewStatusLabel`: the `rejected` branch reads `[rejected — awaiting the author's follow-up: <reasons>]` (keep the 60-character squash). Update the function's doc comment, which says the reasons are "still waiting on the revert". The label is shared by `tumwater reviews` and the TUI Pending pane; no other renderer change.
- src/review/post-merge-review-accept.ts: its doc comments call a `rejected` entry "waiting on its revert"; say it awaits its author's follow-up. The `rejected` outcome and the never-accept rule are unchanged.
- src/cli/cli-review-commands.ts `cmdReviewsAccept`: the `outcome.status === "rejected"` failure says the entry is rejected and awaiting its author's follow-up and cannot be accepted until the fix lands; update the function's doc comment.
- src/cli/help.ts, the `tumwater reviews` stanza: the `[rejected — waiting to revert: …]` line and "it refuses an entry already rejected and waiting on its revert" take the follow-up wording.
- docs/cli.md: the `tumwater reviews` clause and the Pending-pane `Ctrl+A` key-table row (both say "waiting on its revert") take the follow-up wording.
- No change to `renderPostReviews`'s line shape, `acceptPostReview`'s outcome kinds, or the `PostReview` type.

**Files touched.** src/review/post-merge-review-render.ts src/review/post-merge-review-accept.ts src/cli/cli-review-commands.ts src/cli/help.ts docs/cli.md test/post-merge-review-render.test.ts test/cli-reviews.test.ts

**Acceptance criteria.**
- A rejected entry renders `[rejected — awaiting the author's follow-up: <reasons>]` from `postReviewStatusLabel` and on `tumwater reviews`'s line; no read surface says "waiting to revert".
- `tumwater reviews --accept <n>` on a rejected entry fails naming the author's follow-up, and changes nothing.
- The failed-run, unreviewed and empty cases are unchanged.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review-render.test.ts: update the pinned rejected-label assertions (the end-to-end render and `postReviewStatusLabel`) to the new wording.
- test/cli-reviews.test.ts: update the review-list and `reviews --accept` refusal assertions to the new wording.

### A post-merge rejection stops reverting, part 3/3: the dashboard and TUI Pending panes name the forwarded follow-up, not a revert (planned 2026-10-24 by the plan role, split from the held single fix-forward entry; requires parts 1/3 and 2/3 landed, since the TUI renders part 2/3's shared label and the browser mirrors it; touches src/ui/tui/tui-pane-pending.ts src/ui/gui/gui-client-pending.ts src/gui/gui-operator-commands.ts docs/how-it-works.md test/tui-keys.test.ts test/gui-client-pending.test.ts test/gui-post-review-accept.test.ts)

**Previously held 1**

**Follow-up 2026-10-24 by the operator:** same as part 2/3 — the dashboard and TUI wording this part fixes is replaced by "Forward, never back" below (a rejected entry reads `fixed — <finding> (fix <sha>)`, with no accept affordance to explain), so land it only as far as it goes and leave anything in flight as it is.

**Goal.** The TUI Pending pane's two operator messages, the browser's hand-kept label and the GUI's accept-refusal error still tell the operator a rejected entry waits on a revert. After part 1/3 it awaits the author's follow-up instead; the three dashboard surfaces must say so and match `tumwater reviews`.

**Approach.**
- src/ui/tui/tui-pane-pending.ts: the row hint "cannot be accepted until its revert runs — let the revert go, then review the revision" and the accept-flash "is rejected and waiting on its revert — let the revert run, then review the revision" say the entry awaits its author's follow-up and cannot be accepted until the fix lands. Update any row-rendering comment that names a revert.
- src/ui/gui/gui-client-pending.ts: the browser twin `postReviewStatusLabel` (a hand-kept copy) prints `[rejected — awaiting the author's follow-up: …]`; the card and accept-button comments ("not waiting on its revert") follow. A rejected entry still renders no Accept button.
- src/gui/gui-operator-commands.ts: the GUI accept endpoint's 409 error ("rejected and waiting on its revert — let the revert run, then review the revision") takes the follow-up wording.
- docs/how-it-works.md: the post-merge review paragraph (the rejection "goes to the revert slot", the reasons "back to its role as a revision", the `reverted after merge` note) describes the forwarded fix on main instead; the red-main revert paragraph is unchanged.
- No change to the GUI's `data-accept` guard, the TUI Ctrl+A handler, or the status payload shape.

**Files touched.** src/ui/tui/tui-pane-pending.ts src/ui/gui/gui-client-pending.ts src/gui/gui-operator-commands.ts docs/how-it-works.md test/tui-keys.test.ts test/gui-client-pending.test.ts test/gui-post-review-accept.test.ts

**Acceptance criteria.**
- Every dashboard/TUI string about a rejected post-merge review says it awaits the author's follow-up; none says "waiting on its revert" or "let the revert run".
- The TUI and browser render the same rejected label as `tumwater reviews` for the same entry.
- The accept affordances for a rejected entry are unchanged: the TUI refuses it, the GUI renders no Accept button.
- `npm run test:gate` passes.

**Tests.**
- test/tui-keys.test.ts: update the rejected accept-flash assertion to the new wording.
- test/gui-client-pending.test.ts: update the rejected-label assertion.
- test/gui-post-review-accept.test.ts: update the GUI 409 error assertion.

### `tumwater role <id> --review-after-merge` / `--clear-review-after-merge` move a role in and out of `review.afterMerge`, the one command the post-merge churn alert's remedy needs (planned 2026-10-24 by the plan role; independent of every in-flight plan — the accounting plan edits src/merge/merge-core.ts, src/merge/merge-drain.ts and src/report/report-fold.ts, part 1/3 edits src/merge/merge-post-review.ts, src/merge/merge-drain.ts, src/baseline/main-revert.ts and docs/invariants.md, the re-queued merge plan edits src/merge/merge-queue.ts, src/merge/merge-requeue.ts, src/merge/merge-queue-render.ts, src/status/status-data.ts and a `queueEntryLineHtml` region of src/ui/gui/gui-client-pending.ts, the dashboard Role-picker plan edits src/ui/gui/gui-client-pending.ts, and the reviews `--status` plan edits src/review/post-merge-review-render.ts and src/cli/cli-review-commands.ts; none of them edits src/cli/cli-role-command.ts or test/cli-operators.test.ts, and none edits src/config/config-write.ts at all, so this runs alongside every one. It shares src/cli/help.ts and docs/cli.md with the blocked part 2/3 and with the reviews `--status` plan as neighbouring `tumwater role`/`tumwater reviews` lines, so whichever lands second rebases there. Touches src/cli/cli-role-command.ts src/cli/help.ts docs/cli.md test/cli-operators.test.ts)

**Goal.** `review.afterMerge` (src/config/config.ts default `["bugfix", "clean", "coverage", "dedupe", "organize", "readme"]`) decides whether the gate reviews a role's commits before or after they merge, and both the `post-merge-churn` amber alert and its doctor row tell the operator to "narrow `review.afterMerge` for the noisy role" (src/ui/team-alerts.ts, src/doctor/doctor-project-checks.ts). The membership test has one home (`reviewedAfterMerge`, src/config/config-views.ts) and `tumwater role <id>` renders the result (the `- Review: after merge` line, src/roles/role-render.ts), but no surface can change it: the role command carries a write twin for every other per-role knob (`--model`, `--cap`, `--quiet-hours`, `--instances`, `--enable`/`--disable`), and `config set review.afterMerge <json>` replaces the whole list — so acting on the alert means retyping every id and the operator cannot simply take the one noisy role out. Add the two boolean writes, so the alert's own remedy is one command.

**Approach.**
- src/cli/cli-role-command.ts: add `const CLEAR_REVIEW_AFTER_MERGE_SPEC = { names: ["--clear-review-after-merge"] };` and `const REVIEW_AFTER_MERGE_SPEC = { names: ["--review-after-merge"] };` beside `ENABLE_SPEC`/`DISABLE_SPEC`, and add both specs to the `rejectUnknownArgs("role", rest, [...])` list. After the `enable`/`disable` reads add `const reviewAfterMerge = rest.includes("--review-after-merge");`, `const clearReviewAfterMerge = rest.includes("--clear-review-after-merge");` and `const reviewAfterMergeWrite = reviewAfterMerge || clearReviewAfterMerge;`, and `if (reviewAfterMergeWrite) writes.push("review-after-merge");` so the existing `writes.length > 1` guard covers combining it with another write. Add a branch beside the enable/disable branch: fail `give --review-after-merge or --clear-review-after-merge, not both` when both are present and `--json does not apply to a review-after-merge write` for `--json`; then `requireKnownRole(root, id)`; read `const list = loadConfigSafe(root).config?.review.afterMerge ?? [];` and `const has = list.includes(baseRoleOf(id));`, build `const next = has === reviewAfterMerge ? list : reviewAfterMerge ? [...list, baseRoleOf(id)] : list.filter((r) => r !== baseRoleOf(id));`, and call `const result = setConfigKey(root, "review.afterMerge", JSON.stringify(next));` — `setConfigKey`'s section branch compares the value against the resolved `review.afterMerge`, so a `next` equal to the effective list reports `result.unchanged` and writes nothing, exactly like the other role writes. On `!result.ok` `fail(result.error)` (validateConfig owns the string-array shape, the known-role-id check and the `review.afterMerge must not be "director"` refusal), else `say(result.unchanged ? (reviewAfterMerge ? `${base}: already in review.afterMerge, so tumwater.json was not written` : `${base}: not in review.afterMerge, so nothing was cleared`) : (reviewAfterMerge ? `${base}: added to review.afterMerge` : `${base}: removed from review.afterMerge`))` and return. Both flags take no value, so `peelRolePositional`'s value-flag list and the "next token is a flag" guard loop are unchanged. No new import: `setConfigKey` and `baseRoleOf` are already imported, and `loadConfigSafe` is already called by neighbouring branches; an implementation that finds itself adding a config-write helper or touching `reviewedAfterMerge` has gone off-plan — the effective-list read plus `setConfigKey` is the whole write.
- src/cli/help.ts, the `tumwater role` stanzas: after the `--clear-instances` stanza add `tumwater role <id> --review-after-merge` ("Review that role's commits after they merge, written to `review.afterMerge` (the base id for an instance)") and `tumwater role <id> --clear-review-after-merge` ("Review it before merge again, removing it from `review.afterMerge`").
- docs/cli.md, the `tumwater role <id>` clause inside the one Check-state row: after the `--enable`/`--disable` sentence add "`--review-after-merge` adds the role to `review.afterMerge` (the review gate reviews its commits after they merge) and `--clear-review-after-merge` removes it (reviewed before merge again), both for the base id; a role already in the asked-for state is reported as `already in review.afterMerge`/`not in review.afterMerge` and the file is not written".
- No change to `reviewedAfterMerge`, src/roles/role-view.ts or role-render.ts, the default list, the dashboard role drawer or the TUI, the `post-merge-churn` alert's wording, or `config set review.afterMerge`.

**Files touched.** src/cli/cli-role-command.ts src/cli/help.ts docs/cli.md test/cli-operators.test.ts

**Acceptance criteria.**
- `tumwater role feature --review-after-merge` adds `feature` to the file's `review.afterMerge` and prints `feature: added to review.afterMerge`; `tumwater role feature` then prints `- Review: after merge` and `tumwater role feature --json` carries `reviewedAfterMerge: true`. Running it again prints `feature: already in review.afterMerge, so tumwater.json was not written` and leaves the file byte-identical.
- `tumwater role feature --clear-review-after-merge` removes it and prints `feature: removed from review.afterMerge`; a repeat prints `feature: not in review.afterMerge, so nothing was cleared` and leaves the file byte-identical. `tumwater role clean --clear-review-after-merge` removes `clean` from the list while every other id stays, in the same order.
- An instance id targets its base: `tumwater role feature-2 --review-after-merge` writes `feature`.
- A `tumwater.json` that already customizes another field of the `review` section keeps that field across either write; only `afterMerge` changes.
- `tumwater role director --review-after-merge` exits nonzero naming `review.afterMerge` and writes nothing; `tumwater role bogus --review-after-merge` exits nonzero with the unknown-role message; `tumwater role feature --review-after-merge --clear-review-after-merge` exits nonzero naming both flags; `tumwater role feature --review-after-merge --json` exits nonzero naming `--json`; `tumwater role feature --review-after-merge --cap 5` exits nonzero with the existing "cannot share one invocation" message; every refusal leaves the file unchanged.
- `npm run test:gate` passes.

**Tests.**
- test/cli-operators.test.ts: add `role --review-after-merge and --clear-review-after-merge move the role in review.afterMerge` beside `role --enable and --disable write the role's enabled state`, using the same `makeRepo`/`initProject`/`config()` helpers and the same no-op-bytes pattern: `feature` is not in the default list and `clean` is, so `role feature --clear-review-after-merge` and `role clean --review-after-merge` are the no-ops that must leave the fresh bytes unchanged; `role feature --review-after-merge` writes a `review.afterMerge` containing `feature`, the view prints `- Review: after merge`, `--json` carries `reviewedAfterMerge: true`, and the repeat leaves the bytes identical; `role feature --clear-review-after-merge` removes `feature`; `role clean --clear-review-after-merge` leaves `clean` out while `bugfix` stays; `role feature-2 --review-after-merge` writes `feature`; a `tumwater.json` seeded with `review: { enabled: false }` keeps `enabled: false` through an add; and a refusal table (`director`, both flags together, `--json`, `--cap` with `--review-after-merge`) checks each exit code, its message, and an unchanged file.

### A `ci` role runs the CI workflow's own jobs at main's tip and fixes what fails, part 1/3: the role exists as an observer that reads the workflow's steps (planned 2026-10-24 by the operator, split from the held single `ci` plan; part 2/3 below moves the red-main healer hand-off onto the same role and part 3/3 adds its cheap no-op decision — the poll interval, the parity block and the `CI:` result line; touches src/roles/role-catalog.ts src/roles/roles.ts src/roles/role-labels.ts docs/glossary.md docs/how-it-works.md test/roles.test.ts)

**Previously held 1**

**Goal.** Nothing in the loop runs what CI runs. `.github/workflows/ci.yml`'s test job is `npm ci`, `npm test` and `npm run test:e2e` (`npm test` = eslint + tsc + the **whole** suite); the team's own check is `check.gateCommand = "npm run test:gate"` (`eslint` + `tsc` + the **affected** tests only, package.json:41, tumwater.json:92). So the full suite and the e2e suite execute only on GitHub, after a change has landed, and the gap has already been paid for twice: the after-merge reviewer in the 2026-10-23 window rejected a commit over "an e2e test the gate skips" (plans/fast-merge.md, "Review before merge for every role not listed in `review.afterMerge`"), and plans/qa-role.md's motivation names the same hole ("the broken-GUI-page incident shipped through a green suite precisely because no consumer of the page existed in CI"). A `ci` role whose one job is CI parity closes it: it runs the workflow's own steps against main's tip and fixes what fails, before a user, a release tag or a post-merge reviewer finds it. This part adds the role and its charter; part 2/3 makes it the single owner of main's greenness, and part 3/3 makes its no-op decision cheap.

**Approach.**
- src/roles/role-catalog.ts: add the role after `qa` — `{ id: "ci", tier: "default", title: "CI parity runner", find: … }`. Its find text reads the workflow instead of carrying a hardcoded command list, so a step added to `.github/workflows/ci.yml` is picked up without a code change: run that job's own `run:` steps verbatim against main's tip in this worktree (`actions/checkout`, `setup-node` and the git identity are the worktree's own) — `npm ci`, then `npm test`, then `npm run test:e2e`, and `npm pack` (the workflow's package job) when the tip is a push-to-main tip. Part 3/3 below makes the first steps conditional on the parity block; this part runs them every tick, which is correct but expensive, and is exactly what part 3/3 fixes. A failing step is the work: reproduce it, fix the source/tests/docs it names, re-run that step until green, and commit the fix as the run's one change; a step that fails once and passes on the re-run is a flake — file ONE BUGS.md entry naming the test and the flake and change nothing else. Whatever it cannot fix is filed with the failing output. The role never edits `.github/workflows/*` (it reads them) and never weakens a test to make a step pass.
- src/roles/roles.ts: add `"ci"` to `OBSERVER_ROLES` — its product is a verdict and a fix, so `no_change` must mean "checked, green" and schedule at `minRunIntervalSeconds` rather than climbing the idle ladder (src/run/run-apply.ts:241), and the role must not ride every main move the way a maintenance role does: a full suite plus e2e per merge is exactly the load storm BUGS.md's e2e/concurrency class entry blames for flaking the concurrency tests. Do **not** add it to `CODE_MAINTENANCE_ROLES`/`BASELINE_BLOCKED_ROLES`: it is the healer, so a red main must not stop it authoring (the exemption `bugfix` carries today), and the "Every commit is verified on main" plan below removes that block entirely. The md-only exemption list stays unchanged — `ci` authors code.
- src/roles/role-labels.ts and docs: the role's label renders as "CI" wherever role labels are shown (the shared label table, the scheduler's log lines), docs/glossary.md:61's "Observer" line and docs/how-it-works.md's observer paragraph ("`qa`, `selfcheck` and `feedback` are never deferred") add `ci`.

**Files touched.** src/roles/role-catalog.ts src/roles/roles.ts src/roles/role-labels.ts docs/glossary.md docs/how-it-works.md test/roles.test.ts

**Acceptance criteria.**
- `tumwater init` in a fresh repo lists `ci` among the enabled roles, `tumwater status` renders its row, `roles.ci.enabled false` disables it like any other role, and a `tumwater prompt --role ci` reaches it.
- The role runs the workflow's steps as the workflow declares them, in order, against main's tip; a failure ends either as a committed fix with that step re-run green, or as one BUGS.md entry quoting the failing output; a step that fails once and passes on the re-run files the flake and changes no code.
- The merge gate is untouched: `npm run test:gate` still runs only the affected tests, and no test that pins its command changes.
- `npm run test:gate` passes.

**Tests.**
- test/roles.test.ts: `ci` appears exactly once in the catalog, after `qa`, with its title and tier, and is a member of `OBSERVER_ROLES` and of neither `CODE_MAINTENANCE_ROLES` nor `BASELINE_BLOCKED_ROLES` (it is the healer); the md-only/exempt set is unchanged.

**Needs review 2026-10-24 by feature: could not converge — `docs/how-it-works.md` line 74 still routes the attributed main-check failure to bugfix, contradicting the new `ci` ownership and the change's VERIFIED grep claim.; PLANS.md's "Forward, never back" part 1/2 (line 154) and part 2/2 (lines 185, 197) still name bugfix as the red-main healer, contradicting the code and the ci plan this change added.; PLANS.md line 4's intro sentence is deleted with no claim in the commit body — an unclaimed change.**

### A `ci` role runs the CI workflow's own jobs at main's tip and fixes what fails, part 2/3: the red-main healer hand-off moves from `bugfix` to `ci` (planned 2026-10-24 by the plan role, split from part 1/2 of the held `ci` plan; requires part 1/3 landed, since the hand-off names the role that part adds; touches src/baseline/main-red.ts src/runner/runner-run.ts docs/how-it-works.md test/main-red.test.ts)

**Previously held 1**

**Goal.** Main's two broken signals — the watch naming a red culprit and a CI step failing — reach different roles today: `bugfix` owns the red-main repair (`queueCulpritHeal`'s prompt, `runner-run.ts`'s `<main-red>` note branch, and its exemption from the red-main authoring block), while a failing CI step has no owner until a human or a post-merge reviewer finds it. With part 1/3's `ci` role in place, this part routes the hand-off to it, so both signals land in one queue of main repairs and no second role races it for the same tree; `bugfix` returns to its own charter (BUGS.md's backlog) with no heal prompt and no red-main note.

**Approach.**
- src/baseline/main-red.ts: the watch-culprit branch (`enqueueRolePrompt(root, BUGFIX_ROLE, mainRedHealPrompt(red.sha))`, :106) and `queueCulpritHeal` (:141) name the ci role (`"ci"`) instead of `BUGFIX_ROLE`, and the `baseRoleOf(foundBy) !== BUGFIX_ROLE` guard (:104) becomes `!== "ci"`, so a red main the ci role itself found does not re-queue a heal prompt to itself. The prompt text is unchanged (`mainRedHealPrompt` already names the culprit, the failing tests and the output tail; only its recipient changes), and the `could not queue the heal prompt for bugfix` warning (:108) names the healer role.
- src/runner/runner-run.ts: the `ctx.baseRole === "bugfix"` branch (:580) keys on the ci base role instead, so the role that receives the hand-off is the one whose prompt carries the `<main-red>` failure note; a `bugfix` run falls through to the ordinary `mainRedGate` path. Rename the note helper `bugfixMainRedNote` (src/baseline/main-red.ts:157, its one production caller at runner-run.ts:581, and its cases in test/main-red.test.ts) to `mainRedHealNote`, so the name stops naming a role it no longer serves.
- docs/how-it-works.md's "one owner for a red main" paragraph and plans/fast-merge.md's D1 bullet take a supersede line naming parts 1/3 and 2/3.
- No change to the watch's check, `mainRedHealPrompt`'s wording, or `BASELINE_BLOCKED_ROLES`: `ci` is already exempt because part 1/3 puts it in `OBSERVER_ROLES`, not through a bugfix-specific branch. The "Every commit is verified on main" plan below removes the authoring block entirely.

**Files touched.** src/baseline/main-red.ts src/runner/runner-run.ts docs/how-it-works.md test/main-red.test.ts

**Acceptance criteria.**
- A main red that names a culprit queues exactly one heal prompt, to `ci` and not `bugfix`, and the ci role's prompt carries the `<main-red>` note naming the culprit and its failing tests; `bugfix` receives neither and its runs no longer carry that note.
- `ci` is not in `BASELINE_BLOCKED_ROLES` (so a red main does not block it) — already true from part 1/3; no bugfix-specific exemption branch remains in the hand-off.
- `npm run test:gate` passes.

**Tests.**
- test/main-red.test.ts: `the red-main hand-off goes to the ci role` — a watch culprit queues one prompt whose recipient is `ci` and whose text still names the culprit sha and its failing tests; the bugfix-recipient assertions invert. A second case pins that a run for `ci` gets the `<main-red>` note appended and a `bugfix` run does not. The renamed `mainRedHealNote` cases follow the function name.

### A `ci` role runs the CI workflow's own jobs at main's tip and fixes what fails, part 3/3: its parity block and `CI:` result line make its no-op decision cheap (planned 2026-10-24 by the operator, split from the held single `ci` plan; requires part 1/3 landed — the block is the role's own record and the `CI:` line is what it reads back — and lands before its repeated full-suite runs get expensive; touches src/config/config.ts src/run/ci-parity.ts src/prompt/prompt.ts src/verdict/reply-contract.ts src/runner/runner-outcome.ts src/run/run-verdict.ts docs/config.md test/reply-contract.test.ts test/qa-coverage.test.ts)

**Previously held 1**

**Goal.** Without a record of what it covered, the role must run the whole CI job — minutes of suite plus e2e — every tick to answer a question its own history already holds. The parity block and the `CI:` result line make that decision cheap: the role reads the tip and the `package-lock.json` hash its last green run covered, and declares nothing-to-do when main has not moved since and the lock file is unchanged.

**Approach.**
- src/config/config.ts: seed `minRunIntervalSeconds` for `ci` at the observer trio's `7200` (docs/config.md's row), so parity costs at most one full suite plus e2e every two hours; the per-role override works as for every other role.
- src/run/ci-parity.ts (new) + src/prompt/prompt.ts (its `flowCoverage` field, :314): the same-shaped `ciParity` prompt field — the tip the last recorded green parity run covered, its `package-lock.json` hash, and each step's outcome — rendered by a module of its own, and omitted entirely when the record is missing or unreadable, exactly as the qa coverage block is.
- src/verdict/reply-contract.ts: `ciResultLine` beside `flowLine` (:187) — `CI: <sha> — passed|failed`, split and validated with the same `labeledLine`/verdict-required rules (a bare `CI: <sha>`, or a reply truncated mid-verdict, is not a result and is not recorded). The run outcome carries it (src/runner/runner-outcome.ts:54, src/run/run-verdict.ts) and the parity block reads it back, so a fresh session that remembers nothing still knows what the last run covered.
- docs: docs/config.md's `minRunIntervalSeconds` row names `ci` with `7200` (the `Observer` line in docs/glossary.md and the observer paragraph in docs/how-it-works.md belong to part 1/3).
- No change to `.github/workflows/*`, to `check.gateCommand`, to `npm run test:gate`'s definition, to the main watch's check or to the post-merge review. The merge gate stays fast and affected-only — that is the point of a role whose cadence is its own. An implementation that finds itself slowing the gate, or editing a workflow file, has gone off-plan.

**Files touched.** src/config/config.ts src/prompt/prompt.ts src/run/ci-parity.ts src/verdict/reply-contract.ts src/runner/runner-outcome.ts src/run/run-verdict.ts docs/config.md test/prompt-roles.test.ts test/reply-contract.test.ts test/qa-coverage.test.ts

**Acceptance criteria.**
- Its prompt carries a CI parity block naming the tip and lock hash of the last green run; with main unmoved since that run and the lock hash unchanged the role declares nothing-to-do without running the suite (one model run, no suite run).
- A `CI:` line is required on every run and a bare `CI: <sha>` records nothing, so the parity block cannot advance on a truncated reply (the `FLOW:` line's own rule).
- The merge gate is untouched: `npm run test:gate` still runs only the affected tests, and no test that pins its command changes.
- `npm run test:gate` passes.

**Tests.**
- test/reply-contract.test.ts: `ciResultLine` mirrors the FLOW cases — `CI: abc1234 — passed` and `CI: abc1234 — failed` parse, a mid-sentence mention does not, and `CI: abc1234` alone (or a reply truncated mid-verdict) records nothing.
- test/qa-coverage.test.js (or a new test/ci-parity.test.js): the parity block renders "current" for the recorded green tip with a matching lock hash, "stale" naming both shas and hashes when main moved or the lock hash changed, and is omitted entirely for a missing or malformed record rather than rendering an empty verdict.

### Forward, never back, part 1/6: the reviewer fixes a post-merge finding itself and the harness lands its one fix commit on main, so a rejection never fills the revert slot (decided by the user 2026-10-24; split from the held parts 1/2–2/2; supersedes the accounting plan and parts 1/3–3/3 of "A post-merge rejection stops reverting" above; design half: plans/post-merge-fix-forward.md "Decision"; part 2/6 below accounts and bounds the self-fix chain, part 3/6 files a review that never reaches a verdict and updates every surface, and parts 4/6–6/6 delete the revert machinery this part stops using; lands before "Every commit is verified on main" part 3/3 below, which removes the last pre-merge block; touches src/review/post-merge-review.ts src/merge/merge-post-review.ts src/merge/merge-drain.ts src/merge/merge-core.ts src/runner/runner-run.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/prompt/ src/verdict/reply-contract.ts test/post-merge-review.test.ts test/merge-drain.test.ts)

**Previously held 1**

**Needs review 2026-10-24 by feature: too large for one run (held 2)**

**Goal.** Nothing is ever taken off main for a post-merge finding. Today a rejection pays a revert commit, a gate run on the revert inside the single merge slot, a hand-back to the author and a second review — 11 such cycles in the trailing day of 2026-10-23/24, every one a doc/claim slip (plans/post-merge-fix-forward.md "Measurement"), and 8 of 11 are the class a forward follow-up repairs on top of main in one run. The decision: the commit stays; the reviewer that already reads it fixes what it found and commits the fix on top of main; its own fix commits enter the same queue and it reviews them on a later iteration. Self-review is deliberate: at this project's 53% reject rate (plans/reviewer-as-role.md) the author and the reviewer were already rewriting the same text by turns, so the second reader was mostly nominal. The red-main revert is untouched here; parts 4/6–6/6 delete it.

**Approach.**
- A post-merge rejection stops filling the revert slot. src/merge/merge-post-review.ts `drainPostReviews` no longer builds a revert-slot culprit (`postReview: { reasons }` and the `skipChecks` WeakSet go). src/merge/merge-drain.ts loses `sendReviewToRole` together with the arm that handed the reviewer's reasons to the authoring role, plus the parked-forward plumbing that only fed it (`forwardedPendingPath`/`pendingForwards`, `assignPendingReverts`' forward loop, `handBackForward`): after this part a rejected entry is answered by the reviewer's own fix, never by a hand-back to the authoring role. src/merge/merge-core.ts loses `recordForwardedChange` and `handBackChange`'s `"forwarded"` arm, and src/runner/runner-run.ts loses its `state.forwarded` follow-up branch (src/runner/runner-state.ts's `forwarded` field and `hasOutstandingWork`, src/runner/runner-state-load.ts's heal).
- What deliberately stays until part 4/6: `MainCulprit.postReview`, `startRevert`, `handBackReverted`, `revertReasons` and src/baseline/main-revert.ts itself, because the red-main revert still runs through them, and `revertCommitIn` (src/operator/revert.ts) with the `operator_revert` event, which is the operator's own act and stays for good.
- The reviewer fixes. `reviewMergedCommit`'s worktree (src/review/post-merge-review.ts) becomes branch-backed (no `--detach --force` on a bare commit), and the review prompt tells the reviewer that a finding it can repair is the work — make the minimal fix in the worktree, leave the edit, and end with the verdict line plus `FIX: <files changed>`; a finding it cannot repair is recorded as the reasons are today. When the run ends with edits the harness commits them (`tumwater(reviewer): Fix <short sha> — <first finding>`) and lands them through the path a commit takes today minus the revert: the gate command on the result, then the fast-forward under the merge lock. The entry then settles `fixed`, naming the reviewed commit and the fix's sha; a run with no edits and no finding settles `approved`, as today. A fix that cannot land (conflict, red gate) leaves main untouched, records the failure and keeps the entry for the next poll.
- The self-fix chain's accounting and bound, the failure cap and the surfaces are part 2/6 and part 3/6, not this part: this part only makes a repairable finding become a landed fix.

**Files touched.** src/review/post-merge-review.ts src/merge/merge-post-review.ts src/merge/merge-drain.ts src/merge/merge-core.ts src/runner/runner-run.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/prompt/ src/verdict/reply-contract.ts test/post-merge-review.test.ts test/merge-drain.test.ts

**Acceptance criteria.**
- A post-merge review that finds a repairable issue leaves the reviewed commit on main, commits one `tumwater(reviewer): Fix <sha>` commit and lands it; the entry ends `fixed` naming both shas, and the merge slot is free on the next poll.
- A review run that leaves no edit and finds nothing settles `approved`; one that leaves an unrepairable finding records its reasons as today.
- No rejection starts a revert and none hands anything back to the authoring role: `sendReviewToRole`, the parked-forward record and `state.forwarded` have no caller, and no code path reads them.
- The red-main revert still runs through `runMainRevert` (part 4/6 deletes it), and `tumwater revert <sha>` is unchanged.
- Nothing that verifies code changes here: the pre-merge deterministic checks, the main watch's own check and the gate's rule set are untouched.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review.test.ts: replace "a rejecting post-merge review reverts the commit and hands it back as a revision" with `a rejecting post-merge review fixes the commit on main and lands one fix commit` — seed a merged afterMerge change, have the review run leave an edit, and assert the reviewed commit is still on main, one `tumwater(reviewer): Fix` commit landed, no revision record, the entry `fixed` with both shas; keep the torn-entry, failed-write and git-could-not-start cases.
- test/merge-drain.test.ts: `a post-merge finding never takes the merge slot` — run two polls with a rejected entry and an idle merge slot and assert the slot stays free for a queued change while the entry leaves post-review.json once the fix lands.

### Forward, never back, part 2/6: the self-fix chain is counted and its dead end holds the answered plan (planned 2026-10-24 by the plan role, split from the held parts 1/2–2/2; requires part 1/6 landed, since the chain this counter bounds is the fix chain part 1/6 lands; touches src/runner/revision.ts src/review/post-merge-review.ts src/merge/merge-post-review.ts test/revision.test.ts test/post-merge-review.test.ts)

**Previously held 1**

**Goal.** A self-fix chain cannot loop forever, and its dead end is operator-visible. A landed fix enters the queue as a normal post-review entry (`addPostReview`, `summary` = the finding it answers), so the next iteration reviews it like any unreviewed commit; the entry must carry the reviewed commit's round + 1 and stop at `REVISION_BACKSTOP` (src/runner/revision.ts), holding the answered plan as **Needs review** naming the surviving findings (`holdEntryAfterExhaustion`) rather than fixing again. Without this part the forward path as written is counted by neither `state.lastReview` nor the backstop, so a fix that never converges is an unbounded loop with an invisible dead end (plans/post-merge-fix-forward.md "The machinery a forward arm can reuse").

**Approach.**
- Carry the round on the fix: when the harness commits the reviewer's fix (part 1/6), its body carries the `Revision: <n>` trailer of the reviewed commit's round + 1 (`revisionRoundOf`, src/merge/merge-core.ts calls it today for the reverted hand-back), so the next review of that fix reads its own round from the same place a rejection's hand-back reads it.
- Stop at the backstop: in `reviewMergedCommit`/`startPostReview` (src/review/post-merge-review.ts, src/merge/merge-post-review.ts), when the reviewed commit's round is at `REVISION_BACKSTOP`, the reviewer records its surviving reasons instead of committing a fix, and the harness holds the answered PLANS.md plan through `holdEntryAfterExhaustion(root, role, claim, reasons)` — the same terminal state a rejection's exhaustion reaches (`recordRejectedChange`, src/merge/merge-core.ts).
- One counter: reuse `revisionRoundOf` and `holdEntryAfterExhaustion` rather than a second counter, so the self-fix chain and the rejection chain share `REVISION_BACKSTOP` and `REVISION_FINAL_ON_REPEAT` and cannot drift.
- A landed fix is a post-review entry, not a `state.revision`/`state.forwarded` hand-back: the round lives on the fix commit's body and the hold is the only runner state this part writes.

**Files touched.** src/runner/revision.ts src/review/post-merge-review.ts src/merge/merge-post-review.ts test/revision.test.ts test/post-merge-review.test.ts

**Acceptance criteria.**
- The landed fix appears as a new post-review entry and is reviewed on a later iteration; its commit body carries `Revision: <n>` one past the reviewed commit's round.
- A chain of self-fixes stops at `REVISION_BACKSTOP`: the reviewer stops fixing, and the answered plan is held with **Needs review** naming the surviving findings exactly as a rejection's exhaustion holds it.
- There is one backstop constant: the self-fix chain and the rejection chain both read `REVISION_BACKSTOP`, and no second counter is introduced.
- `npm run test:gate` passes.

**Tests.**
- test/revision.test.ts: `a self-fix chain stops at the backstop and holds the answered plan` — walk the fix commits' `Revision` rounds to `REVISION_BACKSTOP` and assert the hold note names the surviving findings and the entry is cleared.
- test/post-merge-review.test.ts: `a reviewer's fix commit carries the next revision round` — assert the landed `tumwater(reviewer): Fix` commit's body names one past the reviewed commit's round, and that a review at the backstop records reasons instead of committing a fix.

### Forward, never back, part 3/6: a review that never reaches a verdict files the commit as backlog work, and every surface reads the reviewer's fix rather than a revert (planned 2026-10-24 by the plan role, split from the held parts 1/2–2/2; requires part 1/6 landed, since the states it renders and files are part 1/6's; touches src/merge/merge-post-review.ts src/review/post-merge-review-render.ts src/review/post-merge-review-accept.ts src/cli/cli-review-commands.ts src/cli/help.ts src/ui/tui/tui-pane-pending.ts src/ui/gui/gui-client-pending.ts src/gui/gui-operator-commands.ts docs/how-it-works.md docs/cli.md test/post-merge-review.test.ts test/cli-reviews.test.ts test/tui-keys.test.ts test/gui-client-pending.test.ts test/gui-post-review-accept.test.ts)

**Previously held 1**

**Goal.** Two loose ends of the forward path become visible and honest. A review that never reaches a verdict disappears today: after `POST_REVIEW_FAILURE_LIMIT` runs (src/merge/merge-post-review.ts) the entry is dropped with "stays on main unreviewed" and nothing else reads it — under this part the commit stays on main *and* a BUGS.md entry names it (sha, the commit summary, the last failure), so another role can improve it in the ordinary backlog flow. And every surface that named a revert reads the reviewer's fix instead.

**Approach.**
- File the unreviewed commit: at the failure cap, instead of `settlePostReview(root, entry.commit, null)` alone, append one BUGS.md entry naming the commit's short sha, its summary and the last failure, through the same backlog-write path `tumwater bug` uses; the `dropped-post-reviews` alert keeps counting the event.
- Surfaces: `postReviewStatusLabel` (src/review/post-merge-review-render.ts) and its GUI twin (src/ui/gui/gui-client-pending.ts) read `fixed — <finding> (fix <sha>)` for a landed fix, `approved` for a clean review, and `rejected — <finding>` for a recorded finding with no fix; `rejected — waiting to revert` and `awaiting the author's follow-up` go. The rejected entry's accept affordances go with the state that had them (`cmdReviewsAccept`'s rejected refusal, the dashboard's Accept button, the TUI's Ctrl+A arm), so no surface offers to accept a rejection.
- Docs: docs/how-it-works.md's post-merge-review paragraph describes the reviewer's fix (`fixed — <finding> (fix <sha>)`) instead of a revert and a revision, and docs/cli.md's `tumwater reviews` entry loses its rejected-entry accept wording; its `tumwater revert` entry stays and says the CLI revert is the operator's alone.
- The `post-merge-churn` alert keeps counting findings with the reviewer-fixes remedy (`narrow review.afterMerge` remains the alternative); the `post-merge-risk` and `dropped-post-reviews` alerts are unchanged.

**Files touched.** src/merge/merge-post-review.ts src/review/post-merge-review-render.ts src/review/post-merge-review-accept.ts src/cli/cli-review-commands.ts src/cli/help.ts src/ui/tui/tui-pane-pending.ts src/ui/gui/gui-client-pending.ts src/gui/gui-operator-commands.ts docs/how-it-works.md docs/cli.md test/post-merge-review.test.ts test/cli-reviews.test.ts test/tui-keys.test.ts test/gui-client-pending.test.ts test/gui-post-review-accept.test.ts

**Acceptance criteria.**
- A post-merge review that exhausts its failure cap leaves its commit on main and files one BUGS.md entry naming it (sha, summary, last failure), so an unreviewed commit is backlog work rather than a line in a log.
- The rejected-entry accept affordances are gone: `tumwater reviews` (and its dashboard and TUI twins) accept a pending entry only, and no surface offers to accept a rejection.
- `postReviewStatusLabel` and its GUI twin read `fixed — <finding> (fix <sha>)`, `approved`, or `rejected — <finding>`, and never "waiting to revert".
- docs/how-it-works.md and docs/cli.md carry the new wording, and no doc says a post-merge rejection reverts.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review.test.ts: `a review that never reaches a verdict files the commit` — drive `POST_REVIEW_FAILURE_LIMIT` failed runs and assert the commit is still on main, the entry is gone, and exactly one BUGS.md entry names its sha; keep the failed-write case.
- The surface tests keep their subjects with the new wording: test/cli-reviews.test.ts (`fixed — … (fix <sha>)` renders; an accept on a fixed entry fails like an accept on any non-pending one), test/tui-keys.test.ts, test/gui-client-pending.test.ts, test/gui-post-review-accept.test.ts.

### Forward, never back, part 4/6: the revert subsystem is deleted — no `main_revert` is emitted and a red main is healed forward (planned 2026-10-24 by the operator, split from the held part 2/2; requires part 3/6 landed, since a rejection must have a complete forward path before the backward one goes; parts 5/6–6/6 then delete every reader of the historical events this part stops writing; touches src/baseline/main-revert.ts (deleted) src/baseline/main-red.ts src/baseline/main-watch.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/orchestrator/orchestrator.ts src/runner/revision.ts docs/invariants.md docs/how-it-works.md test/main-revert.test.ts (deleted) test/operator-revert.test.ts)

**Previously held 1**

**Goal.** With a rejection answered forward, the machinery that takes a commit off main has no caller but the red-main culprit, and this part removes that too: nothing is ever removed from main, including a red main's culprit, which `bugfix` heals forward through the prompt the watch already queues. No new `main_revert` event is logged and no revision is handed back for a red main. The event type and its readers stay, reading history (parts 5/6–6/6 delete them).

**Approach.**
- Delete the revert subsystem: src/baseline/main-revert.ts (`runMainRevert`, `revertSkipReason`, `routeMainCulprit`), src/merge/merge-drain.ts's revert slot (`startRevert`, `handBackReverted`, `handBackRevert`, `revertReasons`, `PendingRevert`, `revertedPendingPath`/`pendingReverts`, and `assignPendingReverts`' revert loop), src/merge/merge-pipeline.ts's `p.revert`, src/merge/merge-core.ts's `recordRevertedChange` and `handBackChange`'s `"reverted"` arm, src/orchestrator/orchestrator.ts's `routeMainCulprit` wiring, and src/runner/revision.ts's re-apply chain (`applyRevision`/`applyWithConflicts` and the `revision`/`rejectedRefName` helpers the reverted path reads). `MainCulprit` moves to src/baseline/main-watch.ts, whose `onCulprit` is its only remaining producer, and keeps only the fields a red-main heal needs. `revertCommitIn` (src/operator/revert.ts) stays: `tumwater revert` is the operator's own act, and the `operator_revert` event with it.
- A red main heals forward: src/baseline/main-red.ts's heal path becomes the only one — the bugfix prompt the watch already queues, with the existing wording — and `main-watch.ts`'s `onCulprit` names the tip as the culprit without routing a revert.
- Docs: docs/invariants.md loses INV-L1, INV-C3, INV-BS1/2/3 and INV-CO1's revert guarantees (the `reason: "post-review"` paragraph is parts 5/6–6/6's, with the readers); docs/how-it-works.md's revert paragraphs describe the red-main heal prompt instead.
- No change to the pre-merge deterministic checks, the main watch's own check, or the `main_revert` event type and its readers: this part removes the emission, not the verification, and parts 5/6–6/6 remove the readers.

**Files touched.** src/baseline/main-revert.ts (deleted) src/baseline/main-red.ts src/baseline/main-watch.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/orchestrator/orchestrator.ts src/runner/revision.ts docs/invariants.md docs/how-it-works.md test/main-revert.test.ts (deleted) test/operator-revert.test.ts

**Acceptance criteria.**
- No `runMainRevert`, `routeMainCulprit` or `startRevert` remains, no `main_revert` event is logged for a red main, and no revision is handed back for one; `tumwater revert <sha>` still reverts and still logs `operator_revert` with the merge slot free afterwards.
- A red main queues the bugfix heal prompt (its existing wording) and reverts nothing.
- The `main_revert` event type, its formatter and its readers still compile and read events already in the log; the only production code that mentions a revert is `tumwater revert`'s operator path, the `operator_revert` event, and wording saying a commit is never taken off main.
- `npm run test:gate` passes.

**Tests.**
- test/main-revert.test.ts: deleted with the module; the cases that still hold (a director-merged or runnerless culprit, `tumwater revert`) move to test/operator-revert.test.ts.
- test/operator-revert.test.ts: `tumwater revert still reverts and logs operator_revert` — a deliberate operator revert lands, logs `operator_revert`, and leaves the merge slot free.

### Forward, never back, part 5/6: the revert guardrails, doctor row, alerts and digest lose a revert that can no longer happen (planned 2026-10-24 by the operator, split from the held part 2/2; requires part 4/6 landed, since no emission remains for the readers this part removes; part 6/6 below then deletes the report and GUI surfaces and the event type itself; touches src/baseline/main-guardrails.ts src/doctor/doctor-holds.ts src/doctor/doctor-project-checks.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/run/selfcheck-digest.ts docs/invariants.md test/main-guardrails.test.ts test/selfcheck-digest.test.ts)

**Previously held 1**

**Goal.** With no revert emitted, the doctor's revert rule, the `reverts` status alert and the digest's revert line count events that can never come. This part deletes them and the ceiling constant, so the 5-revert ceiling disappears and BUGS.md's churn entry loses its counting half (a reason-less event can no longer be misread as a red-main revert). The report and GUI "Reverts by role" charts and the `main_revert` event type are part 6/6's.

**Approach.**
- Delete the guardrail: src/baseline/main-guardrails.ts's `revertGuardrail`/`revertWarnings`/`revertLooksFalse`/`REVERT_RATE_LIMIT`/`revertsFor` and their `main_revert`-vs-`merged` patch-id matching.
- Delete every reader of it: src/doctor/doctor-holds.ts's `revertWarnings` phrases and src/doctor/doctor-project-checks.ts's revert row, src/ui/team-alerts.ts's `reverts` banner, src/ui/status-payload.ts's `revertAlert` (and its call site in the `teamAlerts` list), src/ui/status-render.ts's import and argument, and src/run/selfcheck-digest.ts's `guardrailWarnings` revert section.
- Docs: docs/invariants.md loses the revert-ceiling guarantee and any binding that names the deleted guardrail functions; no summary surface reads a revert that can no longer happen.
- The `main_revert` event type, formatter and label stay so the log still parses and the report/GUI can be removed in part 6/6.

**Files touched.** src/baseline/main-guardrails.ts src/doctor/doctor-holds.ts src/doctor/doctor-project-checks.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/run/selfcheck-digest.ts docs/invariants.md test/main-guardrails.test.ts test/selfcheck-digest.test.ts

**Acceptance criteria.**
- `grep -rn "revertGuardrail\|revertWarnings\|revertLooksFalse\|REVERT_RATE_LIMIT\|revertsFor\|revertAlert" src/ --include=*.ts` is empty, and no doctor row, status alert or digest line mentions a revert.
- The 5-revert ceiling is gone: no constant counts revert events and no warning fires on one.
- `operator_revert` and `tumwater revert` still work and their surfaces are untouched.
- `npm run test:gate` passes.

**Tests.**
- test/main-guardrails.test.ts: drop the revert-ceiling and revert-phrase cases, and keep one case pinning that an `operator_revert` still reads as a deliberate revert while no automatic revert rule warns.
- test/selfcheck-digest.test.ts: drop the digest's revert line case; keep the digest's other sections green.

### Forward, never back, part 6/6: the report and GUI "Reverts by role" surfaces and the `main_revert` event type are deleted (planned 2026-10-24 by the operator, split from the held part 2/2; requires part 5/6 landed, so the event type loses its last readers in the same deletion; touches src/events/events.ts src/events/event-format.ts src/events/event-labels.ts src/events/event-read.ts src/report/report-fold.ts src/report/report-types.ts src/report/report-data.ts src/report/report-render.ts src/ui/gui/gui-client-report-chart.ts src/ui/gui/gui-client-report.ts src/run/run-detail-data.ts src/failure/time-spend.ts docs/invariants.md test/time-spend.test.ts test/report-data.test.ts)

**Previously held 1**

**Goal.** With no producer and no summary reader left, the report's and GUI's "Reverts by role" charts and the `main_revert` event type are dead weight. This part deletes them, so `grep -rn "main_revert" src/` is empty and the `reason: "post-review"` split `1917e9c80` added goes with the event (with no revert there is no cause to tag). `operator_revert` and its report/run-detail rendering stay.

**Approach.**
- Delete the type and its formatting: src/events/events.ts's `main_revert` union member (keep `merged`'s and `operator_revert`'s), src/events/event-format.ts's case, src/events/event-labels.ts's `main_revert: "main red reverted"` label, and src/events/event-read.ts's `main_revert` reason normalization.
- Delete every remaining reader: src/report/report-fold.ts's `revertsByRole` fold and `main_revert` arm (+ src/report/report-types.ts's fields), src/report/report-data.ts's `revertsByRole` plumbing, src/report/report-render.ts's "Reverts by role" lines, src/ui/gui/gui-client-report-chart.ts's `chartRevertsByRole` and src/ui/gui/gui-client-report.ts's "Reverts by role" block, src/run/run-detail-data.ts's revert cause and `main_revert` branch, and src/failure/time-spend.ts's `reverted` loss cause and `main_revert` scan.
- Docs: docs/invariants.md loses the `reason: "post-review"` paragraph and any remaining `main_revert` binding; `operator_revert`'s guarantee stays.
- No production code may mention `main_revert` after this part; the log may still contain old events, which simply no longer parse into a known type.

**Files touched.** src/events/events.ts src/events/event-format.ts src/events/event-labels.ts src/events/event-read.ts src/report/report-fold.ts src/report/report-types.ts src/report/report-data.ts src/report/report-render.ts src/ui/gui/gui-client-report-chart.ts src/ui/gui/gui-client-report.ts src/run/run-detail-data.ts src/failure/time-spend.ts docs/invariants.md test/time-spend.test.ts test/report-data.test.ts

**Acceptance criteria.**
- `grep -rn "main_revert" src/ --include=*.ts` is empty, and `grep -rn "revertsByRole" src/ --include=*.ts` is empty.
- The report and the browser dashboard print no "Reverts by role" chart, and the digest, doctor and status surfaces print no revert line.
- `operator_revert` still renders where it did (`tumwater revert`'s run detail and the report counts), and no surface reads a revert that no longer happens.
- `npm run test:gate` passes.

**Tests.**
- test/time-spend.test.ts / test/report-data.test.ts: drop the `reverted` loss-cause and `revertsByRole` cases, and keep one case pinning that an `operator_revert` still folds into the report's operator-revert count while no automatic revert does.

### Every commit is verified on main, part 1/3: the watch's per-tip check runs the deterministic diff rules, naming the rule and the head (decided by the user 2026-10-24; split from the held single plan; part 2/3 below then makes the newest head the culprit and deletes the bisect, and part 3/3 takes the pre-merge blocks off; this part leaves every pre-merge check in place and keeps the bisect; design half: plans/fast-merge.md "What stays"; touches src/baseline/main-watch.ts src/review/review-precheck.ts src/review/review.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/review-precheck.test.ts)

**Previously held 1**

**Goal.** A commit that lands is judged by the same deterministic rules the merge gate runs before it. Today the watch checks only the declared build command on a new tip, while the conflict-marker, secret-leak, protected-edit, false-fix and backlog-structure rules live only inside the gate (src/review/review.ts) — so a commit that leaves a conflict marker or breaks a backlog section is invisible until a reviewer or a user finds it. This part runs those rules on the tip within one poll and names the rule and the head. It removes nothing: the merge slot's in-lock gate run, the pre-merge model verdict and the red-main authoring block all still stand (part 3/3), and the bisect that names a build red's culprit stays (part 2/3).

**Approach.**
- One home for the rules: add `export async function diffRuleReasons(wt, baseRev, files, role, exempt): Promise<string[]>` to src/review/review-precheck.ts — the gate's five deterministic calls in the gate's own order and scope: `conflictMarkerReason(wt, files)`, then `protectedEditReason(wt, baseRev, files, role)`, then `secretLeakReason(wt, baseRev, files)`, and, after the exempt branch, `falseFixReason(wt, baseRev, files)` only when `exempt` and `backlogStructureReason(wt, baseRev, files)` for every diff. src/review/review.ts computes `const baseRev = await changeBaseRev(wt, mainBranch)` once, calls `diffRuleReasons(wt, baseRev, files, role, isExemptDiff(files, config.review.exemptPaths))`, rejects on `reasons[0]`, and keeps its exempt/code branch and `reviewResume` reset exactly as today, so the gate's behavior and reason text are unchanged. src/run/stage-check.ts is unchanged — it keeps its own calls.
- A base rev, not a branch: the four async rules resolve their base with `changeBaseRev(wt, baseRev)`, which is `git merge-base HEAD <baseRev>`; a commit sha works there exactly as a branch name does, so the watch passes a commit without changing the rule functions.
- The watch runs them on the tip: in `watchOnce` (src/baseline/main-watch.ts), after the build check and before the culprit call, compute `const base = previous ?? \`${baseline.sha}^\``, `const files = (await treeDiffFiles(wt, base, baseline.sha)) ?? []`, and the tip's merging role from the newest `merged` event whose `commit` is `baseline.sha` (a small helper, using `readEvents`, moved here from main-culprit.ts's owner lookup). `const ruleReason = (await diffRuleReasons(wt, base, files, role, isExemptDiff(files, config.review.exemptPaths)))[0]`; a non-empty reason is a red the watch reports as a `warning` naming `shortSha(baseline.sha)` and the reason, and the tip is its culprit. A rule failure is deterministic, so it takes no confirming re-run and never quarantines.
- The rule check is deliberately *not* added to `checkMainBaseline`: that function is consulted by the merge path, the redeploy gate and main-red attribution, and a rule failure there would read main red for every consumer. The watch alone owns the per-tip rule judgement this part adds.
- The full suite and the e2e suite stay out of the watch's check: a full `npm test` plus `npm run test:e2e` on every landing would melt the host. They stay the `ci` role's job at its own cadence (the `ci` plan above), and this part does not change that plan.
- Docs: docs/how-it-works.md's merge paragraph describes landing-then-verifying and names the deterministic rules the watch runs on the tip; docs/invariants.md re-points INV-G1 and the merge-check guarantees at the main watch (their pre-merge halves are part 3/3's to delete).

**Files touched.** src/baseline/main-watch.ts src/review/review-precheck.ts src/review/review.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/review-precheck.test.ts

**Acceptance criteria.**
- The deterministic rules run against main's tip: a commit that leaves a conflict marker, leaks a secret, edits a protected path or the brief block, or breaks the backlog structure is reported by the watch naming the rule and the head within one poll; a false-fix claim is reported when the diff is md-only, exactly as the gate scopes it.
- `diffRuleReasons` is the gate's one call site of those five rules: the gate still rejects a secret leak and a protected edit, still runs the false-fix and backlog checks on an exempt md-only diff, and the watch's report quotes the same reason text the gate would.
- The build check's red handling is unchanged: a red the confirming re-run turns green is still quarantined, and the bisect still names the culprit for a build red.
- Every pre-merge check is still in place when this part lands: the merge slot's gate run, the pre-merge model verdict and the red-main authoring block are part 3/3's to remove, and this part removes none of them.
- `npm run test:gate` passes.

**Tests.**
- test/review-precheck.test.ts: `diffRuleReasons returns the gate's rules in order` — one case per rule over a worktree and an explicit base commit, asserting the reason text, that an md-only diff runs the false-fix rule and a code diff does not, and that a clean diff returns `[]`.
- test/main-watch.test.ts: `the watch runs the precheck rules on the tip` — one case per rule (conflict marker, secret leak, protected edit, backlog structure) asserting the tip's reason is logged naming the rule and the head and takes no confirming re-run.

### Every commit is verified on main, part 2/3: the newest head is the culprit — the bisect is deleted (planned 2026-10-24 by the operator, split from the held single plan; requires part 1/3 landed, so a rule failure added there is attributed to the tip the same way a build red is; part 3/3 below then takes the pre-merge blocks off; touches src/baseline/main-watch.ts src/baseline/main-culprit.ts (deleted) docs/how-it-works.md docs/invariants.md test/main-watch.test.ts)

**Previously held 1**

**Goal.** A red is attributed without a search. The watch checks each new tip, so the tip is the culprit for whatever it finds; the first-parent walk, its fresh last-green re-check and its doc-only skip have nothing left to reconstruct. This part deletes that search. The confirming re-run that turns a one-off flake into a quarantine and the sleep-span skip stay; only the attribution search goes.

**Approach.**
- Delete src/baseline/main-culprit.ts: `findRedCulprit`, `CULPRIT_SEARCH_MAX`, `OWNER_EVENT_TAIL`, `RedCulprit`, and its imports. Remove the `findRedCulprit` import and call from src/baseline/main-watch.ts's `watchOnce`; keep the merged-event owner helper that part 1/3 added.
- Name the tip: on a red `baseline`, the watch logs one `main_culprit` event for `baseline.sha` carrying its `failingTests` and, when the newest `merged` event names it, its `runner`, then calls `onCulprit?.({ commit: baseline.sha, failingTests: baseline.failingTests ?? [], tip: baseline.sha, ...(runner ? { runner } : {}) })`. The `environment`/`unattributed` warning branches and their reasons go, because there is no search left to fail.
- Keep, unchanged: the confirming re-run (`reverifyRed`) and the `quarantineTests` call it feeds, the sleep-span skip, and the once-per-red-head guard (`lastWatched` already holds the head).
- Docs: docs/how-it-works.md's culprit paragraph says the newest head is the culprit; docs/invariants.md's attribution guarantee is re-pointed (its pre-merge halves remain part 3/3's).

**Files touched.** src/baseline/main-watch.ts src/baseline/main-culprit.ts (deleted) docs/how-it-works.md docs/invariants.md test/main-watch.test.ts

**Acceptance criteria.**
- A red tip names exactly that head, logs its `main_culprit` event with its failing tests and, when known, its merging runner, and queues the healer's prompt; no first-parent walk, last-green re-check, doc-only skip or `environment`/`unattributed` warning runs.
- A red the confirming re-run turns green is quarantined, not attributed, exactly as today.
- `src/baseline/main-culprit.ts` is gone, nothing imports it, and `findRedCulprit`/`CULPRIT_SEARCH_MAX` have no reference in `src/`.
- `npm run test:gate` passes.

**Tests.**
- test/main-watch.test.ts: replace the culprit-search cases (`a red tip names the first red commit, its merging runner and the failing tests`, `a culprit with no merged event is named without a runner`, `a last green that is red now too is not attributed`, `a red tip with no cached green below it warns that none was found`) with `a red tip names itself as the culprit` — one case with a merging runner and one without — and keep the confirming re-run/quarantine and sleep-span cases; no assertion mentions a last-green search.

### Every commit is verified on main, part 3/3: the pre-merge blocks come off — no in-lock gate run, no pre-merge model verdict, no red-main authoring block (planned 2026-10-24 by the operator, split from the held single plan; requires part 2/3 landed, since a landing stops being checked on the way in only once the whole deterministic set runs on the watched tip and the tip is the culprit; touches src/merge/merge-verify.ts src/merge/merge-to-main.ts src/merge/merge-batch.ts src/review/review.ts src/review/review-followup.ts (deleted) src/baseline/main-red.ts src/roles/roles.ts src/runner/runner-run.ts src/doctor/doctor-holds.ts src/config/config-schema.ts src/config/config-views.ts src/config/config.ts src/orchestrator/ docs/config.md docs/how-it-works.md test/merge-verify.test.ts test/merge-to-main.test.ts test/review.test.ts test/main-red.test.ts test/runner-run.test.ts test/config.test.ts)

**Previously held 1**

**Goal.** A commit is never stopped on its way to main. With the watch verifying every new tip, the checks that stood in front of a landing are redundant and go: the in-lock gate run (142–330 s per merge, plans/fast-merge.md), the pre-merge model verdict and the permit it holds, the batch check with its largest-passing-prefix bisect, and the red-main authoring block, which existed only to avoid diffs the pre-merge verdict would reject. The trade becomes explicit: a broken commit sits on main between its landing and its fix (minutes), and the fix is the healer's.

**Approach.**
- Delete the merge path's blocking checks: `mergeApprovedChange`'s in-lock gate run, src/merge/merge-verify.ts's pre-merge review step and the `VERIFY_TIER` permit it holds, src/merge/merge-batch.ts's scope-`batch` check and its largest-passing-prefix bisect (with `mergeBatchMax`'s per-pick attribution), and src/review/review-followup.ts's pre-merge revision round. A merge becomes: rebase onto the tip and take the fast-forward under the merge lock.
- `review.afterMerge` goes: every role lands first and is reviewed by the one post-landing pass. Config-schema, config-views, the `tumwater config` and docs surfaces and the tests that pin the key go with it; `review.exemptPaths` and the post-review model knobs stay.
- The precheck rules keep their non-verdict callers — the merge pre-flight's dirty-checkout refusal, the backlog archive's protected-edit guard — so the module does not disappear, only its role as a gate on a role's own diff.
- The red-main authoring block goes with the pre-merge verdict: `mainRedGate` and `baselineBlocked`/`BASELINE_BLOCKED_ROLES` (src/baseline/main-red.ts, src/roles/roles.ts) exist only to stop a code role spending an authoring run whose diff the pre-merge check would reject — with nothing left to reject it, every role authors on a red main. The information survives where it is useful: the prompt's known-red note (`buildMainKnownRedNote`) naming the failing tests and their owner, and the healer hand-off the `ci` plan above routes to the ci role. The doctor's `main red` row (`doctor-holds.ts`'s held-code-role list) and the outcome the block returns go with it.
- The gate-scope checks that are still on the change's own tree go too: `review-precheck.ts`'s reject (:203-212) and `merge-check-failures.ts`'s `merge_blocked`/`review_rejected` attribution lose their producers, and with them the merge-side `main_red` keep (src/merge/merge-core.ts:275-280) and `requeueMainRedPin`'s wait (src/merge/merge-requeue.ts:65,85-112) — there is no in-lock verdict left for main's redness to excuse. A check failure attributed to a landing is the watch's now, and its repair is the healer's (`ci`, per the `ci` plan).
- Two gate rules stay pre-merge, deliberately, and the plan should say so where it deletes the others: **secret leaks** (src/review/review.ts:301, src/review/secret-leaks.ts) and **protected edits** (src/review/review.ts:298, INV-G1's `protected-edits.ts`). Neither is a wrong-but-green change a later commit repairs: a leaked credential is in the history the moment it lands and has to be rotated, and the protected-edit rule is the operator's policy boundary rather than a correctness verdict. Everything else the gate rejects moves forward — conflict markers (review.ts:294), a false fix claim (review.ts:309) and backlog structure (review.ts:315,325) are all things the post-landing check repairs, and parts 1/3 and 2/3's watch set already runs them.
- The reviewer's provider holds stop gating the team: `reviewHeld`/`reviewStrongPaused` (src/orchestrator/scheduling-skip.ts:118-121, orchestrator-poll.ts:354,425-430) exist to keep a change from landing while the reviewer's provider is down. With `review.afterMerge` gone, `afterMergeRoles` is empty and the `!afterMergeRoles.has(...)` exemption collapses, so the hold as written would defer *every* role and every merge. Re-scope it to the post-landing review queue alone: a review parks, a landing does not. The permanent config-error hold (`mergeReviewError`, src/merge/merge-core.ts:283-306, read at src/runner/leftover.ts:118-124) goes with the pre-merge verdict it belongs to.
- One stranding path is fixed rather than deleted: a torn or foreign queue head silently strands every change behind it (`merge-queue.ts`'s `staleHeadFile`/`readMergeQueue`, dropped in `merge-verify.ts`'s `dropTornHead`). Drop the bad head loudly (a warning naming the file and its role) and re-queue its change, so nothing can wait forever on one unreadable file — the "nothing blocks a landing" rule has to hold for a change the queue cannot even read.
- No change to the refusals that are not verdicts about a change's quality, and the plan says so where it deletes the others so nobody reads the deletion as a licence to remove these too: the dirty-primary-checkout pre-flight (`merge-to-main.ts:172-175`, `merge-git.ts:415` — the 2026-10-23 incident's guard), a rebase conflict and its `MERGE_CONFLICT_LIMIT` hand-back (`leftover.ts:36`), a fast-forward that loses to a main move (`merge-git.ts:345`), the startup/redeploy stage check (`build-stage.ts:89,182`), and every team gate that holds *new runs* rather than a landing (budget, per-role cap, pause, streak, quiet hours, disk floor, maintenance quota, bootstrap, provider storms — `src/gates/*`, `src/team/team-hold.ts`). A conflicted tree cannot be landed and a leaked credential cannot be un-leaked; those are the two rules the plan keeps on the way in, and the rest of this list never was about a change's quality.
- Docs: docs/config.md drops `review.afterMerge` and says which checks the remaining merge path keeps (docs/how-it-works.md's merge paragraph and docs/invariants.md's re-pointed guarantees are part 3/3's).

**Files touched.** src/baseline/main-red.ts src/roles/roles.ts src/runner/runner-run.ts src/doctor/doctor-holds.ts src/merge/merge-verify.ts src/merge/merge-to-main.ts src/merge/merge-batch.ts src/merge/merge-queue.ts src/merge/merge-core.ts src/merge/merge-check-failures.ts src/review/review.ts src/review/review-precheck.ts src/review/review-followup.ts (deleted) src/orchestrator/scheduling-skip.ts src/orchestrator/orchestrator-poll.ts src/runner/leftover.ts src/config/config-schema.ts src/config/config-views.ts src/config/config.ts src/orchestrator/ docs/config.md test/main-red.test.ts test/runner-run.test.ts test/merge-verify.test.ts test/merge-to-main.test.ts test/review.test.ts test/merge-queue.test.ts test/config.test.ts

**Acceptance criteria.**
- A merge takes no gate run: the merge slot's per-change work is the rebase, the commit and the fast-forward, and the only refusal left on the path to main is a dirty or conflicted tree.
- Authoring is never blocked by main's redness: `mainRedGate`, `baselineBlocked` and `BASELINE_BLOCKED_ROLES` are gone, no run ends `main_red`, and a role beginning a run on a red main gets the known-red note naming the failing tests and their owner instead. The doctor's `main red` held-role row is gone with them.
- `review.afterMerge` no longer exists in the schema, the config views, the docs or any code path, and every role's commit reaches the queue of unreviewed commits.
- No pre-merge check can refuse a change except the two named: secret leaks and protected edits still reject a diff (`review_rejected` with their reason), and no other rule can — conflict markers, a false fix claim, backlog structure and the declared check are all reported by the watch on main instead. `reviewHeld`/`reviewStrongPaused` defer no role but the post-landing review, and a torn queue head warns and re-queues rather than stranding its change.
- `npm run test:gate` passes.

**Tests.**
- test/merge-to-main.test.ts: `a merge runs no gate command` — merge a change with a gate command declared and assert no build-check run was started and the fast-forward landed; keep the conflict and dirty-checkout refusal cases.
- test/main-red.test.ts / test/runner-run.test.ts: `a red main blocks no run` — a code role's run on a red main proceeds with the known-red note and never returns the `main_red` outcome; `baselineBlocked` no longer exists, and the doctor renders no `main red` held-role row.
- test/review.test.ts: `only a secret leak and a protected edit refuse a diff` — one case per rule: a conflict marker, a false fix claim and a broken backlog structure each land with a `warning`-only path and no `review_rejected`, while a leaked credential and a protected edit still end `review_rejected` with their reason and leave the pin deleted.
- test/merge-verify.test.ts / test/merge-queue.test.ts: `a torn queue head warns and re-queues its change` — plant an unreadable head file and assert one warning names it, the change is re-queued rather than dropped, and the queue advances past it.
- test/config.test.ts: `review.afterMerge is gone` — the key is absent from the schema, from a rendered default config and from `tumwater config`'s listing, while an old config carrying it still loads (the path every removed key takes).

### Split `pollBudgetGate`'s fallback-and-view half out of `src/gates/budget-gates.ts` (planned 2026-10-24 by the organize role)

**Goal.** `src/gates/budget-gates.ts` is 692 lines (3.5× the project's 197-line median) and holds one responsibility too many in a single function: `pollBudgetGate` (lines 244–621, ~378 lines) first decides the gate and emits its edge-triggered events, then derives the fallback config view the roles run under, and both halves share the function's local state and reads. A change to one half (a new subscription-backend rule, a new window-move) forces a read of the other, and the view derivation — the purest, most testable piece — stays buried under the event half. Splitting the view+window derivation out gives each half a plain function boundary and its own tests, mirroring how `stage-path-checks.ts` split `stage-check.ts` and how the vote/failure guards live under `src/budget/`.

**Approach.** Do not start the split now; this entry is the plan. When implemented, the change is one coherent restructure (no behavior change) that leaves `src/gates/budget-gates.ts` for the verdict/event phase and moves the rest of `pollBudgetGate`'s body into a new module. `src/budget` is the home of the spell it calls (`budget.js`, `fallback-breaker.js`), so the new module goes there.
- New `src/budget/budget-fallback-view.ts` owns everything in `pollBudgetGate` from `onFallback` through the end of the function: the seam/backends walk and used-up window moves (`windowOut`, `movedBackends`, `windowMove`, `windowTiers`, `windowResumedBackends`, `windowResumed`), the motion keys (`resolvedKey`, `movedKey`, `fromKey`), the two view derivations (`fallbackConfig`/`directorConfig` and their keys), the `movedTiers`/`applyFallbackModel` application, and `chainInfo`. Its one entry reads the same inputs the moved body reads (`state`, `liveConfig`, `accounts`, `windowOutFor`/`directorWindowOutFor`, `priceResolved`, `pairFreeAt`, the `reached`/`gate` flags) and returns the view fields `BudgetGatePoll` carries, so `pollBudgetGate` keeps its call signature and `src/gates/gate-polls.ts`'s destructure of it is untouched.
- `pollBudgetGate` (src/gates/budget-gates.ts) keeps the spend read, the price/demotion resolutions, the breaker re-key, the `budgetGate` decision, the warning/transition events and `topDailySpenders` — its first ~110 lines unchanged — then calls the new module for the view fields, so the function shrinks to roughly its pre-view size and both modules compile against the same `BudgetGatePoll` shape.
- Move the doc-bearing interfaces and constants the view half uses alongside it (`BudgetGateState`'s view fields stay where they are; the module-scope `MODEL_TIERS`/`seamsInUse`/`tierChainSteps`/`chainInfo` imports move with the moved body). Re-export what `budget-gates.ts` still exports so no importer's name changes.
- Docs: docs/invariants.md's budget-gate and fallback-view paragraphs re-point their `src/` bind lines at the new module where they name `pollBudgetGate`'s body.

**Files touched.** src/gates/budget-gates.ts src/budget/budget-fallback-view.ts (new) docs/invariants.md test/budget-gates.test.ts test/budget.test.ts (the split must not change an existing assertion)

**Acceptance criteria.**
- `npm run test:gate` passes with no assertion change except import-path edits, and `grep -rn "budget-fallback-view"` finds its one production importer (budget-gates.ts) plus its new test.
- `pollBudgetGate`'s call site in `src/gates/gate-polls.ts` is byte-identical in what it destructures: same `BudgetGatePoll` fields, same ordering.
- The two halves are separable in prose: the view module's doc comment names it the fallback-view derivation and cites the same plan references (`part 5b/8`, `part 5c/8`, `6a/7`) the moved comments carry.
- `npm run test:gate` passes.

**Tests.**
- test/budget-gates.test.ts / test/budget.test.ts: existing assertions stay green unchanged; add one test that the view module returns the same fallback view and `fromKey` for a fixed config/window state, so the moved body is pinned in its new home.

### Move `pollTeamGates`'s budget wiring into `src/budget` (planned 2026-10-24 by the organize role)

**Needs review 2026-10-24 by feature: too large for one run (held 1)**

**Goal.** `src/gates/gate-polls.ts`'s `pollTeamGates` (lines 206–621, ~415 lines) is the orchestrator's wiring hub, but ~115 of those lines are budget-and-window wiring inlined right after the `pollBudgetGate` destructure (lines 237–358): the demotions publish (the `fallbackDemotions`/`fallbackDemoted`/`budget`/`chain` info fields), the `fallback_switched` event and `prevChain`/`switched` bookkeeping, the per-runner `gateRoleConfig` + `budgetFallbackActive` assignment, the cap-reopen/window hand-back, and the per-role `budgetPausedRoles`/`windowMovedRoles` subject sets. That wiring is the budget concern's second half: the `Split pollBudgetGate` plan above moves `pollBudgetGate`'s view derivation into `src/budget`; this is its twin — it moves the budget *wiring* out of `pollTeamGates` into the same module, so the whole budget concern (verdict, edge events, fallback view, and the demotion/hand-back/subject-set wiring) lives under `src/budget` and `pollTeamGates` becomes a thin pass that calls each gate module. Today a budget change (a new demotion, a new hand-back rule) forces a read of both `budget-gates.ts` and this wiring block a directory apart, and the same `publishInfoFields`/accounts idiom repeats.

**Approach.** Do not start the split now; this entry is the plan. When implemented, it is one coherent restructure (no behavior change) that lands after the `Split pollBudgetGate`'s fallback-and-view half plan above (whose `BudgetGatePoll` shape this wiring reads unchanged, and which is the natural owner of the region's imports). `src/budget` is the home of the spell it calls (`budget.js`, `fallback-breaker.js`, and the new `budget-fallback-view.js`), so the wiring goes there.
- New `src/budget/budget-wiring.ts` exports one entry that takes what the inlined block reads (`root`, `states`, `runners`, `liveConfig`, `accounts`, `info`, the `BudgetGatePoll` view fields it uses: `gate`/`roleConfig`/`directorConfig`/`onFallback`/`resumed`/`windowResumedBackends`/`windowTiers`/`fallbackPairs`/`priceResolved`/`servingResolved`/`budgetActive`/`chain`, and the budget `breakers`/`engaged`/`prevChain` from `states.budget`) and returns what the block wrote so `pollTeamGates` keeps the same post-block locals it reads later for the pause/streak folds and the final return — the `budgetPausedRoles`/`windowMovedRoles` sets and the updated `gate`/`roleConfig`/`directorConfig`/`budgetActive`/`servingResolved`/`priceResolved`/`windowTiers` values, plus the `fallback_switched`/`budget_handback` event and `publishInfoFields` side effects it already performs. `pollTeamGates` (src/gates/gate-polls.ts) keeps its other blocks untouched and its `TeamGatePoll` return shape identical.
- Move the doc-bearing helpers and constants the block uses alongside it (`fallbackDemotion`, `runOnPair`, `subscriptionBackendOf`, `MODEL_TIERS`/`priceResolved` reads) where they are not already imported by other blocks of `pollTeamGates`; re-export what `gate-polls.ts` still exports so no importer's name changes. The `accounts` read stays in `pollTeamGates` (the window/team-hold block below uses it too) and is passed in.
- Docs: docs/invariants.md's budget-gate and hand-back paragraphs re-point their `src/` bind lines that name `pollTeamGates`'s budget wiring at the new module.

**Files touched.** src/gates/gate-polls.ts src/budget/budget-wiring.ts (new) docs/invariants.md test/gate-polls.test.ts test/budget.test.ts (the split must not change an existing assertion)

**Acceptance criteria.**
- `npm run test:gate` passes with no assertion change except import-path edits, and `grep -rn "budget-wiring"` finds its one production importer (gate-polls.ts) plus its new test.
- `pollTeamGates`'s call site still produces the same `TeamGatePoll` — byte-identical fields, same ordering — and its `publishInfoFields` output for the budget/chain/disk keys is unchanged.
- The wiring module's doc comment names it the budget wiring (demotions publish, hand-back, per-role subject sets) and cites the same plan references (`part 5b/8`, `part 5c/8`, `2e/9`) the moved comments carry.
- `npm run test:gate` passes.

**Tests.**
- test/gate-polls.test.ts / test/budget.test.ts: existing assertions stay green unchanged; add one test that the wiring module publishes the same `fallbackDemotions`/`budget`/`chain` info fields and returns the same `budgetPausedRoles`/`windowMovedRoles` sets for a fixed gate/view state, so the moved body is pinned in its new home.

## Done
