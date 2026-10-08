/** The orchestrator e2e tier's shared-permit slice (see orchestrator.e2e.test.ts for the
 * tier's split): a landing's reviewer run sharing the maxConcurrent permit with role ticks, and
 * a work-role tick jumping ahead of parked maintenance waiters. Renamed here from
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
import { awaitSettledTick, FAST_POLL_MS, fastConfig, readSamples, startLiveOrchestrator, stopOrchestrator } from "./orchestrator-fixtures.js";
import { makeRepo, seedOpenBug, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi } from "./fakes/fake-pi.js";
import { waitFor } from "./helpers/wait.js";
import { assistantLine, leasedRoleShell } from "./pi-events.js";

function readOrder(runDir: string): string[] {
  try {
    return fs.readFileSync(path.join(runDir, "order.log"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

test("a landing's reviewer run takes the same maxConcurrent permit as a role tick", async () => {
  // BUGS.md 2026-09-18: the landing drain ran its reviewer outside the author semaphore, so
  // maxConcurrent + 1 landing + 1 director was the real ceiling and a single-GPU backend saw
  // four streams. With one permit, a landing in flight and a role tick must never overlap.
  const repo = makeRepo();
  await initProject(repo, "landing shares the maxConcurrent cap");
  const cfg = fastConfig(["clean", "bugfix"]);
  cfg.maxConcurrent = 1;
  saveConfig(repo, cfg);
  // bugfix keeps ticking every ~1s here; with an empty BUGS.md `## Open` it defers like a
  // maintenance role instead (deferTick), so the open bug keeps it on the every-wake schedule
  // the overlap observation below depends on.
  seedOpenBug(repo);
  const runDir = tmpdir();
  // Each run records how many pi processes were already in flight when it started. clean's
  // author makes a change (so its landing's reviewer actually runs and holds the slot ~3s);
  // bugfix keeps ticking every ~1s and declares nothing-to-do. Without the permit the reviewer
  // and a bugfix tick overlap; the 3s reviewer sleep makes that window unmissable.
  const restore = fakePi(
    [
      `d="${runDir}/runs"; mkdir -p "$d"`,
      `f=$(mktemp "$d/run.XXXXXX")`,
      `n=0; for x in "$d"/run.*; do n=$((n+1)); done`,
      `printf '%s\\n' "$n" >> "${runDir}/samples.log"`,
      leasedRoleShell(),
      `if [ "$role" = clean ]; then`,
      `  sleep 3`,
      `  printf '%s\\n' '${assistantLine("VERDICT: approve")}'`,
      `else`,
      `  case "$PWD" in`,
      `  *clean*)`,
      `    echo change >> clean-change.txt`,
      `    sleep 1`,
      `    printf '%s\\n' '${assistantLine("clean work\nSUMMARY: add clean change")}'`,
      `    ;;`,
      `  *)`,
      `    sleep 1.5`,
      `    printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `    ;;`,
      `  esac`,
      `fi`,
      `rm -f "$f"`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // The contention was real: clean's change landed through its reviewer while bugfix ticked.
    // Wait for the landing too, not only the runs: the vet frees its permit when its review
    // ends, and the merge after it (which runs no pi) can log `landed` just after bugfix's next
    // tick has started.
    await waitFor(
      () => readSamples(runDir).length >= 5 && readEvents(repo).some((e) => e.type === "landed" && e.loop === "clean"),
      "several pi runs across the landing and role ticks, and clean's change landed",
    );
    const samples = readSamples(runDir);
    assert.ok(
      samples.every((n) => n <= 1),
      `a landing and a role tick never share the backend at maxConcurrent 1 (samples: ${samples})`,
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a work-role tick that becomes due later jumps ahead of maintenance waiters parked in an earlier poll", async () => {
  // Cross-poll slot inversion (BUGS.md 2026-09-12): with one slot, the startup poll admits
  // bugfix first and parks clean + dry behind it. When bugfix becomes due again (~1s idle
  // backoff) while clean is still in flight, its acquire must jump ahead of the maintenance
  // waiters that parked in an EARLIER poll — plain FIFO would hand clean's freed slot to dry.
  const repo = makeRepo();
  await initProject(repo, "cross-poll tier test");
  const base = fastConfig(["clean", "dry", "bugfix"]);
  base.maxConcurrent = 1;
  saveConfig(repo, base);
  // bugfix must become due again ~1s after its first no_change tick; with an empty BUGS.md
  // `## Open` it defers like a maintenance role instead (deferTick), so the open bug keeps it
  // on the every-wake schedule the jump-ahead assertion depends on.
  seedOpenBug(repo);
  const runDir = tmpdir();
  // Records each role's START (cwd is the role's worktree) so the wake order after clean's
  // first release is observable; ~2s holds keep bugfix due while clean is still in flight.
  const restore = fakePi(
    [
      `printf '%s\\n' "$(basename "$PWD")" >> "${runDir}/order.log"`,
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
      `bugfix became due while clean was in flight and must jump ahead of parked dry (${order})`,
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("the director's tick starts immediately while every maxConcurrent slot is busy", async () => {
  // The director never queues behind the author semaphore: a user prompt starts right away
  // even when all slots are held (orchestrator.ts's usesSlot — only role ticks acquire). With
  // one permit and clean's tick holding it for ~5s, the director's run must begin while clean
  // is still in flight — its concurrency sample reads 2, proof it took no permit.
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
      `printf '%s\\n' "$(basename "$PWD")" >> "${runDir}/order.log"`,
      `case "$PWD" in`,
      `*director*) ;;`,
      `*) sleep 5 ;;`,
      `esac`,
      `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `rm -f "$f"`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // clean's startup tick grabs the only permit and holds it for ~5s; the queued prompt is
    // consumed while that tick is still running.
    await waitFor(() => readSamples(runDir)[0] === 1, "clean's startup tick holding the slot");
    enqueuePrompt(repo, "steer me while clean holds the slot");
    await awaitSettledTick(repo, "director", 1, "the director's tick to finish");
    const order = readOrder(runDir);
    const samples = readSamples(runDir);
    assert.equal(order[1], "director", `the director started before clean's second tick (${order})`);
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
