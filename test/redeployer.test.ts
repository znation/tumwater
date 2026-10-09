import test from "node:test";
import { readJson } from "./helpers/json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mainIsGreen } from "../src/baseline/main-baseline.js";
import { autoRestartRecord } from "../src/redeploy/redeploy.js";
import {
  type AutoRestartRecord,
  RESTART_COOLDOWN_MS,
  RESTART_URGENT_COOLDOWN_MS,
  RESTART_EXIT_CODE,
} from "../src/redeploy/redeploy-policy.js";
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
} from "./fixtures/redeploy-fixtures.js";
import { autoRestartStampPath, mirrorWorktreePath } from "../src/paths.js";
import { ensureDetachedWorktree } from "../src/git/worktree.js";
import { headSha, makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { dieMidWrite } from "./helpers/fs-faults.js";
import { projManifest } from "./fakes/fake-commands.js";
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
  assert.equal(warnings.length, 3, "one warning per distinct deadline: ordinary, urgent, then the urgent lapse");
  assert.match(String(warnings[0]!.message), /per 12 h/);
  assert.match(String(warnings[1]!.message), /is red — the cooldown is cut to 15 min/);
  assert.match(String(warnings[2]!.message), /is red, the cooldown was cut to 15 min and that deadline has already passed/);
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

test("a red RUNNING build whose cut deadline already passed proceeds early with a warning, not in silence", async () => {
  // BUGS.md 2026-09-30: the incident's red arrived when the 15 min urgent window it cuts to had
  // already lapsed, so the deferred-branch warning never fired and the fleet restarted hours
  // before its announced 12 h deadline with no event naming why. A lapse the carve-out caused
  // must say so — once per ordinary deadline.
  const f = fakeDeps();
  const { r, events } = harness(f.deps);
  const swappedAt = await driveToRestart(r, f, HEAD_B, 1_000_000);
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 60_000), "none");
  f.red(true);
  await settle();
  // Past the 15 min urgent window, still inside the ordinary 12 h cooldown: the carve-out is
  // what lets this poll into the episode, so it must say so.
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_URGENT_COOLDOWN_MS + 60_000),
    "hold",
    "the red cut the deadline into the past: the episode proceeds now",
  );
  const warnings = events.filter((e) => e.type === "warning");
  assert.equal(warnings.length, 2, "the ordinary cooldown warning, then the early-lapse one");
  assert.match(String(warnings[1]!.message), /is red/);
  assert.match(String(warnings[1]!.message), /already passed/);
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_URGENT_COOLDOWN_MS + 120_000),
    "hold",
    "the episode is pending: the next poll continues it",
  );
  assert.equal(events.filter((e) => e.type === "warning").length, 2, "one warning per cooldown, not per poll");
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
  const stored = readJson(autoRestartStampPath(root)) as { at: number };
  assert.equal(stored.at, secondSwap, "the file holds the LATEST completion for the next process");
});

test("a completion write killed mid-flight leaves the previous timestamp intact", () => {
  const root = tmpdir("auto-restart-atomic-");
  const first = 1_000_000;
  autoRestartRecord(root).record(first);
  assert.equal((readJson(autoRestartStampPath(root)) as { at: number }).at, first, "the seed is on disk");

  // Model a process killed between write and close (SIGKILL, ENOSPC, EIO) at the swap, right
  // before the restart exit: the writer leaves a partial prefix, then throws. The atomic write
  // must surface that failure without replacing the good file, or the respawned fleet boots
  // with lastAt null and skips the 12 h cooldown entirely — restarting again on the next stale
  // head instead of holding to the rate limit.
  const restore = dieMidWrite();
  try {
    assert.throws(
      () => autoRestartRecord(root).record(2_000_000),
      /killed mid-write/,
    );
  } finally {
    restore();
  }
  assert.equal(
    (readJson(autoRestartStampPath(root)) as { at: number }).at,
    first,
    "the torn write never replaced the good timestamp",
  );
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

test("RESTART_EXIT_CODE is EX_TEMPFAIL, distinct from success, fail(), and a forced Ctrl+C", () => {
  assert.equal(RESTART_EXIT_CODE, 75);
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
  const head = headSha(root);
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
