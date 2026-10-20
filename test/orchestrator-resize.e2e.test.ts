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
import { fastConfig, readSamples, startLiveOrchestrator, stopOrchestrator } from "./fixtures/orchestrator-fixtures.js";
import { mergeWork, makeRepo, seedOpenBug, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi } from "./fakes/fake-pi.js";
import { waitFor } from "./helpers/wait.js";
import { assistantLine } from "./fixtures/pi-events.js";

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
  // THREE fast-running roles and ONE slot: with three roles competing for one permit, steady
  // state always has at least one run queued on the semaphore (a two-role team settles into
  // a strict alternation where every poll schedules exactly one role, so there would be no
  // queued run for the grow to wake). The shim's ~1.5s hold makes overlapping runs visible.
  const base = fastConfig(["clean", "dedupe", "bugfix"]);
  base.maxConcurrent = 1;
  saveConfig(repo, base);
  // bugfix is one of the three fast-running roles this test needs to keep running between
  // merges; with an empty BUGS.md `## Open` it defers like a maintenance role instead
  // (deferRun), so the open bug keeps it on the every-wake schedule the test was written for.
  seedOpenBug(repo);
  const runDir = tmpdir();
  const restore = concurrencyRecordingFakePi(runDir);
  // Keeps the DEFAULT poll interval on purpose: phase 3's "no overlap after shrink" assertion
  // relies on the shim's ~1.5s hold being shorter than one poll, so every cap-2-era run file is
  // gone by the time the shrink event is observed. A fast poll would let an in-flight file cross
  // the boundary and false-fail the test.
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

test("a live maxConcurrentPerProvider edit admits a parked omlx run and logs its own event", async () => {
  // plans/provider-concurrency.md §7: config-live re-applies the key caps on an edit and fires
  // provider_concurrency_changed per changed provider. All three roles share omlx with cap 1,
  // so a second omlx run meeting the key is parked; growing the cap to 2 admits it (overlap
  // appears) within a poll, and shrinking to 1 preempts nothing (semaphore unit tests pin the
  // never-preempt contract).
  //
  // The roles run nothing-to-do work — no change, hence no merge. A role with a queued or
  // in-flight merge never runs (the merge-queue interlock), so change-producing roles would
  // serialize on the one merge slot and could never overlap on ANY cap: the parked-run
  // admission this test exists for would be unobservable. With no merges to interlock them,
  // moving main wakes the roles deferred after their no-op startup run, putting two due in one
  // poll — one poll's launch pass starts every due run its permits allow — for the cap to
  // admit or park. Mirrors the sibling maxConcurrent test above.
  const repo = makeRepo();
  await initProject(repo, "live per-provider cap resize");
  const cfg = fastConfig(["clean", "dedupe", "bugfix"]);
  cfg.maxConcurrent = 4;
  cfg.maxConcurrentPerProvider = { omlx: 1 };
  cfg.roles.clean!.provider = "omlx";
  cfg.roles.clean!.model = "m";
  cfg.roles.dedupe!.provider = "omlx";
  cfg.roles.dedupe!.model = "m";
  cfg.roles.bugfix!.provider = "omlx";
  cfg.roles.bugfix!.model = "m";
  saveConfig(repo, cfg);
  // bugfix's open bug keeps it on the every-wake schedule; without it bugfix defers like clean
  // and dedupe and the startup burst below never reaches three samples.
  seedOpenBug(repo);
  const runDir = tmpdir();
  const restore = concurrencyRecordingFakePi(runDir);
  const orch = startLiveOrchestrator(repo);
  try {
    // Phase 1 (omlx cap 1): the startup burst runs one at a time — the second omlx run meeting
    // the full key parks, so no sample ever exceeds one concurrent run.
    await waitFor(() => readSamples(runDir).length >= 3, "the startup burst", 60_000);
    assert.ok(
      readSamples(runDir).every((n) => n <= 1),
      `peak stays 1 while the second omlx run waits on its key (samples: ${readSamples(runDir)})`,
    );

    // Phase 2 (omlx cap 2): the live edit admits the parked run — overlap appears, no restart.
    // The parked startup run is the subject: under cap 1 the role that lost the permit waits on
    // the key, and the grow admits it alongside the run already in progress. No wake is needed —
    // and a main move here would re-defer the waiter instead of admitting it — so grow and read.
    const grow = fastConfig(["clean", "dedupe", "bugfix"]);
    grow.maxConcurrent = 4;
    grow.maxConcurrentPerProvider = { omlx: 2 };
    grow.roles.clean!.provider = "omlx";
    grow.roles.clean!.model = "m";
    grow.roles.dedupe!.provider = "omlx";
    grow.roles.dedupe!.model = "m";
    grow.roles.bugfix!.provider = "omlx";
    grow.roles.bugfix!.model = "m";
    saveConfig(repo, grow);
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "provider_concurrency_changed" && e.provider === "omlx" && e.to === 2),
      "the provider_concurrency_changed grow event",
    );
    await waitFor(() => readSamples(runDir).some((n) => n >= 2), "overlapping omlx runs after the grow", 60_000);

    // Phase 3 (omlx cap 1 again): a shrink logs its event and preempts nothing — every run
    // admitted after the shrink is sequential again. Wake the roles once more so there are
    // post-shrink runs to read.
    const shrink = fastConfig(["clean", "dedupe", "bugfix"]);
    shrink.maxConcurrent = 4;
    shrink.maxConcurrentPerProvider = { omlx: 1 };
    shrink.roles.clean!.provider = "omlx";
    shrink.roles.clean!.model = "m";
    shrink.roles.dedupe!.provider = "omlx";
    shrink.roles.dedupe!.model = "m";
    shrink.roles.bugfix!.provider = "omlx";
    shrink.roles.bugfix!.model = "m";
    saveConfig(repo, shrink);
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "provider_concurrency_changed" && e.provider === "omlx" && e.to === 1),
      "the provider_concurrency_changed shrink event",
    );
    const fromShrink = readSamples(runDir).length;
    mergeWork(repo);
    await waitFor(() => readSamples(runDir).length >= fromShrink + 2, "post-shrink runs", 60_000);
    assert.ok(
      readSamples(runDir).slice(fromShrink).every((n) => n <= 1),
      `no new concurrent run after the shrink (samples: ${readSamples(runDir)})`,
    );

    const changes = eventsOfType(repo, "provider_concurrency_changed").filter((e) => e.provider === "omlx");
    assert.deepEqual(
      changes.map((c) => [c.from, c.to]),
      [[1, 2], [2, 1]],
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});
