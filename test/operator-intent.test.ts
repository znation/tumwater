import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  NO_HARNESS_ERROR,
  PAUSE_FOR_MAX_MS,
  markerApplyNote,
  requestAbort,
  requestResetCounters,
  requestWake,
  rolePauseMessage,
  roleResumeMessage,
  submitRolePromptAndWake,
  timedPauseBits,
} from "../src/operator/operator-intent.js";
import { loadLoopState, saveLoopState } from "../src/loop/loop-state.js";
import { orchestratorStatePath, pausedPath, STATE_DIR, wakeRequestPath } from "../src/paths.js";
import { readEvents } from "../src/events/event-read.js";
import { readJsonFile } from "../src/files/json-files.js";
import { writeMarker } from "./fixtures/log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** src/operator/operator-intent.ts's own tests: the marker-writing cores are shared by the CLI, the
 * dashboard's POST routes, and the TUI, so their confirmations and on-disk effects are pinned
 * here once instead of trusting each surface's manual check. */

/** A state dir with no orchestrator info: every liveness check reads false. */
function deadRoot(): string {
  return tmpdir();
}

/** A state dir whose orchestrator info names this very process — pidAlive(process.pid) is
 * trivially true, so every liveness check reads true without spawning anything. */
function liveRoot(): string {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, STATE_DIR, "state"), { recursive: true });
  fs.writeFileSync(
    orchestratorStatePath(root),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["fix"] }),
  );
  return root;
}

function stateOf(root: string, role: string): Record<string, unknown> {
  return readJsonFile(path.join(root, STATE_DIR, "state", `${role}.json`)) ?? {};
}

/** The operator request markers (wake/reset/restart/abort) must be written ATOMICALLY
 * (tmp+rename): a concurrent poll reading a marker mid-write sees a torn file, which
 * readJsonFile folds to null — the corrupt-marker superset that wakes every runner. For a
 * scheduled wake that superset drops notBeforeMs, firing `wake --in` hours early. This pins
 * the write path: the marker lands via fs.rename (writeTextAtomic), never a direct
 * writeFileSync to the marker path. */
test("operator request markers are written atomically (tmp+rename, never a torn write)", () => {
  const root = deadRoot();
  const wakeFile = wakeRequestPath(root);
  const realRename = fs.renameSync;
  const renamed: string[] = [];
  (fs as unknown as { renameSync: unknown }).renameSync = (from: string, to: string) => {
    renamed.push(to);
    return realRename.call(fs, from, to);
  };
  try {
    requestWake(root, ["fix"], 60_000);
  } finally {
    (fs as unknown as { renameSync: unknown }).renameSync = realRename;
  }
  assert.ok(renamed.includes(wakeFile), `expected the wake marker ${wakeFile} to land via rename`);
  // The rename is the last step, so the marker's final content is intact and no tmp remnant
  // is left behind.
  assert.ok(readJsonFile<{ notBeforeMs?: number }>(wakeFile)?.notBeforeMs);
  assert.strictEqual(fs.readdirSync(path.dirname(wakeFile)).filter((f) => f.includes(".tmp-"))
    .length, 0);
});

test("markerApplyNote reports the no-harness tail without an orchestrator info file", () => {
  const n = markerApplyNote(deadRoot());
  assert.equal(n.live, false);
  assert.equal(n.when, "");
  assert.match(n.tail, /next `tumwater run`/);
});

test("markerApplyNote reports a live fleet and the ~2s window when the orchestrator is alive", () => {
  const n = markerApplyNote(liveRoot());
  assert.equal(n.live, true);
  assert.equal(n.when, " within ~2s");
  assert.equal(n.tail, "");
});

test("requestResetCounters zeroes the named roles' counters and preserves scheduling", () => {
  const root = deadRoot();
  for (const role of ["fix", "docs"]) {
    saveLoopState(root, {
      ...loadLoopState(root, role),
      role,
      ticks: 7,
      commits: 3,
      generatedTokens: 1234,
      totalCostUsd: 0.5,
      peakContextTokens: 99,
      nextRunAt: 555,
      lastMainHead: "abc",
    });
  }
  const msg = requestResetCounters(root, ["fix", "docs"]);
  for (const role of ["fix", "docs"]) {
    const s = stateOf(root, role);
    for (const k of ["ticks", "commits", "generatedTokens", "totalCostUsd", "peakContextTokens"]) {
      assert.equal(s[k], 0, `${role}.${k} must be zeroed`);
    }
    assert.equal(s.nextRunAt, 555, "scheduling must survive the reset");
    assert.equal(s.lastMainHead, "abc", "wake tracking must survive the reset");
  }
  // The marker names its targets: only a live fleet consumes it, and it must know which.
  assert.deepEqual(readJsonFile<{ roles: string[] }>(path.join(root, STATE_DIR, "reset-counters.json"))?.roles, ["fix", "docs"]);
  assert.match(msg, /^counters reset for fix, docs — /);
  assert.match(msg, /no harness is running/);
});

test("requestWake clears backoff and pulls nextRunAt to now, leaving counters alone", () => {
  const root = deadRoot();
  saveLoopState(root, {
    ...loadLoopState(root, "fix"),
    role: "fix",
    backoffSeconds: 300,
    nextRunAt: Date.now() + 300_000,
    ticks: 4,
    commits: 2,
    lastMainHead: "abc",
  });
  const msg = requestWake(root, ["fix"]);
  const s = stateOf(root, "fix");
  const now = readJsonFile<{ at: number }>(path.join(root, STATE_DIR, "wake.json"))?.at ?? 0;
  assert.ok(now > 0, "the marker carries its write instant");
  assert.equal(s.backoffSeconds, 0);
  assert.equal(s.nextRunAt, now, "the wake must make the role eligible at the marker's instant");
  assert.equal(s.wokenAt, now, "wokenAt lets isEligible honor the demand over the min-tick interval");
  assert.equal(s.ticks, 4, "counters are observation-window state; wake must not touch them");
  assert.equal(s.lastMainHead, "abc");
  assert.deepEqual(readJsonFile<{ roles: string[] }>(path.join(root, STATE_DIR, "wake.json"))?.roles, ["fix"]);
  assert.match(msg, /^wake requested for fix — /);
  assert.match(msg, /no harness is running/);
});

test("requestWake with a positive delay schedules the marker and skips the state change", () => {
  const root = deadRoot();
  saveLoopState(root, {
    ...loadLoopState(root, "fix"),
    role: "fix",
    backoffSeconds: 300,
    nextRunAt: Date.now() + 300_000,
  });
  const before = stateOf(root, "fix");
  const msg = requestWake(root, ["fix"], 45 * 60_000);
  // The submit writes only the marker: the state change belongs to the deadline, so a fleet
  // stopped at submit (or restarted before the deadline) must not wake early.
  const s = stateOf(root, "fix");
  assert.equal(s.backoffSeconds, before.backoffSeconds, "the submit must not clear backoff");
  assert.equal(s.nextRunAt, before.nextRunAt, "the submit must not pull nextRunAt to now");
  const m = readJsonFile<{ at: number; roles: string[]; notBeforeMs: number }>(path.join(root, STATE_DIR, "wake.json"));
  assert.ok(m, "the scheduled marker is written");
  assert.ok(m.notBeforeMs > Date.now() + 44 * 60_000, "the marker carries the deadline");
  assert.equal(m.notBeforeMs - m.at, 45 * 60_000, "the deadline is the marker's own instant plus the delay");
  assert.deepEqual(m.roles, ["fix"]);
  assert.match(msg, /^wake scheduled for fix — wakes in 45m — /);
});

test("requestWake with a zero delay behaves immediately", () => {
  const root = deadRoot();
  saveLoopState(root, {
    ...loadLoopState(root, "fix"),
    role: "fix",
    backoffSeconds: 300,
    nextRunAt: Date.now() + 300_000,
  });
  const msg = requestWake(root, ["fix"], 0);
  const s = stateOf(root, "fix");
  assert.equal(s.backoffSeconds, 0, "a zero delay reads as immediate");
  assert.match(msg, /^wake requested for fix — /);
  const m = readJsonFile<{ notBeforeMs?: number }>(path.join(root, STATE_DIR, "wake.json"));
  assert.equal(m?.notBeforeMs, undefined, "the immediate marker keeps the bare { at, roles } shape");
});

test("requestResetCounters leaves a live fleet's state file to the orchestrator (no racing rewrite)", () => {
  const root = liveRoot();
  saveLoopState(root, {
    ...loadLoopState(root, "fix"),
    role: "fix",
    ticks: 7,
    commits: 3,
    nextRunAt: 555,
    lastMainHead: "abc",
  });
  const stateFile = path.join(root, STATE_DIR, "state", "fix.json");
  const before = fs.readFileSync(stateFile, "utf8");
  const msg = requestResetCounters(root, ["fix"]);
  // A live fleet's orchestrator is the state file's single writer: consumeResetRequest zeroes
  // the runner in memory and it saves. A direct CLI rewrite here is a second writer racing
  // those saves with a snapshot it may have moved past — the lost update this pins away.
  assert.equal(fs.readFileSync(stateFile, "utf8"), before, "the CLI must not rewrite a live role's state");
  assert.equal(stateOf(root, "fix").ticks, 7, "the counter is left for the orchestrator to zero");
  assert.deepEqual(readJsonFile<{ roles: string[] }>(path.join(root, STATE_DIR, "reset-counters.json"))?.roles, ["fix"]);
  assert.match(msg, /a running fleet picks this up/);
});

test("requestWake leaves a live fleet's state file to the orchestrator (no racing rewrite)", () => {
  const root = liveRoot();
  saveLoopState(root, {
    ...loadLoopState(root, "fix"),
    role: "fix",
    backoffSeconds: 300,
    nextRunAt: Date.now() + 300_000,
    lastMainHead: "abc",
  });
  const stateFile = path.join(root, STATE_DIR, "state", "fix.json");
  const before = fs.readFileSync(stateFile, "utf8");
  const msg = requestWake(root, ["fix"]);
  assert.equal(fs.readFileSync(stateFile, "utf8"), before, "the CLI must not rewrite a live role's state");
  assert.equal(stateOf(root, "fix").backoffSeconds, 300, "the schedule is left for the orchestrator to clear");
  assert.deepEqual(readJsonFile<{ roles: string[] }>(path.join(root, STATE_DIR, "wake.json"))?.roles, ["fix"]);
  assert.match(msg, /a running fleet applies it/);
});

test("submitRolePromptAndWake queues the prompt and wakes only that role", () => {
  const root = deadRoot();
  const msg = submitRolePromptAndWake(root, "fix", "  add a test  ");
  // The queue got the trimmed prompt...
  const events = readEvents(root).filter((e) => e.type === "prompt_enqueued");
  assert.equal(events.length, 1);
  const ev = events.at(0);
  assert.ok(ev);
  assert.equal(ev.loop, "fix");
  assert.equal(ev.preview, "add a test");
  // ...and the wake marker targets exactly that role.
  assert.deepEqual(readJsonFile<{ roles: string[] }>(path.join(root, STATE_DIR, "wake.json"))?.roles, ["fix"]);
  assert.match(msg, /^wake requested for fix — /);
});

test("requestAbort refuses with NO_HARNESS_ERROR when nothing is running", () => {
  const root = deadRoot();
  const r = requestAbort(root, "fix");
  assert.deepEqual(r, { ok: false, error: NO_HARNESS_ERROR });
});

test("requestAbort drops a per-role marker for a live fleet and notes the director's discard", () => {
  const root = liveRoot();
  const r = requestAbort(root, "fix");
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  assert.match(r.message, /^abort requested for fix — a running fleet applies it within ~2s$/);
  assert.ok(readJsonFile(path.join(root, STATE_DIR, "abort-fix.json")));
  // The director's in-flight prompt is dequeued at tick start, so its abort says the prompt is
  // discarded — an ordinary role's confirmation must not carry that note.
  const d = requestAbort(root, "director");
  if (!d.ok) throw new Error("unreachable");
  assert.match(d.message, /in-flight prompt will be discarded/);
});

test("timedPauseBits renders the duration and resume-time phrases, empty for an indefinite pause", () => {
  assert.deepEqual(timedPauseBits(undefined), { forPhrase: "", note: "" });
  // Both dates are fixed, and `now` is passed explicitly, so the fixture cannot drift out of
  // today and flip the phrasing under a later run date.
  const now = new Date(2026, 8, 30, 12, 0, 0).getTime();
  const until = new Date(2026, 8, 30, 14, 5, 0).getTime();
  const b = timedPauseBits({ ms: 30 * 60_000, untilMs: until }, now);
  assert.equal(b.forPhrase, " for 30m");
  assert.equal(b.note, " — resumes automatically at 14:05:00");
  // A deadline past midnight is ambiguous as a bare clock (a 90d pause printed "resumes
  // automatically at 17:25:45" naming no day), so the calendar date rides along.
  const nextDay = new Date(2026, 11, 29, 9, 14, 0).getTime();
  const crossDay = timedPauseBits({ ms: 90 * 24 * 60 * 60_000, untilMs: nextDay }, now);
  assert.equal(crossDay.forPhrase, " for 90d");
  assert.equal(crossDay.note, " — resumes automatically on 2026-12-29 at 09:14:00");
});

test("rolePauseMessage reports the idempotent no-op and the full pause confirmation", () => {
  const dead = deadRoot();
  assert.equal(rolePauseMessage(dead, "fix", false), "role fix is already paused");
  // Not live: the tail says where the marker lands instead.
  assert.match(
    rolePauseMessage(dead, "fix", true),
    /^role fix paused — it stops starting new ticks at its next eligibility check \(in-flight ticks finish; the rest of the fleet is unaffected\).*next `tumwater run`/,
  );
  // A timed pause echoes the duration and the wall-clock resume time; `now` is passed
  // explicitly so the same-day phrasing the fixture pins cannot flip under a later run date.
  const now = new Date(2026, 8, 30, 12, 0, 0).getTime();
  const until = new Date(2026, 8, 30, 14, 5, 0).getTime();
  const timed = rolePauseMessage(dead, "fix", true, { ms: 30 * 60_000, untilMs: until }, now);
  assert.match(timed, /paused for 30m — it stops starting new ticks/);
  assert.match(timed, /— resumes automatically at 14:05:00/);
});

test("roleResumeMessage reports the no-op and the fleet-pause interplay note", () => {
  const dead = deadRoot();
  assert.equal(roleResumeMessage(dead, "fix", false), "role fix was not paused");
  assert.match(roleResumeMessage(dead, "fix", true), /^role fix resumed — it starts ticking again at its next eligibility check/);
  assert.doesNotMatch(roleResumeMessage(dead, "fix", true), /fleet pause is still active/);

  // With the fleet pause marker present, a non-director resume must say the stronger gate
  // still holds — silence would promise ticks the scheduler then denies.
  writeMarker(pausedPath(dead), { at: Date.now() });
  assert.match(roleResumeMessage(dead, "fix", true), /the fleet pause is still active — `tumwater resume` lifts it/);
  // The director is exempt from that gate, so its resumption is real and the note is absent.
  assert.doesNotMatch(roleResumeMessage(dead, "director", true), /fleet pause is still active/);
});

test("PAUSE_FOR_MAX_MS is exactly 90 days", () => {
  assert.equal(PAUSE_FOR_MAX_MS, 90 * 24 * 60 * 60 * 1000);
});
