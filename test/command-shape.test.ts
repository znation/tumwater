// The classifier's shape table, moved here from test/pi.test.ts (2026-09-30) when
// commandBuffersOutput moved from src/pi.ts to src/command-shape.ts. The runPi stall-warning
// behavior that consumes it stays pinned in test/pi.test.ts ("a stalled piped-stdout call
// warns nothing; the redirect is found in the full command, not the truncated label"),
// together with src/ui/progress.ts's matching skip (test/progress.test.ts) — the two
// surfaces must classify identically (BUGS.md 2026-09-28).
import test from "node:test";
import assert from "node:assert/strict";
import { commandBuffersOutput } from "../src/command-shape.js";

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
