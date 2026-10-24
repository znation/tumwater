import test from "node:test";
import assert from "node:assert/strict";
import {
  NOTHING_TO_DO,
  REFUSED_SENTINEL,
  extractCiResult,
  extractFiled,
  extractFlow,
  extractRefusal,
  fixLine,
  hasVerdictLine,
  isNegatedRefusal,
  isNothingToDo,
  labeledLine,
  verdictLines,
} from "../src/verdict/reply-contract.js";

test("isNothingToDo detects the sentinel", () => {
  assert.ok(isNothingToDo(`some reasoning\n${NOTHING_TO_DO}`));
  assert.ok(!isNothingToDo("all done\nSUMMARY: x"));
});

// The TUMWATER_REFUSED line blocks a PLANS.md/BUGS.md entry and routes a run to handleRefusal
// (plans/refusal-and-thrash.md), so its detection semantics are load-bearing: pi-stream.ts's
// boolean scan is deliberately loose (whole-reply includes), while the REASON extraction is
// anchored at line start so prose that merely mentions the sentinel cannot set it.

test("extractRefusal returns the trimmed reason from a line-start sentinel", () => {
  const text = `I will not force this plan.\n${REFUSED_SENTINEL}: it would delete user data\nSUMMARY: refused`;
  assert.equal(extractRefusal(text), "it would delete user data");
});

test("extractRefusal tolerates leading whitespace and extra spaces after the colon", () => {
  assert.equal(extractRefusal(`  ${REFUSED_SENTINEL}:    spaced out reason`), "spaced out reason");
});

test("extractRefusal returns null for a bare sentinel with no reason", () => {
  assert.equal(extractRefusal(REFUSED_SENTINEL), null);
  assert.equal(extractRefusal(`preamble\n${REFUSED_SENTINEL}:\n`), null, "colon but empty reason");
});

test("extractRefusal ignores mid-sentence mentions (line-start anchor)", () => {
  const text = `I considered ${REFUSED_SENTINEL}: no, that is not what I meant`;
  assert.equal(extractRefusal(text), null);
});

// isNegatedRefusal (BUGS.md 2026-09-23): four runs ended ordinary work-completed replies
// with `TUMWATER_REFUSED: none` — the prompt lists the line beside the reply-contract fields,
// so a compliant model fills it in — and the harness destroyed their tested work. A reason
// that negates the refusal is not a refusal.

test("isNegatedRefusal negates empty, none, and n/a in every recorded shape", () => {
  for (const reason of [undefined, null, "", "   ", "none", "NONE", "n/a", "N/A", "(none)", "(n/a)", "(none — no entry refused this run)", "none — bug filed normally"])
    assert.ok(isNegatedRefusal(reason), `negated: ${JSON.stringify(reason)}`);
});

// BUGS.md 2026-09-28: a sentence mark after the negation (`None.`) left isNegatedRefusal false,
// so a work-completed reply ending `TUMWATER_REFUSED: None.` was a "genuine" refusal whose
// finished, tested work the harness hard-reset — the same destruction the negation guard exists
// to prevent. Punctuation after the token is not an objection.
test("isNegatedRefusal negates none and n/a with trailing sentence punctuation", () => {
  for (const reason of ["None.", "NONE.", "none.", "N/A.", "n/a!", "(none).", "None!", "none;"])
    assert.ok(isNegatedRefusal(reason), `negated: ${JSON.stringify(reason)}`);
  assert.ok(!isNegatedRefusal("Nothing here was refused."), "a real reason with a period stays a refusal");
});

// BUGS.md 2026-09-28 (re-land): a markdown-decorated negation (`**none**`) left isNegatedRefusal
// false — emphasis and code spans are formatting wrapped around the token, not part of the
// reason, but the candidates compared the raw token — so a work-completed reply ending
// `TUMWATER_REFUSED: **none**` was a "genuine" refusal whose tested work the harness
// hard-reset, the same destruction the previous two fixes in this guard closed. Decoration can
// also sit inside the brackets around a dash-appended shape, so the strippings must compose.
test("isNegatedRefusal negates none and n/a under markdown decoration", () => {
  for (const reason of ["**none**", "*none*", "`none`", "**N/A**", "**None.**", "(**none**)", "**none** — nothing refused", "(`n/a`) — nothing refused", "(**None**) — nothing refused"])
    assert.ok(isNegatedRefusal(reason), `negated: ${JSON.stringify(reason)}`);
  assert.ok(!isNegatedRefusal("**it would delete user data**"), "a real reason under emphasis stays a refusal");
});

// BUGS.md 2026-09-28: a parenthesized explanation after the negation (`none (no entry refused
// this run)`) left isNegatedRefusal false — the dash-appended explanation was tolerated but its
// parenthesized dress was not, so a work-completed reply ending `TUMWATER_REFUSED: none (…)` was
// a "genuine" refusal whose tested work the harness hard-reset, the same destruction the
// previous fixes in this guard closed. The explanation is appended to the token, not part of it.
test("isNegatedRefusal negates none and n/a with a trailing parenthesized explanation", () => {
  for (const reason of ["none (no entry refused this run)", "None (nothing to do)", "n/a (nothing fits)", "N/A (no open bugs)", "none (nothing to do).", "none (see (a) above)", "none (a) (b)"])
    assert.ok(isNegatedRefusal(reason), `negated: ${JSON.stringify(reason)}`);
  assert.ok(!isNegatedRefusal("the tests still fail (see log)"), "a real reason with a trailing note stays a refusal");
  assert.ok(!isNegatedRefusal("none of the attempted fixes work (repro attached)"), "a reason beginning with the word none stays a refusal");
  assert.ok(!isNegatedRefusal("(no)ne"), "a bracket inside the token cannot collapse into a negation");
});

// BUGS.md 2026-09-28: a sentence mark *starting* an appended explanation (`None; nothing to
// refuse.`, `None. Nothing worth doing.`) left isNegatedRefusal false — the dash and
// parenthesized dresses were tolerated but the semicolon, colon, comma, and period separators
// were not, so a work-completed reply ending that way was a "genuine" refusal whose tested work
// the harness hard-reset, the same destruction the previous fixes in this guard closed. The
// rule generalized here: after the token, punctuation cannot begin a reason word — only a
// letter can. The ASCII hyphen stays in the separator class beside the en/em dashes (`none -
// …` was accepted before this change and must not regress), pinned here because a class edit
// that drops it is exactly the mistake a green suite cannot otherwise catch.
test("isNegatedRefusal negates none and n/a with a punctuation-separated explanation", () => {
  for (const reason of [
    "none - nothing to do",
    "n/a - no open bugs",
    "none — bug filed normally",
    "none; nothing to refuse",
    "None; nothing worth doing",
    "n/a; no open bugs",
    "none: nothing to do",
    "None, nothing refused",
    "none. Nothing worth doing.",
    "none! really nothing",
    "none? nothing at all",
  ])
    assert.ok(isNegatedRefusal(reason), `negated: ${JSON.stringify(reason)}`);
  assert.ok(!isNegatedRefusal("none of the attempted fixes work; repro attached"), "a word after the token starts the reason, punctuation or not");
});

// BUGS.md 2026-09-29: the one-character ellipsis (`…`) plays the two roles the ASCII sentence
// marks play — a trailing mark on the token (`None…`) and the opening mark of an appended
// explanation (`none… nothing to do`) — but neither bare()'s trailing-punctuation class nor the
// appended-note separator class recognized it, so a work-completed reply ending that way was a
// "genuine" refusal whose finished, tested work the harness hard-reset, the same destruction
// the previous fixes in this guard closed. The three-dot ASCII ellipsis (`...`) already
// stripped via its dots; only the single-character mark was missing.
test("isNegatedRefusal negates none and n/a under the one-character ellipsis", () => {
  for (const reason of ["None…", "n/a…", "none…", "none… nothing to do", "N/A… really nothing", "(none)…"])
    assert.ok(isNegatedRefusal(reason), `negated: ${JSON.stringify(reason)}`);
  assert.ok(!isNegatedRefusal("none of the attempted fixes work…"), "a word after the token starts the reason, ellipsis or not");
});

// BUGS.md 2026-09-28: a quoted negation (`"none"`, `none "nothing to do"`) left isNegatedRefusal
// false — straight quotes are decoration around the token or the opening mark of an appended
// note (punctuation, which cannot begin a reason word), but neither the wrapping strip beside
// the brackets nor the appended-note separator class recognized them, so a work-completed reply
// ending that way was a "genuine" refusal whose tested work the harness hard-reset, the same
// destruction the previous fixes in this guard closed.
test("isNegatedRefusal negates none and n/a under quoting", () => {
  for (const reason of [
    '"none"',
    "'n/a'",
    '"None."',
    '"(**none**)"',
    'none "nothing to do"',
    "n/a 'no open bugs'",
    'none "no entry refused this run".',
  ])
    assert.ok(isNegatedRefusal(reason), `negated: ${JSON.stringify(reason)}`);
  assert.ok(!isNegatedRefusal('"user data would be deleted"'), "a real reason under quotes stays a refusal");
  assert.ok(!isNegatedRefusal('none of the attempted fixes work "per the log"'), "a word after the token starts the reason, quoted or not");
});

// BUGS.md 2026-09-28: a typographic-quoted negation (`“none”`, `none “nothing to do”`) left
// isNegatedRefusal false — the four curly quotes play the same two roles the straight quotes
// play (decoration around the token, opening mark of an appended note), but neither the
// wrapping strip beside the brackets nor the appended-note separator class recognized them, so
// a work-completed reply ending that way was a "genuine" refusal whose tested work the harness
// hard-reset. Each quote is pinned in BOTH roles, and — because unbold's quote-stripping masks
// a bare wrapped token — in the combined shape `q none q…q` that ONLY the strip classes (both
// directions, both anchors) plus the appended-note class can satisfy: a model's quote direction
// is not reliable, so `”none ”nothing to do”` with a closing quote opening must negate too.
test("isNegatedRefusal negates none and n/a under typographic quoting", () => {
  for (const q of ["‘", "’", "“", "”"]) {
    for (const reason of [
      `${q}none${q}`, // wrapping role (decorated token)
      `${q}n/a${q}`, //
      `none ${q}nothing to do${q}`, // note-opener role (raw candidate)
      `${q}none ${q}nothing to do${q}`, // both roles at once — strip-sensitive shape
    ])
      assert.ok(isNegatedRefusal(reason), `negated: ${JSON.stringify(reason)}`);
  }
  assert.ok(isNegatedRefusal("”none ”nothing to do”"), "a closing quote opening the wrap still negates");
  assert.ok(isNegatedRefusal("“(**none**)”"), "quotes nest with markdown like brackets do");
  assert.ok(!isNegatedRefusal("“user data would be deleted”"), "a real reason under curly quotes stays a refusal");
  assert.ok(!isNegatedRefusal("none of the attempted fixes work “per the log”"), "a word after the token starts the reason, quoted or not");
});

// BUGS.md 2026-09-28: a whole-reason absence statement (`TUMWATER_REFUSED: nothing to do`,
// `nothing to refuse`, `nothing refused`, `no refusal`) left isNegatedRefusal false — the
// guard only knew `none`/`n/a` as the negating token, but a role that found no work reaches
// for these phrases too, and the same hard-reset destroyed its finished, tested work. The
// match stays anchored: the phrase followed by a word (`nothing to do with the review`) is a
// real reason and stays a refusal.
test("isNegatedRefusal negates a whole-reason absence statement", () => {
  for (const reason of [
    "nothing to do",
    "Nothing to do.",
    "NOTHING TO REFUSE",
    "nothing to refuse — checked the backlog",
    "nothing to do; the backlog is empty",
    "nothing refused",
    "Nothing refused — the record is clean.",
    "NO REFUSAL",
    "no refusal; the objection was satisfied upstream",
  ])
    assert.ok(isNegatedRefusal(reason), `negated: ${JSON.stringify(reason)}`);
  assert.ok(!isNegatedRefusal("nothing to do with the review"), "a word after the phrase starts the reason, so it stays a refusal");
  assert.ok(!isNegatedRefusal("no refusal of my own — the change stands"), "a word after the phrase starts the reason, so it stays a refusal");
  assert.ok(!isNegatedRefusal("nothing in the plan justifies this change"), "a real objection beginning with nothing stays a refusal");
});

test("isNegatedRefusal keeps a real reason a refusal", () => {
  for (const reason of [
    "it would delete user data",
    "conflicts with PRINCIPLES.md",
    "nonone of the above",
    "annotation, not refusal",
  ])
    assert.ok(!isNegatedRefusal(reason), `a refusal: ${JSON.stringify(reason)}`);
});

test("extractRefusal returns the first parseable line when several exist", () => {
  const text = `${REFUSED_SENTINEL}: first reason\n${REFUSED_SENTINEL}: second reason`;
  assert.equal(extractRefusal(text), "first reason");
});

// labeledLine is the shared parser every reply-field extraction goes through (SUMMARY/WHY/
// RISK/VERIFIED in commit-message.ts, the TUMWATER_REFUSED reason above). These tests pin its
// full contract directly — including the bare-label branch, which only surfaces when a label
// line carries no content of its own.

test("labeledLine returns the trimmed value of the first matching line", () => {
  assert.equal(labeledLine("SUMMARY: did a thing\nWHY: because", "SUMMARY"), "did a thing");
  assert.equal(labeledLine("  SUMMARY:   indented and padded  ", "SUMMARY"), "indented and padded");
});

test("labeledLine matches only whole labels at line start, not words containing them", () => {
  // A longer label sharing the prefix must not match — but a later real line still does.
  assert.equal(labeledLine("SUMMARYX: nope\nSUMMARY: real", "SUMMARY"), "real");
  assert.equal(labeledLine("MY_SUMMARY: nope", "SUMMARY"), null);
});

test("labeledLine returns the first match when several lines carry the label", () => {
  assert.equal(labeledLine("A: one\nA: two", "A"), "one");
});

test("labeledLine captures the following line when a label line carries no content", () => {
  // The value pattern is \\s*(.+)\\s*$ and \\s spans newlines, so a bare (or whitespace-only)
  // label line swallows the next line as its value. This leniency is what lets a model that
  // wraps after "TUMWATER_REFUSED:" still hand over its reason; pin it so tightening the regex
  // to stay on one line becomes a deliberate, test-visible change.
  assert.equal(labeledLine("preamble\nSUMMARY:\nthe real summary", "SUMMARY"), "the real summary");
  assert.equal(labeledLine("SUMMARY:   \nwrapped value", "SUMMARY"), "wrapped value");
});

test("labeledLine returns null when a bare label has no following content", () => {
  assert.equal(labeledLine("preamble\nSUMMARY:", "SUMMARY"), null);
  assert.equal(labeledLine("preamble\nSUMMARY:\n", "SUMMARY"), null);
  assert.equal(labeledLine("no labels here at all", "SUMMARY"), null);
});

test("labeledLine matches each label independently (a swallowed line is not consumed)", () => {
  // A bare WHY swallows the RISK line as its value, but the RISK label still matches on its
  // own — extracting one field never hides another.
  const text = "WHY: \nRISK: real risk";
  assert.equal(labeledLine(text, "WHY"), "RISK: real risk");
  assert.equal(labeledLine(text, "RISK"), "real risk");
});

// The verdict line is anchored at line start so prose that merely mentions "VERDICT:"
// mid-sentence cannot set the outcome — the prompt asks for exactly one, on its own line.

test("hasVerdictLine detects a VERDICT line at line start", () => {
  assert.ok(hasVerdictLine("VERDICT: approve"));
  assert.ok(hasVerdictLine("Some preamble.\nVERDICT: reject\n1. reason"));
  // Leading horizontal whitespace is tolerated like every other labeled field
  // (labeledLine): an indented final line must not fail the whole review.
  assert.ok(hasVerdictLine("Some preamble.\n    VERDICT: approve\n1. what I checked"));
  assert.ok(hasVerdictLine("\tVERDICT: reject"));
});

test("hasVerdictLine ignores mid-sentence mentions and unknown verdicts", () => {
  assert.ok(!hasVerdictLine('I would say "VERDICT: approve" but let me check first'));
  assert.ok(!hasVerdictLine("VERDICT: maybe"));
  assert.ok(!hasVerdictLine("looks good to me, merging"));
  // Only whitespace is tolerated before the label: a blockquote or list prefix quotes
  // the marker rather than declaring it, so it still cannot set the outcome.
  assert.ok(!hasVerdictLine("> VERDICT: approve"));
  assert.ok(!hasVerdictLine("- VERDICT: approve"));
});

test("verdictLines returns every verdict line in order with positions", () => {
  const text = "first\nVERDICT: approve\nthen\nVERDICT: reject";
  assert.deepEqual(verdictLines(text), [
    { index: 6, end: 22, verdict: "approve" },
    { index: 28, end: 43, verdict: "reject" },
  ]);
  // An indented verdict's index sits at the line start (indent included), so slicing
  // around it for reason extraction keeps the indent in the removed span.
  assert.deepEqual(verdictLines("preamble\n  VERDICT: approve"), [
    { index: 9, end: 27, verdict: "approve" },
  ]);
});

test("verdictLines is empty when no line matches", () => {
  assert.deepEqual(verdictLines("mentions VERDICT: approve inline"), []);
});

// The `qa` observer ends each run with a result-carrying FLOW line (plans/observer-roles.md
// 2/2); the harness parses it to rotate the flow menu. Anchored at line start through
// labeledLine, so a mid-sentence mention cannot advance the ledger, and the verdict is
// required: a bare name is not a pass the run never declared.

test("extractFlow parses a result-carrying FLOW line", () => {
  assert.deepEqual(extractFlow("ran the flow\nFLOW: status — passed"), { flow: "status", result: "passed" });
  assert.deepEqual(extractFlow("FLOW: prompt - bug"), { flow: "prompt", result: "bug" });
  assert.deepEqual(extractFlow("FLOW: run (real) — passed"), { flow: "run (real)", result: "passed" });
});

test("extractFlow requires the verdict and keeps hyphens in the name", () => {
  // A bare `FLOW: <name>` — or a reply truncated mid-verdict — is not a result (BUGS.md
  // 2026-09-23): returning null leaves the rotation unadvanced instead of latching a pass.
  assert.equal(extractFlow("FLOW: status"), null);
  assert.equal(extractFlow("FLOW: gui-budget-cap — pa"), null);
  assert.deepEqual(extractFlow("FLOW: reset-counters — passed"), {
    flow: "reset-counters",
    result: "passed",
  });
});

test("extractFlow returns null when absent, empty, or only mid-sentence", () => {
  assert.equal(extractFlow("no flow line here\nSUMMARY: did it"), null);
  assert.equal(extractFlow("FLOW:"), null);
  assert.equal(extractFlow("I considered FLOW: status but did not run it"), null);
});

test("extractCiResult parses a result-carrying CI line", () => {
  assert.deepEqual(extractCiResult("checked the suite\nCI: abc1234 — passed"), {
    sha: "abc1234",
    result: "passed",
  });
  assert.deepEqual(extractCiResult("CI: fa1cafe — failed"), { sha: "fa1cafe", result: "failed" });
  assert.deepEqual(extractCiResult("CI: abc1234 - passed"), { sha: "abc1234", result: "passed" });
});

test("extractCiResult requires the verdict and a hex sha", () => {
  // A bare `CI: <sha>` — or a reply truncated mid-verdict — is not a result: returning null
  // leaves the parity ledger unadvanced rather than latching a coverage the run never
  // declared (the same rule as qa's FLOW line). A non-hex id is not a sha.
  assert.equal(extractCiResult("CI: abc1234"), null, "bare sha records nothing");
  assert.equal(extractCiResult("CI: abc1234 — pa"), null, "truncated mid-verdict");
  assert.equal(extractCiResult("CI: nothex — passed"), null, "non-hex sha");
});

test("extractCiResult returns null when absent, empty, or only mid-sentence", () => {
  assert.equal(extractCiResult("no ci line here\nSUMMARY: did it"), null);
  assert.equal(extractCiResult("CI:"), null);
  assert.equal(extractCiResult("I ran the CI: abc1234 — passed check"), null, "mid-sentence mention is anchored out");
});

// The feedback observer ends each fulfilled filing run with a result-carrying FILED line
// (plans/feedback-role.md 2/2); the harness parses it to persist this install's per-run
// filing ledger. Anchored at line start through labeledLine, and the issue number plus a
// non-empty title are required: a truncated or malformed line records nothing, exactly like
// the FLOW verdict (BUGS.md 2026-09-23).

test("extractFiled parses a result-carrying FILED line", () => {
  assert.deepEqual(extractFiled("filed it\nFILED: #12 — title"), { issue: 12, title: "title" });
  assert.deepEqual(extractFiled("FILED: #3 - A hyphenated-title"), { issue: 3, title: "A hyphenated-title" });
});

test("extractFiled requires the number and a non-empty title", () => {
  // A bare or truncated `FILED:` line is not a filing the run declared (BUGS.md 2026-09-23).
  assert.equal(extractFiled("FILED: title"), null); // no number
  assert.equal(extractFiled("FILED: #12 — tit"), null); // truncated mid-title
  assert.equal(extractFiled("FILED:"), null);
});

test("extractFiled returns null when absent, empty, or only mid-sentence", () => {
  assert.equal(extractFiled("no filed line here\nSUMMARY: did it"), null);
  assert.equal(extractFiled("I considered FILED: #12 — retry but did not file"), null);
});

// The post-merge review's rejecting reply may pair its verdict with a FIX line (Forward never
// back 1a/6): `FIX: <comma-separated paths>` naming the files the reviewer edited in the review
// worktree. Anchored at line start; the paths are required, so a bare or truncated `FIX:` records
// nothing and the review stays a plain reject (the same fail-closed lesson as the FLOW verdict,
// BUGS.md 2026-09-23). A bare `FIX:` must not borrow the following line as its paths.

test("fixLine parses a comma-separated path list", () => {
  assert.deepEqual(fixLine("VERDICT: reject\n1. breaks it\nFIX: a.ts, b.ts"), ["a.ts", "b.ts"]);
  assert.deepEqual(fixLine("FIX: src/a.ts, src/b.ts"), ["src/a.ts", "src/b.ts"]);
});

test("fixLine records nothing for a bare or truncated line or a mid-sentence mention", () => {
  assert.equal(fixLine("FIX:"), null); // bare: no paths
  assert.equal(fixLine("FIX: "), null);
  assert.equal(fixLine("FIX: ,"), null); // commas but no path
  assert.equal(fixLine("FIX:  ,  "), null);
  assert.equal(fixLine("I considered FIX: a.ts but did not edit it"), null); // mid-sentence
  assert.equal(fixLine("no fix line here\nSUMMARY: did it"), null);
});

test("fixLine does not borrow the next line as paths (fail-closed on a bare FIX)", () => {
  // A reply truncated right after `FIX:` must not read the following line as comma-separated
  // paths — the opposite would be the fail-open parse the fail-closed contract forbids.
  assert.equal(fixLine("VERDICT: reject\n1. breaks it\nFIX:\nthe reply ends mid-list"), null);
  assert.equal(fixLine("FIX:\nnext line is reply prose"), null);
  // A path that ends cleanly on its own line is still parsed.
  assert.deepEqual(fixLine("VERDICT: reject\nFIX: a.ts\nmore prose"), ["a.ts"]);
});
