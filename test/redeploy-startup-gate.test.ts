import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { NOT_INITIALIZED_MESSAGE } from "../src/readiness.js";
import { runStartupProblem } from "../src/gates/startup-gate.js";
import { BUILD, HEAD_B, HEAD_C, IDLE, fakeDeps, harness, settle } from "./redeploy-fixtures.js";
import { makeRepo } from "./repo-fixtures.js";
import { fakePi } from "./fake-pi.js";

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
