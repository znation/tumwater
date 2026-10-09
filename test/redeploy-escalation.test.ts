import test from "node:test";
import assert from "node:assert/strict";
import type { HarnessEventInput } from "../src/events/events.js";
import { HEAD_B, IDLE, fakeDeps, harness, settle } from "./fixtures/redeploy-fixtures.js";
import { flushImmediate } from "./helpers/wait.js";

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
    await flushImmediate();
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
    await flushImmediate();
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
    await flushImmediate();
  }
  assert.equal(events.filter((e) => e.type === "restart_refused").length, 1, "one refusal reason, warned once");
  const es = escalations(events);
  assert.equal(es.length, 1, "the refusals feed the pin clock");
  assert.match(String(es[0]?.message), /stayed stale for ~6 h/);
});
