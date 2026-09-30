/** The operator pause gate's e2e tier slice (extracted from orchestrator-2.e2e.test.ts): the
 * fleet-wide pause marker (`tumwater pause` writes it, `resume` removes it) and its narrower
 * per-role sibling, observed on a live orchestrator. The CLI side of both is pinned in
 * test/cli.test.ts. Like the other topic-named orchestrator files (orchestrator-resize,
 * orchestrator-permits), this file holds one coherent topic; the tier's balanced slices are
 * orchestrator-2/3.e2e.test.ts. Each test file gets its own process — and its own PATH, which
 * fakePi's global PATH swap requires. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { enqueuePrompt } from "../src/inbox.js";
import { readEvents } from "../src/event-read.js";
import { loadLoopState } from "../src/loop-state.js";
import { pauseRole, resumeRole } from "../src/fleet-state.js";
import { DIRECTOR_ROLE } from "../src/roles.js";
import { pausedPath } from "../src/paths.js";
import { eventsOfType, writeMarker } from "./log-fixtures.js";
import { awaitSettledTick, makeFastRepo, startIdleOrchestrator, startLiveOrchestrator, stopOrchestrator } from "./orchestrator-fixtures.js";
import { sh } from "./repo-fixtures.js";
import { fakePi, fakePiIdle } from "./fake-pi.js";
import { waitFor } from "./wait.js";
import { APPROVE_PI, assistantLine } from "./pi-events.js";

const FAST_POLL_MS = 100;

test("a pause marker blocks new role ticks for any reason while the director runs; resume unblocks", async () => {
  const repo = await makeFastRepo("operator pause e2e test", ["clean", "director"]);
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    // Baseline: clean's startup tick lands while unpaused.
    await awaitSettledTick(repo, "clean", 1, "the startup tick to finish");

    // The operator pauses the running fleet (what `tumwater pause` does: drop the marker).
    const marker = pausedPath(repo);
    writeMarker(marker, { at: Date.now() });
    await waitFor(() => readEvents(repo).some((e) => e.type === "fleet_paused"), "a fleet_paused event");

    // The world changed under a paused fleet: advance main. An ungated loop would wake early…
    fs.writeFileSync(path.join(repo, "world.txt"), "changed\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "advance main while paused");

    // …but the gate skips role runners before eligibility is even evaluated: several (fast)
    // poll cycles pass with no tick and no wake for clean. The marker itself survives — it
    // is persistent state, not a one-shot request like the abort/reset markers.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "a user-paused role starts no new ticks");
    assert.ok(
      !readEvents(repo).some((e) => e.type === "wake" && e.loop === "clean"),
      "no wake logged for the blocked main move",
    );
    assert.ok(fs.existsSync(marker), "the pause marker is persistent state, not consumed");

    // The director is exempt: a queued human prompt still runs while the fleet is paused.
    enqueuePrompt(repo, "steer me while the fleet is paused");
    await awaitSettledTick(repo, "director", 1, "the director to tick while user-paused");
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "still paused after the director's run");

    // Removing the marker mid-run (what `tumwater resume` does) lifts the pause on the next
    // poll: one transition event, then the blocked role ticks again without a restart.
    fs.rmSync(marker);
    await waitFor(() => readEvents(repo).some((e) => e.type === "fleet_resumed"), "a fleet_resumed event");
    await awaitSettledTick(repo, "clean", 2, "the paused role to tick again after resume");

    // Exactly one of each transition for the whole run — no per-poll event spam.
    assert.equal(eventsOfType(repo, "fleet_paused").length, 1);
    assert.equal(eventsOfType(repo, "fleet_resumed").length, 1);
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

// The persistence bullet of the same plan: pausing while stopped, then starting. The marker
// is the only state involved — a fleet that starts already paused stays blocked until resume,
// with no restart and no loop-state or config changes.
test("starting already paused keeps role ticks blocked until resume — no restart needed", async () => {
  const repo = await makeFastRepo("operator pause at startup test", ["clean", "director"]);
  const restore = fakePiIdle();

  // The operator paused before starting the fleet (the marker is persistent state): startup
  // itself must not start any role tick.
  const marker = pausedPath(repo);
  writeMarker(marker, { at: Date.now() });

  // A queued director prompt runs even on an already-paused fleet — the exemption holds from
  // the first poll, not just mid-run.
  enqueuePrompt(repo, "steer me before the fleet starts");

  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await awaitSettledTick(repo, "director", 1, "the director to tick while the fleet starts paused");

    // Several fast poll cycles pass with zero role ticks — startup is a wake reason like any
    // other, and the gate sits before eligibility. The marker survives: persistent state.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "an already-paused role starts no ticks");
    assert.ok(fs.existsSync(marker), "the marker survives startup — not consumed");

    // Resume without a restart: the blocked role ticks on its next eligibility.
    fs.rmSync(marker);
    await awaitSettledTick(repo, "clean", 1, "the paused role to tick after resume");

    // One transition event per direction for the whole run — including the startup read.
    assert.equal(eventsOfType(repo, "fleet_paused").length, 1);
    assert.equal(eventsOfType(repo, "fleet_resumed").length, 1);
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

// The in-flight bullet of the same plan: a tick already running when the marker drops is not
// killed — it finishes and lands its outcome even though no new one starts.
test("an in-flight tick finishes and lands while the fleet is paused", async () => {
  const repo = await makeFastRepo("operator pause in-flight test", ["clean"]);
  // A slow fake pi that makes a real change: it stays in flight long enough for the marker to
  // drop mid-run. The review gate approves with zero usage so the tick's outcome is clean.
  const restore = fakePi(
    [
      APPROVE_PI,
      `sleep 1`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // Wait for the tick to be in flight (running is persisted before pi starts)…
    await waitFor(
      () => loadLoopState(repo, "clean").running === true,
      "the tick to be in flight",
    );

    // …and pause mid-run. The gate blocks only NEW ticks — it never kills an in-flight one.
    const marker = pausedPath(repo);
    writeMarker(marker, { at: Date.now() });

    // The in-flight tick finishes (commit + pin + enqueue) and the landing slot drains the
    // entry to main — both despite the pause: a queued landing is committed work awaiting
    // completion, not a new tick, so the pause gate deliberately does not hold it.
    await waitFor(
      () => loadLoopState(repo, "clean").lastResult === "changed",
      "the in-flight landing to finish",
    );
    const s = loadLoopState(repo, "clean");
    assert.equal(s.ticks, 1, "exactly one tick started");
    assert.equal(s.lastResult, "changed", "the outcome lands despite the pause");
    assert.ok(fs.existsSync(path.join(repo, "hello.txt")), "the change merged to main");

    // …and no new tick starts while the marker holds.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "no second tick while paused");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

// --- Per-role pause (`tumwater pause --role <id>`): the operator pause's narrower sibling.
// The marker is persistent state, so pausing BEFORE startup starts the fleet with that one
// role already gated; the director is NOT exempt (unlike the fleet pause); resume re-enables
// within one poll. Each crossing logs exactly one harness-level event naming the role. ---

test("a per-role pause gates only that role, holds a named director, and resumes", async () => {
  const repo = await makeFastRepo("per-role pause test", ["clean", "dry"]);
  // Pause clean before startup: the marker survives into the run.
  pauseRole(repo, "clean");
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    // The unpaused role ticks normally while the paused one never starts.
    await awaitSettledTick(repo, "dry", 1, "the unpaused role to tick");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "a paused role starts no new ticks");

    // One harness-level event per crossing, naming the role — not one per poll.
    const paused = eventsOfType(repo, "role_paused");
    assert.equal(paused.length, 1);
    assert.equal(paused[0]?.loop, "harness");
    assert.equal(paused[0]?.role, "clean");

    // The director is NOT exempt from a per-role pause: its queued prompt waits in the inbox.
    pauseRole(repo, DIRECTOR_ROLE);
    enqueuePrompt(repo, "steer me while the director is paused");
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(
      !readEvents(repo).some((e) => e.type === "tick_start" && e.loop === DIRECTOR_ROLE),
      "a paused director starts no ticks",
    );
    assert.ok(
      readEvents(repo).some((e) => e.type === "role_paused" && e.role === DIRECTOR_ROLE),
      "the director's own crossing is logged",
    );

    // Resume re-enables the role within one poll, with its one resumed event.
    resumeRole(repo, "clean");
    await awaitSettledTick(repo, "clean", 1, "the resumed role to tick");
    const resumed = eventsOfType(repo, "role_resumed");
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0]?.loop, "harness");
    assert.equal(resumed[0]?.role, "clean");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});
