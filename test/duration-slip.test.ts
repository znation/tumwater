import test from "node:test";
import assert from "node:assert/strict";
import { durationSlipClause, parseDurationMs } from "../src/text/duration.js";

// src/text/duration.ts's parseDurationMs answers every malformed spelling with the same null, so
// both refusals of it (the CLI's --since/--until/--for/--in/--at family and the dashboard's
// prompt `defer` field) used to print one message for every slip: a value typed as `2hours`, as
// `1h 30m`, or as a bare `45` all came back as "needs a duration like 45s, 90m, 1h30m, or 2d
// (got …)". `durationSlipClause` names WHICH slip it is. These tests pin the clause for each slip
// the grammar can hit, in the order a value can match two of them, and pin the two shape rules
// the clause exists to keep: it is always an appended clause (a leading-space em dash, one line,
// never quoting the value — gotSuffix already does that), and it is empty for a value the grammar
// accepts, so a caller can append it unconditionally.

/** The clause for `value`, asserted verbatim; the input is echoed on mismatch so a failing case
 * names the spelling it was asked about. */
function assertClause(value: string, expected: string): void {
  assert.equal(durationSlipClause(value), expected, JSON.stringify(value));
}

test("durationSlipClause answers empty for every spelling the grammar accepts", () => {
  // The contract the two call sites lean on without checking: they ask only after the parse
  // refused, so the clause must stay silent for anything the grammar takes. Generated rather
  // than listed — single units, every descending composite of two, three and four units over
  // counts 1..12, i.e. the whole space where a branch could mis-fire on a valid value. Every
  // spelling is asserted to parse AND to gain no clause, so a branch with an off-by-one (an
  // ordering check that rejects `1h30m`, a repeat check that fires on one `h`) is caught here.
  const units = ["d", "h", "m", "s"];
  const counts = ["1", "2", "9", "12"];
  let checked = 0;
  for (let mask = 1; mask < 1 << units.length; mask += 1) {
    const chosen = units.filter((_, i) => (mask >> i) & 1);
    for (let pick = 0; pick < counts.length ** chosen.length; pick += 1) {
      const digits = chosen.map((_, i) => counts[Math.floor(pick / counts.length ** i) % counts.length]);
      const value = chosen.map((u, i) => `${digits[i]}${u}`).join("");
      assert.notEqual(parseDurationMs(value), null, value);
      assertClause(value, "");
      checked += 1;
    }
  }
  assert.ok(checked >= 300, `only generated ${checked} spellings`);
});

test("durationSlipClause names a missing unit as the missing unit", () => {
  // The slip that reads as a duration to the eye: a count with no unit at all.
  assertClause("45", " — it has no unit; the units are d, h, m, and s");
  assertClause("90", " — it has no unit; the units are d, h, m, and s");
  // A count written as a fraction is the more specific slip, so it names that instead.
  assertClause("1.5", " — a component's count must be a whole number");
});

test("durationSlipClause names a spelled-out or wrong unit letter, quoting that run", () => {
  // `--for 2hours` is the natural-language slip the CLI used to refuse with the grammar alone;
  // the clause quotes the whole unit run, not one letter, so `2hours` names `hours`.
  assertClause("2hours", ' — the unit must be one of d, h, m, or s, not "hours"');
  assertClause("10secs", ' — the unit must be one of d, h, m, or s, not "secs"');
  assertClause("5x", ' — the unit must be one of d, h, m, or s, not "x"');
  assertClause("1h30minutes", ' — the unit must be one of d, h, m, or s, not "minutes"');
  // A unit run mixing a real letter with a wrong one names the whole run, which is what to fix.
  assertClause("1hour", ' — the unit must be one of d, h, m, or s, not "hour"');
  // Junk carrying no digit at all is named by its letter run, the only part worth naming.
  assertClause("abc", ' — the unit must be one of d, h, m, or s, not "abc"');
  // Text with neither a digit nor a unit letter says so plainly.
  assertClause("???", " — it needs a number and a unit; the units are d, h, m, and s");
  // The empty value gains nothing: the grammar line already says everything there is to say.
  assertClause("", "");
});

test("durationSlipClause separates surrounding whitespace from a gap between components", () => {
  // Padded at either end: what a quoted shell argument with a stray space produces.
  assertClause(" 45s", " — it has leading or trailing whitespace");
  assertClause("45s ", " — it has leading or trailing whitespace");
  // Components that touch in the grammar but were typed apart: a different fix, so a different
  // clause. The leading/trailing check runs first, so a value with both reports that one.
  assertClause("1h 30m", " — its components must touch, with no space between them");
  assertClause("1h30 m", " — its components must touch, with no space between them");
});

test("durationSlipClause names a negative, a fraction, a missing count, and a repeated unit", () => {
  assertClause("-1h", " — a duration may not be negative");
  assertClause("-45s", " — a duration may not be negative");
  assertClause("1.5h", " — a component's count must be a whole number");
  assertClause("0.5d", " — a component's count must be a whole number");
  assertClause("h30m", " — every unit needs a number before it");
  assertClause("30m30m", " — a unit may not repeat");
  assertClause("1h30m1h", " — a unit may not repeat");
});

test("durationSlipClause names the unit order a reversed composite broke", () => {
  assertClause("30m1h", " — units must descend d → h → m → s");
  assertClause("30s5m", " — units must descend d → h → m → s");
  assertClause("1m1d", " — units must descend d → h → m → s");
});

test("durationSlipClause names trailing junk after a unit as an unclosed number", () => {
  // The grammar matches `<n><unit>` components back to back; a bare digit run after a unit is
  // the shape `1h30` produces when the operator means `1h30m`.
  assertClause("1h30", " — every number needs the unit that follows it");
  assertClause("1s0", " — every number needs the unit that follows it");
  assertClause("1h30m7", " — every number needs the unit that follows it");
});

test("durationSlipClause names a zero or zero-padded count", () => {
  // The grammar refuses `0s`, `0h30m` and `007s` with no hint in the message; the clause says why,
  // which is the one rule an operator cannot infer from the four examples.
  assertClause("0s", " — a component's count may not be 0 or start with 0");
  assertClause("007s", " — a component's count may not be 0 or start with 0");
  assertClause("0h30m", " — a component's count may not be 0 or start with 0");
});

test("durationSlipClause answers empty when no named slip fits the value", () => {
  // A value with a unit, an ordering, a count and no whitespace is refused for a reason the
  // grammar line covers; the clause stays out of the way rather than guessing.
  assertClause("1hs", "");
});

test("durationSlipClause orders the slips so the first fix is the one named", () => {
  // A value can match two shapes. The order is deliberate: negative before everything (fix the
  // sign first), then whitespace, then a wrong unit letter, then the structural slips.
  assertClause("-1h 30m", " — a duration may not be negative");
  assertClause(" -1hours", " — it has leading or trailing whitespace");
  assertClause("  1h1h", " — it has leading or trailing whitespace");
  assertClause("1hours1hours", ' — the unit must be one of d, h, m, or s, not "hours"');
});

test("durationSlipClause is always an appended clause, never a report of its own", () => {
  // The contract the two call sites depend on: either empty, or one line starting with a
  // space-em-dash, with no newline and no quote of the value (gotSuffix already appends that,
  // and a clause that repeated it would print the value twice).
  const malformed = [
    "45", "2hours", "1h 30m", " 45s", "-1h", "1.5h", "h30m", "1h1h", "30m1h", "1h30", "0s", "???",
  ];
  for (const value of malformed) {
    const clause = durationSlipClause(value);
    if (clause === "") continue;
    assert.ok(clause.startsWith(" — "), `${JSON.stringify(value)} -> ${JSON.stringify(clause)}`);
    assert.ok(!clause.includes("\n"), `${JSON.stringify(value)} -> ${JSON.stringify(clause)}`);
    assert.ok(!clause.includes(JSON.stringify(value)), `${JSON.stringify(value)} quotes its own value`);
  }
});
