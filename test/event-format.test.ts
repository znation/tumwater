import test from "node:test";
import assert from "node:assert/strict";
import { formatEvent } from "../src/event-format.js";

test("formatEvent renders each type as one line", () => {
  const cases = [
    { ts: 0, loop: "clean", type: "tick_start", tick: 3 },
    { ts: 0, loop: "clean", type: "tick_end", tick: 3, result: "changed", summary: "tidy up" },
    { ts: 0, loop: "clean", type: "tick_end", tick: 4, result: "error", error: "boom" },
    { ts: 0, loop: "clean", type: "merged", commit: "abcdef1234567890", summary: "tidy up" },
    { ts: 0, loop: "harness", type: "orchestrator_start", pid: 1 },
    { ts: 0, loop: "director", type: "prompt_enqueued", preview: "do x" },
  ] as const;
  for (const e of cases) {
    const line = formatEvent(e as never);
    assert.ok(line.includes(e.loop), `line should name the loop: ${line}`);
    assert.ok(!line.includes("\n"));
  }
  assert.match(formatEvent(cases[1] as never), /tidy up/);
  assert.match(formatEvent(cases[2] as never), /boom/);
  assert.match(formatEvent(cases[3] as never), /abcdef12/);
});
