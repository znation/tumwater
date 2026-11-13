// The classifier's shape table, moved here from test/pi.test.ts (2026-09-30) when
// commandBuffersOutput moved from src/pi/pi.ts to src/pi/command-shape.ts. The runPi stall-warning
// behavior that consumes it stays pinned in test/pi.test.ts ("a stalled piped-stdout call
// warns nothing; the redirect is found in the full command, not the truncated label"),
// together with src/ui/progress-data.ts's matching skip (test/progress.test.ts) — the two
// surfaces must classify identically (BUGS.md 2026-09-28).
import test from "node:test";
import assert from "node:assert/strict";
import { callBuffersOutput, callClassifiedCommand, commandBuffersOutput, stallThresholdMs } from "../src/pi/command-shape.js";

test("commandBuffersOutput classifies the redirect shapes", () => {
  const buffered = [
    "npm run test 2>&1 | tail -8", // the prescribed shape: the pipe holds every byte
    "npm run test > /tmp/out.log",
    "npm run test >> /tmp/out.log",
    "npm run test &> /tmp/out.log", // both streams leave
    "npm run test 2> /tmp/err.log > /dev/null", // the > redirects stdout
    'grep "a > b" file', // errs toward buffered on unparseable shapes
  ];
  const live = [
    "sleep 999", // bare: pi's pipe stays open, silence means something
    "npm run test 2>&1", // stderr dups onto stdout's destination — pi's pipe
    "npm run test 2> /tmp/err.log", // only stderr leaves; stdout still streams
    "npm run test 2>> /tmp/err.log", // stderr appends; the >> pair is one operator
    "npm run test >&1", // stdout dups onto itself
  ];
  for (const c of buffered) assert.equal(commandBuffersOutput(c), true, `buffered: ${c}`);
  for (const c of live) assert.equal(commandBuffersOutput(c), false, `live: ${c}`);
});

test("callBuffersOutput folds the agent trait over the command classifier", () => {
  // An agent that streams nothing buffers every call; a pi-routed agent falls back to the
  // command shape, so a bare command still streams.
  assert.equal(callBuffersOutput("claude", "sleep 999"), true);
  assert.equal(callBuffersOutput("opencode", "sleep 999"), true);
  assert.equal(callBuffersOutput("pi", "sleep 999"), false);
  assert.equal(callBuffersOutput("pi", "npm run test 2>&1 | tail -8"), true);
});

test("callClassifiedCommand reads the raw command, falling back to the display label when absent", () => {
  // A bash call rides its full raw command: that text is what the shape classifier sees, not
  // the truncated display label.
  assert.equal(
    callClassifiedCommand({ id: "c1", label: "bash find / -name x", command: "find / -name x > /tmp/o", lastActivityAt: 0 }),
    "find / -name x > /tmp/o",
    "the raw command wins",
  );
  // A non-bash tool carries no raw command (it rides ""), so the fallback is the display
  // label — the || form, not ??: an empty raw command still falls back.
  assert.equal(
    callClassifiedCommand({ id: "c2", label: "read notes.md", command: "", lastActivityAt: 0 }),
    "read notes.md",
    "an empty raw command falls back to the label",
  );
  assert.equal(callClassifiedCommand({ id: "c3", label: "read notes.md", lastActivityAt: 0 }), "read notes.md");
});

test("stallThresholdMs applies the buffered wall-clock threshold only to calls that buffer", () => {
  // The buffered floor is max(2 * stallMs, 10 min) per the contract above; the live
  // threshold is stallMs itself. Expected values come from those formulas, not from the code.
  // lastActivityAt is irrelevant to the threshold (a function of agent + shape + stallMs),
  // so every fixture stamps 0.
  const live = { id: "c1", label: "bash npm test", lastActivityAt: 0 }; // streams on pi, no shape
  const piped = { id: "c2", label: "bash npm test", command: "npm test 2>&1 | tail -8", lastActivityAt: 0 };
  const noStream = { id: "c3", label: "bash npm test", command: "sleep 999", lastActivityAt: 0 };
  // 300 s silence: 2 * 300_000 = 600_000 ties the 10-minute (600_000) floor, so max() is
  // 600_000.
  assert.equal(stallThresholdMs("pi", live, 300_000), 300_000, "a live call is judged by the silence threshold");
  assert.equal(stallThresholdMs("pi", piped, 300_000), 600_000, "a piped call is judged by the buffered wall-clock floor");
  // claude streams no tool output, so EVERY call is buffered, piped or not.
  assert.equal(stallThresholdMs("claude", noStream, 300_000), 600_000, "a no-streaming agent buffers every call");
  // An unregistered backend reads as pi, so its live command keeps the silence threshold.
  assert.equal(stallThresholdMs("weird", live, 300_000), 300_000);
  // Above the 10-minute floor the buffered threshold scales: 2 * 600_000 = 1_200_000.
  assert.equal(stallThresholdMs("pi", piped, 600_000), 1_200_000);
  // 0 disables the stall decision; a live call's own threshold is 0.
  assert.equal(stallThresholdMs("pi", live, 0), 0);
  // A live call whose label carries a shape (no raw command) still classifies from that text.
  assert.equal(
    stallThresholdMs("pi", { id: "c4", label: "bash npm test | tail -1", lastActivityAt: 0 }, 300_000),
    600_000,
    "a label-shaped call takes the buffered floor",
  );
});
