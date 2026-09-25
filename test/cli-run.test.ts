import test from "node:test";
import assert from "node:assert/strict";

import { onceSummary } from "../src/cli-run.js";
import { freshLoopState, saveLoopState } from "../src/state.js";
import { pauseFleet } from "../src/fleet-state.js";
import type { LoopState } from "../src/types.js";
import { makeRepo } from "./util.js";

// Unit seam for cli-run.ts's onceSummary — the one-line `tumwater run --once` summary a cron
// log keeps. The orchestrator-level behavior (which settle reason a real round hands back,
// deferred included) is pinned end to end by test/orchestrator-once.e2e.test.ts; these tests
// pin the summary's own accounting at unit level: tick counting against the pre-round
// snapshot, bucketing by last result, and skip reasons reported verbatim from the
// orchestrator's settle map — the 2026-09-25 BUGS.md fix that stopped a deferred role from
// being re-derived from state as "idle". The state-derived classification appears only as the
// documented fallback for a role the settle map lacks (asserted once, via the unambiguous
// pause-marker branch).

function state(role: string, over: Partial<LoopState>): LoopState {
  return { ...freshLoopState(role), ...over };
}

test("counts the round's ticks and buckets them by last result, sorted by key", () => {
  const root = makeRepo();
  saveLoopState(root, state("clean", { ticks: 2, lastResult: "changed" }));
  saveLoopState(root, state("docs", { ticks: 1, lastResult: "no_change" }));
  saveLoopState(root, state("qa", { ticks: 3, lastResult: "error" }));

  const line = onceSummary(
    root,
    ["clean", "docs", "qa"],
    new Map([
      ["clean", 0],
      ["docs", 0],
      ["qa", 1],
    ]),
    undefined,
  );

  // Only the ticks this round advanced count: qa had 1 tick before, so 2 of its 3 are new.
  assert.equal(line, "once: 5 ticks — 1 changed, 1 error, 1 no_change");
});

test("one advanced tick reads singular; zero ticks read `nothing ran`", () => {
  const root = makeRepo();
  saveLoopState(root, state("clean", { ticks: 1, lastResult: "no_change" }));
  assert.equal(
    onceSummary(root, ["clean"], new Map([["clean", 0]]), undefined),
    "once: 1 tick — 1 no_change",
  );
  // A role that never advanced is skipped with the settle reason too (here: idle, from the map).
  assert.equal(
    onceSummary(root, ["docs"], new Map([["docs", 0]]), new Map([["docs", "idle"]])),
    "once: 0 ticks — nothing ran, 1 skipped (idle)",
  );
});

test("a skipped role reports the orchestrator's settle reason verbatim, not a state re-derivation", () => {
  const root = makeRepo();
  // clean's state would read as idle by derivation (past nextRunAt, no pause marker) — the
  // pre-fix mislabel the 2026-09-25 BUGS.md entry records; the settle map says deferred.
  saveLoopState(root, state("clean", { ticks: 4, nextRunAt: Date.now() - 60_000 }));

  const line = onceSummary(
    root,
    ["clean"],
    new Map([["clean", 4]]),
    new Map([["clean", "deferred"]]),
  );

  assert.equal(line, "once: 0 ticks — nothing ran, 1 skipped (deferred)");
});

test("skip reasons are reported verbatim and in role order", () => {
  const root = makeRepo();
  saveLoopState(root, state("clean", { ticks: 1 }));
  saveLoopState(root, state("docs", { ticks: 1 }));
  saveLoopState(root, state("qa", { ticks: 1 }));

  const line = onceSummary(
    root,
    ["clean", "docs", "qa"],
    new Map([
      ["clean", 1],
      ["docs", 1],
      ["qa", 1],
    ]),
    new Map([
      ["clean", "deferred"],
      ["docs", "disabled"],
      ["qa", "backoff"],
    ]),
  );

  assert.equal(line, "once: 0 ticks — nothing ran, 3 skipped (deferred, disabled, backoff)");
});

test("a role the settle map lacks falls back to state, via the pause marker", () => {
  const root = makeRepo();
  pauseFleet(root);
  saveLoopState(root, state("clean", { ticks: 1 }));

  const line = onceSummary(root, ["clean"], new Map([["clean", 1]]), new Map());

  assert.equal(line, "once: 0 ticks — nothing ran, 1 skipped (paused)");
});
