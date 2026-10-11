import test from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "../src/review/review-verdict.js";
import { buildRejectedReviewNote } from "../src/prompt/gate-prompts.js";

// The review gate's fail-closed rule (review-verdict.ts): a reply with no parseable verdict
// is a FAILED review, never an approval — a model that forgets the VERDICT line must not have
// its silence read as approval. This file holds the parser's unit cases, including the reply-shape
// and prior-objection-resolution cases moved here out of review.test.ts (2026-10-11), which
// now holds only the gate-orchestration tests; the cases that render a parsed rejection
// through buildRejectedReviewNote stay with the parser whose reasons they feed.

test("parseVerdict returns null when no verdict line exists", () => {
  assert.equal(parseVerdict("Looks good to me, ship it."), null);
  assert.equal(parseVerdict(""), null);
});

test("parseVerdict ignores a VERDICT mention that is not at line start", () => {
  assert.equal(parseVerdict("I would say VERDICT: reject but I approve."), null);
});

test("parseVerdict reads the verdict from the LAST verdict line", () => {
  const text = "VERDICT: approve\nchanged my mind\nVERDICT: reject\none bug";
  assert.deepEqual(parseVerdict(text), { verdict: "reject", reasons: ["one bug"] });
});

test("parseVerdict collects numbered and bulleted reasons after the verdict line", () => {
  const text = "VERDICT: reject\n1. first problem\n2) second problem\n- third problem\n* fourth";
  assert.deepEqual(parseVerdict(text)?.reasons, [
    "first problem",
    "second problem",
    "third problem",
    "fourth",
  ]);
});

test("parseVerdict strips the bold pair around a marker, keeping inner emphasis", () => {
  const text = [
    "VERDICT: reject",
    "**1.** dangling closer",
    "**2. open and close.** tail stays",
    "3. **kept** emphasis",
  ].join("\n");
  assert.deepEqual(parseVerdict(text)?.reasons, [
    "dangling closer",
    "open and close. tail stays",
    "**kept** emphasis",
  ]);
});

test("parseVerdict reads items inside markdown headings", () => {
  assert.deepEqual(parseVerdict("VERDICT: reject\n### 1. heading item")?.reasons, [
    "heading item",
  ]);
});

// The prose fallback must skip lead-ins and headings, so the first reason is the reply's
// first finding, not "Findings:" or "## Review" — and a region of nothing but those still
// yields them, since a lead-in beats recording no reason at all.

test("parseVerdict prose fallback skips headings and colon lead-ins", () => {
  const text = "VERDICT: reject\n## Review\nFindings:\nThe retry loop swallows errors.";
  assert.deepEqual(parseVerdict(text)?.reasons, ["The retry loop swallows errors."]);
});

test("parseVerdict falls back to preamble lines when the region has only those", () => {
  const text = "VERDICT: reject\n## Review\nFindings:";
  assert.deepEqual(parseVerdict(text)?.reasons, ["## Review", "Findings:"]);
});

// A verdict line is a marker, not a boundary: reasons may sit above the LAST verdict line,
// and a verdict line itself must never surface as a prose-fallback reason.

test("parseVerdict reads numbered reasons from above the verdict line", () => {
  const text = "1. found above\nVERDICT: reject";
  assert.deepEqual(parseVerdict(text)?.reasons, ["found above"]);
});

test("parseVerdict prose fallback excludes the verdict line itself", () => {
  const text = "Some note.\nVERDICT: approve";
  assert.deepEqual(parseVerdict(text), { verdict: "approve", reasons: ["Some note."] });
});

test("parseVerdict returns no reasons for a bare verdict line", () => {
  assert.deepEqual(parseVerdict("VERDICT: approve"), { verdict: "approve", reasons: [] });
  assert.deepEqual(parseVerdict("VERDICT: reject\n"), { verdict: "reject", reasons: [] });
});

// A chatty reviewer must not bloat persisted state: reasons cap at 10 and each clips to the
// shared per-line cap (clipReason, MAX_REASON_CHARS = 300).

test("parseVerdict caps recorded reasons at ten", () => {
  const text = `VERDICT: reject\n${Array.from(
    { length: 12 },
    (_, i) => `${i + 1}. reason ${i + 1}`,
  ).join("\n")}`;
  const reasons = parseVerdict(text)?.reasons ?? [];
  assert.equal(reasons.length, 10);
  assert.equal(reasons[9], "reason 10");
});

test("parseVerdict clips an over-long reason to the shared per-line cap", () => {
  const text = `VERDICT: reject\n- ${"x".repeat(400)}`;
  const reason = parseVerdict(text)?.reasons[0] ?? "";
  assert.ok(reason.length <= 300, `expected <= 300 chars, got ${reason.length}`);
  assert.ok(reason.endsWith("…"));
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

// A revision re-review is asked to check the prior objections FIRST, so a reviewer may open
// its numbered reasons with a statement that they are resolved. That is not an objection, yet
// every reasons[0] consumer would name it as the rejection and the author's note would tell
// the author to fix it (BUGS.md 2026-10-09).
test("a leading prior-objection resolution is not recorded as a rejection's first reason", () => {
  const v = parseVerdict(
    "VERDICT: reject\n" +
      "1. Prior objections 1–10 are all resolved — the ten cited lines are now ≤100 bytes, so none is an outstanding rejection on this change.\n" +
      "2. plans/portability.md:182 still cites the nonexistent dist/src/test-runner.js\n",
  );
  assert.equal(v?.verdict, "reject");
  assert.deepEqual(v?.reasons, ["plans/portability.md:182 still cites the nonexistent dist/src/test-runner.js"]);
  assert.equal(
    buildRejectedReviewNote({ reasons: v!.reasons }),
    "Your previous change was rejected in review:\n" +
      "1. plans/portability.md:182 still cites the nonexistent dist/src/test-runner.js\n" +
      "Address the objections or take a different approach.",
  );
});

// The filter drops only a resolution; a line that reports a prior objection still open is a
// real objection and must lead the list.
test("a prior objection reported unresolved is kept as the first reason", () => {
  const v = parseVerdict("VERDICT: reject\n1. Prior objection 3 is still unresolved — the helper drops errors.");
  assert.deepEqual(v?.reasons, ["Prior objection 3 is still unresolved — the helper drops errors."]);
  const notResolved = parseVerdict("VERDICT: reject\n1. Prior objection 2 is not resolved by this revision.");
  assert.deepEqual(notResolved?.reasons, ["Prior objection 2 is not resolved by this revision."]);
});

// A resolution phrase with an adverb between the negation and "resolved" is still an open
// objection; the filter must not read it as a resolution and delete it (review 2026-10-09).
test("an unresolved prior objection phrased with an intervening adverb is kept", () => {
  const v = parseVerdict("VERDICT: reject\n1. Prior objection 2 is not yet fully resolved — the helper drops errors.");
  assert.deepEqual(v?.reasons, ["Prior objection 2 is not yet fully resolved — the helper drops errors."]);
});

// A resolution phrase negated by "never" or "no longer … resolved" reports the objection still
// open; the filter must keep it rather than tell the author to fix nothing (latent-bug hunt
// 2026-10-09).
test("a prior objection negated with never or no-longer-resolved is kept", () => {
  const never = "Prior objections 1–3 were never resolved by this revision.";
  assert.deepEqual(parseVerdict(`VERDICT: reject\n1. ${never}`)?.reasons, [never]);
  const noLonger = "Prior objection 2 is no longer resolved by this revision.";
  assert.deepEqual(parseVerdict(`VERDICT: reject\n1. ${noLonger}`)?.reasons, [noLonger]);
});

// A single line that reports some prior objections resolved and another still open is not a
// resolution; dropping it whole would hide the open one the author must fix (review 2026-10-09).
test("a line mixing a resolution with an open objection is kept whole", () => {
  const contrast = "Prior objections 1 and 2 are resolved, but objection 3 requires a bounds check.";
  assert.deepEqual(parseVerdict(`VERDICT: reject\n1. ${contrast}`)?.reasons, [contrast]);
  const outstanding = "Prior objections 1 and 2 are resolved; objection 3 is outstanding.";
  assert.deepEqual(parseVerdict(`VERDICT: reject\n1. ${outstanding}`)?.reasons, [outstanding]);
});

// When the reasons below the VERDICT line are all resolutions, the filter leaves nothing;
// the objections may sit above the verdict line, so the whole-text region is tried next
// rather than returning an empty reason list (review 2026-10-09).
test("a rejection falls back past a resolution-only post-verdict region to the whole text", () => {
  const v = parseVerdict(
    "1. plans/portability.md:182 still cites the nonexistent dist/src/test-runner.js\n" +
      "VERDICT: reject\n" +
      "Prior objections 1–10 are all resolved — all ten cited lines are now ≤100 bytes.\n",
  );
  assert.equal(v?.verdict, "reject");
  assert.deepEqual(v?.reasons, ["plans/portability.md:182 still cites the nonexistent dist/src/test-runner.js"]);
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
    buildRejectedReviewNote({ reasons: v!.reasons }),
    "Your previous change was rejected in review:\n" +
      "1. The helper drops errors. `run` swallows the throw.\n2. No test covers it.\n" +
      "Address the objections or take a different approach.",
  );
});

// A reviewer anchors an objection by quoting the offending source. A block-comment
// continuation line (` * … */`), whether fenced or bare, must not be read as a finding bullet:
// reasonsFrom's numbered-first rule would then return the fragment and suppress the prose
// objection, so reasons[0] named the code instead of what to fix.

test("parseVerdict reads the prose objection, not a quoted block-comment fragment", () => {
  const fenced = [
    "VERDICT: reject",
    "",
    "The comment is stale:",
    "",
    "```",
    " * or write one key through screenOperableKey. */",
    "```",
    "",
    "Fix the comment.",
  ].join("\n");
  assert.deepEqual(parseVerdict(fenced)?.reasons, ["Fix the comment."]);

  const bare = [
    "VERDICT: reject",
    "",
    " * or write one key through screenOperableKey. */",
    "",
    "Fix the comment.",
  ].join("\n");
  assert.deepEqual(parseVerdict(bare)?.reasons, ["Fix the comment."]);
});

// Removal of quoted code is a subtraction, not a state that consumes what follows an
// unmatched opener: a reply that opens a fence (or a `/*`) and never closes it must still
// yield the prose objection below, not an empty reason list.

test("parseVerdict keeps the prose objection after an unmatched code opener", () => {
  const unclosedFence = ["VERDICT: reject", "```", "some code", "Fix the comment."].join("\n");
  assert.ok(
    parseVerdict(unclosedFence)?.reasons.includes("Fix the comment."),
    `expected the prose objection to survive, got ${JSON.stringify(parseVerdict(unclosedFence)?.reasons)}`,
  );

  const unclosedComment = ["VERDICT: reject", "/* note", "Fix the comment."].join("\n");
  assert.ok(
    parseVerdict(unclosedComment)?.reasons.includes("Fix the comment."),
    `expected the prose objection to survive, got ${JSON.stringify(parseVerdict(unclosedComment)?.reasons)}`,
  );
});

// A block-comment opener can follow code on its line. Its continuation lines must still be
// dropped, or the `* … */` line is read as the finding bullet and suppresses the prose.

test("parseVerdict drops continuation lines whose comment opener follows code", () => {
  const text = [
    "VERDICT: reject",
    "const x = 1; /* comment starts here",
    " * comment line one",
    " * comment line two */",
    "Fix it.",
  ].join("\n");
  const reasons = parseVerdict(text)?.reasons ?? [];
  assert.ok(
    reasons.includes("Fix it."),
    `expected the prose objection to survive, got ${JSON.stringify(reasons)}`,
  );
  assert.ok(
    !reasons.some((r) => r.includes("comment line one")),
    `expected the comment continuation to be dropped, got ${JSON.stringify(reasons)}`,
  );
});

// A reviewer quotes the offending code as a fenced block or a C/JSDoc block comment (the
// review prompt invites it). Those lines are context, not findings: a `*`-prefixed comment
// continuation must not match LIST_ITEM as a bullet and push the prose findings out of the
// prose fallback.

test("parseVerdict skips a fenced block-comment quote and keeps the prose finding", () => {
  const text = [
    "VERDICT: reject",
    "",
    "The comment is stale:",
    "",
    "```",
    " * or write one key through screenOperableKey. */",
    "```",
    "",
    "Fix the comment.",
  ].join("\n");
  assert.deepEqual(parseVerdict(text)?.reasons, ["Fix the comment."]);
});

test("parseVerdict does not read a bare quoted comment close line as a bullet", () => {
  const text = "VERDICT: reject\n\n * or write one key through screenOperableKey. */\n";
  assert.deepEqual(parseVerdict(text)?.reasons, []);
});

test("parseVerdict skips a quoted multi-line JSDoc comment and keeps the prose finding", () => {
  const text = [
    "VERDICT: reject",
    "The helper's comment is wrong:",
    "/**",
    " * or write one key through screenOperableKey. */",
    "Fix it.",
  ].join("\n");
  assert.deepEqual(parseVerdict(text)?.reasons, ["Fix it."]);
});

// The fence scan goes through backlog-md.ts's shared fenceTracker, so a backtick fence line
// whose info string itself contains a backtick is paragraph text that opens nothing — a local
// `^(```+|~~~+)` scan would swallow every finding after it as fenced content.

test("parseVerdict reads past a backtick fence info string the shared fenceTracker rejects", () => {
  const text = ["VERDICT: reject", "```md / ## Done / ```", "1. real finding"].join("\n");
  assert.deepEqual(parseVerdict(text)?.reasons, ["real finding"]);
});

// The comment-continuation guard must not drop a genuine bullet: only a `*`-led line closed
// by `*/` on the same line is quoted comment context; a bullet (or the advertised bold-numbered
// shape) whose text merely contains the terminator is a real finding.

test("parseVerdict keeps bullets whose text merely contains a comment terminator", () => {
  const text = [
    "VERDICT: reject",
    "* Fix the stale `*/` handling in the comment",
    "**1.** Remove the trailing `*/`",
  ].join("\n");
  assert.deepEqual(parseVerdict(text)?.reasons, [
    "Fix the stale `*/` handling in the comment",
    "Remove the trailing `*/`",
  ]);
});
