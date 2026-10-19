import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reviewAheadOfMain, REVIEW_FAILURE_LIMIT } from "../src/review/review.js";
import { aheadOfMain, headOf, patchId } from "../src/git/git.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { defaultConfig } from "../src/config/config.js";
import { freshLoopState, REVIEW_RESUME_LIMIT } from "../src/runner/runner-state.js";
import { readEvents } from "../src/events/event-read.js";
import { eventsLogPath, piLogPath, reviewRunSessionDir } from "../src/paths.js";
import { eventsOfType, warningMessages } from "./fixtures/log-fixtures.js";
import { makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { logFlagsTo, piRanMarker, reviewerStub, TOUCH_SESSION, withPi } from "./fakes/fake-pi.js";
import { waitForLogLines, watchdogClock } from "./helpers/wait.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { gateCtx, gateFixture, reviewGate, ROLE } from "./fixtures/gate-fixtures.js";

// Regression coverage for the 2026-08-27 build break (BUGS.md): src/review/review.ts shipped with a
// syntax error and latent type errors and had zero tests, so nothing caught it; importing
// review.js still fails `npm test` if this file stops compiling again. The gate-orchestration
// section drives the real reviewAheadOfMain end-to-end against a git repo with a fake pi on
// PATH, covering every decision branch of the gate that guards each merge; the parser's own
// cases live in review-verdict.test.ts (exemption matching in exemptions.test.ts). The gate's
// build pre-check slice lives in review-precheck.test.ts (extracted 2026-09-29); both files
// share the scaffolding in fixtures/gate-fixtures.ts.


// ── Gate orchestration (reviewAheadOfMain) ────────────────────────────────────────────────
// Each fixture is a real git repo whose worktree sits one commit ahead of main, and the
// reviewer is a fake pi on PATH that prints a canned JSON verdict line. A marker file OUTSIDE
// the worktree records whether the reviewer ran at all (so "no run" branches are asserted,
// not merely assumed).

test("gate approves a good diff, records the HEAD, and discards the reviewer's stray edits", async () => {
  const { root, wt, head } = await gateFixture();
  const committed = fs.readFileSync(path.join(wt, "seed.txt"), "utf8");
  await withPi(
    `echo stray >> seed.txt\n` + // the reviewer's working-tree edit while reading around
      `printf '%s\n' '${assistantLine("VERDICT: approve\n1. solid change", { tokens: 17, output: 17, cost: 0.02 })}'`,
    async () => {
      const { state, result } = await reviewGate(root, wt);
      assert.equal(result.decision, "approved");
      assert.equal(state.lastApprovedHead, head);
      assert.equal(state.lastReview?.verdict, "approve");
      assert.deepEqual(state.lastReview?.reasons, ["solid change"]);
      assert.equal(state.unreviewFailures, 0);
      assert.equal(state.phase, "review"); // persisted before the run; the tick clears it at end
      // The reviewer's only output channel is the verdict: its stray edit is reset away.
      assert.equal(fs.readFileSync(path.join(wt, "seed.txt"), "utf8"), committed);
      // Reviewer usage is surfaced for folding into the loop totals.
      assert.equal(result.run?.outputTokens, 17);
      assert.equal(warningMessages(root).filter((m) => m.includes("reviewer moved HEAD")).length, 0);
  });
});

const COMMITTING =
  `echo extra > extra.txt && git add extra.txt && git -c user.name=t -c user.email=t@t commit -qm reviewer\n`;

test("a reviewer's own commit is dropped on approve: the worktree returns to the reviewed head", async () => {
  const { root, wt, head } = await gateFixture();
  await withPi(COMMITTING + `printf '%s\n' '${assistantLine("VERDICT: approve\n1. fine")}'`, async () => {
    const { state, result } = await reviewGate(root, wt);
    assert.equal(result.decision, "approved");
    assert.equal(await headOf(wt, "HEAD"), head);
    assert.equal(fs.existsSync(path.join(wt, "extra.txt")), false);
    assert.equal(state.lastApprovedHead, head);
    assert.ok(warningMessages(root).some((m) => m.includes("reviewer moved HEAD")));
  });
});

test("a reviewer's own commit is dropped when the review fails strike-free", async () => {
  const { root, wt, head } = await gateFixture();
  await withPi(COMMITTING + `exit 1`, async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "failed");
    assert.ok(!result.discarded);
    assert.equal(await headOf(wt, "HEAD"), head);
    assert.equal(fs.existsSync(path.join(wt, "extra.txt")), false);
  });
});

test("a revision's review carries its round and shows the prior objections and interdiff", async () => {
  const { root, wt, head } = await gateFixture();
  const prompts: string[] = [];
  await withPi(`printf '%s\n' '${assistantLine("VERDICT: approve")}'`, async () => {
    const { result } = await reviewGate(root, wt, {
      revisionRound: 2,
      priorReview: { sha: head, reasons: ["the first bug"] },
      // Capture the assembled prompt through the gate's wiring seam (the fake pi ignores it).
      runGatePi: async (opts) => {
        prompts.push(opts.prompt);
        return gateCtx(root, wt).runGatePi(opts);
      },
    });
    assert.equal(result.decision, "approved");
    assert.match(prompts[0]!, /revision 2 of one previously rejected in review/);
    assert.match(prompts[0]!, /1\. the first bug/);
    assert.ok(prompts[0]!.includes("<interdiff>"), "the interdiff block is present");
    const start = readEvents(root).find((e) => e.type === "review_start");
    assert.equal(start?.revision, 2);
  });
});

test("a fresh merge's review_start carries no revision marker", async () => {
  const { root, wt } = await gateFixture();
  await withPi(`printf '%s\n' '${assistantLine("VERDICT: approve")}'`, async () => {
    await reviewGate(root, wt);
    const start = readEvents(root).find((e) => e.type === "review_start");
    assert.equal(start?.revision, undefined);
  });
});

test("the reviewer's pi run goes through the loop's runGatePi wiring, not bare runPi", async () => {
  // BUGS.md 2026-10-01: the gate called runPi directly, so a 429 in the merge gate failed
  // the review with no transient retry and no rate-limit hold stamp — the one surface the
  // shared retry's "EVERY pi run" doc promised and review.ts alone skipped. The pin: the
  // gate's reviewer run must arrive through the context's runGatePi seam.
  const { root, wt } = await gateFixture();
  const calls: Array<{ prompt: string; label?: string }> = [];
  await withPi(
    `printf '%s\n' '${assistantLine("VERDICT: approve")}'`,
    async () => {
      const { result } = await reviewGate(root, wt, {
        runGatePi: async (opts) => {
          calls.push({ prompt: opts.prompt, label: opts.label });
          return gateCtx(root, wt).runGatePi(opts);
        },
      });
      assert.equal(result.decision, "approved");
      assert.equal(calls.length, 1, "the review run itself went through the wiring");
      assert.match(calls[0]!.prompt, /VERDICT:/, "the wiring saw the review prompt");
      assert.equal(calls[0]!.label, "review");
    },
  );
});

test("gate rejects a bad diff: branch reset to main, reasons recorded", async () => {
  const { root, wt } = await gateFixture();
  await withPi(
    `printf '%s\n' '${assistantLine("VERDICT: reject\n1. breaks the build\n2. no regression test")}'`,
    async () => {
      const { state, result } = await reviewGate(root, wt);
      assert.equal(result.decision, "rejected");
      assert.equal(result.detail, "breaks the build"); // first reason feeds lastSummary
      assert.equal(await aheadOfMain(wt, "main"), 0); // the commit is discarded
      assert.equal(state.lastReview?.verdict, "reject");
      assert.deepEqual(state.lastReview?.reasons, ["breaks the build", "no regression test"]);
      assert.equal(state.unreviewFailures, 0); // a parseable verdict is a successful review
      assert.equal(state.lastApprovedHead, undefined);
  });
});

test("an unwritable events feed cannot reject a review — approval still records and discards stray edits", async () => {
  const { root, wt, head } = await gateFixture();
  // A directory where events.jsonl belongs makes every append throw EISDIR. The declared
  // check below makes the production fault reachable: gateBuildPrecheck actually runs
  // runScopedBuildCheck, whose build_check append is the gate's FIRST write (defaultConfig
  // declares no check, which made the pre-check a no-op and hid that write). Before the fix,
  // that raw logEvent threw before the reviewer even ran, so an approving review came back as
  // a thrown error instead of { decision: "approved" }.
  fs.mkdirSync(eventsLogPath(root), { recursive: true });
  await withPi(`printf '%s\n' '${assistantLine("VERDICT: approve\n1. solid change")}'`, async () => {
    const { state, result } = await reviewGate(root, wt, {
      config: { ...defaultConfig(), check: { command: "true" } },
    });
    assert.equal(result.decision, "approved");
    assert.equal(state.lastApprovedHead, head);
    assert.equal(state.lastReview?.verdict, "approve");
    assert.equal(await aheadOfMain(wt, "main"), 1); // the approved commit survives
  });
});

test("an unwritable events feed cannot lose a rejection — the branch is still reset and the verdict returned", async () => {
  const { root, wt } = await gateFixture();
  fs.mkdirSync(eventsLogPath(root), { recursive: true });
  await withPi(`printf '%s\n' '${assistantLine("VERDICT: reject\n1. breaks the build")}'`, async () => {
    const { state, result } = await reviewGate(root, wt, {
      config: { ...defaultConfig(), check: { command: "true" } },
    });
    assert.equal(result.decision, "rejected");
    assert.equal(result.detail, "breaks the build");
    assert.equal(await aheadOfMain(wt, "main"), 0, "the rejected commit is still discarded");
    assert.equal(state.lastReview?.verdict, "reject");
  });
});

test("an unwritable events feed cannot turn a flaky gate check into a rejection — the flake warning is best-effort too", async () => {
  const { root, wt, head } = await gateFixture();
  fs.mkdirSync(eventsLogPath(root), { recursive: true });
  // The command fails its first run and passes the pre-check's one immediate re-run; that
  // routes the gate through gateBuildPrecheck's flake warning (the raw warnEvent that threw
  // before the fix) and then on to the reviewer, exactly as production does.
  const flaky = "if [ -f .gate-flake ]; then exit 0; else : > .gate-flake; exit 1; fi";
  await withPi(`printf '%s\n' '${assistantLine("VERDICT: approve\n1. solid change")}'`, async () => {
    const { state, result } = await reviewGate(root, wt, {
      config: { ...defaultConfig(), check: { command: flaky } },
    });
    assert.equal(result.decision, "approved");
    assert.equal(state.lastApprovedHead, head);
  });
});

test("gate logs a bold-numbered approval's first finding as the review_verdict reason, not its preamble", async () => {
  // The event the 2026-09-23 log audit read (BUGS.md): a reviewer that opens with a lead-in
  // and numbers its findings `**1. X.** …` logged "…Findings:" as the approval's reason.
  const { root, wt } = await gateFixture();
  const reply =
    "I checked the diff against the code, its callers, and its tests. Findings:\n\n" +
    "**1. Scope matches the claim.** No unclaimed changes.\n\n**2. Tests pin it.** Both ways.\n\nVERDICT: approve";
  await withPi(`printf '%s\n' '${assistantLine(reply)}'`, async () => {
      const { state, result } = await reviewGate(root, wt);
      assert.equal(result.decision, "approved");
      const verdict = readEvents(root).find((e) => e.type === "review_verdict");
      assert.equal(verdict?.reason, "Scope matches the claim. No unclaimed changes.");
      assert.deepEqual(state.lastReview?.reasons, ["Scope matches the claim. No unclaimed changes.", "Tests pin it. Both ways."]);
  });
});

test("gate handles a bare VERDICT: reject with no reasons: fallback detail, empty list recorded", async () => {
  // A reviewer that declines without stating why is still a parseable verdict (not a failed
  // review): the rejection lands exactly like any other, and the missing first reason degrades
  // to the "no reasons given" fallback instead of an undefined lastSummary.
  const { root, wt, head } = await gateFixture();
  await withPi(`printf '%s\n' '${assistantLine("VERDICT: reject")}'`, async () => {
      const { state, result } = await reviewGate(root, wt);
      assert.equal(result.decision, "rejected");
      assert.equal(result.detail, "no reasons given"); // fallback: no first reason to feed lastSummary
      assert.equal(await aheadOfMain(wt, "main"), 0); // the commit is discarded like any reject
      assert.equal(state.lastReview?.verdict, "reject");
      assert.deepEqual(state.lastReview?.reasons, []);
      assert.equal(state.lastReview?.head, head);
      assert.equal(state.unreviewFailures, 0); // a parseable verdict is a successful review
      const rejected = eventsOfType(root, "review_rejected");
      assert.equal(rejected.length, 1);
      assert.deepEqual(rejected[0]?.reasons, []); // the event's fallback renders "no reasons given"
  });
});

test("gate fails closed on a verdict-less reply: commit kept for re-review", async () => {
  const { root, wt } = await gateFixture();
  const marker = piRanMarker();
  await withPi(
    `touch '${marker}'\nprintf '%s\n' '${assistantLine("I think this is fine overall.")}'`,
    async () => {
      const { state, result } = await reviewGate(root, wt);
      assert.ok(fs.existsSync(marker)); // the reviewer did run
      assert.equal(result.decision, "failed");
      assert.match(result.detail ?? "", /no parseable VERDICT/);
      assert.equal(await aheadOfMain(wt, "main"), 1); // commit left for the next tick's re-review
      assert.equal(state.unreviewFailures, 1);
      assert.equal(state.lastReview?.verdict, "failed");
      assert.equal(state.lastApprovedHead, undefined);
  });
});

test("a verdict-less completed reply is recovered with one follow-up turn, not a strike", async () => {
  // The reviewer ran to completion and replied, but without a VERDICT line — a formatting
  // slip, not a verdict about the diff. Before the fix (BUGS.md 2026-09-29) that counted
  // straight onto the strike ladder toward `reset --hard` over a finished commit; now the
  // gate first asks the reviewer's own session (--continue) for the missing line, mirroring
  // requestSummary on the author side.
  const { root, wt, head } = await gateFixture();
  const flags = path.join(tmpdir(), "verdict-followup-flags");
  await withPi(
    [
      TOUCH_SESSION, // the reviewer's session exists, so the follow-up has one to continue
      logFlagsTo(flags),
      `for a in "$@"; do if [ "$a" = "--continue" ]; then`,
      `  printf '%s\n' '${assistantLine("VERDICT: approve\n1. recovered the verdict on the follow-up")}'`,
      `  exit 0`,
      `fi; done`,
      `printf '%s\n' '${assistantLine("I think this is fine overall.")}'`,
    ].join("\n"),
    async () => {
      const { state, result } = await reviewGate(root, wt);
      assert.equal(result.decision, "approved");
      assert.equal(state.unreviewFailures, 0); // a recovered verdict is a successful review
      assert.equal(state.lastApprovedHead, head);
      assert.equal(await aheadOfMain(wt, "main"), 1);
      // Both runs ride back for usage folding into the loop totals.
      assert.ok(result.run);
      assert.ok(result.followUpRun);
      assert.equal(eventsOfType(root, "review_failed").length, 0);
      assert.equal(eventsOfType(root, "review_verdict").length, 1);
      // The recovery is observable in the event feed.
      const warnings = eventsOfType(root, "warning");
      assert.ok(warnings.some((e) => String(e.message).includes('follow-up turn')));
      // Exactly one --continue run happened, after the fresh review run.
      const lines = fs.readFileSync(flags, "utf8").trim().split("\n");
      assert.equal(lines.length, 2);
      assert.match(lines[0]!, /^run: -n/);
      assert.match(lines[1]!, /^run: --continue$/);
  });
});

test("a follow-up turn that also yields no verdict still counts the strike against the HEAD", async () => {
  const { root, wt } = await gateFixture();
  // The session exists (TOUCH_SESSION), so the follow-up runs — and replies without a
  // VERDICT line again, like the first run. Only now does the strike ladder engage.
  await withPi(`
    ${TOUCH_SESSION}
    printf '%s\n' '${assistantLine("still no verdict here")}'
  `, async () => {
      const { state, result } = await reviewGate(root, wt);
      assert.equal(result.decision, "failed");
      assert.match(result.detail ?? "", /even after a follow-up turn/);
      assert.equal(state.unreviewFailures, 1);
      assert.equal(await aheadOfMain(wt, "main"), 1); // still kept under the limit
      assert.ok(result.followUpRun); // the follow-up's usage rides back for folding
  });
});

test("a follow-up turn that itself fails (backend dies) is strike-free, like the review run's own failure", async () => {
  // The reviewer completed and replied without a VERDICT line, but the recovery turn then ran
  // into a dead backend (ok false: transport error, failed spawn, timeout). Before the fix
  // (BUGS.md 2026-09-29) the strike was decided by the ORIGINAL run's ok flag alone, so that
  // backend death counted against the HEAD — three of them discarded a finished, tested
  // commit, exactly what the strike-free branch exists to prevent (BUGS.md 2026-09-20).
  const { root, wt } = await gateFixture();
  await withPi(`
    ${TOUCH_SESSION}
    for a in "$@"; do if [ "$a" = "--continue" ]; then exit 1; fi; done
    printf '%s\n' '${assistantLine("still no verdict here")}'
  `, async () => {
      const { state, result } = await reviewGate(root, wt);
      assert.equal(result.decision, "failed");
      assert.match(result.detail ?? "", /the agent exited 1/); // the follow-up's own failure is named
      assert.equal(state.unreviewFailures ?? 0, 0); // backend evidence, never a strike against the HEAD
      assert.equal(await aheadOfMain(wt, "main"), 1); // the commit survives for the next re-review
      assert.ok(result.followUpRun); // the failed follow-up's spend still folds into the totals
  });
});

test("gate discards the leftover after three failed reviews of one HEAD", async () => {
  const { root, wt } = await gateFixture();
  await withPi(`printf '%s\n' '${assistantLine("still no verdict here")}'`, async () => {
      const state = freshLoopState(ROLE);
      for (let tick = 1; tick < REVIEW_FAILURE_LIMIT; tick++) {
        assert.equal((await reviewAheadOfMain(gateCtx(root, wt, tick), state)).decision, "failed");
        assert.equal(await aheadOfMain(wt, "main"), 1); // still kept while under the limit
      }
      const last = await reviewAheadOfMain(gateCtx(root, wt, REVIEW_FAILURE_LIMIT), state);
      assert.equal(last.decision, "failed");
      assert.equal(await aheadOfMain(wt, "main"), 0); // discarded at the limit
      assert.equal(state.unreviewFailures, 0); // the HEAD is gone; nothing left to count against
      const warning = readEvents(root).find((e) => e.type === "warning");
      assert.match(String(warning?.message), /discarding unreviewed leftover/);

      // A NEW commit (new HEAD) restarts the failure count from one, not four.
      fs.appendFileSync(path.join(wt, "seed.txt"), "another change\n");
      sh(wt, "git", "add", "-A");
      sh(wt, "git", "commit", "-m", "next attempt");
      assert.equal((await reviewAheadOfMain(gateCtx(root, wt, 4), state)).decision, "failed");
      assert.equal(state.unreviewFailures, 1);
  });
});

test("gate does not discard the commit when the reviewer run itself fails", async () => {
  // A dead reviewer backend: pi exits non-zero with no assistant output at all, so the run
  // FAILED (pi.ok false) rather than replying without a VERDICT. That says nothing about the
  // diff, so it must never count toward the discard limit — otherwise three infrastructure
  // failures delete a complete commit the reviewer never saw (BUGS.md 2026-09-20).
  const { root, wt } = await gateFixture();
  await withPi(`echo 'oMLX HTTP 400: prefill_memory_exceeded' >&2\nexit 1`, async () => {
      const state = freshLoopState(ROLE);
      for (let tick = 1; tick <= REVIEW_FAILURE_LIMIT + 2; tick++) {
        const result = await reviewAheadOfMain(gateCtx(root, wt, tick), state);
        assert.equal(result.decision, "failed");
        assert.equal(await aheadOfMain(wt, "main"), 1); // commit kept for re-review every time
        assert.equal(state.unreviewFailures ?? 0, 0); // a failed run is not a strike against the commit
      }
      const events = readEvents(root);
      assert.equal(events.filter((e) => e.type === "review_failed").length, REVIEW_FAILURE_LIMIT + 2);
      assert.ok(!events.some((e) => e.type === "warning" && String(e.message).includes('discarding unreviewed')));
  });
});

test("a reviewer that outruns review.timeoutSeconds fails in its own budget: commit kept, no strike", async () => {
  // A wedged reviewer must not hold the merge queue for a whole authoring tick: its own budget
  // kills it long before runTimeoutSeconds, and the kill is a failed RUN (like a dead backend),
  // so the pin stays and the per-HEAD discard counter does not move.
  const { root, wt, head } = await gateFixture();
  await withPi(`exec sleep 60`, async () => { // exec so the kill signal reaches the sleeper directly
      const config = defaultConfig();
      config.review.timeoutSeconds = 2;
      assert.ok(config.runTimeoutSeconds > 60); // only the review budget can end this run in time
      const state = freshLoopState(ROLE);
      const startedAt = Date.now();
      const result = await reviewAheadOfMain({ ...gateCtx(root, wt), config }, state);
      const elapsedMs = Date.now() - startedAt;
      assert.equal(result.decision, "failed");
      assert.match(result.detail ?? "", /timed out after 2s/);
      assert.ok(elapsedMs < 20_000, `the review ended in its 2 s budget, not the sleeper's 60 s (took ${elapsedMs} ms)`);
      assert.equal(await aheadOfMain(wt, "main"), 1); // commit kept for the next tick's re-review
      assert.equal(state.unreviewFailures ?? 0, 0); // a timed-out run is not a strike against the commit
      assert.equal(state.lastApprovedHead, undefined);
      const failed = eventsOfType(root, "review_failed");
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.head, head);
      assert.match(String(failed[0]?.message), /timed out after 2s/);
  });
});

test("a progressing timeout says the next attempt continues this review, not 'preserved for resume'", async () => {
  // runPi's progressing-timeout text is written for authoring ticks, which do resume their
  // session and worktree (BUGS.md 2026-09-29). The reviewer's commit stays on the branch and
  // the gate leaves the session for the next attempt to continue (LoopState.reviewResume), so
  // the recorded failure names that — not the raw "preserved for resume" whose resume the
  // gate could not honor before (BUGS.md 2026-09-30). The session file must exist for the
  // promise to be one the next attempt can keep (TOUCH_SESSION).
  const { root, wt } = await gateFixture();
  // Keeps speaking progress events through the doubled deadline, so the review is still
  // making progress when killed and runPi emits its progressing-timeout text.
  await withPi(
    `${TOUCH_SESSION}\nprintf '%s\n' '${assistantLine("reading the diff…")}'\nwhile true; do sleep 0.05; echo '${assistantLine("still reading")}'; done`,
    async () => {
      const config = defaultConfig();
      config.review.timeoutSeconds = 1;
      const state = freshLoopState(ROLE);
      const result = await reviewAheadOfMain({ ...gateCtx(root, wt), config }, state);
      assert.equal(result.decision, "failed");
      assert.match(
        result.detail ?? "",
        /timed out after 2s while still making progress — the commit is kept; the next attempt continues this review/,
      );
      assert.doesNotMatch(result.detail ?? "", /preserved for resume/);
      const failed = eventsOfType(root, "review_failed");
      assert.equal(failed.length, 1);
      assert.doesNotMatch(String(failed[0]?.message), /preserved for resume/);
      assert.equal(state.reviewResume?.attempts, 0);
      assert.equal(await aheadOfMain(wt, "main"), 1); // commit kept for the next tick's re-review
  });
});

test("a progressing timeout with no session to resume records a from-scratch re-review and leaves no marker", async () => {
  // The next attempt only resumes when the directory still holds a gate session. A backend
  // that leaves no session file must not record a marker the next review silently declines, so
  // the recorded failure says it re-reviews from scratch — the promise and the behavior agree.
  const { root, wt } = await gateFixture();
  await withPi(`printf '%s\n' '${assistantLine("reading the diff…")}'\nwhile true; do sleep 0.05; echo '${assistantLine("still reading")}'; done`, async () => {
      const config = defaultConfig();
      config.review.timeoutSeconds = 1;
      const state = freshLoopState(ROLE);
      const result = await reviewAheadOfMain({ ...gateCtx(root, wt), config }, state);
      assert.equal(result.decision, "failed");
      assert.match(
        result.detail ?? "",
        /the commit is kept; the next attempt reviews it from scratch/,
      );
      assert.doesNotMatch(result.detail ?? "", /continues this review/);
      assert.equal(state.reviewResume, undefined);
      assert.equal(await aheadOfMain(wt, "main"), 1); // commit still kept for the next tick
  });
});

test("a progressing timeout leaves a resume marker and the next review continues its session", async () => {
  const { root, wt, head } = await gateFixture();
  const flags = path.join(tmpdir(), "review-resume-flags");
  const calls: Array<{ sessionDir: string; continueSession?: boolean; prompt: string }> = [];
  // The first run (no --continue) keeps making progress and is killed by the extended
  // progressing timeout; the second run (--continue) approves, proving the timed-out
  // session was continued.
  await withPi(
    [
      TOUCH_SESSION,
      logFlagsTo(flags),
      `for a in "$@"; do if [ "$a" = "--continue" ]; then`,
      `  printf '%s\\n' '${assistantLine("VERDICT: approve\\n1. resumed and finished")}'`,
      `  exit 0`,
      `fi; done`,
      `printf '%s\\n' '${assistantLine("reading the diff…")}'`,
      `while true; do sleep 0.05; echo '${assistantLine("still reading")}'; done`,
    ].join("\n"),
    async () => {
      const config = defaultConfig();
      config.review.timeoutSeconds = 1;
      const state = freshLoopState(ROLE);
      const firstCtx = gateCtx(root, wt, 1);
      const first = await reviewAheadOfMain({ ...firstCtx, config }, state);
      assert.equal(first.decision, "failed");
      assert.match(first.detail ?? "", /the next attempt continues this review/);
      assert.equal(state.reviewResume?.patchId, await patchId(wt, "main", head));
      assert.equal(state.reviewResume?.sessionDir, firstCtx.sessionDir);
      assert.equal(state.reviewResume?.attempts, 0);

      const second = await reviewAheadOfMain(
        {
          ...gateCtx(root, wt, 2),
          config,
          runGatePi: async (opts) => {
            calls.push({ sessionDir: opts.sessionDir, continueSession: opts.continueSession, prompt: opts.prompt });
            return firstCtx.runGatePi(opts);
          },
        },
        state,
      );
      assert.equal(second.decision, "approved");
      assert.equal(state.reviewResume, undefined);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.continueSession, true);
      assert.equal(calls[0]!.sessionDir, firstCtx.sessionDir);
      assert.ok(!calls[0]!.prompt.includes("<diff>"), "the resume prompt carries no diff");
      assert.match(calls[0]!.prompt, /resuming an adversarial review/);
      const starts = eventsOfType(root, "review_start");
      assert.equal(starts[0]?.resumed, undefined);
      assert.equal(starts[1]?.resumed, true);
      const lines = fs.readFileSync(flags, "utf8").trim().split("\n");
      assert.equal(lines.length, 2);
      assert.match(lines[0]!, /^run: -n/);
      assert.match(lines[1]!, /^run: --continue$/);
    },
  );
});

test("a resumed review's verdict follow-up continues the resumed session's directory", async () => {
  // The review run resumed another attempt's directory; its verdict-recovery turn must
  // `--continue` that same directory, not this tick's fresh ctx.sessionDir. Otherwise the
  // follow-up would reach a directory that never held this review and lose its context.
  const { root, wt, head } = await gateFixture();
  const resumeDir = reviewRunSessionDir(root, ROLE, "resumed-run");
  fs.mkdirSync(resumeDir, { recursive: true });
  fs.writeFileSync(path.join(resumeDir, "s.jsonl"), "");
  const counter = path.join(tmpdir(), "resume-followup-count");
  fs.writeFileSync(counter, "0");
  const calls: Array<{ sessionDir: string; continueSession?: boolean }> = [];
  // First --continue (the resumed review) replies without a VERDICT; the second (the
  // recovery turn) supplies it, so the test observes both runs' directories.
  await withPi(
    [
      TOUCH_SESSION,
      `n=$(cat ${counter}); n=$((n+1)); printf '%s' "$n" > ${counter}`,
      `if [ "$n" = "1" ]; then printf '%s\\n' '${assistantLine("no verdict on the resume yet")}'; exit 0; fi`,
      `printf '%s\\n' '${assistantLine("VERDICT: approve\\n1. recovered")}'`,
    ].join("\n"),
    async () => {
      const state = freshLoopState(ROLE);
      state.reviewResume = {
        patchId: (await patchId(wt, "main", head)) ?? "",
        sessionDir: resumeDir,
        attempts: 0,
        at: 1,
      };
      const ctx = gateCtx(root, wt, 1);
      const result = await reviewAheadOfMain(
        {
          ...ctx,
          runGatePi: async (opts) => {
            calls.push({ sessionDir: opts.sessionDir, continueSession: opts.continueSession });
            return ctx.runGatePi(opts);
          },
        },
        state,
      );
      assert.equal(result.decision, "approved");
      assert.equal(calls.length, 2);
      assert.equal(calls[0]!.continueSession, true);
      assert.equal(calls[0]!.sessionDir, resumeDir);
      assert.equal(calls[1]!.continueSession, true);
      assert.equal(calls[1]!.sessionDir, resumeDir, "the follow-up continues the resumed dir, not the fresh tick dir");
    },
  );
});

test("a resume marker for a different patch reviews fresh and clears", async () => {
  const { root, wt } = await gateFixture();
  const calls: Array<{ continueSession?: boolean; prompt: string }> = [];
  await withPi(`printf '%s\\n' '${assistantLine("VERDICT: approve")}'`, async () => {
      const state = freshLoopState(ROLE);
      const staleDir = reviewRunSessionDir(root, ROLE, "old-run");
      fs.mkdirSync(staleDir, { recursive: true });
      fs.writeFileSync(path.join(staleDir, "s.jsonl"), "");
      state.reviewResume = { patchId: "a-different-patch", sessionDir: staleDir, attempts: 0, at: 1 };
      const result = await reviewAheadOfMain(
        {
          ...gateCtx(root, wt, 1),
          runGatePi: async (opts) => {
            calls.push({ continueSession: opts.continueSession, prompt: opts.prompt });
            return gateCtx(root, wt).runGatePi(opts);
          },
        },
        state,
      );
      assert.equal(result.decision, "approved");
      assert.equal(state.reviewResume, undefined);
      assert.equal(calls.length, 1);
      assert.ok(!calls[0]!.continueSession, "a changed patch never resumes the old session");
      assert.ok(calls[0]!.prompt.includes("<diff>"), "the full diff prompt is used");
  });
});

test("after REVIEW_RESUME_LIMIT resumes the next review starts from scratch", async () => {
  const { root, wt, head } = await gateFixture();
  const calls: Array<{ continueSession?: boolean; prompt: string }> = [];
  await withPi(`printf '%s\\n' '${assistantLine("VERDICT: approve")}'`, async () => {
      const state = freshLoopState(ROLE);
      const spentDir = reviewRunSessionDir(root, ROLE, "spent-run");
      fs.mkdirSync(spentDir, { recursive: true });
      fs.writeFileSync(path.join(spentDir, "s.jsonl"), "");
      state.reviewResume = {
        patchId: (await patchId(wt, "main", head)) ?? "",
        sessionDir: spentDir,
        attempts: REVIEW_RESUME_LIMIT,
        at: 1,
      };
      const result = await reviewAheadOfMain(
        {
          ...gateCtx(root, wt, 1),
          runGatePi: async (opts) => {
            calls.push({ continueSession: opts.continueSession, prompt: opts.prompt });
            return gateCtx(root, wt).runGatePi(opts);
          },
        },
        state,
      );
      assert.equal(result.decision, "approved");
      assert.equal(state.reviewResume, undefined);
      assert.equal(calls.length, 1);
      assert.ok(!calls[0]!.continueSession, "no --continue once the budget is spent");
      assert.ok(calls[0]!.prompt.includes("<diff>"), "the full diff prompt is used");
  });
});

test("a stalled tool call during review warns in the event feed while the watchdog counts down", async (t) => {
  // The reviewer hangs on an interactive tool call; the gate must surface the stall in the
  // feed — the same guarantee as the author-side warning (test/runner-2.test.ts) — rather than
  // stay silent until the quiet watchdog kills the run minutes later.
  const { root, wt } = await gateFixture();
  await withPi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 999" } })}'`,
      `exec sleep 60`, // exec so the kill signal reaches the sleeper directly
    ].join("\n"),
    async () => {
      const config = defaultConfig();
      config.quietTimeoutSeconds = 5; // the watchdog still owns the kill...
      config.toolCallStallSeconds = 2; // ...but the warning lands first
      const state = freshLoopState(ROLE);
      // On logical time (watchdogClock, test/helpers/wait.ts): once the reviewer has named its
      // call,
      // move the watchdog past the stall threshold and then the quiet window.
      const clock = watchdogClock(t);
      const review = reviewAheadOfMain({ ...gateCtx(root, wt), config }, state);
      await waitForLogLines(piLogPath(root, ROLE), "tool_execution_start");
      clock.advance(30_000);
      const result = await review;
      assert.equal(result.decision, "failed");
      const warnings = warningMessages(root);
      assert.ok(
        warnings.some((m) => m.startsWith("tool call stalled: bash sleep 999")),
        `the review stall warning names the hung command; got: ${JSON.stringify(warnings)}`,
      );
  });
});

test("a stalled tool call during the verdict follow-up warns in the event feed too", async (t) => {
  // The verdict follow-up is a second pi run on the reviewer's own session, and it carries
  // the same stall watchdog wiring as the review run itself (requestVerdict's
  // onToolCallStalled): a hung recovery turn must surface in the feed the same way, not sit
  // silent until its quiet watchdog kills it. The first run replies verdict-less without
  // ever starting a tool call, so any stall warning below can only come from the follow-up.
  const { root, wt } = await gateFixture();
  await withPi(
    [
      TOUCH_SESSION, // the reviewer's session exists, so the follow-up has one to continue
      `for a in "$@"; do if [ "$a" = "--continue" ]; then`,
      `  printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 999" } })}'`,
      `  exec sleep 60`, // exec so the kill signal reaches the sleeper directly
      `  exit 0`,
      `fi; done`,
      `printf '%s\n' '${assistantLine("I think this is fine overall.")}'`,
    ].join("\n"),
    async () => {
      const config = defaultConfig();
      config.quietTimeoutSeconds = 5; // the watchdog still owns the kill...
      config.toolCallStallSeconds = 2; // ...but the warning lands first
      // On logical time (watchdogClock, test/helpers/wait.ts): once the follow-up has named its
      // call,
      // move the watchdog past the stall threshold and then the quiet window.
      const clock = watchdogClock(t);
      const review = reviewGate(root, wt, { config });
      await waitForLogLines(piLogPath(root, ROLE), "tool_execution_start");
      clock.advance(30_000);
      const { result } = await review;
      assert.equal(result.decision, "failed");
      assert.ok(result.followUpRun); // the warned run's spend still folds into the totals
      const warnings = warningMessages(root);
      assert.ok(
        warnings.some((m) => m.startsWith("tool call stalled: bash sleep 999")),
        `the follow-up stall warning names the hung command; got: ${JSON.stringify(warnings)}`,
      );
  });
});

test("an unwritable events feed cannot break the verdict follow-up's stall warning", async (t) => {
  // The same follow-up stall as the test above, with events.jsonl replaced by a directory.
  // The follow-up's onToolCallStalled warning (review-followup.ts) must be best-effort: a raw
  // append's EISDIR escapes the watchdog's setInterval callback and, unlike a rejected review
  // promise, is an uncaught exception out of clock.advance below. The first run replies
  // verdict-less without starting a tool call, so the stall can only come from the follow-up.
  const { root, wt } = await gateFixture();
  fs.mkdirSync(eventsLogPath(root), { recursive: true });
  await withPi(
    [
      TOUCH_SESSION, // the reviewer's session exists, so the follow-up has one to continue
      `for a in "$@"; do if [ "$a" = "--continue" ]; then`,
      `  printf '%s\\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 999" } })}'`,
      `  exec sleep 60`, // exec so the kill signal reaches the sleeper directly
      `  exit 0`,
      `fi; done`,
      `printf '%s\\n' '${assistantLine("I think this is fine overall.")}'`,
    ].join("\n"),
    async () => {
      const config = defaultConfig();
      config.quietTimeoutSeconds = 5; // the watchdog still owns the kill...
      config.toolCallStallSeconds = 2; // ...but the warning lands first
      const clock = watchdogClock(t);
      const review = reviewGate(root, wt, { config });
      await waitForLogLines(piLogPath(root, ROLE), "tool_execution_start");
      clock.advance(30_000); // the raw warning's EISDIR used to escape here
      const { result } = await review;
      assert.equal(result.decision, "failed");
      assert.ok(result.followUpRun); // the warned run's spend still folds into the totals
    },
  );
});

test("gate exempts a doc-only diff without running pi", async () => {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.mkdirSync(path.join(wt, "docs"), { recursive: true });
  fs.writeFileSync(path.join(wt, "docs", "notes.md"), "a doc\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "doc only");
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
      const { state, result } = await reviewGate(root, wt);
      assert.equal(result.decision, "exempt");
      assert.ok(!fs.existsSync(marker)); // no reviewer run at all
      assert.equal(state.lastApprovedHead, undefined);
  });
});

/** A deterministic gate rejection: commit `content` as `file` in a fresh repo, run the gate
 * under a pi shim that would create `piRanMarker()` if the reviewer ran, and assert the
 * rejection carried every `detailMatch` while pi never ran. The conflict-marker and
 * misfiled-plan tests share this shape because their rejections must be decided before any
 * reviewer run. */
async function assertRejectedWithoutReview(
  file: string,
  content: string,
  message: string,
  ...detailMatches: RegExp[]
): Promise<void> {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(path.join(wt, file), content);
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", message);
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    for (const detail of detailMatches) assert.match(result.detail!, detail);
    assert.ok(!fs.existsSync(marker), "deterministic rejection — no reviewer run at all");
  });
}

test("gate rejects a change that still holds conflict markers, with no pi run", async () => {
  // A change handed back to its author with the markers left in place (PLANS.md "Robust
  // conflict landing, part 2/2") reaches the gate if the author's stage fix-up turn did not
  // clear them. An md-only diff skips the reviewer by design, so only a deterministic check
  // can stop raw `<<<<<<<` lines from being merged to main.
  await assertRejectedWithoutReview(
    "notes.md",
    "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\nafter\n",
    "doc change with markers left in",
    /conflict markers remain in: notes\.md/,
  );
});

test("gate rejects conflict markers in a non-ASCII-named file (git C-quotes the diff path)", async () => {
  // `git diff --name-only` C-quotes non-ASCII paths by default; if aheadOfMainFiles hands the
  // gate that quoted text, hasConflictMarkers reads a path that does not exist and returns
  // false, so a marker-bearing non-ASCII file slips through the same way a plain-named one did.
  await assertRejectedWithoutReview(
    "héllo.md",
    "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\nafter\n",
    "non-ASCII doc change with markers left in",
    /conflict markers remain in: héllo\.md/,
  );
});

test("gate rejects an md-only diff that files a new plan directly under ## Done, with no pi run", async () => {
  // The 2026-09-25 shape (PLANS.md 9eaae5ac, plans part 4/4): a plan written straight into
  // the done section. The heading-set check cannot see it — one ## Done, heading set unchanged
  // — so the new-plan-under-Done rule is what rejects it, deterministically, before any
  // reviewer run.
  await assertRejectedWithoutReview(
    "PLANS.md",
    "## Planned\n\n## Done\n\n### Feature B (planned 2026-09-26)\n\n**Goal.** New work.\n",
    "misfiled plan",
    /PLANS\.md files "Feature B \(planned 2026-09-26\)"/,
    /file it under "## Planned"/,
  );
});

test("gate is a no-op when review.enabled is false", async () => {
  const { root, wt } = await gateFixture(); // code change — would be reviewed if enabled
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
      const config = defaultConfig();
      config.review.enabled = false;
      const { result } = await reviewGate(root, wt, { config });
      assert.equal(result.decision, "exempt");
      assert.ok(!fs.existsSync(marker));
  });
});

test("gate skips the run when this exact HEAD was already approved", async () => {
  const { root, wt, head } = await gateFixture();
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
      const state = freshLoopState(ROLE);
      state.lastApprovedHead = head; // e.g. a merge_blocked retry of the same commit
      const result = await reviewAheadOfMain(gateCtx(root, wt), state);
      assert.equal(result.decision, "approved");
      assert.ok(!fs.existsSync(marker)); // no second reviewer run for the same HEAD
  });
});

test("a review's session is named by its role and tick", async () => {
  const { root, wt } = await gateFixture();
  // The fake pi records its own argv (outside the worktree) so the test can assert on the
  // exact session name the harness chose for this run.
  const argsFile = path.join(tmpdir(), "pi-args");
  await withPi(
    `printf '%s\\n' "$@" > '${argsFile}'\n` +
      reviewerStub(),
    async () => {
      await reviewGate(root, wt); // tick 1 gate run
      const gateArgs = fs.readFileSync(argsFile, "utf8").split("\n");
      assert.ok(gateArgs.includes("tumwater-review-improve-1"), `gate session name missing in ${gateArgs}`);
  });
});

test("gate fails closed on an aborted run without bookkeeping", async () => {
  const { root, wt } = await gateFixture();
  await withPi(`sleep 5\n${reviewerStub()}`, async () => {
      const controller = new AbortController();
      controller.abort(); // harness shutdown already in progress
      const { state, result } = await reviewGate(root, wt, { signal: controller.signal });
      assert.equal(result.decision, "failed");
      assert.ok(result.aborted);
      assert.equal(await aheadOfMain(wt, "main"), 1); // commit stays; the resumed tick re-reviews it
      assert.equal(state.lastReview, undefined); // no bookkeeping on abort
      assert.equal(state.unreviewFailures, undefined);
  });
});

/** A repo whose main carries `base` files, plus the ROLE worktree with `edit` committed on top. */
async function protectedEditRepo(base: Record<string, string>, edit: Record<string, string>) {
  const root = makeRepo();
  for (const [f, c] of Object.entries(base)) fs.writeFileSync(path.join(root, f), c);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "base");
  const wt = await ensureWorktree(root, ROLE, "main");
  for (const [f, c] of Object.entries(edit)) fs.writeFileSync(path.join(wt, f), c);
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "edit");
  return { root, wt };
}

const PROMPT_README = (body: string) =>
  `# T\n\n<!-- tumwater:prompt:start -->\n${body}\n<!-- tumwater:prompt:end -->\n`;

test("gate rejects an md-only edit to the initial prompt block with no pi run", async () => {
  const { root, wt } = await protectedEditRepo(
    { "README.md": PROMPT_README("original") },
    { "README.md": PROMPT_README("rewritten") },
  );
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    assert.match(result.detail!, /README\.md changes the brief/);
    assert.ok(!fs.existsSync(marker), "deterministic rejection — no reviewer run at all");
  });
});

test("gate rejects an md-only PRINCIPLES.md edit except from the steward", async () => {
  const { root, wt } = await protectedEditRepo({ "PRINCIPLES.md": "# P\n" }, { "PRINCIPLES.md": "# P\n- new\n" });
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    assert.match(result.detail!, /PRINCIPLES\.md is edited by the improve role/);
    assert.ok(!fs.existsSync(marker));
    const steward = await reviewGate(root, wt, { role: "steward" });
    assert.equal(steward.result.decision, "exempt");
  });
});

test("gate rejects an md-only change that writes a secret env value, with no pi run", async () => {
  const value = "tw-secret-value-0123456789";
  const { root, wt } = await protectedEditRepo({ "NOTES.md": "# N\n" }, { "NOTES.md": `# N\n${value}\n` });
  const marker = piRanMarker();
  process.env.TUMWATER_TEST_FAKE_TOKEN = value;
  try {
    await withPi(`touch '${marker}'`, async () => {
      const { result } = await reviewGate(root, wt);
      assert.equal(result.decision, "rejected");
      assert.match(result.detail!, /`NOTES\.md` contains the value of \$TUMWATER_TEST_FAKE_TOKEN/);
      assert.ok(!result.detail!.includes(value));
      assert.ok(!fs.existsSync(marker), "deterministic rejection — no reviewer run at all");
    });
  } finally {
    delete process.env.TUMWATER_TEST_FAKE_TOKEN;
  }
});
