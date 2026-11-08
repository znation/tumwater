import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePolicyOffenders,
  policyOffenderLine,
  POLICY_OFFENDER_PREFIX,
} from "../src/build/policy-offenders.js";

// The machine-readable penalty a policy scan prints per offender (policy-offenders.ts, part 1/2
// of BUGS.md 2026-11-08): one `tumwater-policy-offender\t<title>\t<offender>` line before its
// assertion fails, which runBuildCheck folds into BuildCheckOutcome.failingOffenders so a later
// attribution can tell a change's new offender from a base's or main's old one. This pins the
// line format and the parse (title-keyed, deduplicated, output order; noise ignored).

test("policyOffenderLine prints the prefix, the exact title and the offender, tab-delimited", () => {
  const title = "every comment line in src/ and test/ fits in 100 columns and opens no block inside a block";
  assert.equal(
    policyOffenderLine(title, "src/a.ts:10 (cols)"),
    `${POLICY_OFFENDER_PREFIX}\t${title}\tsrc/a.ts:10 (cols)`,
  );
});

test("parsePolicyOffenders returns title-keyed lists in output order, deduplicated", () => {
  const output = [
    "ℹ fail 2",
    policyOffenderLine("scan A", "src/a.ts:1 (cols)"),
    policyOffenderLine("scan A", "src/b.ts:2 (cols)"),
    policyOffenderLine("scan A", "src/a.ts:1 (cols)"), // repeated offender stays once
    policyOffenderLine("scan B", "src/x.ts: Name"),
    "✖ scan A (3ms)",
  ].join("\n");
  assert.deepEqual(parsePolicyOffenders(output), {
    "scan A": ["src/a.ts:1 (cols)", "src/b.ts:2 (cols)"],
    "scan B": ["src/x.ts: Name"],
  });
});

test("parsePolicyOffenders ignores prefix-free noise and malformed prefixed lines", () => {
  const output = [
    policyOffenderLine("title", "offender"),
    "tumwater-policy-offender no tab", // prefix without a tab follows it
    "plain text",
    "",
  ].join("\n");
  assert.deepEqual(parsePolicyOffenders(output), { title: ["offender"] });
  // A prefixed line with nothing after the tab is not an offender line either.
  assert.deepEqual(parsePolicyOffenders(`tumwater-policy-offender\t\n`), {});
});

test("parsePolicyOffenders of empty or offender-free output is an empty record", () => {
  assert.deepEqual(parsePolicyOffenders(""), {});
  assert.deepEqual(parsePolicyOffenders("✖ failing tests:\nℹ fail 1\n"), {});
});
