import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { HarnessEventInput } from "../src/events.js";
import { mainIsGreen } from "../src/main-baseline.js";
import {
  autoRestartRecord,
  type AutoRestartRecord,
  redeployDeps,
  RESTART_COOLDOWN_MS,
  RESTART_EXIT_CODE,
} from "../src/redeploy.js";
import {
  BUILD,
  CFG,
  HEAD_B,
  HEAD_C,
  IDLE,
  driveToRestart,
  fakeDeps,
  harness,
  settle,
} from "./redeploy-fixtures.js";
import { autoRestartStampPath, mirrorWorktreePath } from "../src/paths.js";
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

test("a compile that never ran is a rejection, not a verdict: retried instead of blocked", async () => {
  // `tsc exited ENOENT` is execFile's spawn-failure code, not a compiler exit: the compile said
  // nothing about the tree, so latching the head ("no retry until main moves") pins the fleet
  // on the stale build even after the environment recovers (BUGS.md 2026-09-28). Like the
  // REJECTED green check, the episode is dropped and the next poll re-attempts.
  const f = fakeDeps();
  const { r, events, types } = harness(f.deps);
  await r.poll(HEAD_B, IDLE, true);
  f.green(true);
  await settle();
  await r.poll(HEAD_B, IDLE, true);
  f.compiled(false, "could not start the compile: spawn mirror ENOENT", true);
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true), "none", "dropped, not blocked: nothing was verified about the tree");
  assert.deepEqual(types(), ["build_stale", "restart_pending", "warning"]);
  assert.match(String(events.at(-1)!.message), /could not start the rebuild of bbbbbbbb/);
  assert.equal(r.status().restartBlocked, undefined, "no latch: repairing the environment must be enough");
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold", "the next poll re-attempts without main moving");
  f.green(true);
  await settle();
  await r.poll(HEAD_B, IDLE, true);
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true), "restart", "a repaired environment redeploys the same head");
  assert.deepEqual(f.calls.compile, [HEAD_B, HEAD_B]);
});

test("a rejected compile warns once per head, not once per retry", async () => {
  // The rejection path re-attempts on every poll while the environment is broken, so a warning
  // per attempt would flood the digest exactly as the latched ENOENT cluster did (64 in a day).
  // The dedupe key is the head: the same head's repeated rejection stays quiet; a new head that
  // also cannot compile is a new episode and warns again (BUGS.md 2026-09-28). The same key
  // holds the state stream quiet: a retry re-enters "compiling" without ever leaving it, so a
  // second restart_pending per head would pin the digest's newest transition there forever.
  const pending = (head: string) => events.filter((e) => e.type === "restart_pending" && e.head === head).length;
  const f = fakeDeps();
  const { r, events } = harness(f.deps);
  // Each retry emits its own restart_pending; the dedupe claim is about warnings.
  const warnings = () => events.filter((e) => e.type === "warning");
  const rejectOnce = async (head: string) => {
    await r.poll(head, IDLE, true);
    f.green(true);
    await settle();
    await r.poll(head, IDLE, true);
    f.compiled(false, "could not start the compile: spawn mirror ENOENT", true);
    await settle();
    assert.equal(await r.poll(head, IDLE, true), "none", "dropped, not blocked");
  };
  await rejectOnce(HEAD_B);
  assert.equal(warnings().length, 1);
  assert.equal(pending(HEAD_B), 1);
  assert.match(String(warnings()[0]!.message), /could not start the rebuild of bbbbbbbb/);
  await rejectOnce(HEAD_B);
  assert.equal(warnings().length, 1, "the same head's repeated rejection warns once, not per attempt");
  assert.equal(pending(HEAD_B), 1, "and its in-progress state event is logged once, not once per doomed retry");
  assert.deepEqual(f.calls.compile, [HEAD_B, HEAD_B], "and the compile was still re-attempted for the head");
  await rejectOnce(HEAD_C);
  assert.equal(warnings().length, 2, "a different head is a new episode and warns again");
  assert.equal(pending(HEAD_C), 1, "the new head's compile start is a fresh state event");
  assert.match(String(warnings().at(-1)!.message), /could not start the rebuild of cccccccc/);
});

test("a swap failure is reported and blocks like a compile failure", async () => {
  const f = fakeDeps({
    swap: () => {
      throw new Error("EACCES: dist is read-only");
    },
  });
  const { r, events } = harness(f.deps);
  await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true);
  f.green(true);
  await settle();
  await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true);
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none");
  assert.match(String(events.at(-1)!.message), /swapping the new build into place failed: EACCES/);
  assert.equal(r.status().restartBlocked, "swapping the new build into place failed");
});

// The tracked background promises are documented to never reject (mainIsGreen and compileStaged
// both catch internally), but a regression can still let one through, and the two tracked checks
// are treated differently: a REJECTED green check is a "could not run", not a red verdict — drop
// the pending head, warn once, retry on the next poll (BUGS.md 2026-09-16); a rejected compile
// is a failed step and blocks with its error text. These drive track()'s rejection handler,
// which the resolved-failure tests above cannot reach.

test("a thrown green check is a 'could not run': drop, warn once, retry — no latched red", async () => {
  let checks = 0;
  const f = fakeDeps({
    mainGreen: () => {
      checks++;
      return Promise.reject(new Error("baseline check blew up"));
    },
  });
  const { r, events } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold");
  await settle(); // the rejection lands in the tracked slot
  assert.equal(await r.poll(HEAD_B, IDLE, true), "none", "a thrown check ends the hold without a verdict");
  assert.deepEqual(events.map((e) => e.type), ["build_stale", "warning"]);
  assert.match(
    String(events.at(-1)!.message),
    /green check of bbbbbbbb could not run: baseline check blew up/,
  );
  assert.equal(r.status().restartBlocked, undefined, "no latched block");
  // The next poll re-checks the same head instead of waiting for main to move — a retry, not a latch.
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold");
  assert.equal(checks, 2, "the green check re-ran");
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true), "none");
  assert.equal(events.filter((e) => e.type === "warning").length, 1, "one warning per episode");
});

test("a green check that fails once and then recovers still reaches the swap: the fleet self-heals", async () => {
  let checks = 0;
  const f = fakeDeps({
    mainGreen: () => {
      checks++;
      return checks === 1 ? Promise.reject(new Error("git broke mid-check")) : Promise.resolve(true);
    },
  });
  const { r, events } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold");
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true), "none", "first check failed: dropped, not blocked");
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold", "retry starts");
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold", "recovered check is green: the compile starts");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true), "restart");
  assert.equal(checks, 2);
  assert.deepEqual(f.calls.compile, [HEAD_B]);
  assert.deepEqual(f.calls.swap, [HEAD_B]);
  assert.deepEqual(events.map((e) => e.type), ["build_stale", "warning", "restart_pending", "restart"]);
});

test("a thrown compile is a rejection, not a verdict: its error text rides the warning, nothing is latched", async () => {
  // The production deps.compile wraps the mirror worktree checkout around compileStaged
  // (src/redeploy.ts), so an environment failure there — a git lock, a full disk — surfaces as
  // a REJECTED promise, not the rejected flag a spawn failure inside tsc's own run produces.
  // Same class, different shape: it says nothing about the tree, so it must be retried, not
  // latched, or the fleet stays pinned on the stale build after the environment recovers
  // (BUGS.md 2026-09-28). The warning still carries compiled.error — the "compile threw"
  // fallback would hide what actually broke.
  const f = fakeDeps({
    mainGreen: async () => true,
    compile: () => Promise.reject(new Error("tsc exploded")),
  });
  const { r, events } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold");
  await settle(); // green resolves; the next poll starts the compile
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold", "compile runs in the background");
  await settle(); // the rejection lands in the tracked slot
  assert.equal(await r.poll(HEAD_B, IDLE, true), "none", "dropped, not blocked: nothing was verified about the tree");
  assert.deepEqual(events.map((e) => e.type), ["build_stale", "restart_pending", "warning"]);
  assert.match(String(events.at(-1)!.message), /rebuild of bbbbbbbb could not run: tsc exploded — retrying on the next poll/);
  assert.equal(r.status().restartBlocked, undefined, "no latch: repairing the environment must be enough");
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold", "the next poll re-attempts without main moving");
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

// --- The sustained-pin escalation (BUGS.md 2026-09-29) -------------------------------------
// The 2026-09-28/29 incident: build 66afeacd stayed 362 commits behind a churning main for
// 24+ h while every rebuild died with `tsc exited ENOENT`, and the response — one per-head
// "rebuild of <sha> failed" warning — never said the pin itself was the story. These tests
// drive that shape over simulated hours: the escalation is keyed to the stale EPISODE (not to
// any one head), so it fires under churn, under a frozen main, and at a refused boot gate, and
// never under healthy churn or a red main.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The sustained-pin warning, identified by its message so the per-head block/cooldown/refusal
 * warnings around it never confuse the count. */
const escalations = (events: HarnessEventInput[]) =>
  events.filter((e) => e.type === "warning" && String(e.message ?? "").includes("stayed stale"));

/** A fast settle for the long simulated-hours loops: one macrotask turn is enough for the
 * tracked green/compile promises (both resolve immediately in these fakes). */
const tick = () => new Promise((r) => setImmediate(r));

test("the incident shape — a failing compile verdict on every head while main churns every 5 minutes — escalates once at 6 h, then daily", async () => {
  // Every head's compile produces a real verdict: the build is bad. Main moves every 5 minutes,
  // so each head runs hold → compile → block and leaves its own per-head warning behind — the
  // 109-warnings shape — while the pin itself persists across every head.
  const f = fakeDeps({
    mainGreen: async () => true,
    compile: async () => ({ ok: false, detail: "tsc exited ENOENT" }),
  });
  const { r, events } = harness(f.deps);
  let t = 0;
  for (let i = 1; i <= 31 * 60; i++) {
    t = i * MINUTE;
    const head = `churn${String(Math.floor(t / (5 * MINUTE))).padStart(4, "0")}`.padEnd(40, "0");
    await r.poll(head, IDLE, true, t);
    await tick();
  }
  const es = escalations(events);
  assert.equal(es.length, 2, `expected 2 escalations over 31 h, got ${es.length}`);
  assert.match(String(es[0]?.message), /stayed stale for ~6 h/);
  assert.match(String(es[1]?.message), /stayed stale for ~30 h/);
  assert.match(String(es[0]?.message), /the sustained pin itself is the problem/);
  // The escalation does not replace the per-head warnings; it sums them up beside them.
  assert.ok(events.filter((e) => e.type === "warning").length > 300, "the churn kept warning per head");
});

test("a blocked head on a frozen main escalates the pin once at 6 h, then daily — even though no new failure ever lands", async () => {
  const f = fakeDeps();
  const { r, events } = harness(f.deps);
  let t = 0;
  // One failed compile verdict latches the block; the clock then runs on staleness alone.
  assert.equal(await r.poll(HEAD_B, IDLE, true, (t += MINUTE)), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true, (t += MINUTE)), "hold", "the compile starts");
  f.compiled(false, "tsc exited 2");
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true, (t += MINUTE)), "none", "the verdict blocks the head");
  assert.equal(await r.poll(HEAD_B, IDLE, true, (t = 6 * HOUR)), "none");
  assert.equal(escalations(events).length, 0, "quiet below the threshold");
  assert.equal(await r.poll(HEAD_B, IDLE, true, (t = 6 * HOUR + 2 * MINUTE)), "none");
  assert.equal(escalations(events).length, 1, "one escalation past 6 h");
  assert.match(String(escalations(events)[0]?.message), /stayed stale for ~6 h/);
  const first = t;
  assert.equal(await r.poll(HEAD_B, IDLE, true, (t = first + 24 * HOUR - MINUTE)), "none");
  assert.equal(escalations(events).length, 1, "daily cadence, not per poll");
  assert.equal(await r.poll(HEAD_B, IDLE, true, (t = first + 24 * HOUR + MINUTE)), "none");
  assert.equal(escalations(events).length, 2, "the repeat fires a day later");
  assert.match(String(escalations(events)[1]?.message), /stayed stale for ~30 h/);
});

test("a red main is a correct deferral, not a failure: it never escalates the pin", async () => {
  const f = fakeDeps({ mainGreen: async () => false });
  const { r, events } = harness(f.deps);
  let t = 0;
  assert.equal(await r.poll(HEAD_B, IDLE, true, (t += MINUTE)), "hold");
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true, (t += MINUTE)), "none", "the red verdict blocks");
  for (let h = 0; h < 12; h++) await r.poll(HEAD_B, IDLE, true, (t += HOUR));
  assert.equal(escalations(events).length, 0, "no failed restart attempt, no escalation");
  assert.ok(events.some((e) => e.type === "warning" && String(e.message ?? "").includes("is red")));
});

test("healthy churn — restarts landing inside the cooldown window — never escalates", async () => {
  let swappedHead: string | null = null;
  const f = fakeDeps({
    staleness: async (h) => (h === swappedHead ? { stale: false, aheadCommits: 0 } : { stale: true, aheadCommits: 5 }),
    mainGreen: async () => true,
    compile: async () => ({ ok: true, detail: "" }),
    swap: (h) => {
      swappedHead = h;
    },
  });
  const { r, events } = harness(f.deps);
  let t = 0;
  for (let i = 1; i <= 31 * 60; i++) {
    t = i * MINUTE;
    const head = `healthy${String(Math.floor(t / (5 * MINUTE))).padStart(4, "0")}`.padEnd(40, "0");
    await r.poll(head, IDLE, true, t);
    await tick();
  }
  assert.ok(events.filter((e) => e.type === "restart").length >= 2, "the churn landed restarts");
  assert.equal(escalations(events).length, 0, "cooldown deferrals and landings are not a pin");
});

test("a pin sustained purely at the boot gate escalates too — both gate asks share refuse, so neither can be forgotten", async () => {
  const f = fakeDeps({ bootProblem: async () => "pi is not on PATH" });
  const { r, events } = harness(f.deps);
  let t = 0;
  for (let i = 1; i <= 7 * 60; i++) {
    t = i * MINUTE;
    await r.poll(HEAD_B, IDLE, true, t);
    await tick();
  }
  assert.equal(events.filter((e) => e.type === "restart_refused").length, 1, "one refusal reason, warned once");
  const es = escalations(events);
  assert.equal(es.length, 1, "the refusals feed the pin clock");
  assert.match(String(es[0]?.message), /stayed stale for ~6 h/);
});
