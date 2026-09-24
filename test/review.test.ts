import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseVerdict, reviewAheadOfMain, REVIEW_FAILURE_LIMIT } from "../src/review.js";
import { buildRejectedReviewNote } from "../src/gate-prompts.js";
import { clipBuildTail, runBuildCheck } from "../src/build-check.js";
import { detectBuildCheck } from "../src/build-check-detect.js";
import { aheadOfMain, headOf } from "../src/git.js";
import { ensureWorktree } from "../src/worktree.js";
import { defaultConfig } from "../src/config.js";
import { freshLoopState } from "../src/state.js";
import { readEvents } from "../src/events.js";
import { noteGreenBaseline } from "../src/main-baseline.js";
import { shortSha } from "../src/text.js";
import { assistantLine, buildCheckFixture, fakePi, makeRepo, sh, tmpdir } from "./util.js";

// Regression coverage for the 2026-08-27 build break (BUGS.md): src/review.ts shipped with a
// syntax error and latent type errors and had zero tests, so nothing caught it. The pure
// functions below pin parsing — importing review.js also fails `npm test` if this file ever
// stops compiling again (exemption matching moved to exemptions.test.ts with its module).
// The gate-orchestration section drives the real reviewAheadOfMain end-to-end against a git
// repo with a fake pi on PATH, covering every decision branch of the gate that guards each
// merge.

test("parseVerdict returns null when no VERDICT line exists (fail closed)", () => {
  assert.equal(parseVerdict(""), null);
  assert.equal(parseVerdict("looks good to me, merging"), null);
});

test("parseVerdict does not honor a mid-sentence mention of VERDICT:", () => {
  // The regex is anchored at line start: prose that merely quotes the format cannot set
  // the outcome.
  assert.equal(parseVerdict('I would say "VERDICT: approve" but let me check first'), null);
});

test("parseVerdict parses an approval with numbered reasons", () => {
  const v = parseVerdict("Some preamble.\nVERDICT: approve\n1. follows the principles\n2. tested offline");
  assert.deepEqual(v, { verdict: "approve", reasons: ["follows the principles", "tested offline"] });
});

test("parseVerdict parses a rejection with bulleted reasons", () => {
  const v = parseVerdict("VERDICT: reject\n- breaks the zero-dep rule\n* no regression test");
  assert.deepEqual(v, { verdict: "reject", reasons: ["breaks the zero-dep rule", "no regression test"] });
});

test("parseVerdict falls back to prose lines when no list items follow the verdict", () => {
  const v = parseVerdict("VERDICT: approve\nAll good.\nNo issues found.");
  assert.deepEqual(v, { verdict: "approve", reasons: ["All good.", "No issues found."] });
});

test("parseVerdict accepts a bare VERDICT line with no reasons (empty list, not null)", () => {
  // A minimal reviewer reply is still a parseable verdict — fail-closed applies only when
  // there is NO verdict line at all. The empty reasons list flows to the gate's "no reasons
  // given" detail fallback and the next tick's "(no reasons recorded)" note, so it must not
  // be null (a null here would count as a failed review and burn a strike).
  assert.deepEqual(parseVerdict("VERDICT: reject"), { verdict: "reject", reasons: [] });
  assert.deepEqual(parseVerdict("VERDICT: approve"), { verdict: "approve", reasons: [] });
});

test("parseVerdict reads numbered reasons written BEFORE a verdict-last reply's verdict", () => {
  // The most common reply shape a mid-sized model produces: reason through the diff, then
  // decide. A verdict line is a marker, not a boundary — the reply's findings are its
  // reasons, wherever they sit. Regression for the digest's "no reasons given" rows.
  const v = parseVerdict(
    "1. The helper drops errors.\n2. No test covers the new branch.\nVERDICT: reject",
  );
  assert.deepEqual(v, {
    verdict: "reject",
    reasons: ["The helper drops errors.", "No test covers the new branch."],
  });
});

test("parseVerdict reads prose reasons written before a verdict-last reply's verdict", () => {
  const v = parseVerdict(
    "The change repeats the swap logic twice.\nIt also needs a maxRetries guard.\nVERDICT: reject",
  );
  assert.deepEqual(v, {
    verdict: "reject",
    reasons: [
      "The change repeats the swap logic twice.",
      "It also needs a maxRetries guard.",
    ],
  });
});

test("parseVerdict prefers reasons after the verdict when both regions carry them", () => {
  const v = parseVerdict(
    "1. stale concern above the decision\nVERDICT: reject\n1. the real reason below",
  );
  assert.deepEqual(v, { verdict: "reject", reasons: ["the real reason below"] });
});

test("parseVerdict never records a verdict line itself as a prose reason", () => {
  // A reply with the verdict at the top and prose above it: the removed verdict line must
  // not surface as a fallback reason over the reply's actual prose.
  const v = parseVerdict("The diff is fine and small.\nVERDICT: approve\nShip it.");
  assert.deepEqual(v, { verdict: "approve", reasons: ["Ship it."] });
});

test("parseVerdict lets the LAST VERDICT line win", () => {
  const v = parseVerdict(
    "VERDICT: reject\n1. first pass had problems\nAfter re-reading:\nVERDICT: approve\n1. actually fine",
  );
  assert.deepEqual(v, { verdict: "approve", reasons: ["actually fine"] });
});

test("parseVerdict clips long reasons and caps the count at ten", () => {
  const long = "x".repeat(500);
  const v = parseVerdict(`VERDICT: reject\n1. ${long}`);
  assert.equal(v?.reasons.length, 1);
  assert.equal(v?.reasons[0]?.length, 300); // ellipsis included in the cap
  assert.match(v!.reasons[0]!, /^x{299}…$/);

  const many = Array.from({ length: 12 }, (_, i) => `${i + 1}. reason ${i + 1}`).join("\n");
  assert.equal(parseVerdict(`VERDICT: reject\n${many}`)?.reasons.length, 10);
});

// Reply shapes the fleet's reviewers really wrote (BUGS.md 2026-09-23: 11 approvals logged a
// preamble as their `review_verdict` reason). Reviewers number findings in bold or under
// headings and open with a colon-terminated lead-in or a bare heading; a bare-marker list
// match missed every such item, so the whole reply fell to the prose fallback and its first
// line — the preamble — became reasons[0], the field review_verdict logs, the feed renders,
// and the digest clusters rejections on. Each row: reasons[0] is the first real finding, and
// no reason keeps the list's own markup.
const REPLY_SHAPES: { shape: string; reply: string; reasons: string[] }[] = [
  {
    shape: "colon preamble, then bold-wrapped numbered leads (bugfix, 2026-09-23 23:46)",
    reply:
      "I checked the diff against the code, its callers, and its tests. Findings:\n\n" +
      "**1. Scope matches the claim.** The diff touches exactly the five things the summary enumerates.\n\n" +
      "**2. Both record paths really decline.** `extractFlow` has exactly one consumer.\n\n" +
      "VERDICT: approve",
    reasons: [
      "Scope matches the claim. The diff touches exactly the five things the summary enumerates.",
      "Both record paths really decline. `extractFlow` has exactly one consumer.",
    ],
  },
  {
    shape: "\"Here is what I verified:\" preamble (organize, 2026-09-23 20:48)",
    reply:
      "All checks complete. Here is what I verified:\n\n" +
      "**1. Scope — the diff is exactly what's claimed.** The merge diff is precisely the 5-file change.\n\n" +
      "**2. The extraction is verbatim.** I mechanically diffed the moved block.\n\n" +
      "VERDICT: approve",
    reasons: [
      "Scope — the diff is exactly what's claimed. The merge diff is precisely the 5-file change.",
      "The extraction is verbatim. I mechanically diffed the moved block.",
    ],
  },
  {
    shape: "bare heading, then bold numbered questions (clean, 2026-09-23 22:06)",
    reply:
      "## Review\n\n**1. Does the diff match the claims?** Yes. The diff is four files.\n\n" +
      "**2. VERIFIED claims hold.** Tests only match `/not initialized/`.\n\nVERDICT: approve",
    reasons: [
      "Does the diff match the claims? Yes. The diff is four files.",
      "VERIFIED claims hold. Tests only match `/not initialized/`.",
    ],
  },
  {
    shape: "bold lead alone on its line, its body on the next (organize, 2026-09-23 14:24)",
    reply:
      "I verified the change against the repo. Summary of what I checked:\n\n" +
      "**1. Diff matches the claim — no more, no less.**\n`git show --stat HEAD` confirms the 7 files.\n\n" +
      "**2. The move is verbatim, as the RISK claim states.**\nI diffed the block line-by-line.\n\n" +
      "VERDICT: approve",
    reasons: ["Diff matches the claim — no more, no less.", "The move is verbatim, as the RISK claim states."],
  },
  {
    shape: "bold number only (`**1.** X`)",
    reply: "All checks done. Summary of what I verified:\n**1.** The helper drops errors.\n**2.** No test covers it.\nVERDICT: reject",
    reasons: ["The helper drops errors.", "No test covers it."],
  },
  {
    shape: "bold number with a paren (`**1) X**`)",
    reply: "Findings:\n**1) The helper drops errors.**\n**2) No test covers it.**\nVERDICT: reject",
    reasons: ["The helper drops errors.", "No test covers it."],
  },
  {
    shape: "heading-wrapped numbering (`### 1. X`)",
    reply: "## Review\n### 1. Scope matches the claim\nNothing unclaimed.\n### 2) Tests pin the fix\nBoth ways.\nVERDICT: approve",
    reasons: ["Scope matches the claim", "Tests pin the fix"],
  },
  {
    shape: "plain numbering with a bold lead keeps the reviewer's own emphasis (`1. **X** body`)",
    reply: "Findings:\n1. **Scope matches.** Nothing unclaimed.\n2. **Tests pin it.**\nVERDICT: approve",
    reasons: ["**Scope matches.** Nothing unclaimed.", "**Tests pin it.**"],
  },
  {
    shape: "prose fallback skips a colon preamble",
    reply: "All checks complete. Here is what I verified:\nThe diff is exactly the claimed split.\nVERDICT: approve",
    reasons: ["The diff is exactly the claimed split."],
  },
  {
    shape: "prose fallback skips a bare heading and a bold lead-in",
    reply: "## Review\n**Summary:**\nThe move is byte-identical.\n**Diff matches the claim exactly.** Nothing unclaimed.\nVERDICT: approve",
    reasons: ["The move is byte-identical.", "**Diff matches the claim exactly.** Nothing unclaimed."],
  },
  {
    shape: "a reply of nothing but lead-ins still records them rather than no reason",
    reply: "## Review\nHere is what I verified:\nVERDICT: approve",
    reasons: ["## Review", "Here is what I verified:"],
  },
];

for (const { shape, reply, reasons } of REPLY_SHAPES) {
  test(`parseVerdict reads the first finding, not the preamble: ${shape}`, () => {
    assert.deepEqual(parseVerdict(reply)?.reasons, reasons);
  });
}

test("a bold-numbered rejection reaches the author's next-tick note numbered once, markup-free", () => {
  // The rejection path shares the list: before the fix the prose fallback kept every line
  // whole, so the note read "1. Findings:" then "2. **1. The helper drops errors.** …".
  const v = parseVerdict(
    "I checked the diff. Findings:\n\n**1. The helper drops errors.** `run` swallows the throw.\n\n" +
      "**2. No test covers it.**\n\nVERDICT: reject",
  );
  assert.equal(v?.verdict, "reject");
  assert.equal(
    buildRejectedReviewNote(v!.reasons),
    "Your previous change was rejected in review:\n" +
      "1. The helper drops errors. `run` swallows the throw.\n2. No test covers it.\n" +
      "Address the objections or take a different approach.",
  );
});

// ── Gate orchestration (reviewAheadOfMain) ────────────────────────────────────────────────
// Each fixture is a real git repo whose worktree sits one commit ahead of main, and the
// reviewer is a fake pi on PATH that prints a canned JSON verdict line. A marker file OUTSIDE
// the worktree records whether the reviewer ran at all (so "no run" branches are asserted,
// not merely assumed).

const ROLE = "improve";

/** Repo with a worktree one commit ahead of main — a code change, so NOT exempt. */
async function gateFixture(): Promise<{ root: string; wt: string; head: string }> {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change");
  return { root, wt, head: await headOf(wt, "HEAD") };
}

function gateCtx(root: string, wt: string, tick = 1) {
  return { root, role: ROLE, wt, mainBranch: "main", config: defaultConfig(), tick };
}

test("gate approves a good diff, records the HEAD, and discards the reviewer's stray edits", async () => {
  const { root, wt, head } = await gateFixture();
  const committed = fs.readFileSync(path.join(wt, "seed.txt"), "utf8");
  const restore = fakePi(
    `echo stray >> seed.txt\n` + // the reviewer's working-tree edit while reading around
      `printf '%s\n' '${assistantLine("VERDICT: approve\n1. solid change", { tokens: 17, output: 17, cost: 0.02 })}'`,
  );
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
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
  } finally {
    restore();
  }
});

test("gate rejects a bad diff: branch reset to main, reasons recorded", async () => {
  const { root, wt } = await gateFixture();
  const restore = fakePi(
    `printf '%s\n' '${assistantLine("VERDICT: reject\n1. breaks the build\n2. no regression test")}'`,
  );
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "rejected");
    assert.equal(result.detail, "breaks the build"); // first reason feeds lastSummary
    assert.equal(await aheadOfMain(wt, "main"), 0); // the commit is discarded
    assert.equal(state.lastReview?.verdict, "reject");
    assert.deepEqual(state.lastReview?.reasons, ["breaks the build", "no regression test"]);
    assert.equal(state.unreviewFailures, 0); // a parseable verdict is a successful review
    assert.equal(state.lastApprovedHead, undefined);
  } finally {
    restore();
  }
});

test("gate logs a bold-numbered approval's first finding as the review_verdict reason, not its preamble", async () => {
  // The event the 2026-09-23 log audit read (BUGS.md): a reviewer that opens with a lead-in
  // and numbers its findings `**1. X.** …` logged "…Findings:" as the approval's reason.
  const { root, wt } = await gateFixture();
  const reply =
    "I checked the diff against the code, its callers, and its tests. Findings:\n\n" +
    "**1. Scope matches the claim.** No unclaimed changes.\n\n**2. Tests pin it.** Both ways.\n\nVERDICT: approve";
  const restore = fakePi(`printf '%s\n' '${assistantLine(reply)}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "approved");
    const verdict = readEvents(root).find((e) => e.type === "review_verdict");
    assert.equal(verdict?.reason, "Scope matches the claim. No unclaimed changes.");
    assert.deepEqual(state.lastReview?.reasons, ["Scope matches the claim. No unclaimed changes.", "Tests pin it. Both ways."]);
  } finally {
    restore();
  }
});

test("gate handles a bare VERDICT: reject with no reasons: fallback detail, empty list recorded", async () => {
  // A reviewer that declines without stating why is still a parseable verdict (not a failed
  // review): the rejection lands exactly like any other, and the missing first reason degrades
  // to the "no reasons given" fallback instead of an undefined lastSummary.
  const { root, wt, head } = await gateFixture();
  const restore = fakePi(`printf '%s\n' '${assistantLine("VERDICT: reject")}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "rejected");
    assert.equal(result.detail, "no reasons given"); // fallback: no first reason to feed lastSummary
    assert.equal(await aheadOfMain(wt, "main"), 0); // the commit is discarded like any reject
    assert.equal(state.lastReview?.verdict, "reject");
    assert.deepEqual(state.lastReview?.reasons, []);
    assert.equal(state.lastReview?.head, head);
    assert.equal(state.unreviewFailures, 0); // a parseable verdict is a successful review
    const rejected = readEvents(root).filter((e) => e.type === "review_rejected");
    assert.equal(rejected.length, 1);
    assert.deepEqual(rejected[0]?.reasons, []); // the event's fallback renders "no reasons given"
  } finally {
    restore();
  }
});

test("gate fails closed on a verdict-less reply: commit kept for re-review", async () => {
  const { root, wt } = await gateFixture();
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(
    `touch '${marker}'\nprintf '%s\n' '${assistantLine("I think this is fine overall.")}'`,
  );
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.ok(fs.existsSync(marker)); // the reviewer did run
    assert.equal(result.decision, "failed");
    assert.match(result.detail ?? "", /no parseable VERDICT/);
    assert.equal(await aheadOfMain(wt, "main"), 1); // commit left for the next tick's re-review
    assert.equal(state.unreviewFailures, 1);
    assert.equal(state.lastReview?.verdict, "failed");
    assert.equal(state.lastApprovedHead, undefined);
  } finally {
    restore();
  }
});

test("gate discards the leftover after three failed reviews of one HEAD", async () => {
  const { root, wt } = await gateFixture();
  const restore = fakePi(`printf '%s\n' '${assistantLine("still no verdict here")}'`);
  try {
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
  } finally {
    restore();
  }
});

test("gate does not discard the commit when the reviewer run itself fails", async () => {
  // A dead reviewer backend: pi exits non-zero with no assistant output at all, so the run
  // FAILED (pi.ok false) rather than replying without a VERDICT. That says nothing about the
  // diff, so it must never count toward the discard limit — otherwise three infrastructure
  // failures delete a complete commit the reviewer never saw (BUGS.md 2026-09-20).
  const { root, wt } = await gateFixture();
  const restore = fakePi(`echo 'oMLX HTTP 400: prefill_memory_exceeded' >&2\nexit 1`);
  try {
    const state = freshLoopState(ROLE);
    for (let tick = 1; tick <= REVIEW_FAILURE_LIMIT + 2; tick++) {
      const result = await reviewAheadOfMain(gateCtx(root, wt, tick), state);
      assert.equal(result.decision, "failed");
      assert.equal(await aheadOfMain(wt, "main"), 1); // commit kept for re-review every time
      assert.equal(state.unreviewFailures ?? 0, 0); // a failed run is not a strike against the commit
    }
    const events = readEvents(root);
    assert.equal(events.filter((e) => e.type === "review_failed").length, REVIEW_FAILURE_LIMIT + 2);
    assert.ok(!events.some((e) => e.type === "warning" && /discarding unreviewed/.test(String(e.message))));
  } finally {
    restore();
  }
});

test("a reviewer that outruns review.timeoutSeconds fails in its own budget: commit kept, no strike", async () => {
  // A wedged reviewer must not hold the land queue for a whole authoring tick: its own budget
  // kills it long before tickTimeoutSeconds, and the kill is a failed RUN (like a dead backend),
  // so the pin stays and the per-HEAD discard counter does not move.
  const { root, wt, head } = await gateFixture();
  const restore = fakePi(`exec sleep 60`); // exec so the kill signal reaches the sleeper directly
  try {
    const config = defaultConfig();
    config.review.timeoutSeconds = 2;
    assert.ok(config.tickTimeoutSeconds > 60); // only the review budget can end this run in time
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
    const failed = readEvents(root).filter((e) => e.type === "review_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.head, head);
    assert.match(String(failed[0]?.message), /timed out after 2s/);
  } finally {
    restore();
  }
});

test("a stalled tool call during review warns in the event feed while the watchdog counts down", async () => {
  // The reviewer hangs on an interactive tool call; the gate must surface the stall in the
  // feed — the same guarantee as the author-side warning (test/loop-2.test.ts) — rather than
  // stay silent until the quiet watchdog kills the run minutes later.
  const { root, wt } = await gateFixture();
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 999" } })}'`,
      `exec sleep 60`, // exec so the kill signal reaches the sleeper directly
    ].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 5; // the watchdog still owns the kill...
    config.toolCallStallSeconds = 2; // ...but the warning lands first
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), config }, state);
    assert.equal(result.decision, "failed");
    const warnings = readEvents(root).filter((e) => e.type === "warning").map((e) => String(e.message));
    assert.ok(
      warnings.some((m) => m.startsWith("tool call stalled: bash sleep 999")),
      `the review stall warning names the hung command; got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    restore();
  }
});

test("gate exempts a doc-only diff without running pi", async () => {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.mkdirSync(path.join(wt, "docs"), { recursive: true });
  fs.writeFileSync(path.join(wt, "docs", "notes.md"), "a doc\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "doc only");
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "exempt");
    assert.ok(!fs.existsSync(marker)); // no reviewer run at all
    assert.equal(state.lastApprovedHead, undefined);
  } finally {
    restore();
  }
});

test("gate is a no-op when review.enabled is false", async () => {
  const { root, wt } = await gateFixture(); // code change — would be reviewed if enabled
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'`);
  try {
    const config = defaultConfig();
    config.review.enabled = false;
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), config }, state);
    assert.equal(result.decision, "exempt");
    assert.ok(!fs.existsSync(marker));
  } finally {
    restore();
  }
});

test("gate skips the run when this exact HEAD was already approved", async () => {
  const { root, wt, head } = await gateFixture();
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'`);
  try {
    const state = freshLoopState(ROLE);
    state.lastApprovedHead = head; // e.g. a merge_blocked retry of the same commit
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "approved");
    assert.ok(!fs.existsSync(marker)); // no second reviewer run for the same HEAD
  } finally {
    restore();
  }
});

test("recovery reviews get a -recovery session suffix so they never collide with the gate's session", async () => {
  const { root, wt } = await gateFixture();
  // The fake pi records its own argv (outside the worktree) so the test can assert on the
  // exact session name the harness chose for this run.
  const argsFile = path.join(tmpdir(), "pi-args");
  const restore = fakePi(
    `printf '%s\\n' "$@" > '${argsFile}'\n` +
      `printf '%s\n' '${assistantLine("VERDICT: approve")}'`,
  );
  try {
    await reviewAheadOfMain(gateCtx(root, wt), freshLoopState(ROLE)); // tick 1 gate run
    const gateArgs = fs.readFileSync(argsFile, "utf8").split("\n");
    assert.ok(gateArgs.includes("tumwater-review-improve-1"), `gate session name missing in ${gateArgs}`);

    await reviewAheadOfMain({ ...gateCtx(root, wt), sessionSuffix: "-recovery" }, freshLoopState(ROLE));
    const recoveryArgs = fs.readFileSync(argsFile, "utf8").split("\n");
    assert.ok(
      recoveryArgs.includes("tumwater-review-improve-1-recovery"),
      `recovery session name missing in ${recoveryArgs}`,
    ); // same tick number, distinct name — no pi session collision
  } finally {
    restore();
  }
});

test("gate fails closed on an aborted run without bookkeeping", async () => {
  const { root, wt } = await gateFixture();
  const restore = fakePi(`sleep 5\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const controller = new AbortController();
    controller.abort(); // harness shutdown already in progress
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), signal: controller.signal }, state);
    assert.equal(result.decision, "failed");
    assert.ok(result.aborted);
    assert.equal(await aheadOfMain(wt, "main"), 1); // commit stays; the resumed tick re-reviews it
    assert.equal(state.lastReview, undefined); // no bookkeeping on abort
    assert.equal(state.unreviewFailures, undefined);
  } finally {
    restore();
  }
});

// The gate's integration with the deterministic build pre-check (src/build-check.ts): a
// healthy build must reach the model reviewer. The check's own unit tests live in
// build-check.test.ts.
test("gate pre-check compiles the worktree against the root install — a healthy build reaches the reviewer", async () => {
  const root = makeRepo();
  // The install signature at the repo root (what detectBuildCheck walks up to from the
  // worktree), plus the worktree's own tracked package.json with no node_modules.
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --ok" } }),
  );
  const tool = path.join(binDir, "buildcheck-tool");
  fs.writeFileSync(tool, "#!/bin/sh\necho ok\n");
  fs.chmodSync(tool, 0o755);

  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --ok" } }),
  );
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change");

  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "approved"); // pre-fix: "rejected" by the build check
    assert.ok(fs.existsSync(marker)); // …with no reviewer run; now it reaches pi
    // Both halves of the gate price themselves in the feed: the deterministic pre-check as a
    // build_check event (scope gate), the reviewer run's wall time on its verdict event.
    const events = readEvents(root);
    const checks = events.filter((e) => e.type === "build_check");
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.scope, "gate");
    assert.equal(checks[0]!.status, "passed");
    assert.equal(checks[0]!.script, "build");
    assert.ok(Number(checks[0]!.durationMs) >= 0);
    const verdict = events.find((e) => e.type === "review_verdict");
    assert.ok(verdict && Number.isFinite(Number(verdict.durationMs)), "the approval carries the reviewer's duration");
  } finally {
    restore();
  }
});

// ── Build pre-check: detection edge cases, tail clipping, no-npm skip ───────────────

test("detectBuildCheck prefers test over typecheck and build when all three scripts are declared", () => {
  const base = tmpdir("buildcheck-");
  const dir = path.join(base, "proj");
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });

  // All three declared: test wins — npm convention makes `npm test` the canonical verify command.
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { build: "tsc", typecheck: "tsc --noEmit", test: "node --test" } }),
  );
  assert.deepEqual(detectBuildCheck(dir), { kind: "npm", rootDir: dir, script: "test" });

  // Without a test script the old preference stands: typecheck over build.
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { build: "tsc", typecheck: "tsc --noEmit" } }),
  );
  assert.deepEqual(detectBuildCheck(dir), { kind: "npm", rootDir: dir, script: "typecheck" });
});

test("detectBuildCheck returns the NEAREST qualifying ancestor when several qualify", () => {
  const base = tmpdir("buildcheck-");
  const outer = path.join(base, "outer");
  const inner = path.join(outer, "inner");
  for (const [dir, script] of [
    [outer, "echo outer"],
    [inner, "echo inner"],
  ] as const) {
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: script } }));
  }
  // Start from a worktree-shaped path below the inner root — inner is closer and must win.
  const start = path.join(inner, ".tumwater", "worktrees", ROLE);
  fs.mkdirSync(start, { recursive: true });
  assert.deepEqual(detectBuildCheck(start), { kind: "npm", rootDir: inner, script: "build" });
});

test("detectBuildCheck stops at the first qualifying ancestor even when it has no check script", () => {
  // The first directory with package.json + node_modules IS the project. An unrelated
  // install further up must never be used for its scripts — malformed JSON and a
  // script-less manifest are both dead ends, and detection never throws.
  const base = tmpdir("buildcheck-");
  const outer = path.join(base, "outer");
  fs.mkdirSync(path.join(outer, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(outer, "package.json"), JSON.stringify({ scripts: { build: "echo x" } }));

  const malformed = path.join(outer, "malformed");
  fs.mkdirSync(path.join(malformed, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(malformed, "package.json"), "{ not json");
  assert.equal(detectBuildCheck(malformed), null);

  const scriptless = path.join(outer, "scriptless");
  fs.mkdirSync(path.join(scriptless, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(scriptless, "package.json"), JSON.stringify({ name: "no-scripts-here" }));
  assert.equal(detectBuildCheck(scriptless), null);
});

test("detectBuildCheck gives up past maxLevels ancestors", () => {
  const base = tmpdir("buildcheck-");
  const root = path.join(base, "proj");
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "echo x" } }));
  // The start dir sits four levels below the install — beyond a cap of two.
  const start = path.join(root, "a", "b", "c", "d");
  fs.mkdirSync(start, { recursive: true });
  assert.equal(detectBuildCheck(start, undefined, 2), null);
  // …and the same walk with the default cap still finds it.
  assert.deepEqual(detectBuildCheck(start), { kind: "npm", rootDir: root, script: "build" });
});

test("clipBuildTail keeps the last ten non-empty lines", () => {
  const many = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
  assert.deepEqual(clipBuildTail(many), [
    "line 6",
    "line 7",
    "line 8",
    "line 9",
    "line 10",
    "line 11",
    "line 12",
    "line 13",
    "line 14",
    "line 15",
  ]);
});

test("clipBuildTail drops blank lines and npm's script banner, and clips long ones with an ellipsis", () => {
  const out = clipBuildTail(`> proj@1.0.0 build\n> tsc --noEmit\na\n${"x".repeat(400)}\n\nb\n`);
  assert.deepEqual(out, ["a", "x".repeat(299) + "…", "b"]);
});

test("clipBuildTail yields no lines for empty or whitespace-only output", () => {
  assert.deepEqual(clipBuildTail(""), []);
  assert.deepEqual(clipBuildTail("\n   \n\t\n"), []);
});

test("runBuildCheck skips (not fails closed) when npm is missing from PATH", async () => {
  const { root, wt } = buildCheckFixture();
  const oldPath = process.env.PATH;
  process.env.PATH = tmpdir("empty-path-"); // a directory with no executables
  try {
    const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.skipReason, "no-npm");
  } finally {
    process.env.PATH = oldPath;
  }
});

// ── Build pre-check: gate-level e2e (failing build, hanging build) ──────────────────

/** A repo whose root carries the install signature (package.json + node_modules) and a
 * worktree with a committed change; both manifests declare the same check script under
 * `scriptName` (default `build`). `toolBody`, when given, is installed as an executable at
 * the root's node_modules/.bin/buildcheck-tool — the dogfood layout where the worktree
 * resolves its toolchain from the installed root. */
async function gateBuildFixture(
  buildScript: string,
  toolBody?: string,
  scriptName = "build",
): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  if (toolBody) {
    const tool = path.join(root, "node_modules", ".bin", "buildcheck-tool");
    fs.writeFileSync(tool, toolBody);
    fs.chmodSync(tool, 0o755);
  }
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { [scriptName]: buildScript } }),
  );
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { [scriptName]: buildScript } }),
  );
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change");
  return { root, wt };
}

// A pre-check failure that survives its one re-run is attributed through main's own baseline
// verdict at its tip (main-red.ts's mainTipVerdict) — never handed to a model run. Main green:
// the change broke the check and is rejected deterministically. Main red: not the change's
// failure — the gate fails without a strike and the commit stays. No verdict: rejected, and the
// reasons say so. makeRepo's seed commit is byte-identical across tests run in the same second,
// and the baseline cache is keyed by SHA and process-wide, so a test that needs main red or
// unverdicted gives main a commit of its own (uniqueMain) instead of trusting whatever an
// earlier test cached for the shared seed SHA.

/** Seed main's baseline green at `root`'s tip — what every landing leaves behind for the SHA it
 * moved main to (noteGreenBaseline), so the gate's attribution is a cache hit, no run. */
function seedGreenMain(root: string): void {
  noteGreenBaseline(sh(root, "git", "rev-parse", "main"));
}

/** Give `root`'s main a commit no other test shares and return its sha: the baseline cache then
 * has no verdict for it, and the attribution check runs main's declared check for real. */
function uniqueMain(root: string): string {
  const file = `main-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  fs.writeFileSync(path.join(root, file), "main moved\n");
  sh(root, "git", "add", file);
  sh(root, "git", "commit", "-m", "main moves on its own");
  return sh(root, "git", "rev-parse", "main");
}

const buildCheckEvents = (root: string): string[] =>
  readEvents(root)
    .filter((e) => e.type === "build_check")
    .map((e) => `${e.scope}:${e.status}`);

test("gate pre-check rejects a failing build with zero reviewer runs", async () => {
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'src/bad.ts(3,5): error TS2345: Argument of type string is not assignable'\nexit 1\n",
  );
  seedGreenMain(root);

  // Any pi run at all touches the marker: none may start — not a fix run, not the reviewer.
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "rejected");
    assert.ok(!fs.existsSync(marker), "no pi run: the check and main's verdict decided alone");
    assert.equal(result.run, undefined, "the reviewer never ran");
    // The failure is re-run once before it is attributed, both runs priced as gate build_check
    // events; main's green verdict was a cache hit (the seeded landing), so no baseline run.
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed"]);
    assert.equal(await aheadOfMain(wt, "main"), 0); // branch reset to main
    assert.match(result.detail ?? "", /^build check failed \(\`npm run build\`\): /);
    assert.equal(state.lastReview?.verdict, "reject");
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /^build check failed \(\`npm run build\`\): src\/bad\.ts\(3,5\)/); // header + first output line
    assert.ok(!reasons.some((r) => r.includes("baseline")), "a green main needs no attribution note");
    assert.equal(state.unreviewFailures, 0); // a deterministic verdict resets strikes like a model reject
    const rejected = readEvents(root).find((e) => e.type === "review_rejected");
    assert.ok(rejected, "the rejection is logged for tumwater logs");
    assert.match(String(rejected?.reasons), /TS2345/); // the compiler tail rides on the event
  } finally {
    restore();
  }
});

test("a red pre-check on the declared test script rejects with zero pi runs", async () => {
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho '1 failing of 3 tests: assert.equal'\nexit 1\n",
    "test",
  );
  seedGreenMain(root);

  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "rejected");
    assert.ok(!fs.existsSync(marker), "no pi run before the reject");
    assert.equal(await aheadOfMain(wt, "main"), 0); // branch reset to main
    assert.match(result.detail ?? "", /^build check failed \(\`npm run test\`\): /);
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /^build check failed \(\`npm run test\`\): 1 failing/); // header names the script that ran
    assert.equal(state.unreviewFailures, 0); // a deterministic verdict resets strikes like a model reject
  } finally {
    restore();
  }
});

test("gate pre-check names the failing assertion, not the stack frame the tail opens on", async () => {
  // A suite that dies on an unhandled rejection leaves a tail whose window opens mid-stack; the
  // headline must be the assertion line the suite reported, and the real diff content must
  // survive — not be skipped as noise (BUGS.md 2026-09-19).
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    [
      "#!/bin/sh",
      "cat <<'BUILD_OUT'",
      "AssertionError [ERR_ASSERTION]: 1 == 2",
      "at TestContext.<anonymous> (file:///w/dist/test/x.test.js:3:35)",
      "at Test.runInAsyncScope (node:async_hooks:226:14)",
      "at Test.run (node:internal/test_runner/test:1397:25)",
      "at Test.start (node:internal/test_runner/test:1257:17)",
      "at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17)",
      "generatedMessage: true,",
      "code: 'ERR_ASSERTION',",
      "actual: 1,",
      "expected: 2,",
      "operator: '==',",
      "diff: 'simple'",
      "}",
      "BUILD_OUT",
      "exit 1",
      "",
    ].join("\n"),
    "test",
  );
  seedGreenMain(root);

  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "rejected");
    assert.ok(!fs.existsSync(marker), "no pi run before the reject");
    const reasons = state.lastReview?.reasons ?? [];
    assert.equal(reasons[0], "build check failed (`npm run test`): AssertionError [ERR_ASSERTION]: 1 == 2");
    assert.ok(reasons.some((r) => r.startsWith("at ")), "the rest of the clipped tail still follows");
    assert.ok(reasons.includes("actual: 1,"), "real diff content is not skipped as noise");
  } finally {
    restore();
  }
});

// A red MAIN must not reject every queued change for a failure none of their authors caused —
// the goal the in-slot build-fix run served, now met by attribution: the change keeps its commit
// (and the lander its pin), no strike is counted, and main-red.ts's gate and the bugfix handoff
// own the repair.
test("a pre-check that fails twice on a red main fails without a strike and keeps the commit", async () => {
  // The tool fails everywhere — on the change's tree AND on main's, which the attribution check
  // runs in its own worktree because this unique main SHA has no cached verdict.
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n",
  );
  const mainSha = uniqueMain(root);
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const state = freshLoopState(ROLE);
    state.unreviewFailures = 1; // an earlier reviewer strike against this head stays exactly as it was
    const head = await headOf(wt, "HEAD");
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "failed");
    assert.equal(result.detail, `main ${shortSha(mainSha)} is red — not this change's failure`);
    assert.equal(result.aborted, undefined);
    assert.equal(result.discarded, undefined, "not a discard: the pin must stay");
    assert.equal(result.mainRed, true, "the landing reports main_red, not a reviewer failure");
    assert.ok(!fs.existsSync(marker), "no pi run: nothing was spent on main's failure");
    assert.equal(state.unreviewFailures, 1, "no strike: nothing judged this diff");
    assert.equal(state.lastReview?.verdict, "failed", "no rejection recorded against the author");
    assert.equal(await headOf(wt, "HEAD"), head, "the commit stays for the next re-land");
    assert.equal(await aheadOfMain(wt, "main"), 1);
    const events = readEvents(root);
    assert.ok(!events.some((e) => e.type === "review_rejected"), "no rejection logged");
    // The change's check ran twice; main's once, in the attribution worktree, priced as a baseline run.
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "baseline:failed"]);
    const warnings = events.filter((e) => e.type === "warning").map((e) => String(e.message));
    assert.ok(
      warnings.some((m) => m.startsWith(`main ${shortSha(mainSha)} is red (build: error TS2345: boom)`)),
      `the fleet-wide red-main warning fires; got: ${JSON.stringify(warnings)}`,
    );
    assert.ok(
      warnings.includes(`gate check failed on ${shortSha(head)}, but main ${shortSha(mainSha)} is red — not this change's failure; landing kept`),
      `the role's warning names both heads; got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    restore();
  }
});

test("a pre-check that fails twice with no verdict for main rejects, saying the baseline was unavailable", async () => {
  // A configured command that fails fast on the change's tree (it carries change.txt) and hangs
  // on main's, past its own cap: main's run is a timeout skip, which yields no verdict.
  const root = makeRepo();
  uniqueMain(root);
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(path.join(wt, "change.txt"), "change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change");
  const ctx = {
    ...gateCtx(root, wt),
    config: {
      ...defaultConfig(),
      check: { command: "if [ -f change.txt ]; then echo 'boom'; exit 1; fi; sleep 5", timeoutSeconds: 0.5 },
    },
  };
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(ctx, state);
    assert.equal(result.decision, "rejected", "the author's failure is the safe default");
    assert.ok(!fs.existsSync(marker), "no pi run");
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /^build check failed \(`.*`\): boom$/);
    assert.equal(
      reasons.at(-1),
      "main's baseline was unavailable (its check was skipped (timeout)), so the failure is attributed to this change",
    );
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "baseline:skipped"]);
  } finally {
    restore();
  }
});

// BUGS.md 2026-09-23: the gate's failures were mostly load flakes. A failure that does not
// reproduce on one immediate re-run is a flake: the tree is verified like a first-time pass, the
// flake is named in a warning, and no pi run is spent before the reviewer.
test("a pre-check failure that passes its one re-run is a flake: no pi run before the reviewer, verified, warned", async () => {
  const flag = path.join(tmpdir(), "flaky-once");
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --flaky",
    `#!/bin/sh\nif [ -f '${flag}' ]; then exit 0; fi\ntouch '${flag}'\necho 'AssertionError [ERR_ASSERTION]: startup latency is not a hung tool call' >&2\nexit 1\n`,
  );
  const prompts = path.join(tmpdir(), "prompts.log");
  const restore = fakePi(
    `{ printf '%s\\n' "$@"; echo "===RUN==="; } >> "${prompts}"\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`,
  );
  try {
    const state = freshLoopState(ROLE);
    const head = await headOf(wt, "HEAD");
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "approved");
    assert.ok(result.run, "the reviewer ran, exactly as after a first-time pass");
    const runs = fs.readFileSync(prompts, "utf8").split("===RUN===").filter((b) => b.trim());
    assert.equal(runs.length, 1, "the reviewer is the only pi run");
    assert.equal(await aheadOfMain(wt, "main"), 1, "the author's commit alone");
    assert.equal(result.verifiedHead, head, "the re-run's green verdict verifies the tree");
    const events = readEvents(root);
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:passed"], "both attempts are priced");
    const flaky = events.filter((e) => e.type === "warning").map((e) => String(e.message));
    assert.deepEqual(flaky, [
      "gate check failed then passed on retry — flaky: AssertionError [ERR_ASSERTION]: startup latency is not a hung tool call",
    ]);
    // The reviewer is told the check passed, the same claim a first-time pass makes.
    assert.match(runs[0] ?? "", /`npm run build` \(the project's declared check\) passed/);
  } finally {
    restore();
  }
});

test("a configured check.command gates a merge in a repo with no npm install at all", async () => {
  // plans/portability.md §6/7: no package.json and no node_modules anywhere — today's walk-up
  // detection finds nothing and every gate silently turns off; a configured command must run
  // at the review gate instead, failing the diff deterministically with the command's tail.
  const root = makeRepo();
  seedGreenMain(root);
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change");
  const ctx = {
    ...gateCtx(root, wt),
    config: { ...defaultConfig(), check: { command: "echo 'pytest: 3 failing'; exit 1" } },
  };

  // Main is green (seeded), so the repeat failure is the change's: rejected with no pi run.
  const marker = path.join(tmpdir(), "pi-ran-command-check");
  const restore = fakePi(`touch '${marker}'\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(ctx, state);
    assert.equal(result.decision, "rejected", "the configured check's failure gates the merge");
    assert.equal(result.run, undefined, "the reviewer never ran: the check decided alone");
    assert.ok(!fs.existsSync(marker), "no pi run");
    assert.equal(state.lastReview?.verdict, "reject");
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /^build check failed \(\`echo 'pytest: 3 failing'; exit 1\`\): pytest: 3 failing$/);
    const rejected = readEvents(root).find((e) => e.type === "review_rejected");
    assert.ok(rejected, "the rejection is logged");
  } finally {
    restore();
  }

  // And a green configured check passes the gate: the run is priced with the command in the
  // build_check event's script field, exactly like an npm check's run. A fresh change — the
  // reject above reset the branch to main, and an empty diff is exempt, not approved.
  fs.appendFileSync(path.join(wt, "seed.txt"), "second change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change 2");
  const greenCtx = {
    ...gateCtx(root, wt),
    config: { ...defaultConfig(), check: { command: "true" } },
  };
  const restoreGreen = fakePi(`printf '%s\n' '${assistantLine("VERDICT: approve\n1. checked the diff", { tokens: 17, output: 17, cost: 0.02 })}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(greenCtx, state);
    assert.equal(result.decision, "approved");
    const events = readEvents(root);
    const check = events.filter((e) => e.type === "build_check" && e.scope === "gate").at(-1);
    assert.equal((check as { script?: string } | undefined)?.script, "true");
    assert.equal((check as { status?: string } | undefined)?.status, "passed");
  } finally {
    restoreGreen();
  }
});

test("a shutdown during a failing pre-check fails closed before main is consulted, keeping the commit", async () => {
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n",
  );
  uniqueMain(root);
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const controller = new AbortController();
    controller.abort(); // harness shutdown already in progress
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), signal: controller.signal }, state);
    assert.equal(result.decision, "failed");
    assert.ok(result.aborted);
    assert.ok(!fs.existsSync(marker), "no pi run");
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed"], "main's check never ran");
    assert.equal(await aheadOfMain(wt, "main"), 1); // the work commit stays; re-landed next tick
    assert.equal(state.lastReview, undefined); // no bookkeeping on abort
  } finally {
    restore();
  }
});

test("gate pre-check timeout warns and still proceeds to the model review", async () => {
  const { root, wt } = await gateBuildFixture("sleep 5"); // hangs past the shortened cap
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), buildCheckTimeoutMs: 400 }, state);
    assert.equal(result.decision, "approved"); // a timeout is environmental — not fail-closed
    assert.equal(result.verifiedHead, undefined); // no suite ran green — nothing to hand the landing path
    assert.ok(fs.existsSync(marker), "the reviewer still ran after the warning");
    const warning = readEvents(root).find((e) => e.type === "warning");
    assert.match(String(warning?.message), /build check timed out after 0\.4s; proceeding to model review/);
  } finally {
    restore();
  }
});

// The gate hands its green pre-check verdict to the landing path via GateResult.verifiedHead:
// src/merge.ts seeds the red-main baseline with the SHA that actually becomes main (the
// rebased head, which may differ from this one — merge.test.ts covers the seeding and the
// post-rebase re-verify). A skipped pre-check makes no fresh observation: verifiedHead stays
// absent even when the model approves (asserted in the timeout test above).
test("a green pre-check hands its verified head to the landing path", async () => {
  const { root, wt } = await gateBuildFixture("buildcheck-tool --ok", "#!/bin/sh\nexit 0\n");
  const restore = fakePi(`printf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "approved"); // pre-check passed AND the reviewer approved
    assert.equal(result.verifiedHead, await headOf(wt, "HEAD")); // exactly the tree the pre-check ran green on
  } finally {
    restore();
  }
});

// Land-queue speed 2a: a review judges a diff, not a sha. landChange rebases the pin onto main
// before its gate, so an approved change re-drained after main moved arrives at a new sha with
// the same patch — the approval is reused (no second reviewer run), the build pre-check is not.

/** Move main past the fixture's worktree with a commit to a file the change never touches,
 * then rebase the worktree onto it — the clean rebase landChange's syncPinToMain does. Returns
 * the rebased head. Only other.txt is staged: the root's package.json and node_modules are the
 * fixture's untracked install. */
async function moveMainAndRebase(root: string, wt: string): Promise<string> {
  fs.writeFileSync(path.join(root, "other.txt"), "someone else's change\n");
  sh(root, "git", "add", "other.txt");
  sh(root, "git", "commit", "-m", "main moves");
  sh(wt, "git", "rebase", "-q", "main");
  return headOf(wt, "HEAD");
}

test("an approved change cleanly rebased onto a moved main reuses its approval: no reviewer run, one check", async () => {
  const { root, wt } = await gateBuildFixture("buildcheck-tool --ok", "#!/bin/sh\nexit 0\n");
  const runs = path.join(tmpdir(), "pi-runs");
  const restore = fakePi(`echo run >> '${runs}'\nprintf '%s\n' '${assistantLine("VERDICT: approve\n1. solid")}'`);
  try {
    const state = freshLoopState(ROLE);
    const approvedHead = await headOf(wt, "HEAD");
    assert.equal((await reviewAheadOfMain(gateCtx(root, wt), state)).decision, "approved");
    assert.ok(state.lastApprovedPatchId, "the approval is keyed by its patch-id too");
    const checksBefore = readEvents(root).filter((e) => e.type === "build_check").length;

    const rebased = await moveMainAndRebase(root, wt);
    assert.notEqual(rebased, approvedHead, "the rebase rewrote the sha: the exact-sha short-circuit misses");
    const result = await reviewAheadOfMain(gateCtx(root, wt, 2), state);
    assert.equal(result.decision, "approved");
    assert.equal(result.run, undefined, "no reviewer run was spent");
    assert.equal(fs.readFileSync(runs, "utf8").trim().split("\n").length, 1, "one reviewer run across both gates");
    // The model review is reused; the check that the new tree still builds is not.
    const checks = readEvents(root).filter((e) => e.type === "build_check").slice(checksBefore);
    assert.deepEqual(checks.map((e) => `${e.scope}:${e.status}`), ["gate:passed"]);
    // The landing path trusts exactly this tree (its in-lock rebase is then a no-op), so the
    // pre-check is the only check the re-landing pays.
    assert.equal(result.verifiedHead, rebased);
    assert.equal(state.lastApprovedHead, rebased, "a retry of the rebased head is an exact-sha hit");
    assert.equal(
      readEvents(root).filter((e) => e.type === "review_start").length,
      1,
      "the reused approval never shows as reviewing",
    );
  } finally {
    restore();
  }
});

test("a rebase that changes the patch is re-reviewed", async () => {
  const { root, wt } = await gateBuildFixture("buildcheck-tool --ok", "#!/bin/sh\nexit 0\n");
  const runs = path.join(tmpdir(), "pi-runs");
  const restore = fakePi(`echo run >> '${runs}'\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const state = freshLoopState(ROLE);
    assert.equal((await reviewAheadOfMain(gateCtx(root, wt), state)).decision, "approved");
    const approvedPatch = state.lastApprovedPatchId;
    await moveMainAndRebase(root, wt);
    // What a conflict resolution does: the rebased commit carries a hunk the reviewer never saw.
    fs.appendFileSync(path.join(wt, "seed.txt"), "resolved differently\n");
    sh(wt, "git", "commit", "-a", "--amend", "--no-edit");
    const result = await reviewAheadOfMain(gateCtx(root, wt, 2), state);
    assert.equal(result.decision, "approved");
    assert.ok(result.run, "the changed patch got its own reviewer run");
    assert.equal(fs.readFileSync(runs, "utf8").trim().split("\n").length, 2);
    assert.notEqual(state.lastApprovedPatchId, approvedPatch, "the new approval names the new patch");
  } finally {
    restore();
  }
});

test("a reused approval still rejects a tree whose pre-check now fails", async () => {
  // The same patch, but main moved under it and the rebased tree no longer builds: the
  // approval covers the diff's review, never the check.
  const red = path.join(tmpdir(), "red");
  const { root, wt } = await gateBuildFixture(`test ! -f '${red}'`);
  const restore = fakePi(`printf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const state = freshLoopState(ROLE);
    assert.equal((await reviewAheadOfMain(gateCtx(root, wt), state)).decision, "approved");
    await moveMainAndRebase(root, wt);
    fs.writeFileSync(red, "");
    // Main's own verdict at its new tip is green (what its landing left behind), so the
    // repeat failure is the change's own and the gate rejects it.
    seedGreenMain(root);
    const result = await reviewAheadOfMain(gateCtx(root, wt, 2), state);
    assert.equal(result.decision, "rejected");
    assert.match(result.detail ?? "", /^build check failed/);
    assert.equal(await aheadOfMain(wt, "main"), 0, "branch reset to main");
  } finally {
    restore();
  }
});

// The reviewer's prompt names the harness's own green pre-check so the model reviewer does not
// spend its run re-running `npm test` — and stays silent about it when no check ran (no declared
// script, or a skipped run), so the reviewer is never told a suite passed that never executed.
test("a green pre-check is named in the reviewer's prompt; no check means no such claim", async () => {
  const { root, wt } = await gateBuildFixture("buildcheck-tool --ok", "#!/bin/sh\nexit 0\n", "test");
  const prompts = path.join(tmpdir(), "prompts.log");
  // The fake pi records its argv (the prompt is the last argument) before answering.
  const restore = fakePi(
    `{ printf '%s\n' "$@"; echo "===RUN==="; } >> "${prompts}"\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`,
  );
  try {
    const result = await reviewAheadOfMain(gateCtx(root, wt), freshLoopState(ROLE));
    assert.equal(result.decision, "approved");
    const run = fs.readFileSync(prompts, "utf8");
    assert.match(run, /The harness already ran the project's own check on this exact tree and it passed:/);
    assert.match(run, /`npm run test` \(the project's declared check\) passed/);
  } finally {
    restore();
  }

  // A worktree with no declared check script: the pre-check never runs, so the prompt must not
  // claim a passing suite.
  const bare = await gateFixture();
  const barePrompts = path.join(tmpdir(), "prompts.log");
  const restoreBare = fakePi(
    `{ printf '%s\n' "$@"; echo "===RUN==="; } >> "${barePrompts}"\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`,
  );
  try {
    const result = await reviewAheadOfMain(gateCtx(bare.root, bare.wt), freshLoopState(ROLE));
    assert.equal(result.decision, "approved");
    const run = fs.readFileSync(barePrompts, "utf8");
    assert.ok(!run.includes("The harness already ran"), "no pre-check claim when nothing ran");
  } finally {
    restoreBare();
  }
});

// The suite-rerun tripwire (BUGS.md 2026-09-23): a reviewer told the harness's pre-check passed
// that runs the full suite anyway — in a scratch copy under /tmp, like organize's and improve's
// reviews that day — is named in the event feed, while a filtered run (one test file) is not.
// After a timed-out pre-check no verified result exists: the prompt carries no no-re-run rule,
// and the same tool calls draw no warning.
test("a reviewer that re-runs the suite behind a green pre-check is warned about; after a timed-out pre-check it is not", async () => {
  const toolCalls = [
    { toolCallId: "c1", command: "cd /tmp/revrun && npm test 2>&1 | tail -15" },
    { toolCallId: "c2", command: "npm test gui 2>&1 | tail -5" },
  ]
    .flatMap(({ toolCallId, command }) => [
      { type: "tool_execution_start", toolCallId, toolName: "bash", args: { command } },
      { type: "tool_execution_end", toolCallId, result: {}, isError: false },
    ])
    .map((event) => `printf '%s\n' '${JSON.stringify(event)}'`)
    .join("\n");
  const reviewer = (prompts: string) =>
    fakePi(`printf '%s\n' "$@" >> "${prompts}"\n${toolCalls}\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  const rerunWarnings = (root: string) =>
    readEvents(root)
      .filter((e) => e.type === "warning")
      .map((e) => String(e.message))
      .filter((m) => m.startsWith("reviewer re-ran the suite"));

  const green = await gateBuildFixture("buildcheck-tool --ok", "#!/bin/sh\nexit 0\n", "test");
  const greenPrompts = path.join(tmpdir(), "prompts.log");
  const restore = reviewer(greenPrompts);
  try {
    const result = await reviewAheadOfMain(gateCtx(green.root, green.wt), freshLoopState(ROLE));
    assert.equal(result.decision, "approved", "the tripwire warns; it never changes the verdict");
    assert.match(fs.readFileSync(greenPrompts, "utf8"), /^- Do not re-run the check named above/m);
    assert.deepEqual(rerunWarnings(green.root), [
      "reviewer re-ran the suite the harness's pre-check already verified: cd /tmp/revrun && npm test 2>&1 | tail -15",
    ]);
  } finally {
    restore();
  }

  const timed = await gateBuildFixture("sleep 5"); // hangs past the shortened cap
  const timedPrompts = path.join(tmpdir(), "prompts.log");
  const restoreTimed = reviewer(timedPrompts);
  try {
    const result = await reviewAheadOfMain(
      { ...gateCtx(timed.root, timed.wt), buildCheckTimeoutMs: 400 },
      freshLoopState(ROLE),
    );
    assert.equal(result.decision, "approved");
    assert.equal(result.verifiedHead, undefined, "the pre-check timed out — no verified result");
    assert.ok(!fs.readFileSync(timedPrompts, "utf8").includes("Do not re-run"), "no verified result, no rule");
    assert.deepEqual(rerunWarnings(timed.root), [], "running the suite is the reviewer's job here");
  } finally {
    restoreTimed();
  }
});
