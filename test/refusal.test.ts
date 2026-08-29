import test from "node:test";
import assert from "node:assert/strict";
import { PiStreamParser } from "../src/pi.js";
import { REFUSED_SENTINEL, extractRefusal } from "../src/reply-contract.js";
import { assistantLine } from "./util.js";

// Sentinel parse — the first piece of the planned refusal suite (plans/refusal-and-thrash.md).
// The TUMWATER_REFUSED line is what blocks a PLANS.md/BUGS.md entry and routes a tick to
// handleRefusal, so its detection semantics are load-bearing: pi.ts's boolean scan is
// deliberately loose (whole-reply includes), while the REASON extraction is anchored at
// line start so prose that merely mentions the sentinel cannot set it.

test("extractRefusal returns the trimmed reason from a line-start sentinel", () => {
  const text = `I will not force this plan.\n${REFUSED_SENTINEL}: it would delete user data\nSUMMARY: refused`;
  assert.equal(extractRefusal(text), "it would delete user data");
});

test("extractRefusal tolerates leading whitespace and extra spaces after the colon", () => {
  assert.equal(extractRefusal(`  ${REFUSED_SENTINEL}:    spaced out reason`), "spaced out reason");
});

test("extractRefusal returns null for a bare sentinel with no reason", () => {
  assert.equal(extractRefusal(`${REFUSED_SENTINEL}`), null);
  assert.equal(extractRefusal(`preamble\n${REFUSED_SENTINEL}:\n`), null, "colon but empty reason");
});

test("extractRefusal ignores mid-sentence mentions (line-start anchor)", () => {
  const text = `I considered ${REFUSED_SENTINEL}: no, that is not what I meant`;
  assert.equal(extractRefusal(text), null);
});

test("extractRefusal returns the first parseable line when several exist", () => {
  const text = `${REFUSED_SENTINEL}: first reason\n${REFUSED_SENTINEL}: second reason`;
  assert.equal(extractRefusal(text), "first reason");
});

// Parser level: the refusal flag and reason must survive later messages, mirroring the
// nothing-to-do sentinel (a compliant run emits the sentinel once, in its final message —
// but a closing remark after it must not erase the declaration).

test("parser records refused + reason from the sentinel line", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`declining\n${REFUSED_SENTINEL}: plan conflicts with PRINCIPLES.md`) + "\n");
  assert.equal(parser.refused, true);
  assert.equal(parser.refusedReason, "plan conflicts with PRINCIPLES.md");
});

test("parser keeps a refusal declared in an intermediate message (regression)", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`${REFUSED_SENTINEL}: too risky to land`) + "\n");
  parser.feed(assistantLine("closing remarks about the refusal") + "\n");
  assert.equal(parser.finalText, "closing remarks about the refusal", "finalText stays the last message");
  assert.equal(parser.refused, true, "refusal from an earlier turn is not lost");
  assert.equal(parser.refusedReason, "too risky to land");
});

test("parser sets refused with an empty reason for a bare sentinel", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`${REFUSED_SENTINEL}`) + "\n");
  assert.equal(parser.refused, true);
  assert.equal(parser.refusedReason, "", "no parseable reason — the loop falls back to 'no reason given'");
});

test("parser flags a mid-sentence mention but leaves the reason empty", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`I would say ${REFUSED_SENTINEL}: no, let me keep going`) + "\n");
  assert.equal(parser.refused, true, "boolean scan is deliberately loose (whole-reply includes)");
  assert.equal(parser.refusedReason, "", "anchored extraction rejects the mid-sentence mention");
});

test("parser keeps the first parseable reason across messages", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`${REFUSED_SENTINEL}: original objection`) + "\n");
  parser.feed(assistantLine(`${REFUSED_SENTINEL}: a later, different line`) + "\n");
  assert.equal(parser.refusedReason, "original objection", "first reason wins; a compliant run emits the sentinel once");
});

test("parser does not set refused when no message carries the sentinel", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine("all done\nSUMMARY: fix it") + "\n");
  assert.equal(parser.refused, false);
  assert.equal(parser.refusedReason, "");
});
