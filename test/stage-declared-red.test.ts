import test from "node:test";
import assert from "node:assert/strict";
import { declaredRedPhrase } from "../src/stage/stage-declared-red.js";

// The incident's own wording (BUGS.md 2026-11-20): the RISK line declared the change incomplete
// and the suite red, and the merge read neither line.
test("a RISK line that declares the change incomplete or the suite red is detected", () => {
  assert.equal(
    declaredRedPhrase({ risk: "the change is NOT complete — the flip leaves the suite red" }),
    "NOT complete",
  );
  assert.equal(declaredRedPhrase({ risk: "the flip leaves the suite red" }), "leaves the suite red");
  assert.equal(declaredRedPhrase({ risk: "this is incomplete: the default is not wired" }), "incomplete");
});

test("a VERIFIED line that declares the suite not green or red is detected", () => {
  assert.equal(declaredRedPhrase({ verified: "the change is not suite-green as it stands" }), "not suite-green");
  assert.equal(declaredRedPhrase({ verified: "the suite is red in claims" }), "the suite is red");
  assert.equal(declaredRedPhrase({ verified: "the suite stays red after the flip" }), "the suite stays red");
});

test("the declaring forms match case-insensitively", () => {
  assert.equal(declaredRedPhrase({ risk: "Not Complete" }), "Not Complete");
  assert.equal(declaredRedPhrase({ verified: "NOT SUITE-GREEN" }), "NOT SUITE-GREEN");
});

test("a conditional risk does not fire the detector", () => {
  assert.equal(declaredRedPhrase({ risk: "a wrong field would make the status test fail" }), null);
  assert.equal(declaredRedPhrase({ risk: "if the default is wrong, the suite could go red" }), null);
});

test("a line that blames main's known-red tests does not fire the detector", () => {
  assert.equal(declaredRedPhrase({ verified: "main already fails the claims tests; the suite is red there" }), null);
  assert.equal(declaredRedPhrase({ verified: "the claims failures are known red on main" }), null);
});

test("an absent or empty description does not fire the detector", () => {
  assert.equal(declaredRedPhrase({}), null);
  assert.equal(declaredRedPhrase({ risk: undefined, verified: undefined }), null);
  assert.equal(declaredRedPhrase({ risk: "", verified: "all 12 tests pass" }), null);
});

test("RISK is read before VERIFIED when both declare red", () => {
  assert.equal(declaredRedPhrase({ risk: "NOT complete", verified: "not suite-green" }), "NOT complete");
});
