/** The orchestrator e2e tier's live maxConcurrent-resize test (see orchestrator.e2e.test.ts
 * for the tier's split): a live maxConcurrent edit resizing the cap. Renamed here from
 * orchestrator-4.e2e.test.ts (2026-09-29) so the topic has a name instead of a slice number —
 * unlike the tier's balanced orchestrator-2/3 slices, this file holds one coherent topic.
 * It keeps the real poll cadence on purpose and is the tier's single longest test, so it runs
 * in its own process. Like the rest of the tier it waits on real timers and runs via
 * `npm run test:e2e`, not in the gating `npm test`. */
import test from "node:test";
import assert from "node:assert/strict";
import { saveConfig } from "../src/config/config.js";
import { initProject } from "../src/init/init.js";
import { readEvents } from "../src/events/event-read.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { censusHoldFragment, fastConfig, readSamples, startLiveOrchestrator, stopOrchestrator } from "./fixtures/orchestrator-fixtures.js";
import { mergeWork, makeRepo, seedOpenBug, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi } from "./fakes/fake-pi.js";
import { awaitQuietHost, waitFor } from "./helpers/wait.js";
import { assistantLine } from "./fixtures/pi-events.js";

/** A fake pi that records how many runs were in flight during its run, holds its census slot
 * until it observes a second run in flight (a deterministic overlap witness — see
 * censusHoldFragment) and declares nothing-to-do (so no commit happens). The hold, not a
 * wall-clock sample, is what makes `n >= 2` observable the moment two runs are admitted. */
function concurrencyRecordingFakePi(runDir: string): () => void {
  const script = [
    `d="${runDir}/runs"`,
    `mkdir -p "$d"`,
    `f=$(mktemp "$d/run.XXXXXX")`,
    censusHoldFragment(runDir, "", 30),
    `printf '%s\\n' "$n" >> "${runDir}/samples.log"`,
    `rm -f "$f"`,
    `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
  ].join("\n");
  return fakePi(script);
}

test("a live maxConcurrent edit resizes the cap without a restart", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = makeRepo();
  await initProject(repo, "live maxConcurrent test");
  // THREE fast-running roles and ONE slot: with three roles competing for one permit, steady
  // state always has at least one run queued on the semaphore (a two-role team settles into
  // a strict alternation where every poll schedules exactly one role, so there would be no
  // queued run for the grow to wake). The shim's census hold keeps each run alive until a
  // partner joins, so an overlapping pair records it the moment the second is admitted.
  const base = fastConfig(["clean", "dedupe", "bugfix"]);
  base.maxConcurrent = 1;
  saveConfig(repo, base);
  // bugfix is one of the three fast-running roles this test needs to keep running between
  // merges; with an empty BUGS.md `## Open` it defers like a maintenance role instead
  // (deferRun), so the open bug keeps it on the every-wake schedule the test was written for.
  seedOpenBug(repo);
  const runDir = tmpdir();
  const restore = concurrencyRecordingFakePi(runDir);
  // Default poll interval (not FAST_POLL_MS): the census hold waits up to 3s for a partner,
  // a span the number of concurrent rolls a fast poll could blur. Phase 3's "no overlap after
  // shrink" assertion needs the start-sample semantics — a cap-2-era run records its overlap
  // at launch, before the shrink boundary, and under cap 1 the next run cannot start until
  // the earlier run's permit is released, so a post-shrink run never observes a partner.
  const orch = startLiveOrchestrator(repo);
  try {
    // Phase 1 (cap 1): all three roles run — but never overlap. Wait until each has run at
    // least once (three samples), then confirm no sample ever exceeded one concurrent run.
    await waitFor(() => readSamples(runDir).length >= 3, "all three roles to have run");
    assert.ok(
      readSamples(runDir).every((n) => n <= 1),
      `peak stays 1 while the second role waits on its slot (samples: ${readSamples(runDir)})`,
    );

    // Phase 2 (cap 2): a live edit admits the queued work — runs overlap without a restart.
    const grow = fastConfig(["clean", "dedupe", "bugfix"]);
    grow.maxConcurrent = 2;
    saveConfig(repo, grow);
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "max_concurrent_changed" && e.to === 2),
      "the max_concurrent_changed event",
    );
    // Need-based deferral (merged after this test was written) leaves only bugfix running:
    // clean and dedupe defer after their nothing-to-do startup runs, so without a merge there
    // is no queued work for the grow to admit and no overlap can ever form — phase 2 would
    // then pass only by racing the startup burst's tail. Merge work to wake the deferred roles:
    // with cap 2 at least two of them run concurrently, making the overlap deterministic.
    mergeWork(repo);
    // 60s, not the 20s default: this is the one assertion in the suite that waits on the
    // orchestrator's real poll loop scheduling two live pi shims at once, and under the load the
    // team runs it at, 20s expired before the grow was observable (BUGS.md 2026-09-18).
    await waitFor(() => readSamples(runDir).some((n) => n >= 2), "overlapping runs after the grow", 150_000);

    // Phase 3 (cap 1 again): shrinking admits no NEW concurrent run until in-flight work
    // finishes. Every sample recorded from the change onward must be <= 1 — a cap that was
    // not applied would let the fast roles overlap again within a few polls.
    const shrink = fastConfig(["clean", "dedupe", "bugfix"]);
    shrink.maxConcurrent = 1;
    saveConfig(repo, shrink);
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "max_concurrent_changed" && e.to === 1),
      "the shrink event",
    );
    // Samples before this point may overlap (the cap was still 2 when those runs were
    // admitted); every sample from here on must be sequential.
    const fromShrink = readSamples(runDir).length;
    await waitFor(() => readSamples(runDir).length >= fromShrink + 3, "several post-shrink runs");
    assert.ok(
      readSamples(runDir).slice(fromShrink).every((n) => n <= 1),
      `no new concurrent run after the shrink until in-flight work finishes (samples: ${readSamples(runDir)})`,
    );

    // Exactly one change event per distinct value — unchanged polls log nothing.
    const changes = eventsOfType(repo, "max_concurrent_changed");
    assert.equal(changes.length, 2);
    assert.deepEqual(
      changes.map((c) => [c.source, c.from, c.to]),
      [
        ["tumwater", 1, 2],
        ["tumwater", 2, 1],
      ],
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

