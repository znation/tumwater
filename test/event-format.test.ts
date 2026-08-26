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

test("formatEvent renders wake reasons and warning messages operators rely on", () => {
  // These are the diagnostic lines read in logs/TUI/GUI when figuring out why a loop woke or
  // what went wrong: the reason and message payloads must survive formatting.
  const wake = formatEvent({ ts: 0, loop: "clean", type: "wake", reason: "main moved" } as never);
  assert.match(wake, /woke \(main moved\)/, `wake line must carry its reason: ${wake}`);

  const warn = formatEvent({
    ts: 0,
    loop: "harness",
    type: "warning",
    message: "tumwater.json invalid — keeping current config",
  } as never);
  assert.match(warn, /warning: tumwater\.json invalid/, `warning line must carry its message: ${warn}`);

  const stop = formatEvent({ ts: 0, loop: "harness", type: "orchestrator_stop" } as never);
  assert.match(stop, /orchestrator stopped/);
});

test("formatEvent renders a no-change tick with no summary or error suffix", () => {
  // The third arm of the tick_end ternary is the empty string: a regression that gave every
  // result a suffix would print "— undefined" on every idle tick in every display surface.
  const line = formatEvent({ ts: 0, loop: "clean", type: "tick_end", tick: 5, result: "no_change" } as never);
  assert.match(line, /tick #5 no_change$/, `no-change tick must end at the result: ${line}`);
});

test("formatEvent degrades gracefully for unknown event types", () => {
  // The default branch is a safety net: HarnessEvent's union has no exhaustiveness check, so a
  // type added in types.ts without a case here would otherwise render empty or crash on every
  // display surface. Pin the graceful fallback.
  const line = formatEvent({ ts: 0, loop: "clean", type: "brand_new_type" } as never);
  assert.match(line, /clean\s+brand_new_type/, `unknown types must still render their name: ${line}`);
});

test("formatEvent renders counters_reset plainly, naming all roles when several are affected", () => {
  const single = formatEvent({ ts: 0, loop: "clean", type: "counters_reset" } as never);
  assert.match(single, /clean\s+counters reset \(ticks, commits, tokens, cost\)/);
  const multi = formatEvent(
    { ts: 0, loop: "harness", type: "counters_reset", roles: ["feature", "bugfix"] } as never,
  );
  assert.match(multi, /harness\s+counters reset for feature, bugfix \(ticks, commits, tokens, cost\)/);
});
