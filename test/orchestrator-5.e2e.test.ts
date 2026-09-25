/** The orchestrator e2e tier, fifth slice (see orchestrator.e2e.test.ts for the split): a
 * landing's reviewer run sharing the maxConcurrent permit with role ticks, and a work-role tick
 * jumping ahead of parked maintenance waiters. Like the rest of the tier it waits on real
 * timers and runs via `npm run test:e2e`, not in the gating `npm test`. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../src/config.js";
import { initProject } from "../src/init.js";
import { readEvents } from "../src/events.js";
import {
  assistantLine,
  fakePi,
  FAST_POLL_MS,
  fastConfig,
  makeRepo,
  readSamples,
  startLiveOrchestrator,
  tmpdir,
  waitFor,
} from "./util.js";

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
      `case "$PWD" in`,
      `*_land-clean*)`,
      `  sleep 3`,
      `  printf '%s\\n' '${assistantLine("VERDICT: approve")}'`,
      `  ;;`,
      `*clean*)`,
      `  echo change >> clean-change.txt`,
      `  sleep 1`,
      `  printf '%s\\n' '${assistantLine("clean work\nSUMMARY: add clean change")}'`,
      `  ;;`,
      `*)`,
      `  sleep 1.5`,
      `  printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `  ;;`,
      `esac`,
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
    restore();
    await orch.stop();
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
    restore();
    await orch.stop();
  }
});

// --- Reset counters while running (tumwater reset-counters marker) ---
