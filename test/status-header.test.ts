/** The status header's badge tests: the header line renderStatus (src/ui/status-render.ts)
 * assembles from buildBadge, the questions and inbox counts, the timed-pause countdown, the
 * budget badge, the land-queue badge, and the merge-scope main check. The table-body suites
 * live beside this in status-render.test.ts and status-model.test.ts, the badges' own unit
 * tests in badges.test.ts; the fixtures both assemble snapshots from are in
 * status-fixtures.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import { renderStatus } from "../src/ui/status-render.js";
import { buildBadge } from "../src/ui/badges.js";
import type { StatusSnapshot } from "../src/status/status-data.js";
import { tmpdir } from "./repo-fixtures.js";
import { DEFAULT_BUDGET, headerOf, snapshotWith } from "./status-fixtures.js";

// The questions badge (plans/questions-outbox.md) rides the header line like the inbox one:
// visible only while something needs an answer, so a quiet project's header stays uncluttered.

test("the status header carries a questions badge only while questions await", () => {
  const zero = headerOf(renderStatus(tmpdir(), snapshotWith([{ role: "clean" }])));
  assert.doesNotMatch(zero, /questions/);

  const snap = snapshotWith([{ role: "clean" }]);
  snap.questions = 2;
  const header = headerOf(renderStatus(tmpdir(), snap));
  // The standing budget badge follows the questions one in the header.
  assert.match(header, /· questions: 2 · budget: \$0\.00\/\$50 today$/);
});

// The inbox badge is the questions badge's sibling: queued director prompts show as `· inbox:
// N` so an operator sees waiting work at a glance, and a drained inbox leaves no trace —
// `status --json` carries the same count, but only the header renders it for a human.

test("the status header carries an inbox badge only while prompts are queued", () => {
  const zero = headerOf(renderStatus(tmpdir(), snapshotWith([{ role: "clean" }])));
  assert.doesNotMatch(zero, /inbox/);

  const snap = snapshotWith([{ role: "clean" }]);
  snap.inbox = 3;
  const header = headerOf(renderStatus(tmpdir(), snap));
  // The standing budget badge follows the inbox one in the header, like the questions badge's.
  assert.match(header, /· inbox: 3 · budget: \$0\.00\/\$50 today$/);
});

// The timed-pause countdown rides the header last (PLANS.md "Pause countdown"): only a
// FUTURE fleet-marker deadline makes it appear — a role-only pause, an indefinite pause, and
// an expired marker all keep the header byte-identical, because the badge must never claim
// a countdown that is over (the read side already treats an expired marker as unpaused).
test("the status header shows the timed-pause countdown only while the fleet deadline stands", () => {
  const quiet = headerOf(renderStatus(tmpdir(), snapshotWith([{ role: "clean" }])));
  assert.doesNotMatch(quiet, /auto-resumes/);

  const snap = snapshotWith([{ role: "clean" }], DEFAULT_BUDGET, true);
  snap.pausedUntil = Date.now() + 3 * 3_600_000;
  const header = headerOf(renderStatus(tmpdir(), snap));
  // The budget badge precedes it, like the questions and inbox badges' ordering.
  assert.match(header, /· budget: \$0\.00\/\$50 today · paused — auto-resumes in 3h$/);

  snap.pausedUntil = Date.now() - 1_000; // expired: the read side already treats it as unpaused
  assert.doesNotMatch(headerOf(renderStatus(tmpdir(), snap)), /auto-resumes/);
});

// The operator pause's why (`pause --reason <text>`) rides the header after the countdown —
// and a reason makes the untimed pause visible up here (`· paused — "why"`), while a
// reasonless pause keeps today's byte-identical header.
test("the status header states the operator pause's reason, timed or not", () => {
  const anonymous = snapshotWith([{ role: "clean" }], DEFAULT_BUDGET, true);
  anonymous.pausedUntil = Date.now() + 3 * 3_600_000;
  const bare = headerOf(renderStatus(tmpdir(), anonymous));
  assert.match(bare, /· paused — auto-resumes in 3h$/);

  const timed = snapshotWith([{ role: "clean" }], DEFAULT_BUDGET, true);
  timed.pausedUntil = Date.now() + 3 * 3_600_000;
  timed.pauseReason = "deploying to prod";
  assert.match(headerOf(renderStatus(tmpdir(), timed)), /· paused — auto-resumes in 3h — "deploying to prod"$/);

  const untimed = snapshotWith([{ role: "clean" }], DEFAULT_BUDGET, true);
  untimed.pauseReason = "deploying to prod";
  assert.match(headerOf(renderStatus(tmpdir(), untimed)), /· paused — "deploying to prod"$/);

  const quiet = snapshotWith([{ role: "clean" }]);
  assert.doesNotMatch(headerOf(renderStatus(tmpdir(), quiet)), /paused/);
});

// Quiet hours 2/2 (plans: "Quiet hours … part 2/2, observability"): the window rides the
// header LAST, after the pause badge, as standing information once configured — the plain
// window string outside it, the active `quiet until <end>` reading inside — and a fleet
// without the schedule keeps its header byte-identical (the badge is empty).
test("the status header carries a quiet-hours badge only while a window is configured", () => {
  const unset = headerOf(renderStatus(tmpdir(), snapshotWith([{ role: "clean" }])));
  assert.doesNotMatch(unset, /quiet/);

  const snap = snapshotWith([{ role: "clean" }]);
  snap.quietHours = "23:00-07:00";
  snap.inQuietHours = false;
  const outside = headerOf(renderStatus(tmpdir(), snap));
  assert.match(outside, /· quiet 23:00-07:00$/);

  snap.inQuietHours = true;
  const inside = headerOf(renderStatus(tmpdir(), snap));
  assert.match(inside, /· quiet until 07:00$/);
  assert.doesNotMatch(inside, /23:00-07:00/, "inside the window the active reading replaces the raw string");
});

// The daily cost budget (plans/daily-cost-budget.md): the header badge is standing
// information while enabled — the paused role loops' state-cell half of this plan lives in
// status-render.test.ts's fallback tests.

test("the status header carries a budget badge in every cap state", () => {
  const enabled = headerOf(
    renderStatus(tmpdir(), snapshotWith([{ role: "clean" }], { spentUsd: 12.34, capUsd: 50, capHitAt: null, free: false, fallback: null })),
  );
  assert.match(enabled, /· budget: \$12\.34\/\$50 today$/);

  // Fractional caps keep their cents; whole-dollar spent values stay two-decimal like the cost column.
  const fractional = headerOf(
    renderStatus(tmpdir(), snapshotWith([{ role: "clean" }], { spentUsd: 0, capUsd: 12.34, capHitAt: null, free: false, fallback: null })),
  );
  assert.match(fractional, /· budget: \$0\.00\/\$12\.34 today$/);

  // Disabled (cap 0): the badge stays — it is the affordance for SETTING a cap — and reads
  // spend plus `no cap` instead of a $X/$Y figure.
  const disabled = headerOf(
    renderStatus(tmpdir(), snapshotWith([{ role: "clean" }], { spentUsd: 3.25, capUsd: 0, capHitAt: null, free: false, fallback: null })),
  );
  assert.match(disabled, /· budget: \$3\.25 today · no cap$/);
});

// A fleet whose models are all free (local LLMs) can never accumulate spend against the cap,
// so the badge reads n/a instead of a dollar figure that would never move.
test("the status header budget badge reads n/a for an all-free fleet", () => {
  const free = headerOf(
    renderStatus(tmpdir(), snapshotWith([{ role: "clean" }], { spentUsd: 0, capUsd: 50, capHitAt: null, free: true, fallback: null })),
  );
  assert.match(free, /· budget: n\/a$/);

  // The dollar form is untouched for a fleet that can spend (byte-identical to before).
  const paid = headerOf(
    renderStatus(tmpdir(), snapshotWith([{ role: "clean" }], { spentUsd: 0, capUsd: 50, capHitAt: null, free: false, fallback: null })),
  );
  assert.match(paid, /· budget: \$0\.00\/\$50 today$/);
});

test("the header names the running build and flags a stale one", () => {
  // Build provenance (src/build/build-info.ts): the dashboards are where an operator learns the fleet
  // is running code main no longer describes — the badge must carry the commit and the gap.
  const fresh = { ...snapshotWith([{ role: "clean" }]), running: true, pid: 4242, build: { sha: "a".repeat(40), builtAt: 1, stale: false, aheadCommits: 0, checkedHead: "b".repeat(40) } };
  assert.match(headerOf(renderStatus("/tmp/x", fresh)), /running \(pid 4242, build aaaaaaaa\)/);
  const stale = { ...fresh, build: { ...fresh.build, stale: true, aheadCommits: 7 } };
  assert.match(headerOf(renderStatus("/tmp/x", stale)), /build aaaaaaaa — STALE: main \+7 commit\(s\) since\)/);
  // A stale build also says what auto-restart made of it: pending resolves itself, BLOCKED
  // never will until main moves, and only the second one needs an operator (BUGS.md).
  const pending = { ...stale.build, restartPending: true };
  assert.match(buildBadge(pending), /STALE: main \+7 commit\(s\) since; restart pending$/);
  const blocked = { ...stale.build, restartBlocked: "main cccccccc is red" };
  assert.match(buildBadge(blocked), /since; restart BLOCKED: main cccccccc is red$/);
  assert.equal(buildBadge(stale.build), ", build aaaaaaaa — STALE: main +7 commit(s) since", "silent when neither");
  const unstamped = { ...fresh, build: null };
  assert.match(headerOf(renderStatus("/tmp/x", unstamped)), /running \(pid 4242\)/, "no stamp: the pre-stamp header");
  assert.equal(buildBadge(null), "");
});

test("renderStatus shows the land-queue badge in the header and the label in the landing role's row", () => {
  const root = tmpdir();
  // Idle queue: the header carries no badge (every existing byte stays intact)…
  const idle = renderStatus(root, {
    ...snapshotWith([{ role: "clean" }]),
    running: true,
    pid: 4242,
  });
  assert.doesNotMatch(idle, /land queue/);
  assert.match(idle, /^clean +queued/m, "an idle loop keeps its ordinary state cell");

  // Two queued landings: the header badge appears…
  const queued = {
    ...snapshotWith([{ role: "clean" }, { role: "bugfix" }]),
    running: true,
    pid: 4242,
    landQueue: { depth: 2 } as StatusSnapshot["landQueue"],
  };
  const text = renderStatus(root, queued);
  assert.match(headerOf(text), /running \(pid 4242\) · land queue: 2/, "badge after the running part, before the budget badge");
  assert.match(text, /clean +queued/, "a merely queued role shows its normal state");

  // …and the role whose in-flight record is attached reads `landing <elapsed> · <stage>` in
  // its row — no work-item prefix (the loop is not running, so stateCell returns the phase),
  // while the other row is untouched.
  const startedAt = Date.now() - 90_000;
  const landing = {
    ...queued,
    landQueue: {
      depth: 2,
      inFlight: { role: "clean", sha: "abc123", summary: "tidy", startedAt, stage: "build-check" },
    } as StatusSnapshot["landQueue"],
  };
  const text2 = renderStatus(root, landing);
  assert.match(text2, /clean +landing 1m3[01]s · build check/, "the landing role reads the marker's elapsed and stage");
  assert.match(text2, /bugfix +queued/, "other roles are untouched");
});

test("the status header carries a mainCheck badge only after a merge-scope check", () => {
  // No check yet: no badge — the header of a quiet fleet stays byte-identical to before.
  const none = headerOf(renderStatus(tmpdir(), snapshotWith([{ role: "clean" }])));
  assert.doesNotMatch(none, /· main /);
  // Green with counts (PLANS.md "Retire the README freshness stamp" wording: the old README
  // stamp's `suite N/N (N skipped)` shape, rendered live instead of committed).
  const green = headerOf(renderStatus(tmpdir(), {
    ...snapshotWith([{ role: "clean" }]),
    mainCheck: { sha: "a".repeat(40), status: "passed", counts: { tests: 10, pass: 9, fail: 0, skipped: 1 }, at: 0 },
  }));
  assert.match(green, /· main a{8}: green · 9\/10 \(1 skipped\)/);
  // Red with no counts (the check never printed a summary block): verdict only.
  const red = headerOf(renderStatus(tmpdir(), {
    ...snapshotWith([{ role: "clean" }]),
    mainCheck: { sha: "a".repeat(40), status: "failed", at: 0 },
  }));
  assert.match(red, /· main a{8}: red$/);
});

// The disk floor (plans/disk-floor.md, part 4/4): the header carries the published free space,
// the hold verdict and the last reclaim — an operator sees why the fleet stopped without
// reading events. No disk block keeps the header byte-identical.
test("the status header carries the disk reading, the hold and the last reclaim", () => {
  assert.doesNotMatch(headerOf(renderStatus(tmpdir(), snapshotWith([{ role: "clean" }]))), /disk/);

  const low = snapshotWith([{ role: "clean" }]);
  low.disk = { freeGB: 30, holdGB: 10, reclaimGB: 40, held: false };
  assert.match(headerOf(renderStatus(tmpdir(), low)), /· disk 30\.0 GB free$/);

  const held = snapshotWith([{ role: "clean" }]);
  held.disk = {
    freeGB: 8.2,
    holdGB: 10,
    reclaimGB: 40,
    held: true,
    lastReclaim: { at: Date.now() - 300_000, mode: "pressure", freedGB: 3.24 },
  };
  assert.match(
    headerOf(renderStatus(tmpdir(), held)),
    /· disk 8\.2 GB free — holding new work · last reclaim freed 3\.2 GB 5m ago$/,
  );
});
