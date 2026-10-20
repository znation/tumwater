import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  NO_HARNESS_ERROR,
  PAUSE_FOR_MAX_MS,
  cancelWakes,
  listWakes,
  renderWakeList,
  markerApplyNote,
  requestAbort,
  requestResetCounters,
  requestWake,
  rolePauseMessage,
  roleResumeMessage,
  submitRolePromptAndWake,
  timedPauseBits,
} from "../src/operator/operator-intent.js";
import { saveRunnerState } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { readScheduledWakes } from "./helpers/json-read.js";
import { orchestratorStatePath, pausedPath, scheduledWakeDir, STATE_DIR, wakeRequestPath } from "../src/paths.js";
import { readEvents } from "../src/events/event-read.js";
import { readJsonFile } from "../src/files/json-files.js";
import { writeMarker } from "./fixtures/log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { patchFsMethod } from "./helpers/fs-faults.js";

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

/** The operator request markers (wake/reset/restart/abort) must be written ATOMICALLY (tmp+rename):
 * a concurrent poll reading a marker mid-write sees a torn file, which readJsonFile folds to null —
 * the corrupt-marker superset that wakes every runner. For a scheduled wake that superset drops
 * notBeforeMs, firing `wake --in` hours early. This pins the write path: the marker arrives via
 * fs.rename (writeTextAtomic), never a direct writeFileSync to the marker path. */
test("operator request markers are written atomically (tmp+rename, never a torn write)", () => {
  const root = deadRoot();
  const wakeDir = scheduledWakeDir(root);
  const renamed: string[] = [];
  const restoreRename = patchFsMethod("renameSync", (orig) => (from, to) => {
    renamed.push(to as string);
    return orig(from, to);
  });
  try {
    requestWake(root, ["fix"], 60_000);
  } finally {
    restoreRename();
  }
  assert.ok(renamed.some((to) => path.dirname(to) === wakeDir), `expected a wake marker in ${wakeDir} to arrive via rename`);
  // The rename is the last step, so the marker's final content is intact and no tmp remnant
  // is left behind.
  assert.ok(readScheduledWakes(root)[0]?.notBeforeMs);
  assert.equal(fs.readdirSync(wakeDir).filter((f) => f.includes(".tmp-")).length, 0);
});

test("markerApplyNote reports the no-harness tail without an orchestrator info file", () => {
  const n = markerApplyNote(deadRoot());
  assert.equal(n.live, false);
  assert.equal(n.when, "");
  assert.match(n.tail, /next `tumwater start`/);
});

test("markerApplyNote reports a live team and the ~2s window when the orchestrator is alive", () => {
  const n = markerApplyNote(liveRoot());
  assert.equal(n.live, true);
  assert.equal(n.when, " within ~2s");
  assert.equal(n.tail, "");
});

test("requestResetCounters zeroes the named roles' counters and preserves scheduling", () => {
  const root = deadRoot();
  for (const role of ["fix", "docs"]) {
    saveRunnerState(root, {
      ...loadRunnerState(root, role),
      role,
      runs: 7,
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
    for (const k of ["runs", "commits", "generatedTokens", "totalCostUsd", "peakContextTokens"]) {
      assert.equal(s[k], 0, `${role}.${k} must be zeroed`);
    }
    assert.equal(s.nextRunAt, 555, "scheduling must survive the reset");
    assert.equal(s.lastMainHead, "abc", "wake tracking must survive the reset");
  }
  // The marker names its targets: only a live team consumes it, and it must know which.
  assert.deepEqual(readJsonFile<{ roles: string[] }>(path.join(root, STATE_DIR, "reset-counters.json"))?.roles, ["fix", "docs"]);
  assert.match(msg, /^counters reset for fix, docs — /);
  assert.match(msg, /tumwater is not running/);
});

test("requestWake clears backoff and pulls nextRunAt to now, leaving counters alone", () => {
  const root = deadRoot();
  saveRunnerState(root, {
    ...loadRunnerState(root, "fix"),
    role: "fix",
    backoffSeconds: 300,
    nextRunAt: Date.now() + 300_000,
    runs: 4,
    commits: 2,
    lastMainHead: "abc",
  });
  const msg = requestWake(root, ["fix"]);
  const s = stateOf(root, "fix");
  const now = readJsonFile<{ at: number }>(path.join(root, STATE_DIR, "wake.json"))?.at ?? 0;
  assert.ok(now > 0, "the marker carries its write instant");
  assert.equal(s.backoffSeconds, 0);
  assert.equal(s.nextRunAt, now, "the wake must make the role eligible at the marker's instant");
  assert.equal(s.wokenAt, now, "wokenAt lets isEligible honor the demand over the min-run interval");
  assert.equal(s.runs, 4, "counters are observation-window state; wake must not touch them");
  assert.equal(s.lastMainHead, "abc");
  assert.deepEqual(readJsonFile<{ roles: string[] }>(path.join(root, STATE_DIR, "wake.json"))?.roles, ["fix"]);
  assert.match(msg, /^wake requested for fix — /);
  assert.match(msg, /tumwater is not running/);
});

test("requestWake with a positive delay schedules the marker and skips the state change", () => {
  const root = deadRoot();
  saveRunnerState(root, {
    ...loadRunnerState(root, "fix"),
    role: "fix",
    backoffSeconds: 300,
    nextRunAt: Date.now() + 300_000,
  });
  const before = stateOf(root, "fix");
  const msg = requestWake(root, ["fix"], 45 * 60_000);
  // The submit writes only the marker: the state change belongs to the deadline, so a team
  // stopped at submit (or restarted before the deadline) must not wake early.
  const s = stateOf(root, "fix");
  assert.equal(s.backoffSeconds, before.backoffSeconds, "the submit must not clear backoff");
  assert.equal(s.nextRunAt, before.nextRunAt, "the submit must not pull nextRunAt to now");
  const m = readScheduledWakes(root)[0];
  assert.ok(m, "the scheduled marker is written");
  assert.ok(m.notBeforeMs > Date.now() + 44 * 60_000, "the marker carries the deadline");
  assert.equal(m.notBeforeMs - m.at, 45 * 60_000, "the deadline is the marker's own instant plus the delay");
  assert.deepEqual(m.roles, ["fix"]);
  assert.match(msg, /^wake scheduled for fix — wakes in 45m — /);
});

test("requestWake with a zero delay behaves immediately", () => {
  const root = deadRoot();
  saveRunnerState(root, {
    ...loadRunnerState(root, "fix"),
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

test("requestResetCounters leaves a live team's state file to the orchestrator (no racing rewrite)", () => {
  const root = liveRoot();
  saveRunnerState(root, {
    ...loadRunnerState(root, "fix"),
    role: "fix",
    runs: 7,
    commits: 3,
    nextRunAt: 555,
    lastMainHead: "abc",
  });
  const stateFile = path.join(root, STATE_DIR, "state", "fix.json");
  const before = fs.readFileSync(stateFile, "utf8");
  const msg = requestResetCounters(root, ["fix"]);
  // A live team's orchestrator is the state file's single writer: consumeResetRequest zeroes
  // the runner in memory and it saves. A direct CLI rewrite here is a second writer racing
  // those saves with a snapshot it may have moved past — the lost update this pins away.
  assert.equal(fs.readFileSync(stateFile, "utf8"), before, "the CLI must not rewrite a live role's state");
  assert.equal(stateOf(root, "fix").runs, 7, "the counter is left for the orchestrator to zero");
  assert.deepEqual(readJsonFile<{ roles: string[] }>(path.join(root, STATE_DIR, "reset-counters.json"))?.roles, ["fix"]);
  assert.match(msg, /the running team picks this up/);
});

test("requestWake leaves a live team's state file to the orchestrator (no racing rewrite)", () => {
  const root = liveRoot();
  saveRunnerState(root, {
    ...loadRunnerState(root, "fix"),
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
  assert.match(msg, /the running team applies it/);
});

test("submitRolePromptAndWake queues the prompt and wakes only that role", () => {
  const root = deadRoot();
  const msg = submitRolePromptAndWake(root, "fix", "  add a test  ");
  // The queue got the trimmed prompt…
  const events = readEvents(root).filter((e) => e.type === "prompt_enqueued");
  assert.equal(events.length, 1);
  const ev = events.at(0);
  assert.ok(ev);
  assert.equal(ev.source, "fix");
  assert.equal(ev.preview, "add a test");
  // …and the wake marker targets exactly that role.
  assert.deepEqual(readJsonFile<{ roles: string[] }>(path.join(root, STATE_DIR, "wake.json"))?.roles, ["fix"]);
  assert.match(msg, /^wake requested for fix — /);
});

test("requestAbort refuses with NO_HARNESS_ERROR when nothing is running", () => {
  const root = deadRoot();
  const r = requestAbort(root, "fix");
  assert.deepEqual(r, { ok: false, error: NO_HARNESS_ERROR });
});

test("requestAbort drops a per-role marker for a live team and notes the director's discard", () => {
  const root = liveRoot();
  const r = requestAbort(root, "fix");
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  assert.match(r.message, /^abort requested for fix — the running team applies it within ~2s$/);
  assert.ok(readJsonFile(path.join(root, STATE_DIR, "abort-fix.json")));
  // The director's in-flight prompt is dequeued at run start, so its abort says the prompt is
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
  // Not live: the tail says where the marker arrives instead.
  assert.match(
    rolePauseMessage(dead, "fix", true),
    /^role fix paused — it starts no new runs \(current runs finish; the rest of the team is unaffected\).*next `tumwater start`/,
  );
  // A timed pause echoes the duration and the wall-clock resume time; `now` is passed
  // explicitly so the same-day phrasing the fixture pins cannot flip under a later run date.
  const now = new Date(2026, 8, 30, 12, 0, 0).getTime();
  const until = new Date(2026, 8, 30, 14, 5, 0).getTime();
  const timed = rolePauseMessage(dead, "fix", true, { ms: 30 * 60_000, untilMs: until }, now);
  assert.match(timed, /paused for 30m — it starts no new runs/);
  assert.match(timed, /— resumes automatically at 14:05:00/);
});

test("roleResumeMessage reports the no-op and the team-pause interplay note", () => {
  const dead = deadRoot();
  assert.equal(roleResumeMessage(dead, "fix", false), "role fix was not paused");
  assert.match(roleResumeMessage(dead, "fix", true), /^role fix resumed — it starts new runs again/);
  assert.doesNotMatch(roleResumeMessage(dead, "fix", true), /team pause is still active/);

  // With the team pause marker present, a non-director resume must say the stronger gate
  // still holds — silence would promise runs the scheduler then denies.
  writeMarker(pausedPath(dead), { at: Date.now() });
  assert.match(roleResumeMessage(dead, "fix", true), /the team pause is still active — `tumwater resume` lifts it/);
  // The director is exempt from that gate, so its resumption is real and the note is absent.
  assert.doesNotMatch(roleResumeMessage(dead, "director", true), /team pause is still active/);
});

test("PAUSE_FOR_MAX_MS is exactly 90 days", () => {
  assert.equal(PAUSE_FOR_MAX_MS, 90 * 24 * 60 * 60 * 1000);
});

test("a later wake request leaves a pending scheduled wake standing", () => {
  const root = deadRoot();
  requestWake(root, ["fix"], 3_600_000);
  requestWake(root, ["plan"]);
  requestWake(root, ["clean"], 7_200_000);
  const scheduled = readScheduledWakes(root);
  assert.deepEqual(scheduled.map((m) => m.roles), [["fix"], ["clean"]]);
  const immediate = readJsonFile<{ roles: string[]; notBeforeMs?: number }>(wakeRequestPath(root));
  assert.deepEqual(immediate?.roles, ["plan"]);
  assert.equal(immediate?.notBeforeMs, undefined);
});

test("readScheduledWakes orders same-millisecond markers by notBeforeMs, not file name", () => {
  const root = deadRoot();
  const dir = scheduledWakeDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const at = Date.now();
  // Two wakes written in the SAME millisecond (identical `at` and `now` file-name prefix) whose
  // random file-name suffixes sort in the WRONG order: the 7.2M "clean" marker's name sorts
  // first, so a name-order reader returns [clean, fix] ~half the time. readScheduledWakes must
  // follow the deterministic deadline instead, returning [fix, clean].
  fs.writeFileSync(
    path.join(dir, `${at}-${process.pid}-00000000.json`),
    JSON.stringify({ at, roles: ["clean"], notBeforeMs: at + 7_200_000 }),
  );
  fs.writeFileSync(
    path.join(dir, `${at}-${process.pid}-ffffffff.json`),
    JSON.stringify({ at, roles: ["fix"], notBeforeMs: at + 3_600_000 }),
  );
  assert.deepEqual(readScheduledWakes(root).map((m) => m.roles), [["fix"], ["clean"]]);
});

test("submitRolePromptAndWake leaves a pending scheduled wake standing", () => {
  const root = deadRoot();
  requestWake(root, ["clean"], 3_600_000);
  submitRolePromptAndWake(root, "fix", "add a test");
  assert.deepEqual(readScheduledWakes(root).map((m) => m.roles), [["clean"]]);
});

test("cancelWakes reports what it dropped, team-wide or for one role", () => {
  const root = tmpdir();
  assert.equal(cancelWakes(root), "no scheduled wake pending");
  requestWake(root, ["feature"], 60_000);
  requestWake(root, ["qa", "docs"], 90_000);
  assert.equal(cancelWakes(root, ["nope"]), "no scheduled wake pending for nope");
  assert.equal(cancelWakes(root, ["nope", "ghost"]), "no scheduled wake pending for nope, ghost");
  assert.equal(cancelWakes(root, ["qa"]), "cancelled 1 scheduled wake for qa");
  assert.deepEqual(readScheduledWakes(root).map((w) => w.roles).sort(), [["docs"], ["feature"]]);
  assert.equal(cancelWakes(root), "cancelled 2 scheduled wakes");
  assert.deepEqual(readScheduledWakes(root), []);
});

test("renderWakeList numbers wakes and words the empty case", () => {
  const now = 1_000_000;
  assert.equal(renderWakeList([], now), "no scheduled wake pending");
  assert.equal(renderWakeList([], now, ["qa"]), "no scheduled wake pending for qa");
  assert.equal(renderWakeList([], now, ["qa", "clean"]), "no scheduled wake pending for qa, clean");
  assert.equal(
    renderWakeList([{ roles: ["qa"], atMs: now + 45 * 60_000 }, { roles: ["feature", "qa"], atMs: now + 2 * 3_600_000 }], now),
    "1. in 45m — qa\n2. in 2h — feature, qa",
  );
});

test("listWakes filters by role and keeps full roles lists, earliest first", () => {
  const root = tmpdir();
  requestWake(root, ["clean"], 3_600_000);
  requestWake(root, ["feature", "qa"], 7_200_000);
  requestWake(root, ["qa"], 60_000);
  const now = Date.now();
  assert.deepEqual(listWakes(root, undefined, now).map((w) => w.roles), [["qa"], ["clean"], ["feature", "qa"]]);
  assert.deepEqual(listWakes(root, ["feature"], now).map((w) => w.roles), [["feature", "qa"]]);
  assert.deepEqual(listWakes(root, ["clean", "feature"], now).map((w) => w.roles), [["clean"], ["feature", "qa"]]);
});

/** A dead-team root whose tumwater.json disables the given roles. */
function rootWithDisabled(...ids: string[]): string {
  const root = deadRoot();
  const roles = Object.fromEntries(ids.map((id) => [id, { enabled: false }]));
  fs.writeFileSync(path.join(root, "tumwater.json"), JSON.stringify({ roles }));
  return root;
}

test("requestWake names a disabled target in the immediate confirmation", () => {
  const msg = requestWake(rootWithDisabled("selfcheck"), ["selfcheck"]);
  assert.match(msg, /^wake requested for selfcheck — /);
  assert.ok(
    msg.endsWith(
      "; selfcheck is disabled, so the wake only ends its sleep — it won't run until you enable it with tumwater config set roles.selfcheck.enabled true",
    ),
    msg,
  );
});

test("requestWake appends the disabled clause to a scheduled wake naming enabled roles too", () => {
  const msg = requestWake(rootWithDisabled("selfcheck"), ["clean", "selfcheck"], 45 * 60_000);
  assert.match(msg, /^wake scheduled for clean, selfcheck — wakes in 45m — /);
  assert.ok(
    msg.endsWith(
      "; selfcheck is disabled, so the wake only ends its sleep — it won't run until you enable it with tumwater config set roles.selfcheck.enabled true",
    ),
    msg,
  );
});

test("requestWake pluralises the disabled clause and omits it when every target is enabled", () => {
  const two = requestWake(rootWithDisabled("perf", "selfcheck"), ["perf", "selfcheck"]);
  assert.match(
    two,
    /; perf, selfcheck are disabled, so the wake only ends their sleep — they won't run until you enable them with tumwater config set roles\.<id>\.enabled true$/,
  );
  const none = requestWake(rootWithDisabled("selfcheck"), ["clean"]);
  assert.doesNotMatch(none, /disabled/);
});

test("roleResumeMessage names a disabled role instead of promising runs", () => {
  const root = rootWithDisabled("selfcheck");
  const msg = roleResumeMessage(root, "selfcheck", true);
  assert.match(msg, /it is disabled, so it still starts no runs/);
  assert.match(msg, /tumwater config set roles\.selfcheck\.enabled true/);
  assert.doesNotMatch(msg, /starts new runs again/);
  assert.equal(roleResumeMessage(root, "selfcheck", false), "role selfcheck was not paused");
});

test("rolePauseMessage names a disabled role", () => {
  const root = rootWithDisabled("selfcheck");
  assert.match(rolePauseMessage(root, "selfcheck", true), /selfcheck is disabled/);
  assert.equal(rolePauseMessage(root, "selfcheck", false), "role selfcheck is already paused");
});
