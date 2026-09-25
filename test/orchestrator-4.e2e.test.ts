/** The orchestrator e2e tier, fourth slice (see orchestrator.e2e.test.ts for the split): a live
 * maxConcurrent edit resizing the cap. It keeps the real poll cadence on purpose and is the
 * tier's single longest test, so it runs in its own process. Like the rest of the tier it
 * waits on real timers and runs via `npm run test:e2e`, not in the gating `npm test`. */
import test from "node:test";
import assert from "node:assert/strict";
import { saveConfig } from "../src/config.js";
import { initProject } from "../src/init.js";
import { readEvents } from "../src/events.js";
import {
  assistantLine,
  fakePi,
  fastConfig,
  landWork,
  makeRepo,
  readSamples,
  startLiveOrchestrator,
  tmpdir,
  waitFor,
} from "./util.js";

/** A fake pi that records how many runs were in flight when it started (one sample line per
 * run), holds its slot for ~1.5s so overlapping runs are observable, and declares
 * nothing-to-do (so no commit happens). */
function concurrencyRecordingFakePi(runDir: string): () => void {
  const script = [
    `d="${runDir}/runs"`,
    `mkdir -p "$d"`,
    `f=$(mktemp "$d/run.XXXXXX")`,
    `n=0; for x in "$d"/run.*; do n=$((n+1)); done`,
    `printf '%s\\n' "$n" >> "${runDir}/samples.log"`,
    `sleep 1.5`,
    `rm -f "$f"`,
    `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
  ].join("\n");
  return fakePi(script);
}

test("a live maxConcurrent edit resizes the cap without a restart", async () => {
  const repo = makeRepo();
  await initProject(repo, "live maxConcurrent test");
  // THREE fast-ticking roles and ONE slot: with three loops competing for one permit, steady
  // state always has at least one tick queued on the semaphore (a two-role fleet settles into
  // a strict alternation where every poll schedules exactly one loop, so there would be no
  // queued tick for the grow to wake). The shim's ~1.5s hold makes overlapping runs visible.
  const base = fastConfig(["clean", "dry", "bugfix"]);
  base.maxConcurrent = 1;
  saveConfig(repo, base);
  const runDir = tmpdir();
  const restore = concurrencyRecordingFakePi(runDir);
  // Keeps the DEFAULT poll interval on purpose: phase 3's "no overlap after shrink" assertion
  // relies on the shim's ~1.5s hold being shorter than one poll, so every cap-2-era run file is
  // gone by the time the shrink event is observed. A fast poll would let an in-flight file cross
  // the boundary and false-fail the test.
  const orch = startLiveOrchestrator(repo);
  try {
    // Phase 1 (cap 1): all three loops tick — but never overlap. Wait until each has run at
    // least once (three samples), then confirm no sample ever exceeded one concurrent run.
    await waitFor(() => readSamples(runDir).length >= 3, "all three roles to have run");
    assert.ok(
      readSamples(runDir).every((n) => n <= 1),
      `peak stays 1 while the second loop waits on its slot (samples: ${readSamples(runDir)})`,
    );

    // Phase 2 (cap 2): a live edit admits the queued work — runs overlap without a restart.
    const grow = fastConfig(["clean", "dry", "bugfix"]);
    grow.maxConcurrent = 2;
    saveConfig(repo, grow);
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "max_concurrent_changed" && e.to === 2),
      "the max_concurrent_changed event",
    );
    // Need-based deferral (landed after this test was written) leaves only bugfix ticking:
    // clean and dry defer after their nothing-to-do startup ticks, so without a landing there
    // is no queued work for the grow to admit and no overlap can ever form — phase 2 would
    // then pass only by racing the startup burst's tail. Land work to wake the deferred roles:
    // with cap 2 at least two of them tick concurrently, making the overlap deterministic.
    landWork(repo);
    // 60s, not the 20s default: this is the one assertion in the suite that waits on the
    // orchestrator's real poll loop scheduling two live pi shims at once, and under the load the
    // fleet runs it at, 20s expired before the grow was observable (BUGS.md 2026-09-18).
    await waitFor(() => readSamples(runDir).some((n) => n >= 2), "overlapping runs after the grow", 150_000);

    // Phase 3 (cap 1 again): shrinking admits no NEW concurrent run until in-flight work
    // finishes. Every sample recorded from the change onward must be <= 1 — a cap that was
    // not applied would let the fast roles overlap again within a few polls.
    const shrink = fastConfig(["clean", "dry", "bugfix"]);
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
    const changes = readEvents(repo).filter((e) => e.type === "max_concurrent_changed");
    assert.equal(changes.length, 2);
    assert.deepEqual(
      changes.map((c) => [c.loop, c.from, c.to]),
      [
        ["harness", 1, 2],
        ["harness", 2, 1],
      ],
    );
  } finally {
    restore();
    await orch.stop();
  }
});
