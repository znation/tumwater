import test from "node:test";
import assert from "node:assert/strict";
import { decimalSlipClause, parseNonNegativeInt, parsePositiveInt } from "../src/text/text.js";

// The clause half of the plain-decimal count rule (INV-AD4's parser, INV-AD6's naming). A refusal
// like `-n needs a positive integer (got "1,000")` names the value but not the slip, so the
// operator re-types the same shape. These tests hold the two properties that matter: every spelling
// the parsers accept gains NO clause (that is what catches a branch that fires too early), and each
// rejected shape names the one thing to fix. Written beside, not inside, test/text.test.ts so the
// parser's existing pins stay untouched.

/** The accepted spelling space, generated rather than listed: every count the parsers admit, so a
 * clause that fires on an accepted value fails here. Counts sweep single digits, multi-digit runs,
 * and the largest exactly-representable count. */
const ACCEPTED_COUNTS = [
  "1",
  "2",
  "9",
  "10",
  "42",
  "100",
  "1000",
  "65535",
  "2147483647",
  String(Number.MAX_SAFE_INTEGER),
];

test("decimalSlipClause names nothing for a count the parsers accept", () => {
  // The sweep is the load-bearing one: the clause does not re-run the parser, so an off-by-one or a
  // too-broad regex in a branch shows up as a clause on a value that parsed fine.
  let checked = 0;
  for (const raw of ACCEPTED_COUNTS) {
    checked += 1;
    assert.notEqual(parsePositiveInt(raw), null, `the parser must accept ${raw}`);
    assert.equal(decimalSlipClause(raw, "positive"), "", `positive ${raw}`);
    assert.equal(decimalSlipClause(raw, "non-negative"), "", `non-negative ${raw}`);
  }
  // "0" is accepted only as non-negative, so it must gain a clause for `positive` and none here.
  checked += 1;
  assert.equal(parseNonNegativeInt("0"), 0);
  assert.equal(decimalSlipClause("0", "non-negative"), "");
  assert.ok(checked >= ACCEPTED_COUNTS.length + 1);
});

test("decimalSlipClause names the shape of each rejected count", () => {
  // Each of these is a shape a real operator types; each clause says what to retype. The clause
  // never quotes the value — the standing ` (got "…")` suffix stays the only echo.
  const cases: Array<[string, string]> = [
    [" 5", " — it has leading or trailing whitespace"],
    ["5 ", " — it has leading or trailing whitespace"],
    ["1 2", " — the digits may not have a space between them"],
    ["1,000", " — the digits may not be grouped with , or ;"],
    ["1;000", " — the digits may not be grouped with , or ;"],
    ["+5", " — the count may not carry a + or - sign"],
    ["-5", " — the count may not carry a + or - sign"],
    ["0x10", " — the count must be decimal, not a 0x hexadecimal spelling"],
    ["0b101", " — the count must be decimal, not a 0x hexadecimal spelling"],
    ["1e3", " — scientific notation is not a count; write out the digits"],
    ["2.5", " — the count must be a whole number, not a decimal fraction"],
    [".5", " — the count must be a whole number, not a decimal fraction"],
    ["007", " — the count may not start with 0"],
    ["08", " — the count may not start with 0"],
    ["00", " — the count may not start with 0"],
    ["9".repeat(20), " — the count is past what tumwater can hold exactly (at most 9007199254740991)"],
  ];
  for (const [raw, clause] of cases) {
    assert.equal(parsePositiveInt(raw), null, `the parser must reject ${JSON.stringify(raw)}`);
    assert.equal(decimalSlipClause(raw, "positive"), clause, JSON.stringify(raw));
    assert.doesNotMatch(decimalSlipClause(raw, "positive"), new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("decimalSlipClause's zero clause follows the caller's kind", () => {
  // A `--in 0`-style non-negative surface has a legal 0; naming that slip for it would refuse a
  // value the parser accepts, so only `positive` may say it.
  assert.equal(decimalSlipClause("0", "positive"), " — the count must be at least 1");
  assert.equal(parsePositiveInt("0"), null);
  assert.equal(parseNonNegativeInt("0"), 0);
  assert.equal(decimalSlipClause("0", "non-negative"), "");
});

test("decimalSlipClause stays silent rather than guess", () => {
  // A value with no count shape at all, the empty value the `(got "")` suffix already shows, and a
  // dropped-flag token that merely starts with `-` are the three rejections a shape clause would
  // only obscure — the sentence before the clause already says as much as can be said.
  for (const raw of ["", "abc", "-", "--json", "-x"]) {
    assert.equal(decimalSlipClause(raw, "positive"), "", JSON.stringify(raw));
    assert.equal(decimalSlipClause(raw, "non-negative"), "", JSON.stringify(raw));
  }
});

test("decimalSlipClause is always an appended clause, never a report of its own", () => {
  // The clause's contract with its callers: it opens with the spaced em dash the duration clause
  // uses, carries no leading or trailing space of its own beyond that, and never starts a sentence
  // that would read oddly after the standing refusal.
  const samples = [" 5", "1,000", "+5", "0x10", "1e3", "2.5", "0", "007", "9".repeat(20), "abc", ""];
  for (const raw of samples) {
    for (const kind of ["positive", "non-negative"] as const) {
      const clause = decimalSlipClause(raw, kind);
      if (clause === "") continue;
      assert.ok(clause.startsWith(" — "), `clause for ${raw}: ${JSON.stringify(clause)}`);
      assert.ok(clause.length > 3 && !clause.endsWith(" "), `clause for ${raw}: ${JSON.stringify(clause)}`);
    }
  }
});
