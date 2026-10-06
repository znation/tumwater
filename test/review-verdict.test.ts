import test from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "../src/review/review-verdict.js";

// The review gate's fail-closed rule (review-verdict.ts): a reply with no parseable verdict
// is a FAILED review, never an approval — a model that forgets the VERDICT line must not have
// its silence read as approval.

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
