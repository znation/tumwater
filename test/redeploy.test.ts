import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { HarnessEventInput } from "../src/events.js";
import { readBuildInfo } from "../src/build-info.js";
import { mainIsGreen } from "../src/main-baseline.js";
import { autoRestartRecord, createRedeployer, redeployDeps } from "../src/redeploy.js";
import {
  type AutoRestartRecord,
  Redeployer,
  RESTART_COOLDOWN_MS,
  RESTART_URGENT_COOLDOWN_MS,
  RESTART_EXIT_CODE,
} from "../src/redeploy-policy.js";
import {
  BUILD,
  CFG,
  HEAD_B,
  HEAD_C,
  HEAD_D,
  IDLE,
  driveToRestart,
  fakeDeps,
  harness,
  settle,
} from "./redeploy-fixtures.js";
import { autoRestartStampPath, mirrorWorktreePath, witnessWorktreePath } from "../src/paths.js";
import { ensureDetachedWorktree } from "../src/worktree.js";
import { initProject } from "../src/init.js";
import { NOT_INITIALIZED_MESSAGE } from "../src/readiness.js";
import { runStartupProblem } from "../src/startup-gate.js";
import { makeRepo, sh, tmpdir } from "./repo-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { projManifest } from "./fake-commands.js";
test("a non-self-hosted harness never acts, whatever main does", async () => {
  const f = fakeDeps();
  const { r, events } = harness(f.deps, false);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none");
  assert.deepEqual(events, []);
  assert.deepEqual(r.status(), { sha: BUILD.sha, builtAt: 1 }, "no staleness verdict is ever computed");
});

test("a fresh build reports not stale and takes no action", async () => {
  const f = fakeDeps({ stale: { stale: false, aheadCommits: 2 } });
  const { r, events } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none");
  assert.deepEqual(events, []);
  assert.deepEqual(r.status(), { sha: BUILD.sha, builtAt: 1, stale: false, aheadCommits: 2, checkedHead: HEAD_B });
});

test("stale + autoRestart off: one build_stale event, staleness published, no restart", async () => {
  const f = fakeDeps();
  const { r, types } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, false), "none");
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, false), "none", "the verdict is cached per head");
  assert.deepEqual(types(), ["build_stale"], "one event per newly stale head, not one per poll");
  assert.equal(r.status().stale, true);
  assert.deepEqual(f.calls.green, [], "no green check without autoRestart");
});

test("the happy path: hold through the green check and compile, then restart when idle", async () => {
  const f = fakeDeps();
  const { r, events, types } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 2, directorInFlight: 0 }, true), "hold", "the drain starts while the green check runs");
  assert.deepEqual(f.calls.green, [HEAD_B]);
  assert.equal(r.status().restartPending, true, "a stale build with a restart under way says so");
  assert.equal(r.status().restartBlocked, undefined);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 2, directorInFlight: 0 }, true), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 2, directorInFlight: 0 }, true), "hold", "green: the compile starts");
  assert.deepEqual(f.calls.compile, [HEAD_B]);
  assert.deepEqual(types(), ["build_stale", "restart_pending"]);
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 2, directorInFlight: 0 }, true), "hold", "compiled but ticks still in flight");
  assert.deepEqual(f.calls.swap, []);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "restart", "idle: swap and go");
  assert.deepEqual(f.calls.swap, [HEAD_B]);
  const restart = events.at(-1)!;
  assert.equal(restart.type, "restart");
  assert.equal(restart.from, BUILD.sha);
  assert.equal(restart.to, HEAD_B);
  assert.equal(restart.abortedTicks, 0);
});

test("the drain cap aborts in-flight ticks: restart anyway, counting them", async () => {
  const f = fakeDeps();
  const { r, events } = harness(f.deps, true, 1000);
  let now = 100_000;
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, now), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 10)), "hold");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 500)), "hold", "inside the drain window");
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 600)), "restart", "past it: the caller aborts them");
  assert.equal(events.at(-1)!.abortedTicks, 3);
  assert.equal(events.at(-1)!.drainedMs, 1110);
  assert.equal(events.at(-1)!.drainWindowMs, 1000, "no observed samples: the cold-start constant bounds the drain");
});

test("the drain window tracks the observed p75 tick duration, not the cold-start constant", async () => {
  const f = fakeDeps();
  // Cold-start fallback 1000 ms; the fleet's observed p75 is 5000 ms.
  const { r, events } = harness(f.deps, true, 1000);
  const inFlight = { roleInFlight: 3, directorInFlight: 0, roleTickP75Ms: 5000 };
  let now = 200_000;
  assert.equal(await r.poll(HEAD_B, inFlight, true, now), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, inFlight, true, (now += 10)), "hold");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, inFlight, true, (now += 1200)), "hold", "past the cold-start constant but inside the observed p75");
  assert.equal(await r.poll(HEAD_B, inFlight, true, (now += 4000)), "restart", "past the observed p75: the caller aborts them");
  assert.equal(events.at(-1)!.drainWindowMs, 5000);
  assert.equal(events.at(-1)!.abortedTicks, 3);
});

test("a director tick in flight holds past the drain window without a cap; the swap lands once it clears", async () => {
  // The 2026-09-08 incident: median ticks run ~35 min, so a long director prompt routinely
  // outlived the 30-minute drain and was aborted mid-task. A human prompt outranks the redeploy:
  // no swap and no abort until it finishes (BUGS.md).
  const f = fakeDeps();
  const { r, events } = harness(f.deps, true, 1000);
  let now = 100_000;
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 1 }, true, now), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 1 }, true, (now += 50)), "hold");
  f.compiled(true);
  await settle();
  // Far past the window with the prompt still running — a role tick would have been aborted here.
  assert.equal(
    await r.poll(HEAD_B, { roleInFlight: 1, directorInFlight: 1 }, true, (now += 5000)),
    "hold",
    "the director extends the hold without a cap",
  );
  // The prompt finishes; one role tick is still running but its window is long gone — it lands now.
  assert.equal(
    await r.poll(HEAD_B, { roleInFlight: 1, directorInFlight: 0 }, true, (now += 10)),
    "restart",
    "only then does the restart land",
  );
  const ev = events.at(-1)!;
  assert.equal(ev.abortedTicks, 1, "the remaining role tick is counted; the finished director is not");
  assert.ok(Number(ev.drainedMs) > 5000, `a director-extended hold reports its true length (${String(ev.drainedMs)}ms)`);
});

test("a main move during the drain does not restart the clock: the same ticks get one window", async () => {
  // A busy self-hosting fleet merges while it drains — the 2026-09-08 restart superseded its
  // pending head once and then held for 38 minutes under a 30-minute cap (BUGS.md). Nothing new
  // starts during a hold, so the ticks the drain waits on are the ones it began with; a new head
  // inherits the window rather than opening its own.
  const f = fakeDeps();
  const { r, events } = harness(f.deps, true, 1000);
  let now = 100_000;
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, now), "hold", "the drain starts here");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 400)), "hold");
  f.compiled(true);
  await settle();
  // 800 ms in, main moves: the pending restart is superseded, the drain is not.
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 400)), "hold");
  assert.deepEqual(f.calls.green, [HEAD_B, HEAD_C]);
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 100)), "hold", "the new head still needs its own compile");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 200)), "restart", "past the original deadline, not a fresh one");
  assert.deepEqual(f.calls.swap, [HEAD_C], "and it is the new head's build that goes in");
  assert.equal(events.at(-1)!.drainedMs, 1100, "reported from the first hold, not the last head");
});

test("a blocked restart ends the drain: the next one gets its clock back", async () => {
  const f = fakeDeps();
  const { r } = harness(f.deps, true, 1000);
  let now = 100_000;
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, now), "hold");
  f.green(false);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 400)), "none", "red: the fleet schedules again");
  // Main moves long after the old cap would have expired; the new drain still gets its window.
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 5000)), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 10)), "hold");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 10)), "hold", "inside the NEW window, not the abandoned one");
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 1000)), "restart");
});

test("a red main blocks the restart for that head with one warning; a moved main retries", async () => {
  const f = fakeDeps();
  const { r, events, types } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "hold");
  f.green(false);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none");
  assert.deepEqual(types(), ["build_stale", "restart_blocked", "warning"]);
  assert.match(String(events.at(-1)!.message), /is red — holding the restart/);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none", "blocked: no second green check for the same head");
  assert.deepEqual(f.calls.green, [HEAD_B]);
  // Published, not just warned about once: nothing will change until main moves, and a bare
  // `stale: true` cannot be told apart from a restart that is seconds away (BUGS.md).
  assert.equal(r.status().restartBlocked, "main bbbbbbbb is red");
  assert.equal(r.status().restartPending, undefined, "blocked and pending are mutually exclusive");
  // Main moves (a fix landed): the new head gets its own green check.
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 0, directorInFlight: 0 }, true), "hold");
  assert.equal(r.status().restartBlocked, undefined, "the new head starts clean");
  assert.equal(r.status().restartPending, true);
  assert.deepEqual(f.calls.green, [HEAD_B, HEAD_C]);
  assert.deepEqual(types(), ["build_stale", "restart_blocked", "warning"], "still stale relative to the same build: no second build_stale");
});

test("a failed compile keeps the old build running and warns once", async () => {
  const f = fakeDeps();
  const { r, events, types } = harness(f.deps);
  await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true);
  f.green(true);
  await settle();
  await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true);
  f.compiled(false, "tsc exited 2: src/x.ts(1,1): error TS1005");
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none");
  assert.deepEqual(types(), ["build_stale", "restart_pending", "restart_blocked", "warning"]);
  assert.match(String(events.at(-1)!.message), /rebuild of bbbbbbbb failed — staying on build aaaaaaaa: tsc exited 2/);
  assert.equal(r.status().restartBlocked, "rebuild of bbbbbbbb failed");
  assert.deepEqual(f.calls.swap, []);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none", "and stays blocked for this head");
});

test("a blocked restart leaves the state stream: a restart_blocked event beside the warning, once per head", async () => {
  // The digest's Fleet state changes section replays only typed transitions, and the restart
  // episode had one for its start (`restart_pending`) and its two happy/refused endings — but
  // not for `block()`, which warned only. A broken toolchain therefore left the state stream
  // reading "compiling" forever while the warning cluster said the rebuilds had died
  // (BUGS.md 2026-09-28): the block is a terminal state, so it gets its own event.
  const f = fakeDeps();
  const { r, events, types } = harness(f.deps);
  await r.poll(HEAD_B, IDLE, true);
  f.green(true);
  await settle();
  await r.poll(HEAD_B, IDLE, true);
  f.compiled(false, "tsc exited 2: src/x.ts(1,1): error TS1005");
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true), "none");
  assert.ok(types().includes("restart_blocked"), "the block is a typed transition, not only a warning");
  assert.deepEqual(events.find((e) => e.type === "restart_blocked"), {
    loop: "harness",
    type: "restart_blocked",
    from: BUILD.sha,
    to: HEAD_B,
    reason: "rebuild of bbbbbbbb failed",
  });
  assert.equal(await r.poll(HEAD_B, IDLE, true), "none", "stays blocked for this head");
  assert.equal(events.filter((e) => e.type === "restart_blocked").length, 1, "the latch means no poll re-emits it");
});

test("main moving during a pending restart supersedes it: the new head is evaluated afresh", async () => {
  const f = fakeDeps();
  const { r } = harness(f.deps);
  await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true);
  f.green(true);
  await settle();
  await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true); // compiling HEAD_B
  assert.deepEqual(f.calls.compile, [HEAD_B]);
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 0, directorInFlight: 0 }, true), "hold", "new head: a new green check, not a swap of the old compile");
  assert.deepEqual(f.calls.green, [HEAD_B, HEAD_C]);
  f.compiled(true); // HEAD_B's compile finishing late changes nothing
  await settle();
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 0, directorInFlight: 0 }, true), "hold");
  assert.deepEqual(f.calls.swap, [], "the superseded build is never swapped in");
});

test("a forced restart waives the cooldown: the deferred head starts its episode on the next poll", async () => {
  // The dashboard's restart button (PLANS.md 2026-09-30): the operator presses the stale-build
  // alert's refresh icon rather than waiting out the 12 h cooldown. The force clears ONLY the
  // deferral — verify-green, compile, drain, and swap run through the ordinary machinery.
  const f = fakeDeps();
  const { r, types } = harness(f.deps);
  const swappedAt = await driveToRestart(r, f, HEAD_B, 1_000_000);
  assert.equal(
    await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, swappedAt + 60 * 60_000),
    "none",
    "still inside the cooldown: deferring",
  );
  r.forceRestart();
  assert.deepEqual(
    types().filter((t) => t === "restart_forced"),
    ["restart_forced"],
    "one restart_forced event records the operator's hand",
  );
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + 60 * 60_000 + 1),
    "hold",
    "the forced flag consumes the deferral: the episode starts",
  );
  assert.equal(r.status(swappedAt + 60 * 60_000 + 1).restartPending, true);
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 60 * 60_000 + 2), "hold", "the compile starts — the ordinary machinery, not a shortcut");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 60 * 60_000 + 3), "restart", "swap and go");
  assert.deepEqual(f.calls.swap, [HEAD_B, HEAD_C]);
  // The flag is one-shot: the new cooldown after the forced restart defers the next head as usual.
  assert.equal(
    await r.poll(HEAD_D, { roleInFlight: 1, directorInFlight: 0 }, true, swappedAt + 60 * 60_000 + 4),
    "none",
    "one press buys one waiver, not a standing exemption",
  );
});

test("a forced restart still refuses on a blocked head: a red main blocks the forced episode too", async () => {
  const f = fakeDeps();
  const { r, types } = harness(f.deps);
  const swappedAt = await driveToRestart(r, f, HEAD_B, 1_000_000);
  await r.poll(HEAD_C, IDLE, true, swappedAt + 60 * 60_000);
  r.forceRestart();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 60 * 60_000 + 1), "hold");
  f.green(false);
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 60 * 60_000 + 2), "none");
  assert.match(String(r.status(swappedAt + 60 * 60_000 + 2).restartBlocked), /is red/);
  assert.deepEqual(types().filter((t) => t === "restart_blocked"), ["restart_blocked"], "the forced episode blocks through the ordinary path");
  assert.deepEqual(f.calls.swap, [HEAD_B], "no swap happened for the red head");
});

test("a forced restart request evaporates with the pending restart it targeted: a later stale head defers as usual", async () => {
  // The dashboard's restart button waives the cooldown of the restart pending WHEN the operator
  // pressed. If main reverts before the next poll, the build goes fresh and that pending
  // restart evaporates — the press must evaporate with it, not linger armed until some later
  // stale head's poll waives a deferral the operator never saw.
  let staleNow = true;
  const f = fakeDeps({
    staleness: async () => (staleNow ? { stale: true, aheadCommits: 3 } : { stale: false, aheadCommits: 0 }),
  });
  const { r, events } = harness(f.deps);
  const swappedAt = await driveToRestart(r, f, HEAD_B, 1_000_000);
  assert.equal(
    await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, swappedAt + 60 * 60_000),
    "none",
    "HEAD_C pending inside the cooldown: deferring",
  );
  r.forceRestart(); // the operator presses for HEAD_C's pending restart
  // Before the forced poll lands, main reverts to the built sha: the build is fresh, the
  // pending restart evaporates, and the poll exits before the cooldown check.
  staleNow = false;
  assert.equal(await r.poll(BUILD.sha, IDLE, true, swappedAt + 60 * 60_000 + 1), "none", "fresh build: nothing to restart");
  // Main moves again well before the cooldown lapses: a NEW pending restart the operator has
  // not pressed for. The evaporated press must not waive its deferral.
  staleNow = true;
  const beforeHeadD = events.length;
  assert.equal(
    await r.poll(HEAD_D, { roleInFlight: 3, directorInFlight: 0 }, true, swappedAt + 2 * 60 * 60_000),
    "none",
    "the stale press died with HEAD_C's restart: HEAD_D defers inside the cooldown as usual",
  );
  assert.equal(
    events.slice(beforeHeadD).some((e) => e.type === "restart_pending"),
    false,
    "no episode started for HEAD_D",
  );
});

test("a red RUNNING build cuts the cooldown to the urgent window: the episode starts minutes, not 12 h, after the swap", async () => {
  // BUGS.md 2026-09-30 (urgency carve-out): the incident left the fleet executing a build whose
  // own commit was red for the full 12 h cooldown while a fixed main sat one commit ahead. The
  // carve-out defers to a short fixed window instead — long enough that consecutive reds cannot
  // storm, short enough that the fleet stops knowingly running failing code.
  const f = fakeDeps();
  const { r, events } = harness(f.deps);
  const swappedAt = await driveToRestart(r, f, HEAD_B, 1_000_000);
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + 60_000),
    "none",
    "the verdict is still being established: the ordinary deadline stands",
  );
  assert.deepEqual(f.calls.buildRed, [BUILD.sha], "the deferral asks for the running build's verdict, exactly once per SHA");
  f.red(true);
  await settle();
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + 90_000),
    "none",
    "still inside the urgent window after the red lands",
  );
  assert.equal(
    r.status(swappedAt + 90_000).restartBlocked,
    `cooldown until ${new Date(swappedAt + RESTART_URGENT_COOLDOWN_MS).toISOString()} (the running build's own commit is red — cut to 15 min)`,
    "the dashboard publishes the earlier deadline once the red is known",
  );
  f.green(true); // the prewarmed check resolves; the lapse adopts it
  await settle();
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_URGENT_COOLDOWN_MS),
    "hold",
    "the urgent lapse starts the episode — not 12 h later",
  );
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_URGENT_COOLDOWN_MS + 10),
    "hold",
    "the adopted green verdict moves straight to the staged compile",
  );
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_URGENT_COOLDOWN_MS + 20), "restart");
  assert.deepEqual(f.calls.swap, [HEAD_B, HEAD_C]);
  assert.deepEqual(f.calls.green, [HEAD_B, HEAD_C], "the prewarmed verdict is adopted, not re-run");
  const warnings = events.filter((e) => e.type === "warning");
  assert.equal(warnings.length, 2, "one warning per distinct deadline: ordinary, then urgent");
  assert.match(String(warnings[0]!.message), /per 12 h/);
  assert.match(String(warnings[1]!.message), /is red — the cooldown is cut to 15 min/);
});

test("the urgency onset mid-cooldown warns once more with the earlier deadline", async () => {
  // The red verdict is re-consulted on every poll: a deferral first warned at the ordinary 12 h
  // deadline must say so again — once — when the running build's red arrives and the deadline
  // moves earlier (the warning is keyed to the deadline, not a bare once-per-episode flag).
  const f = fakeDeps();
  const { r, events } = harness(f.deps);
  const swappedAt = await driveToRestart(r, f, HEAD_B, 1_000_000);
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 60_000), "none");
  const status = r.status(swappedAt + 60_000);
  assert.equal(
    status.restartBlocked,
    `cooldown until ${new Date(swappedAt + RESTART_COOLDOWN_MS).toISOString()}`,
    "without a red verdict the ordinary deadline stands",
  );
  f.red(true); // the red verdict arrives two minutes into the cooldown, urgent window still open
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 2 * 60_000), "none", "still inside the urgent window");
  const urgentUntil = swappedAt + RESTART_URGENT_COOLDOWN_MS;
  assert.equal(
    r.status(swappedAt + 2 * 60_000).restartBlocked,
    `cooldown until ${new Date(urgentUntil).toISOString()} (the running build's own commit is red — cut to 15 min)`,
    "the earlier deadline is what the dashboard publishes once the red is known",
  );
  const warnings = events.filter((e) => e.type === "warning");
  assert.equal(warnings.length, 2, "one warning per distinct deadline: the ordinary one, then the urgent one");
  assert.match(String(warnings[0]!.message), /per 12 h/);
  assert.match(String(warnings[1]!.message), /is red — the cooldown is cut to 15 min/);
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + 3 * 60_000),
    "none",
    "the same deadline does not warn again",
  );
  assert.equal(events.filter((e) => e.type === "warning").length, 2);
});

test("an unknown or unsettled running-build verdict never triggers the urgent window", async () => {
  // Cold cache, skip, or error: anything short of a settled red keeps the full 12 h cooldown —
  // the carve-out is fail-safe in the direction of the old behaviour.
  const f = fakeDeps();
  const { r } = harness(f.deps);
  const swappedAt = await driveToRestart(r, f, HEAD_B, 1_000_000);
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 60_000), "none");
  f.red(null); // no verdict obtainable (no declared check or environmental skip)
  await settle();
  assert.equal(
    r.status(swappedAt + 90_000).restartBlocked,
    `cooldown until ${new Date(swappedAt + RESTART_COOLDOWN_MS).toISOString()}`,
    "null is not red: the ordinary 12 h deadline stands",
  );
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_URGENT_COOLDOWN_MS),
    "none",
    "the urgent window has lapsed but the ordinary cooldown still defers",
  );
});

test("a red RUNNING build after the urgent window already passed keeps the episode moving", async () => {
  // If the red verdict lands when the urgent window is already over, it must not resurrect a
  // deferral: the episode simply proceeds.
  const f = fakeDeps();
  const { r } = harness(f.deps);
  const swappedAt = await driveToRestart(r, f, HEAD_B, 1_000_000);
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 60_000), "none");
  f.red(true);
  await settle();
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS),
    "hold",
    "the ordinary lapse starts the episode — the red verdict does not resurrect a deferral",
  );
});

test("the completion timestamp survives process restart via its state file", async () => {
  // Auto-restart kills the orchestrator and the supervisor respawns it — the cooldown's start
  // must outlive that exit, so it lives in its own state file, not orchestrator.json (BUGS.md).
  const root = tmpdir();
  assert.equal(autoRestartRecord(root).lastAt, null, "a missing file reads as no completed restart yet");
  const f1 = fakeDeps();
  const h1 = harness(f1.deps, true, undefined, autoRestartRecord(root));
  const swappedAt = await driveToRestart(h1.r, f1, HEAD_B, 2_000_000);
  assert.ok(fs.existsSync(autoRestartStampPath(root)), "the timestamp is written on swap");

  // A second process: a fresh Redeployer reading the same file honors the cooldown...
  const f2 = fakeDeps();
  const h2 = harness(f2.deps, true, undefined, autoRestartRecord(root));
  assert.equal(await h2.r.poll(HEAD_C, IDLE, true, swappedAt + 60 * 60_000), "none", "the respawned process defers the second episode");
  assert.match(String(h2.r.status(swappedAt + 60 * 60_000).restartBlocked ?? ""), /cooldown until/);
  // ...and past the deadline it proceeds, overwriting the file with the new completion.
  const secondSwap = swappedAt + RESTART_COOLDOWN_MS + 20;
  assert.equal(await h2.r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS), "hold", "past the deadline: the green check starts");
  f2.green(true);
  await settle();
  assert.equal(await h2.r.poll(HEAD_C, IDLE, true, secondSwap - 10), "hold", "green: the compile starts");
  f2.compiled(true);
  await settle();
  assert.equal(await h2.r.poll(HEAD_C, IDLE, true, secondSwap), "restart");
  const stored = JSON.parse(fs.readFileSync(autoRestartStampPath(root), "utf8")) as { at: number };
  assert.equal(stored.at, secondSwap, "the file holds the LATEST completion for the next process");
});

test("an unpersistable completion timestamp degrades to no cooldown rather than failing the restart", async () => {
  // record() runs inside poll immediately before it returns "restart": by then the swap has
  // already succeeded and the process exits right after. If persisting threw (disk full,
  // permissions) and the error propagated, a fleet would sit on stale code with no restart —
  // so the catch degrades to no cooldown for the NEXT process instead of failing this one.
  const f = fakeDeps();
  let recordedAt: number | null = null;
  const record: AutoRestartRecord = {
    lastAt: null,
    record(at) {
      recordedAt = at;
      throw new Error("disk full");
    },
  };
  const h = harness(f.deps, true, undefined, record);
  const swappedAt = await driveToRestart(h.r, f, HEAD_B, 2_000_000); // would reject if the throw escaped
  assert.equal(recordedAt, swappedAt, "the timestamp was attempted at the swap");

  // The restart still lands: its event is logged…
  assert.ok(h.types().includes("restart"), `a restart event was logged:\n${JSON.stringify(h.events)}`);
  // …and the in-memory cooldown still defers the next episode within this process.
  assert.equal(
    await h.r.poll(HEAD_C, IDLE, true, swappedAt + 60_000),
    "none",
    "the in-memory cooldown applies even though persistence failed",
  );
});

// The startup gate (BUGS.md 2026-09-23): a green, compiled build that cannot START here — the
// environment fails `tumwater run`'s preconditions, not the code — must never be swapped in.
// On 2026-09-22 one was: its child exited "not initialized" and the supervisor took the whole
// fleet down with it. The gate is asked before the hold and again right before the swap.

test("a successor that could not boot is refused before any hold, once per reason, and a repaired environment proceeds", async () => {
  let problem: string | null = NOT_INITIALIZED_MESSAGE;
  const f = fakeDeps({ bootProblem: async () => problem });
  const { r, events, types } = harness(f.deps);
  let t = 1_000_000;
  for (let i = 0; i < 3; i++)
    assert.equal(await r.poll(HEAD_B, IDLE, true, (t += 10)), "none", "refused: the running generation keeps scheduling");
  assert.deepEqual(types(), ["build_stale", "restart_refused"], "one event per refusal, not one per poll");
  assert.deepEqual(events[1], { loop: "harness", type: "restart_refused", from: BUILD.sha, to: HEAD_B, reason: NOT_INITIALIZED_MESSAGE });
  assert.deepEqual(f.calls.green, [], "nothing past the gate ran: no green check, no compile, no drain");
  assert.equal(r.status(t).restartPending, undefined);
  assert.equal(r.status(t).restartBlocked, `the new build could not start: ${NOT_INITIALIZED_MESSAGE}`);

  // Main moving mid-refusal adds nothing (the gate is head-independent); a different reason is news.
  assert.equal(await r.poll(HEAD_C, IDLE, true, (t += 10)), "none");
  assert.deepEqual(types(), ["build_stale", "restart_refused"]);
  problem = "pi not found on PATH";
  assert.equal(await r.poll(HEAD_C, IDLE, true, (t += 10)), "none");
  assert.deepEqual(types(), ["build_stale", "restart_refused", "restart_refused"]);

  // Repaired: the same head proceeds without main moving again — nothing was latched.
  problem = null;
  assert.equal(await r.poll(HEAD_C, IDLE, true, (t += 10)), "hold", "the gate passes: the episode starts");
  assert.equal(r.status(t).restartBlocked, undefined, "the refusal cleared with the gate");
  assert.equal(r.status(t).restartPending, true);
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, (t += 10)), "hold", "green: the compile starts");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, (t += 10)), "restart");
  assert.deepEqual(f.calls.swap, [HEAD_C]);
});

test("the gate is asked again right before the swap: a successor that stops booting mid-drain is refused and nothing is held while it stays so", async () => {
  let problem: string | null = null;
  const asked: number[] = [];
  const f = fakeDeps({
    bootProblem: async () => {
      asked.push(1);
      return problem;
    },
  });
  const { r, types } = harness(f.deps, true, 60_000);
  const busy = { roleInFlight: 1, directorInFlight: 0 };
  let t = 1_000_000;
  assert.equal(await r.poll(HEAD_B, busy, true, t), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, busy, true, (t += 10)), "hold", "green: the compile starts");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, busy, true, (t += 10)), "hold", "compiled; draining the in-flight tick");
  assert.equal(asked.length, 1, "asked once at the episode start, not on every hold poll");

  // During the drain a landing that was already in flight deletes tumwater.json.
  problem = NOT_INITIALIZED_MESSAGE;
  assert.equal(await r.poll(HEAD_B, IDLE, true, (t += 10)), "none", "drained, but the successor could not boot: no swap");
  assert.deepEqual(f.calls.swap, []);
  assert.deepEqual(types(), ["build_stale", "restart_pending", "restart_refused"]);

  // While it stays unbootable nothing is held and no episode restarts: no green check, no event.
  assert.equal(await r.poll(HEAD_B, busy, true, (t += 10)), "none");
  assert.equal(await r.poll(HEAD_B, busy, true, (t += 10)), "none");
  assert.equal(f.calls.green.length, 1);
  assert.deepEqual(types(), ["build_stale", "restart_pending", "restart_refused"]);

  // Repaired: a fresh, full episode — with a drain of its own, not the refused one's clock.
  problem = null;
  assert.equal(await r.poll(HEAD_B, busy, true, (t += 10)), "hold");
  assert.equal(f.calls.green.length, 2, "the new episode re-runs the green check");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, busy, true, (t += 10)), "hold");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, busy, true, (t += 10)), "hold", "in-flight work gets the new episode's drain window");
  assert.equal(await r.poll(HEAD_B, IDLE, true, (t += 10)), "restart");
  assert.deepEqual(f.calls.swap, [HEAD_B]);
});

test("a startup gate that throws refuses fail-closed, naming its error", async () => {
  const f = fakeDeps({
    bootProblem: async () => {
      throw new Error("EACCES: tumwater.json");
    },
  });
  const { r, events } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, IDLE, true), "none");
  assert.equal(events.at(-1)!.type, "restart_refused");
  assert.match(String(events.at(-1)!.reason), /the startup check could not run: EACCES: tumwater\.json/);
});

test("the incident repro through the production gate: a ready repo whose tumwater.json vanishes refuses the restart until it returns", async () => {
  // BUGS.md 2026-09-23's repro, minus the fleet: the same runStartupProblem cmdRun runs, asked
  // on behalf of the successor. Pre-fix nothing asked it and the swap went ahead.
  const repo = makeRepo();
  await initProject(repo, "startup gate repro");
  const restore = fakePi("exit 0");
  try {
    const f = fakeDeps({ bootProblem: () => runStartupProblem(repo, null) });
    const { r, events } = harness(f.deps);
    const config = path.join(repo, "tumwater.json");
    const saved = fs.readFileSync(config, "utf8");
    fs.rmSync(config);
    assert.equal(await r.poll(HEAD_B, IDLE, true), "none");
    assert.equal(events.at(-1)!.type, "restart_refused");
    assert.equal(events.at(-1)!.reason, NOT_INITIALIZED_MESSAGE, "the reason is the one the child would have died with");
    fs.writeFileSync(config, saved);
    assert.equal(await r.poll(HEAD_B, IDLE, true), "hold", "the config is back: the restart proceeds");
  } finally {
    restore();
  }
});

test("RESTART_EXIT_CODE is EX_TEMPFAIL, distinct from success, fail(), and a forced Ctrl+C", () => {
  assert.equal(RESTART_EXIT_CODE, 75);
});

test("the production mainGreen wiring runs the real check in a fresh mirror and logs the baseline event", async () => {
  // createRedeployer's own closures never ran under test: isSelfHosted pins it to the repo the
  // running build was stamped in (a fixture never reads as self-hosted), so the unit tier drove
  // Redeployer with scripted deps while the real wiring — mirror worktree, live config read,
  // baseline build_check event — executed only inside a live daemon whose main actually moved.
  // redeployDeps is that wiring, exposed: a real repo, the real npm check, green and red alike.
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ test: "node -e 'process.exit(0)'" }),
  );
  fs.mkdirSync(path.join(root, "node_modules")); // untracked install marker detectBuildCheck walks up to
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "project");
  const greenHead = sh(root, "git", "rev-parse", "HEAD");

  const events: HarnessEventInput[] = [];
  const deps = redeployDeps(root, { sha: greenHead, builtAt: 1, root }, (e) => events.push(e), async () => null);
  assert.equal(await deps.mainGreen(greenHead), true, "a passing suite reads green");

  // A red main reads false — the verdict the restart gate blocks a swap on.
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ test: "node -e 'process.exit(1)'" }),
  );
  sh(root, "git", "commit", "-aqm", "break the suite");
  const redHead = sh(root, "git", "rev-parse", "HEAD");
  assert.equal(await deps.mainGreen(redHead), false, "a failing suite reads red");

  // Each check priced exactly one baseline build_check event through the wiring's own log —
  // the feed's record that the fleet spent this minute verifying its successor.
  const baseline = events.filter((e) => e.type === "build_check" && e.scope === "baseline");
  assert.deepEqual(
    baseline.map((e) => [e.status, e.loop, e.script]),
    [
      ["passed", "harness", "test"],
      ["failed", "harness", "test"],
    ],
  );
  // The mirror worktree the closure created is real and repointed at each asked head.
  assert.equal(
    sh(mirrorWorktreePath(root), "git", "rev-parse", "HEAD"),
    redHead,
    "the mirror sits at the head its check verified",
  );

  // The urgency carve-out's verdict source (BUGS.md 2026-09-30): the red for redHead is already
  // cached (the mainGreen call above paid for it), so buildRed answers without running anything.
  const baselineCountAfterWarm = events.filter((e) => e.type === "build_check" && e.scope === "baseline").length;
  assert.equal(await deps.buildRed(redHead), true, "a cached red verdict reads red without running anything");
  assert.equal(await deps.buildRed(greenHead), false, "a cached green verdict reads not red");
  assert.equal(
    events.filter((e) => e.type === "build_check" && e.scope === "baseline").length,
    baselineCountAfterWarm,
    "cached verdicts cost no new suite run",
  );

  // Cold-cache recovery: a third commit no check has ever seen in this process. buildRed must
  // establish the verdict from the tree itself — one suite run in the witness worktree — instead
  // of waiting for role ticks that will never baseline a SHA that is no longer main's tip.
  sh(root, "git", "commit", "-q", "--allow-empty", "-m", "another red tree, never baselined");
  const coldRedHead = sh(root, "git", "rev-parse", "HEAD");
  assert.equal(await deps.buildRed(coldRedHead), true, "a cold-cache red verdict is established by the witness check");
  assert.equal(
    sh(witnessWorktreePath(root), "git", "rev-parse", "HEAD"),
    coldRedHead,
    "the witness worktree sits at the build SHA it verified",
  );
  const baselineEvents = events.filter((e) => e.type === "build_check" && e.scope === "baseline");
  assert.equal(baselineEvents.length, baselineCountAfterWarm + 1, "exactly one new suite run — the witness check");
  assert.equal(baselineEvents[baselineEvents.length - 1]!.status, "failed");
  assert.equal(await deps.buildRed(coldRedHead), true, "the second consult reads the cache — no second run");
  assert.equal(
    events.filter((e) => e.type === "build_check" && e.scope === "baseline").length,
    baselineCountAfterWarm + 1,
    "no second suite run",
  );
});

test("createRedeployer composes the production Redeployer from the running build's own stamp", async () => {
  // The composition itself (redeploy.ts's createRedeployer) had never run under test: the unit
  // tier drove Redeployer with scripted deps while the real boot executed only inside a live
  // `tumwater run`. The stamp exists in the test process's dist (stamp-build ran before the
  // suite), so the composition is exercised here against a fixture repo — which never reads as
  // self-hosted, so the wired Redeployer proves inert while still being the production object.
  const root = makeRepo();
  const events: HarnessEventInput[] = [];
  let bootAsks = 0;
  const r = await createRedeployer(root, (e) => events.push(e), async () => {
    bootAsks += 1;
    return null;
  });
  assert.ok(r, "the running dist carries a build stamp during tests");
  assert.ok(r instanceof Redeployer, "the production class, not a test double");
  assert.equal(r.build.sha, readBuildInfo()?.sha, "the stamp read is the running build's own");
  assert.equal(r.selfHosted, false, "a fixture repo is never the build's own repo");

  // Through the real wiring, a non-self-hosted build takes no action on any main move — and
  // never asks the successor's startup gate or writes the restart record, which only a
  // restart decision touches.
  const head = sh(root, "git", "rev-parse", "HEAD");
  assert.equal(await r.poll(head, IDLE, true), "none");
  assert.equal(await r.poll(head, IDLE, true), "none", "the inert verdict is not a one-poll accident");
  assert.deepEqual(events, [], "no build_stale, no restart events");
  assert.deepEqual(
    r.status(),
    { sha: r.build.sha, builtAt: r.build.builtAt },
    "no staleness verdict is ever computed for a foreign repo",
  );
  assert.equal(bootAsks, 0, "the successor's startup gate is asked only on a restart decision");
  assert.ok(!fs.existsSync(autoRestartStampPath(root)), "the restart record is only written by an actual restart");
});

test("buildRed with no declared check answers unknown (null), not not-red", async () => {
  // The urgency carve-out's third verdict: a repo whose check detection finds nothing gives
  // the baseline no verdict at all. The caller must read null as "cannot decide" — reading it
  // as false ("main is green") would drop a red-build deferral on a project whose checks are
  // simply undeclared, restarting onto a build nobody ever verified.
  const root = makeRepo(); // no package.json, no declared check anywhere
  const events: HarnessEventInput[] = [];
  const deps = redeployDeps(root, { sha: "stale", builtAt: 1, root }, (e) => events.push(e), async () => null);
  const head = sh(root, "git", "rev-parse", "HEAD");
  assert.equal(await deps.buildRed(head), null, "no check means no verdict, not a green one");
  assert.deepEqual(events, [], "a null verdict costs no suite run and logs no build_check");
});

test("a toolchain-broken suite leaves no latched block: the skip reads as green and the restart proceeds", async () => {
  // BUGS.md 2026-09-15 end to end: git works (the mirror checkout and the rev-parse key both
  // succeed), the suite runs and dies on the toolchain — pre-fix that read as a RED main and
  // latched the restart until main moved; the fix must let the same episode proceed.
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: 'echo "xcrun: error: missing input"; exit 1' }));
  fs.mkdirSync(path.join(root, "node_modules")); // untracked install marker detectBuildCheck walks up to
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "project");
  const head = sh(root, "git", "rev-parse", "HEAD");
  const mirror = await ensureDetachedWorktree(root, mirrorWorktreePath(root), head);

  const f = fakeDeps({ mainGreen: () => mainIsGreen(mirror, CFG) }); // the production wiring, real check
  const { r, events } = harness(f.deps);
  assert.equal(await r.poll(head, IDLE, true), "hold");
  // The real check runs a full `npm run` — poll as the orchestrator would until the green
  // check settles and the compile starts. Pre-fix the second poll answered "none" with a
  // latched "main is red" instead of ever reaching restart_pending.
  const started = Date.now();
  while (!events.some((e) => e.type === "restart_pending")) {
    assert.equal(await r.poll(head, IDLE, true), "hold", "no block while the green check settles");
    if (Date.now() - started > 60_000) throw new Error("green check did not settle in time");
    await settle();
  }
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(head, IDLE, true), "restart");
  assert.equal(r.status().restartBlocked, undefined, "no latched block — the skip is environmental");
  assert.ok(!events.some((e) => String(e.message ?? "").includes("is red")), "no false red verdict");
});
