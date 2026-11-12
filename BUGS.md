# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

- The bugfix "with the director" skip is re-derived from prose every run; no machine hold exists (filed 2026-11-11 from ~/Desktop/tumwater-no-progress-bugs.md).

**Symptom.** The bugfix charter (src/roles/role-catalog.ts, bugfix `find` step 2, lines ~119–127) tells the model to skip an entry "whose newest Progress note names a director handoff" and that carries no `**Needs review … by director: …**` note. Nothing in the backlog index marks that state, so every run re-derives it from prose. One model (`codex/gpt-6-luna`) misread repeatedly: 25 consecutive `no_change` runs (00:00–01:05) while the director had already answered, `yieldMultiplier: 8`; the bug was fixed only when a later run on another model took the entry.

**Required behavior.** A machine hold at handoff time: write a hold line (e.g. `**Director handoff <date>**`) beside the request file, have the index mark the entry `[blocked: with the director]`, and clear it when the director resolves — the request-file lifecycle (src/inbox/director-request.ts) already knows when the director ran (the request file's deletion marks that event), so the index can derive the hold from that state instead of asking the model to interpret the newest Progress note.

**Suspected cause.** The handoff state exists only in prose; the entry stays eligible, so a model that misreads the note idles instead of being held.

- A director run with a queued user prompt ends on the `pinned` recovery arm, starving the prompt indefinitely while its pin cannot merge (filed 2026-11-11 from a live stuck instance).

**Symptom.** The director held an unmerged pin (`refs/tumwater/merge/director` at `d524a78e`) while the merge slot's one gate-then-merge task waited on a `VERIFY_TIER` permit (all 4 held by long pi runs). Each of the director's two queued operator prompts dequeued (`prompt_taken`), then `recoverLeftoversForRun` → `recoverLeftover` found the pin and `handleRecoveredLeftover` (src/runner/runner-run.ts) ended the run through `ctx.finishRecoveryRun` **before authoring** — the only arm that falls through to authoring is `already_queued`, which requires a queue file, and pin-only writers (parts 3e/7, 3i/7) never write one. `finishRecoveryRunPhase` re-queued the dequeued prompt ("a run's dequeued user prompt goes back to its queue, since nothing ran it"), so the operator's request never ran and never will until the pin clears on its own.

**Required behavior.** A run that dequeued a user prompt (`plan.userPrompt !== null`) must not end on the `pinned`/`relief_wait` recovery arms: either run the recovery first and then author the request, or decline to dequeue while a pin recovery is pending (admit the run only when it can actually serve the prompt). The operator's request must always reach an authoring run.

**Suspected cause.** `handleRecoveredLeftover` treats every recovery arm except `already_queued` as terminal, and the director's `recoveryOnly` gate (src/runner/runner-run.ts `runOncePhase`) is computed with `ctx.pending.get() === null` before the dequeue in `runPrompt` — so a prompt-carrying run enters the recovery path and loses its prompt.

- The live-orchestrator e2e `a stale marker beside a stale pin is dropped at the drain without a merge run` (test/orchestrator-3.e2e.test.ts:273) flakes under load — it timed out waiting for the stale pin to be dropped and its marker cleared, and CI on the GitHub runner failed on it (found by the ci role 2026-11-11).

**Symptom.** On a slow/loaded runner the drain path that drops an orphaned stale merge pin and clears its marker does not settle within the test's ~60 s window: the GitHub run https://github.com/znation/tumwater/actions/runs/43015260315 (main tip `ec3a65e4a`) reported the test as `timed out`. The same test passes in isolation (~0.9 s) and in the full local e2e suite at the live tip (661 ms on 2026-11-11), so it is load-sensitive, not a regression.

**Required behavior.** The stale-pin drop and its marker clear settle within the timeout under the load the hosted runner actually applies, or the test's bound is widened (and the drain's timing checked) so a slow machine does not fail the suite. A flaky live-orchestrator test in the known-flaky family (cf. the archived merge-pipeline-2 / abort entries) that only fails under load should be made deterministically fast or its bound raised — not left red at the mercy of runner speed.

**Suspected cause.** The pin-queue rework made the drain heavier (it drops pins rather than queue files), so on a loaded runner the drop-and-clear round-trip crosses the test's wall-clock bound even though the code path is correct.

- The steward's `## Done` epitaph shape for a superseded plan is invisible to the stranded-plan detector, keeping main's self-referential backlog-structure guardrail red for over a day (found by the selfcheck role 2026-11-12 from the digest's Fast-merge-guardrails line: "main has had no passing full check for more than 24 h", "this repo's current PLANS.md and PLANS-DONE.md yield nothing").

**Symptom.** The guardrail test `test/backlog-structure.test.ts` "this repo's current PLANS.md and PLANS-DONE.md yield nothing" fails on main: `strandedPlanEntries` reports the two `## Done` entries steward moved in `d15db595` (subtract pin queue part 2/3 and part 3/3, PLANS.md lines 116 and 140) as stranded. Each carries `(planned 2026-11-09 …)` and no `done` date, and each was closed with a `— superseded 2026-11-12 by the steward role: …` epitaph line under `## Done`. The detector's completion stamps are only `DONE_DATE` (`done YYYY-MM-DD`) and `RETIRED_STAMP` (`retired YYYY-MM-DD`) — `src/backlog/backlog-structure.ts` lines 110 and 123 — and `headingMetadata` joins heading continuation lines only for an unbalanced parenthetical (`headingIsWrapped`), so the `superseded` epitaph on the line after each heading is neither a recognized stamp nor joined into the heading text. Both entries remain under `## Done` with `(planned …)` and no completion stamp, so the whole-document stranding check keeps failing and main stays red past the 30-minute G1 threshold; even the `ci` `d031c080` fix touched no PLANS.md and left the guardrail red. The same failure recurred from the same cause as the archived 2026-11-11 fix (BUGS-FIXED.md: the operator/team-start bulk archive shipped stranded entries to PLANS-DONE.md).

**Required behavior.** A superseded plan's `## Done` entry must carry a stamped completion the detector reads. The role catalog (src/roles/role-catalog.ts lines 200 and 371) already prescribes the `retired YYYY-MM-DD` heading stamp for a plan closed without being built — so a superseded entry should use the `retired` stamp (e.g. `(planned …) — retired 2026-11-12 by the steward role`) rather than a bare `— superseded`, which `RETIRED_STAMP` accepts and the stranding check then excuses. The steward/plan roles should land those two `## Done` entries with `retired` stamps (or the detector extended to also recognize a `superseded` delimiter stamp as a completion). Until one lands, the backlog-structure guardrail test stays red.

**Suspected cause.** The steward's d15db595 used a `— superseded …` epitaph as the body when moving the two entries under `## Done`, following the role catalog's "one-line epitaph as its body" wording (line 713) but not its `retired` heading-stamp rule for a plan closed without being built; the harness's stranded-plan detector has no `superseded` completion stamp.

## Fixed
