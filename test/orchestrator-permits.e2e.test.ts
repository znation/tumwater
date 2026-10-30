/** The orchestrator e2e tier's shared-permit slice (see orchestrator.e2e.test.ts for the
 * tier's split): a merge's reviewer run sharing the maxConcurrent permit with role runs, and
 * a work-role run jumping ahead of parked maintenance waiters. Renamed here from
 * orchestrator-5.e2e.test.ts (2026-09-29) so the topic has a name instead of a slice number —
 * unlike the tier's balanced orchestrator-2/3 slices, this file holds one coherent topic.
 * Like the rest of the tier it waits on real timers and runs via `npm run test:e2e`, not in
 * the gating `npm test`. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../src/config/config.js";
import { enqueuePrompt } from "../src/inbox/inbox.js";
import { initProject } from "../src/init/init.js";
import { readEvents } from "../src/events/event-read.js";
import { awaitSettledRun, FAST_POLL_MS, fastConfig, readSamples, startLiveOrchestrator, stopOrchestrator } from "./fixtures/orchestrator-fixtures.js";
import { makeRepo, seedOpenBug, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi } from "./fakes/fake-pi.js";
import { awaitQuietHost, waitFor } from "./helpers/wait.js";
import { assistantLine, leasedRoleShell } from "./fixtures/pi-events.js";

function readOrder(runDir: string): string[] {
  try {
    return fs.readFileSync(path.join(runDir, "order.log"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

test("a merge's reviewer run takes the same maxConcurrent permit as a role run", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  // BUGS.md 2026-09-18: the merge drain ran its reviewer outside the author semaphore, so
  // maxConcurrent + 1 merge + 1 director was the real ceiling and a single-GPU backend saw
  // four streams. With one permit, a merge in flight and a role run must never overlap.
  const repo = makeRepo();
  await initProject(repo, "merge shares the maxConcurrent cap");
  const cfg = fastConfig(["clean", "bugfix"]);
  cfg.maxConcurrent = 1;
  saveConfig(repo, cfg);
  // bugfix keeps running every ~1s here; with an empty BUGS.md `## Open` it defers like a
  // maintenance role instead (deferRun), so the open bug keeps it on the every-wake schedule
  // the overlap observation below depends on.
  seedOpenBug(repo);
  const runDir = tmpdir();
  // Each run records how many pi processes were already in flight when it started. clean's
  // author makes a change (so its merge's reviewer actually runs and holds the slot ~3s);
  // bugfix keeps running every ~1s and declares nothing-to-do. Without the permit the reviewer
  // and a bugfix run overlap; the 3s reviewer sleep makes that window unmissable.
  const restore = fakePi(
    [
      `d="${runDir}/runs"; mkdir -p "$d"`,
      `f=$(mktemp "$d/run.XXXXXX")`,
      `n=0; for x in "$d"/run.*; do n=$((n+1)); done`,
      `printf '%s\\n' "$n" >> "${runDir}/samples.log"`,
      `printf '%s\\n' "$n role=\${role:-?} verdict=$(printf '%s' "$*" | grep -c VERDICT)" >> "${runDir}/who.log"`,
      // Role and run kind from the real markers, not the cwd: non-director runs happen in
      // pooled `_slot-<n>` checkouts (worktree-pool), so `case $PWD in *clean*)` can no
      // longer see the role. The role comes from the slot lease; the reviewer's run carries
      // the gate's VERDICT prompt, a run's does not. A `verify` flag routes the branch so
      // `rm -f "$f"` still cleans the reviewer's own file (clearing `f` would leak it and
      // fake a sample-2 overlap on the next run's count).
      leasedRoleShell(),
      `verify=0`,
      `for a in "$@"; do case "$a" in *"VERDICT:"*) verify=1; break;; esac; done`,
      `if [ "$verify" = 1 ]; then`,
      `  sleep 3`,
      `  printf '%s\\n' '${assistantLine("VERDICT: approve")}'`,
      `else`,
      `  if [ "$role" = clean ]; then`,
      `    echo change >> clean-change.txt`,
      `    sleep 1`,
      `    printf '%s\\n' '${assistantLine("clean work\nSUMMARY: add clean change")}'`,
      `  else`,
      `    sleep 1.5`,
      `    printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `  fi`,
      `fi`,
      `rm -f "$f"`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // The contention was real: clean's change merged through its reviewer while bugfix ran.
    // Wait for the merge too, not only the runs: the verify frees its permit when its review
    // ends, and the merge after it (which runs no pi) can log `merge_done` just after bugfix's next
    // run has started.
    await waitFor(
      () => readSamples(runDir).length >= 5 && readEvents(repo).some((e) => e.type === "merge_done" && e.source === "clean"),
      "several pi runs across the merge and role runs, and clean's change merged",
    );
    const samples = readSamples(runDir);
    assert.ok(
      samples.every((n) => n <= 1),
      `a merge and a role run never share the backend at maxConcurrent 1 (samples: ${samples})`,
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a work-role run that becomes due later jumps ahead of maintenance waiters parked in an earlier poll", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  // Cross-poll slot inversion (BUGS.md 2026-09-12): with one slot, the startup poll admits
  // bugfix first and parks clean + dedupe behind it. When bugfix becomes due again (~1s idle
  // backoff) while clean is still in flight, its acquire must jump ahead of the maintenance
  // waiters that parked in an EARLIER poll — plain FIFO would hand clean's freed slot to dedupe.
  const repo = makeRepo();
  await initProject(repo, "cross-poll tier test");
  const base = fastConfig(["clean", "dedupe", "bugfix"]);
  base.maxConcurrent = 1;
  saveConfig(repo, base);
  // bugfix must become due again ~1s after its first no_change run; with an empty BUGS.md
  // `## Open` it defers like a maintenance role instead (deferRun), so the open bug keeps it
  // on the every-wake schedule the jump-ahead assertion depends on.
  seedOpenBug(repo);
  const runDir = tmpdir();
  // Records each run's role (from the slot lease, not the cwd — non-director runs happen in
  // pooled `_slot-<n>` checkouts) and holds ~2s, so the wake order after clean's first
  // release is observable while bugfix stays due.
  const restore = fakePi(
    [
      leasedRoleShell(),
      `printf '%s\\n' "$role" >> "${runDir}/order.log"`,
      `sleep 2`,
      `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => readOrder(runDir).length >= 3, "three role starts");
    const order = readOrder(runDir);
    assert.equal(order[0], "bugfix", "the work tier leads the startup poll (fairOrder)");
    assert.equal(order[1], "clean", "the first-parked maintenance waiter runs next");
    assert.equal(
      order[2],
      "bugfix",
      `bugfix became due while clean was in flight and must jump ahead of parked dedupe (${order})`,
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("the director's run starts immediately while every maxConcurrent slot is busy", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  // The director never queues behind the author semaphore: a user prompt starts right away
  // even when all slots are held (orchestrator-launch.ts's usesSlot — only role runs
  // acquire). With one permit and clean's run holding it for ~5s, the director's run must
  // begin while clean is still in flight — its concurrency sample reads 2, proof it took no
  // permit.
  const repo = makeRepo();
  await initProject(repo, "director bypasses the slot cap");
  const cfg = fastConfig(["clean", "director"]);
  cfg.maxConcurrent = 1;
  saveConfig(repo, cfg);
  const runDir = tmpdir();
  const restore = fakePi(
    [
      `d="${runDir}/runs"; mkdir -p "$d"`,
      `f=$(mktemp "$d/run.XXXXXX")`,
      `n=0; for x in "$d"/run.*; do n=$((n+1)); done`,
      `printf '%s\\n' "$n" >> "${runDir}/samples.log"`,
      // The role from the slot lease, not the cwd (pooled `_slot-<n>` checkouts); the
      // director keeps its own `<role>` worktree and leases no slot, so its lease probe
      // reads empty.
      leasedRoleShell(),
      `printf '%s\\n' "\${role:-director}" >> "${runDir}/order.log"`,
      `case "\${role:-director}" in`,
      `director) ;;`,
      `*) sleep 5 ;;`,
      `esac`,
      `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `rm -f "$f"`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // clean's startup run grabs the only permit and holds it for ~5s; the queued prompt is
    // consumed while that run is still in progress.
    await waitFor(() => readSamples(runDir)[0] === 1, "clean's startup run holding the slot");
    enqueuePrompt(repo, "steer me while clean holds the slot");
    await awaitSettledRun(repo, "director", 1, "the director's run to finish");
    const order = readOrder(runDir);
    const samples = readSamples(runDir);
    assert.equal(order[1], "director", `the director started before clean's second run (${order})`);
    assert.equal(
      samples[1],
      2,
      `the director's run began while clean still held the slot — it never queued (${samples})`,
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

// --- Reset counters while running (tumwater reset-counters marker) ---
