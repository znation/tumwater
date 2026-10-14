import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseNoChange, extractNoChangeAnswer } from "../src/verdict/no-change.js";
import type { PiRunResult } from "../src/pi/pi-run-result.js";
import { piRunResult } from "./fakes/fake-pi.js";

/** A no-change pi run result; tests override only what they exercise. */
function noChangePi(over: Partial<PiRunResult> = {}): PiRunResult {
  return piRunResult({
    finalText: "TUMWATER_NOTHING_TO_DO",
    nothingToDo: true,
    stopReason: "stop",
    ...over,
  });
}

test("a compliant nothing-to-do run is not cut off and carries no notes", () => {
  const d = diagnoseNoChange(noChangePi());
  assert.equal(d.cutOff, false);
  assert.deepEqual(d.notes, []);
});

test("a contentless final message without a sentinel is a context-ceiling cut-off", () => {
  const d = diagnoseNoChange(
    noChangePi({ nothingToDo: false, finalText: "", stopReason: "length", finalMessageContentless: true }),
  );
  assert.equal(d.cutOff, true);
  assert.deepEqual(d.notes, [
    "stopReason=length",
    "no assistant text",
    "final message had no text or tool call — likely cut off at the context ceiling",
  ]);
});

test("a contentless final message that auto-compacted notes the compaction last", () => {
  const d = diagnoseNoChange(
    noChangePi({ nothingToDo: false, finalText: "", finalMessageContentless: true, compacted: true }),
  );
  assert.equal(d.cutOff, true);
  // stopReason "stop" is normal — not noted; the compaction note comes after the contentless one.
  assert.deepEqual(d.notes, [
    "no assistant text",
    "final message had no text or tool call — likely cut off at the context ceiling",
    "pi auto-compacted the session",
  ]);
});

test("plain non-compliance (text but no sentinel) is not a cut-off and lists only its notes", () => {
  const d = diagnoseNoChange(noChangePi({ nothingToDo: false, finalText: "I did some thinking." }));
  assert.equal(d.cutOff, false);
  assert.deepEqual(d.notes, []); // normal stopReason, text present, message not contentless
});

test("a sentinel in an intermediate turn suppresses the diagnosis even when the last message is contentless", () => {
  const d = diagnoseNoChange(
    noChangePi({ nothingToDo: true, finalText: "", finalMessageContentless: true }),
  );
  assert.equal(d.cutOff, false); // cut-off requires BOTH signals; the sentinel wins
  assert.deepEqual(d.notes, []);
});

test("extractNoChangeAnswer returns the prose above the sentinel", () => {
  const ans = extractNoChangeAnswer("Not a bug. The merge slot is busy.\n\nTUMWATER_NOTHING_TO_DO");
  assert.equal(ans, "Not a bug. The merge slot is busy.");
});

test("extractNoChangeAnswer trims decoration but keeps the answer", () => {
  const ans = extractNoChangeAnswer("  The row is accurate.  \n\nTUMWATER_NOTHING_TO_DO");
  assert.equal(ans, "The row is accurate.");
});

test("extractNoChangeAnswer is null when nothing rides the sentinel", () => {
  assert.equal(extractNoChangeAnswer("TUMWATER_NOTHING_TO_DO"), null);
  assert.equal(extractNoChangeAnswer("some reply without the sentinel"), null);
});

test("extractNoChangeAnswer caps an overlong answer like a SUMMARY", () => {
  const ans = extractNoChangeAnswer("x".repeat(400) + "\n\nTUMWATER_NOTHING_TO_DO");
  assert.ok(ans!.length <= 100, `kept ${ans!.length} chars, under the 100 cap`);
  assert.ok(ans!.endsWith("…"));
});
