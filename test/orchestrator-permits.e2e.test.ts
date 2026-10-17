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
import { awaitSettledTick, FAST_POLL_MS, fastConfig, readSamples, startLiveOrchestrator, stopOrchestrator } from "./fixtures/orchestrator-fixtures.js";
import { makeRepo, seedOpenBug, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi } from "./fakes/fake-pi.js";
import { waitFor } from "./helpers/wait.js";
import { assistantLine, leasedRoleShell } from "./fixtures/pi-events.js";

function readOrder(runDir: string): string[] {
  try {
    return fs.readFileSync(path.join(runDir, "order.log"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

/** The provider-caps fake pi's census: one `provider providerInFlight totalInFlight` line per
 * run, reading back as the per-provider and whole-fleet in-flight snapshots at that run's start. */
function readProviderSamples(runDir: string): Array<{ provider: string; providerInFlight: number; totalInFlight: number }> {
  try {
    return fs
      .readFileSync(path.join(runDir, "samples.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [provider, a, b] = line.split(" ");
        return { provider: provider ?? "", providerInFlight: Number(a), totalInFlight: Number(b) };
      });
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
      `printf '%s\\n' "$n role=\${role:-?} verdict=$(printf '%s' "$*" | grep -c VERDICT)" >> "${runDir}/who.log"`,
      // Role and run kind from the real markers, not the cwd: non-director runs happen in
      // pooled `_slot-<n>` checkouts (worktree-pool), so `case $PWD in *clean*)` can no
      // longer see the role. The role comes from the slot lease; the reviewer's run carries
      // the gate's VERDICT prompt, a tick's does not. A `vet` flag routes the branch so
      // `rm -f "$f"` still cleans the reviewer's own file (clearing `f` would leak it and
      // fake a sample-2 overlap on the next run's count).
      leasedRoleShell(),
      `vet=0`,
      `for a in "$@"; do case "$a" in *"VERDICT:"*) vet=1; break;; esac; done`,
      `if [ "$vet" = 1 ]; then`,
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
    // The contention was real: clean's change landed through its reviewer while bugfix ticked.
    // Wait for the landing too, not only the runs: the vet frees its permit when its review
    // ends, and the merge after it (which runs no pi) can log `landed` just after bugfix's next
    // tick has started.
    await waitFor(
      () => readSamples(runDir).length >= 5 && readEvents(repo).some((e) => e.type === "merge_done" && e.source === "clean"),
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
  // bugfix first and parks clean + dedupe behind it. When bugfix becomes due again (~1s idle
  // backoff) while clean is still in flight, its acquire must jump ahead of the maintenance
  // waiters that parked in an EARLIER poll — plain FIFO would hand clean's freed slot to dedupe.
  const repo = makeRepo();
  await initProject(repo, "cross-poll tier test");
  const base = fastConfig(["clean", "dedupe", "bugfix"]);
  base.maxConcurrent = 1;
  saveConfig(repo, base);
  // bugfix must become due again ~1s after its first no_change tick; with an empty BUGS.md
  // `## Open` it defers like a maintenance role instead (deferTick), so the open bug keeps it
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

test("the director's tick starts immediately while every maxConcurrent slot is busy", async () => {
  // The director never queues behind the author semaphore: a user prompt starts right away
  // even when all slots are held (orchestrator-launch.ts's usesSlot — only role ticks
  // acquire). With one permit and clean's tick holding it for ~5s, the director's run must
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

test("maxConcurrentPerProvider caps role-tick admission per provider while others run beside (part 2/5)", async () => {
  // plans/provider-concurrency.md §4: the launch pass acquires a keyed lease on the authoring
  // seam's provider, so maxConcurrentPerProvider caps role-tick admission on that provider
  // alone. With maxConcurrent 4 and { omlx: 1 }, two omlx roles must never overlap, while a
  // huggingface role runs beside them, and nothing exceeds the fleet total. Disabled review
  // keeps every pi process here a role tick, so the shim's in-flight census is the role
  // census this part owns (vets count against their provider from part 3/5).
  const repo = makeRepo();
  await initProject(repo, "per-provider concurrency caps");
  const cfg = fastConfig(["feature", "bugfix", "clean"]);
  cfg.maxConcurrent = 4;
  cfg.maxConcurrentPerProvider = { omlx: 1 };
  cfg.review!.enabled = false;
  cfg.roles.feature!.provider = "omlx";
  cfg.roles.feature!.model = "m";
  cfg.roles.bugfix!.provider = "omlx";
  cfg.roles.bugfix!.model = "m";
  cfg.roles.clean!.provider = "huggingface";
  cfg.roles.clean!.model = "hf";
  saveConfig(repo, cfg);
  const runDir = tmpdir();
  const restore = fakePi(
    [
      `d="${runDir}/runs"; mkdir -p "$d"`,
      `prov=""; prev=""; for a in "$@"; do if [ "$prev" = "--provider" ]; then prov="$a"; fi; prev="$a"; done`,
      `[ -n "$prov" ] || prov=unknown`,
      `f=$(mktemp "$d/run.\${prov}.XXXXXX")`,
      `n=0; for x in "$d"/run.\${prov}.*; do n=$((n+1)); done`,
      `t=0; for x in "$d"/run.*; do t=$((t+1)); done`,
      `printf '%s %s %s\\n' "$prov" "$n" "$t" >> "${runDir}/samples.log"`,
      leasedRoleShell(),
      `echo change >> change.txt`,
      `sleep 1.5`,
      `rm -f "$f"`,
      `printf '%s\\n' '${assistantLine("do the work\\nSUMMARY: add a change")}'`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => readProviderSamples(runDir).length >= 12 && readEvents(repo).some((e) => e.type === "merge_done"),
      "several role runs across both providers, and a landing",
      150_000,
    );
    const samples = readProviderSamples(runDir);
    const omlxCounts = samples.filter((s) => s.provider === "omlx").map((s) => s.providerInFlight);
    const totals = samples.map((s) => s.totalInFlight);
    assert.ok(
      omlxCounts.every((n) => n <= 1),
      `at most one omlx role run in flight at a time (samples: ${JSON.stringify(samples)})`,
    );
    assert.ok(
      totals.every((n) => n <= 4),
      `nothing exceeds the fleet total (samples: ${JSON.stringify(samples)})`,
    );
    assert.ok(
      samples.some((s) => s.provider === "huggingface" && s.totalInFlight >= 2),
      `a huggingface role ran beside an omlx run (samples: ${JSON.stringify(samples)})`,
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a vet's reviewer and a role tick on the same capped provider never overlap, while another provider runs beside (part 3/5)", async () => {
  // plans/provider-concurrency.md §4: the landing vet acquires a keyed lease on the author's
  // review seam, so a review on omlx shares the omlx provider cap with role ticks — not just
  // the fleet total (part 2/5's scope, review off). With { omlx: 1 }, feature's omlx tick and
  // the omlx review vetting feature's (or clean's) change never run at once, while the
  // huggingface bugfix tick runs beside them. Review is on, pinned to omlx.
  const repo = makeRepo();
  await initProject(repo, "per-provider caps reach the vet");
  const cfg = fastConfig(["feature", "bugfix", "clean"]);
  cfg.maxConcurrent = 4;
  cfg.maxConcurrentPerProvider = { omlx: 1 };
  cfg.review!.enabled = true;
  cfg.review!.provider = "omlx";
  cfg.review!.model = "m";
  cfg.roles.feature!.provider = "omlx";
  cfg.roles.feature!.model = "m";
  cfg.roles.clean!.provider = "omlx";
  cfg.roles.clean!.model = "m";
  cfg.roles.bugfix!.provider = "huggingface";
  cfg.roles.bugfix!.model = "hf";
  saveConfig(repo, cfg);
  const runDir = tmpdir();
  const restore = fakePi(
    [
      `d="${runDir}/runs"; mkdir -p "$d"`,
      `prov=""; prev=""; for a in "$@"; do if [ "$prev" = "--provider" ]; then prov="$a"; fi; prev="$a"; done`,
      `[ -n "$prov" ] || prov=unknown`,
      `f=$(mktemp "$d/run.\${prov}.XXXXXX")`,
      `n=0; for x in "$d"/run.\${prov}.*; do n=$((n+1)); done`,
      `t=0; for x in "$d"/run.*; do t=$((t+1)); done`,
      `printf '%s %s %s\\n' "$prov" "$n" "$t" >> "${runDir}/samples.log"`,
      leasedRoleShell(),
      `vet=0`,
      `for a in "$@"; do case "$a" in *"VERDICT:"*) vet=1; break;; esac; done`,
      `if [ "$vet" = 1 ]; then`,
      `  printf '%s\\n' '${assistantLine("VERDICT: approve")}'`,
      `else`,
      `  echo change >> change.txt`,
      `  sleep 1.5`,
      `  printf '%s\\n' '${assistantLine("do the work\\nSUMMARY: add a change")}'`,
      `fi`,
      `rm -f "$f"`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => readProviderSamples(runDir).length >= 12 && readEvents(repo).some((e) => e.type === "merge_done"),
      "several role and vet runs across both providers, and a landing",
      150_000,
    );
    const samples = readProviderSamples(runDir);
    const omlxCounts = samples.filter((s) => s.provider === "omlx").map((s) => s.providerInFlight);
    const totals = samples.map((s) => s.totalInFlight);
    assert.ok(
      omlxCounts.every((n) => n <= 1),
      `a vet review and a role tick on omlx never overlap (samples: ${JSON.stringify(samples)})`,
    );
    assert.ok(
      totals.every((n) => n <= 4),
      `nothing exceeds the fleet total (samples: ${JSON.stringify(samples)})`,
    );
    assert.ok(
      samples.some((s) => s.provider === "huggingface" && s.totalInFlight >= 2),
      `a huggingface role ran beside an omlx run (samples: ${JSON.stringify(samples)})`,
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a director prompt on a full provider starts at once and holds the provider's only free slot (part 3/5)", async () => {
  // plans/provider-concurrency.md §4: the director keeps its bypass — it never queues and never
  // counts toward maxConcurrent — but its tick does raise its provider's in-use by one. With
  // { omlx: 1 } and clean holding the omlx slot for ~5s, a director prompt on omlx starts at
  // once (order.log: it runs while clean is in flight) and its own run reads omlx in-flight 2 —
  // the overshoot — and no third omlx run appears until that in-use drains.
  const repo = makeRepo();
  await initProject(repo, "director counts against a full provider");
  const cfg = fastConfig(["clean", "director"]);
  cfg.maxConcurrent = 4;
  cfg.maxConcurrentPerProvider = { omlx: 1 };
  cfg.review!.enabled = false; // keep every pi run a role/director tick: no vet, no resolver
  cfg.roles.clean!.provider = "omlx";
  cfg.roles.clean!.model = "m";
  cfg.roles.director!.provider = "omlx";
  cfg.roles.director!.model = "m";
  saveConfig(repo, cfg);
  const runDir = tmpdir();
  const restore = fakePi(
    [
      `d="${runDir}/runs"; mkdir -p "$d"`,
      `prov=""; prev=""; for a in "$@"; do if [ "$prev" = "--provider" ]; then prov="$a"; fi; prev="$a"; done`,
      `[ -n "$prov" ] || prov=unknown`,
      `f=$(mktemp "$d/run.\${prov}.XXXXXX")`,
      `n=0; for x in "$d"/run.\${prov}.*; do n=$((n+1)); done`,
      `printf '%s %s\\n' "$prov" "$n" >> "${runDir}/samples.log"`,
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
    await waitFor(() => readProviderSamples(runDir)[0]?.providerInFlight === 1, "clean's startup omlx tick holding the cap");
    enqueuePrompt(repo, "steer me while omlx is full");
    await awaitSettledTick(repo, "director", 1, "the director's tick to finish");
    const order = readOrder(runDir);
    const samples = readProviderSamples(runDir);
    assert.equal(order[1], "director", `the director started before clean's second tick (${order})`);
    const directorIdx = order.indexOf("director");
    const directorSample = samples[directorIdx];
    assert.ok(directorSample, "the director's run was counted against omlx");
    assert.equal(
      directorSample.providerInFlight,
      2,
      `the director overshot the full omlx key by one, a grant the cap would have withheld (${JSON.stringify(samples)})`,
    );
    assert.ok(
      samples.filter((s) => s.provider === "omlx").every((s) => s.providerInFlight <= 2),
      `no third omlx run starts while the cap and the director's overshoot both hold (${JSON.stringify(samples)})`,
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("two ticks on one provider and a single worktree slot both finish (pool-slot wait rule, part 4/5)", async () => {
  // plans/provider-concurrency.md §5 "No deadlock": a lease never holds a provider key while it
  // waits for a pool slot. With one pool slot and two omlx roles (cap 2 lets both hold omlx at
  // admission), the second tick parks on the slot and drops its omlx key while it waits; the
  // first releases the slot and both finish. The drop runs inside the tick's provider-lease
  // store (orchestrator-launch wraps runner.tick()), so this reaches the pool-slot drop path
  // in a live orchestrator.
  const repo = makeRepo();
  await initProject(repo, "pool slot serializes one provider");
  const cfg = fastConfig(["feature", "bugfix"]);
  cfg.maxConcurrent = 6;
  cfg.maxConcurrentPerProvider = { omlx: 2 };
  cfg.worktreeSlots = 1;
  cfg.review!.enabled = false;
  cfg.roles.feature!.provider = "omlx";
  cfg.roles.feature!.model = "m";
  cfg.roles.bugfix!.provider = "omlx";
  cfg.roles.bugfix!.model = "m";
  saveConfig(repo, cfg);
  const runDir = tmpdir();
  const restore = fakePi(
    [
      `d="${runDir}/runs"; mkdir -p "$d"`,
      `f=$(mktemp "$d/run.XXXXXX")`,
      leasedRoleShell(),
      `printf '%s\\n' "$role" >> "${runDir}/order.log"`,
      `echo change >> change.txt`,
      `sleep 1`,
      `printf '%s\\n' '${assistantLine("do the work\\nSUMMARY: add a change")}'`,
      `rm -f "$f"`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => readOrder(runDir).length >= 4 && readEvents(repo).some((e) => e.type === "merge_done"),
      "both roles ticking through the one slot, and a landing",
      150_000,
    );
    const roles = readOrder(runDir);
    assert.ok(
      roles.includes("feature") && roles.includes("bugfix"),
      `both omlx roles made progress through the single slot (${roles})`,
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

