/** The quiet-hours gate's e2e tier slice (test/quiet-hours.test.ts covers the unit surface):
 * a configured quietHours window blocks role loops' ticks on a live orchestrator while the
 * director stays exempt, and emptying the window live lifts the hold without a restart —
 * the operator pause's semantics on a schedule (test/orchestrator-pause.e2e.test.ts is the
 * sibling this mirrors). Each test file gets its own process — and its own PATH, which
 * fakePi's global PATH swap requires. */
import test from "node:test";
import assert from "node:assert/strict";

import { enqueuePrompt } from "../src/inbox.js";
import { readEvents } from "../src/event-read.js";
import { loadLoopState } from "../src/loop-state.js";
import { setConfigKey } from "../src/config-write.js";
import { defaultConfig, saveConfig } from "../src/config.js";
import { eventsOfType } from "./log-fixtures.js";
import { awaitSettledTick, makeFastRepo, startIdleOrchestrator, stopOrchestrator } from "./orchestrator-fixtures.js";
import { sleep, waitFor } from "./wait.js";

/** A window that always contains the current local wall clock: [now-30min, now+30min]. Near
 * midnight it wraps (start > end), which exercises the wrapping membership on real time. */
function quietWindowAroundNow(): string {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const fmt = (min: number): string => {
    const m = ((min % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  return `${fmt(nowMin - 30)}-${fmt(nowMin + 30)}`;
}

test("quiet hours block role ticks while the director runs; emptying the window unblocks live", async () => {
  const repo = await makeFastRepo("quiet hours e2e test", ["clean", "director"]);
  // The quiet window is on disk before the orchestrator starts, so the very first poll is
  // already inside it — no startup tick for roles, one started event on that first poll.
  saveConfig(repo, { ...defaultConfig(), quietHours: quietWindowAroundNow() });
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    // The gate sits before eligibility: the entry event arrives on the first poll, and the
    // role's startup tick (which an ungated fleet runs immediately) never starts.
    await waitFor(
      () => eventsOfType(repo, "quiet_hours_started").length === 1,
      "a quiet_hours_started event",
    );

    // Several (fast) poll cycles pass: clean starts no tick while the window holds.
    await sleep(600);
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "a quiet-hours role starts no ticks");

    // The director is exempt: a queued human prompt still runs during the window.
    enqueuePrompt(repo, "steer me during quiet hours");
    await awaitSettledTick(repo, "director", 1, "the director to tick during quiet hours");
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "still quiet after the director's run");

    // Emptying the window live (what `tumwater config set quietHours ""` does) ends the
    // hold on the next poll: one ended event, then the blocked role ticks without a restart.
    const cleared = setConfigKey(repo, "quietHours", "");
    assert.ok(cleared.ok, `clearing quietHours should succeed: ${cleared.ok ? "" : cleared.error}`);
    await waitFor(
      () => eventsOfType(repo, "quiet_hours_ended").length === 1,
      "a quiet_hours_ended event",
    );
    await awaitSettledTick(repo, "clean", 1, "the quiet role to tick after the window ends");

    // Exactly one of each transition for the whole run — no per-poll event spam.
    assert.equal(eventsOfType(repo, "quiet_hours_started").length, 1);
    assert.equal(eventsOfType(repo, "quiet_hours_ended").length, 1);
    assert.ok(readEvents(repo).length > 0, "the run logged events at all");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});
