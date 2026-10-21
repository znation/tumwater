/** The badges suite: the status header's badge fragments (budgetBadge, buildBadge,
 * mainCheckBadge, mergeBadge, pauseBadge) and the humanSeconds phrasing they share. Split
 * out of status-model.test.ts when the badges moved from src/ui/status-model.ts to
 * src/ui/badges.ts — this suite travels with the new module the way status-model.test.ts
 * travels with the per-role display model. */
import test from "node:test";
import assert from "node:assert/strict";
import { budgetBadge, chainBadge, claudeWindowTone, diskBadge, mergeBadge, mainCheckBadge, mainCountsFragment, pauseBadge, pauseCountdown, permitsBadge, checksBadge, runWindowBadge, workspacesBadge, wakeBadge, roleWakeMarker } from "../src/ui/badges.js";
import type { StatusSnapshot } from "../src/status/status-data.js";

test("budgetBadge renders the standing daily-cost rule in every cap state", () => {
  // One home for the badge string (renderStatus's header and the payload's preformatted
  // budgetBadge field): n/a for an all-free team (checked first, in EVERY cap state — a
  // disabled free team still cannot accumulate spend), $X/$Y while enabled with priced
  // models, `· no cap` when disabled. Whole-dollar caps stay bare ($50); fractional ones
  // keep their cents ($12.34).
  assert.equal(budgetBadge({ spentUsd: 0, capUsd: 50, capHitAt: null, free: true, fallback: null }), " · budget: n/a", "all-free team reads n/a");
  assert.equal(budgetBadge({ spentUsd: 12.34, capUsd: 50, capHitAt: null, free: false, fallback: null }), " · budget: $12.34/$50 today", "whole-dollar cap stays bare");
  assert.equal(budgetBadge({ spentUsd: 0, capUsd: 12.34, capHitAt: null, free: false, fallback: null }), " · budget: $0.00/$12.34 today", "fractional cap keeps its cents");
  assert.equal(budgetBadge({ spentUsd: 7.5, capUsd: 0, capHitAt: null, free: false, fallback: null }), " · budget: $7.50 today · no cap", "disabled: spend shown, gate off");
  assert.equal(budgetBadge({ spentUsd: 0, capUsd: 0, capHitAt: null, free: true, fallback: null }), " · budget: n/a", "free outranks disabled too");
});

// The cost n/a fallback model (plans/fallback-model.md): while it carries the team the badge
// names it, and the roles keep their ordinary state cells — they are working, not stopped.
test("budgetBadge names the fallback model only while it is carrying the team", () => {
  const fallback = { provider: "omlx", model: "local-free" };
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback }),
    " · budget: $50.00/$50 today · over-cap model: local-free (cost n/a)",
    "at the cap with a usable fallback: the badge says what the team is running on now",
  );
  assert.equal(
    budgetBadge({ spentUsd: 10, capUsd: 50, capHitAt: null, free: false, fallback }),
    " · budget: $10.00/$50 today",
    "under the cap the fallback is not engaged, so the badge is byte-identical to before",
  );
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: null }),
    " · budget: $50.00/$50 today",
    "at the cap with no usable fallback: the team is paused, nothing to name",
  );
  // A fallback naming only a provider still identifies itself.
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: { provider: "omlx" } }),
    " · budget: $50.00/$50 today · over-cap model: omlx (cost n/a)",
  );
});

// A claude fallback (PLANS.md "Mixed claude + pi fleets, part 3/4" gap 7): the pair's `backend`
// is `claude`, so it renders agent-qualified — `claude/claude-sonnet-5-5` —
// the same form every other surface carries, never a bare `claude-sonnet-5-5`.
test("budgetBadge agent-qualifies a claude fallback", () => {
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: { backend: "claude", provider: "claude", model: "claude-sonnet-5-5" }, tiers: null }),
    " · budget: $50.00/$50 today · over-cap model: claude/claude-sonnet-5-5 (cost n/a)",
  );
});

test("budgetBadge lists the tiers when the fallback resolves to two or more distinct pairs", () => {
  // Part 7b/8: the snapshot's tier map stands exactly in that state, and the badge lists
  // each tier's pair in tier order, borrowed ones marked by their `(from …)` suffix.
  const tiers = { small: "free/qwen-free (from default)", default: "free/qwen-free", strong: "free/llama-free" };
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: { provider: "free", model: "qwen-free" }, tiers }),
    " · budget: $50.00/$50 today · over-cap model: small: free/qwen-free (from default), default: free/qwen-free, strong: free/llama-free (cost n/a)",
    "a strong-tier borrow must be visible at a glance",
  );
  // A one-entry map (a torn snapshot — never emitted by status-data, which requires two
  // distinct pairs) falls back to the single-pair text, exactly like an absent map.
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: { provider: "free", model: "qwen-free" }, tiers: { default: "free/qwen-free" } }),
    " · budget: $50.00/$50 today · over-cap model: qwen-free (cost n/a)",
  );
  // Without the map — the single-fallback state the pre-tier badge saw — the single-pair
  // text stands byte-identical.
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: { provider: "omlx", model: "local-free" }, tiers: null }),
    " · budget: $50.00/$50 today · over-cap model: local-free (cost n/a)",
  );
});

test("budgetBadge appends the burn-rate forecast as · ~cap at HH:MM and stays byte-identical without one", () => {
  // A forecast stands: wall-clock local, hours and minutes only (formatTime's seconds are
  // noise for a forecast), zero-padded on both sides — 14:05, not 14:5.
  const hit = new Date(2026, 9, 1, 14, 5, 0).getTime();
  assert.equal(
    budgetBadge({ spentUsd: 12.34, capUsd: 50, capHitAt: hit, free: false, fallback: null }),
    " · budget: $12.34/$50 today · ~cap at 14:05",
  );

  // The forecast and the fallback fragment can never co-occur: the fallback stands only once
  // the cap is reached — the one state where projectCapHit is itself null — so no assertion
  // pairs them here; the fragment order is still forecast-before-fallback by construction.

  // No forecast (`capHitAt: null` — no cap, no spend, cap reached, or a burn that misses
  // midnight): every reading is byte-identical to the pre-projection badge.
  assert.equal(
    budgetBadge({ spentUsd: 12.34, capUsd: 50, capHitAt: null, free: false, fallback: null }),
    " · budget: $12.34/$50 today",
    "no forecast, no fragment",
  );
  assert.equal(
    budgetBadge({ spentUsd: 7.5, capUsd: 0, capHitAt: null, free: false, fallback: null }),
    " · budget: $7.50 today · no cap",
    "a disabled cap never carries a forecast",
  );
  assert.equal(
    budgetBadge({ spentUsd: 0, capUsd: 50, capHitAt: null, free: true, fallback: null }),
    " · budget: n/a",
    "an all-free team never carries a forecast",
  );
});

// Merge queue 4/5 — the merge queue's one payload field, three renderers: the header badge,
// the marker-driven row label, and the payload's preformatted field.
test("mergeBadge shows the merge queue depth and stays empty when idle", () => {
  // Empty at depth 0 keeps every existing header byte identical; the count while anything
  // is queued or merge (in-flight merges always count toward depth — their entry stays
  // in the queue until its outcome).
  assert.equal(mergeBadge({ depth: 0 }), "", "idle queue adds nothing to the header");
  assert.equal(mergeBadge({ depth: 1 }), " · merge queue: 1");
  assert.equal(mergeBadge({ depth: 3 }), " · merge queue: 3");
});

// The timed-pause countdown: the badge stands only while a
// FUTURE team deadline stands, so a role-only or indefinite pause and an expired marker
// leave the header unchanged — the read side treats an expired marker as unpaused, and the
// badge must never claim a countdown that is over.
test("pauseBadge counts down a standing team timed pause and stays empty otherwise", () => {
  const now = 1_800_000_000_000;
  assert.equal(pauseBadge(undefined, now), "", "no timed pause: no badge");
  assert.equal(pauseBadge(now - 1, now), "", "an expired deadline renders nothing, matching the unpaused read");
  assert.equal(pauseBadge(now + 45_000, now), " · paused — auto-resumes in 45s", "sub-minute reads seconds");
  assert.equal(pauseBadge(now + 12 * 60_000, now), " · paused — auto-resumes in 12m", "sub-hour reads minutes");
  assert.equal(pauseBadge(now + 3 * 3_600_000, now), " · paused — auto-resumes in 3h", "hours read hours");

  // The operator's why (`pause --reason <text>`) rides after the countdown; a reason also
  // makes the untimed pause visible (`· paused — "why"`), the one change to today's form.
  assert.equal(pauseBadge(now + 45_000, now, "deploying"), " · paused — auto-resumes in 45s — \"deploying\"");
  assert.equal(pauseBadge(undefined, now, "deploying"), " · paused — \"deploying\"");
  assert.equal(pauseBadge(undefined, now), "", "no reason, no change: an indefinite pause stays invisible");
  assert.equal(pauseBadge(now - 1, now, "deploying"), " · paused — \"deploying\"");
});

// pauseCountdown is the guard + rounding behind both pause countdowns (the badge and the
// team-alerts title): none when the deadline is absent or already past — an expired marker
// reads as unpaused — else humanSeconds of the remaining milliseconds.
test("pauseCountdown returns the remaining duration, or null when no countdown stands", () => {
  const now = 1_800_000_000_000;
  assert.equal(pauseCountdown(undefined, now), null, "no timed pause: no countdown");
  assert.equal(pauseCountdown(now - 1, now), null, "an expired deadline is no countdown, matching the unpaused read");
  assert.equal(pauseCountdown(now + 45_000, now), "45s", "sub-minute reads seconds");
  assert.equal(pauseCountdown(now + 3 * 3_600_000, now), "3h", "hours read hours");
  assert.equal(pauseCountdown(now + 90 * 86_400_000, now), "90d", "days read days, not an hour count");
});

// The counts fragment both main-check surfaces render (BUGS.md 2026-09-30: the GUI sidebar
// re-derived `pass/tests` and dropped the skipped count, so a fully green suite with one
// skip read like one failure). Every non-passing count is named explicitly; zero counts add
// no parenthetical, matching the stamp wording the README carried.
test("mainCountsFragment names the skipped and failed counts the pass ratio would fold away", () => {
  assert.equal(mainCountsFragment({ tests: 2430, pass: 2429, fail: 0, skipped: 1 }), "2429/2430 (1 skipped)", "a skip is named, not folded into the ratio");
  assert.equal(mainCountsFragment({ tests: 2430, pass: 2427, fail: 2, skipped: 1 }), "2427/2430 (2 failed · 1 skipped)", "fail and skip both read, fail first");
  assert.equal(mainCountsFragment({ tests: 2430, pass: 2428, fail: 2, skipped: 0 }), "2428/2430 (2 failed)", "a failure is named even with no skip");
  assert.equal(mainCountsFragment({ tests: 2430, pass: 2430, fail: 0, skipped: 0 }), "2430/2430", "a fully green suite stays bare");
  assert.equal(mainCountsFragment(undefined), "", "a check without counts renders nothing");
});

test("mainCheckBadge renders the shared counts fragment", () => {
  assert.equal(
    mainCheckBadge({ sha: "a".repeat(40), status: "passed", counts: { tests: 10, pass: 9, fail: 0, skipped: 1 }, at: 0 }),
    " · main aaaaaaaa: green · 9/10 (1 skipped)",
  );
  assert.equal(mainCheckBadge(undefined), "", "no check: no badge");
});

// The disk floor's header fragment (plans/disk-floor.md, part 4/4): the hold names itself,
// below the reclaim threshold renders the bare reading, and every other state is empty so the
// header stays byte-identical. A disk block absent (an older orchestrator, an unmeasurable
// volume) renders nothing, exactly as before the field existed. A recorded reclaim rides the
// fragment whenever it has run, so its size and age stand even after space recovers.
test("permitsBadge shows the team line slots and stays byte-identical without a pool", () => {
  assert.equal(permitsBadge(undefined), "", "no permit snapshot: header unchanged");
  // A map-less team publishes an empty byKey (no caps), so the whole badge stays empty and
  // the header is unchanged.
  assert.equal(permitsBadge({ inUse: 5, limit: 8, reserve: 0, byKey: {} }), "");
  // With a per-provider cap map set, the team total and each capped key ride the badge;
  // uncapped keys that happen to be in the snapshot are dropped.
  assert.equal(
    permitsBadge({ inUse: 5, limit: 8, reserve: 0, byKey: {
      omlx: { inUse: 3, limit: 3, waiting: 1 },
      claude: { inUse: 2, limit: 6, waiting: 0 },
      huggingface: { inUse: 1, waiting: 0 },
    } }),
    " · running 5 of 8 · claude 2/6 · omlx 3/3",
  );
});

test("diskBadge shows the hold or low space and stays empty otherwise", () => {
  assert.equal(diskBadge(undefined), "", "no disk block: header unchanged");
  assert.equal(diskBadge({ freeGB: 100, holdGB: 10, reclaimGB: 40, held: false }), "", "comfortable space: no badge");
  assert.equal(diskBadge({ freeGB: 30, holdGB: 10, reclaimGB: 40, held: false }), " · disk 30.0 GB free", "below the reclaim threshold informs");
  assert.equal(diskBadge({ freeGB: 8.2, holdGB: 10, reclaimGB: 40, held: true }), " · disk 8.2 GB free — holding new work", "the hold names itself");
  assert.equal(diskBadge({ freeGB: 8.2, holdGB: 10, reclaimGB: 0, held: false }), "", "reclaim disabled means no low badge");
});

test("diskBadge leaves the last reclaim to the Activity log, held or recovered", () => {
  const reclaimed = { at: 0, mode: "pressure" as const, freedGB: 3.24 };
  assert.equal(
    diskBadge({ freeGB: 8.2, holdGB: 10, reclaimGB: 40, held: true, lastReclaim: reclaimed }),
    " · disk 8.2 GB free — holding new work",
    "a held team names the hold, not the reclaim that ran",
  );
  assert.equal(
    diskBadge({ freeGB: 100, holdGB: 10, reclaimGB: 40, held: false, lastReclaim: reclaimed }),
    "",
    "a recovered disk shows nothing, whatever the last reclaim freed",
  );
});

// The subscription usage-window fragment (plans/agent-backends.md §8, PLANS.md part 6d/7):
// the window replaces the daily spend on a subscription-only team and joins it on a mixed one.
// The reset clock is built from a LOCAL Date, so the expected HH:MM holds in any test timezone.
test("budgetBadge renders the subscription window in place of or beside the daily spend", () => {
  const at = (h: number, m: number) => new Date(2026, 9, 10, h, m).getTime();
  const now = at(10, 18);
  const cw = (over: Partial<NonNullable<StatusSnapshot["claudeWindow"]>> = {}): NonNullable<StatusSnapshot["claudeWindow"]> => ({
    windows: [{ type: "five_hour", status: "allowed", resetsAt: at(14, 30), utilization: 0.64, observedAt: 0 }],
    primary: { type: "five_hour", status: "allowed", resetsAt: at(14, 30), utilization: 0.64, observedAt: 0 },
    only: true,
    heldUntil: null,
    ...over,
  });
  assert.equal(
    budgetBadge({ spentUsd: 3, capUsd: 50, capHitAt: null, free: false, fallback: null }, cw(), now),
    " · Claude 5h · 64% · resets in 4h 12m",
    "subscription-only: the window replaces the daily spend",
  );
  assert.equal(
    budgetBadge({ spentUsd: 3, capUsd: 50, capHitAt: null, free: false, fallback: null }, cw({
      primary: { type: "five_hour", status: "allowed_warning", resetsAt: at(14, 30), observedAt: 0 },
    }), now),
    " · Claude 5h · near limit · resets in 4h 12m",
    "no utilization: the status word stands in",
  );
  assert.equal(
    budgetBadge({ spentUsd: 3, capUsd: 50, capHitAt: null, free: false, fallback: null }, cw({
      primary: { type: "five_hour", status: "rejected", resetsAt: at(15, 0), utilization: 1, observedAt: 0 },
      heldUntil: at(15, 0),
    })),
    " · Claude 5h · 100% · claude model jobs wait until 15:00",
    "rejected: the held wording replaces resets",
  );
  assert.equal(
    budgetBadge({ spentUsd: 3, capUsd: 50, capHitAt: null, free: false, fallback: null }, cw({
      primary: { type: "five_hour", status: "allowed", isUsingOverage: true, utilization: 0.8, observedAt: 0 },
    })),
    " · Claude 5h · 80% · overage",
    "the overage marker rides while the account spends into overage",
  );
  assert.equal(
    budgetBadge({ spentUsd: 3, capUsd: 50, capHitAt: null, free: false, fallback: null }, cw({
      primary: { type: "five_hour", status: "reset", observedAt: 0 },
    })),
    " · Claude 5h · reset",
    "a past window reads reset and names no clock",
  );
  const sevenDay = (resetsAt: number) => cw({
    primary: { type: "seven_day", status: "allowed", resetsAt, utilization: 0.14, observedAt: 0 },
  });
  const budget = { spentUsd: 3, capUsd: 50, capHitAt: null, free: false, fallback: null };
  assert.equal(
    budgetBadge(budget, sevenDay(new Date(2026, 9, 15, 13, 18).getTime()), now),
    " · Claude 7d · 14% · resets in 5d 3h",
    "a 7d window days out reads as days, not a bare clock",
  );
  assert.equal(
    budgetBadge(budget, sevenDay(now - 5_000), now),
    " · Claude 7d · 14% · resets now",
    "a deadline already past reads now",
  );
  // Mixed: the daily-spend line plus the window line.
  assert.equal(
    budgetBadge({ spentUsd: 12.34, capUsd: 50, capHitAt: null, free: false, fallback: null }, cw({ only: false }), now),
    " · budget: $12.34/$50 today · Claude 5h · 64% · resets in 4h 12m",
    "mixed: both the daily spend and the window",
  );
  // None: no window block, byte-identical to before.
  assert.equal(
    budgetBadge({ spentUsd: 12.34, capUsd: 50, capHitAt: null, free: false, fallback: null }),
    " · budget: $12.34/$50 today",
  );
  // The tone: red at rejected, yellow near the limit, none otherwise.
  assert.equal(claudeWindowTone(cw({ primary: { type: "five_hour", status: "rejected", observedAt: 0 } })), "red");
  assert.equal(claudeWindowTone(cw({ primary: { type: "five_hour", status: "allowed_warning", observedAt: 0 } })), "yellow");
  assert.equal(claudeWindowTone(cw()), undefined);
  assert.equal(claudeWindowTone(undefined), undefined);
});

test("budgetBadge's fallback label with no pair halves is pi's default", () => {
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: {} }),
    " · budget: $50.00/$50 today · over-cap model: pi default (cost n/a)",
  );
});

test("wakeBadge names a pending scheduled wake and is empty otherwise", () => {
  const now = 1_000_000;
  assert.equal(wakeBadge({ roles: ["feature", "plan"], atMs: now + 45 * 60_000 }, now), " · wake scheduled in 45m (feature, plan)");
  assert.equal(wakeBadge(undefined, now), "");
  assert.equal(wakeBadge({ roles: ["feature"], atMs: now }, now), "");
});

test("roleWakeMarker names the earliest future wake that names the role", () => {
  const now = 1_000_000;
  const h = 3_600_000;
  const wakes = [{ roles: ["feature"], atMs: now + h }, { roles: ["plan"], atMs: now + 2 * h }];
  assert.equal(roleWakeMarker(wakes, "feature", undefined, now), " · wake in 1h");
  assert.equal(roleWakeMarker(wakes, "plan", undefined, now), " · wake in 2h");
  assert.equal(roleWakeMarker(wakes, "qa", undefined, now), "");
  assert.equal(roleWakeMarker(wakes, "feature-2", "feature", now), " · wake in 1h", "an instance matches its base role's wake");
  assert.equal(roleWakeMarker([...wakes].reverse(), "plan", undefined, now), " · wake in 2h");
  const both = [{ roles: ["plan"], atMs: now + 3 * h }, { roles: ["plan"], atMs: now + h }];
  assert.equal(roleWakeMarker(both, "plan", undefined, now), " · wake in 1h", "latest-first still yields the earliest");
  assert.equal(roleWakeMarker([{ roles: ["feature"], atMs: now }], "feature", undefined, now), "");
  assert.equal(roleWakeMarker(undefined, "feature", undefined, now), "");
});

test("runWindowBadge counts down to the deadline, then reads stopping, and is empty unwindowed", () => {
  const now = 1_000_000;
  assert.equal(runWindowBadge(undefined, now), "");
  assert.equal(runWindowBadge(now + 2 * 3600_000, now), " · stops in 2h");
  assert.equal(runWindowBadge(now - 1, now), " · stopping");
});

test("budgetBadge names each tier's fallback step while the window is rejected", () => {
  const at = (h: number, m: number) => new Date(2026, 9, 10, h, m).getTime();
  const cw: NonNullable<StatusSnapshot["claudeWindow"]> = {
    windows: [{ type: "five_hour", status: "rejected", resetsAt: at(15, 0), utilization: 1, observedAt: 0 }],
    primary: { type: "five_hour", status: "rejected", resetsAt: at(15, 0), utilization: 1, observedAt: 0 },
    only: false,
    heldUntil: at(15, 0),
  };
  const budget = { spentUsd: 3, capUsd: 50, capHitAt: null, free: false, fallback: null };
  const chain = {
    default: { pair: "DeepSeek-V4-Flash", step: 2, of: 2, reason: "window" as const, returnsAt: at(15, 0), spentUsd: 3.1, capUsd: 5 },
  };
  const moved = budgetBadge(budget, cw, at(10, 0), chain);
  assert.match(moved, /default → DeepSeek-V4-Flash \$3\.10\/\$5 until 15:00/);
  assert.match(moved, /on fallback until 15:00/);
  assert.doesNotMatch(moved, /wait until|held/);
  assert.match(budgetBadge(budget, cw, at(10, 0)), /claude model jobs wait until 15:00/);
  assert.equal(chainBadge(undefined), "");
  assert.equal(chainBadge({}), "");
});

test("checksBadge shows the check pool only while a check runs or waits", () => {
  assert.equal(checksBadge(undefined), "");
  assert.equal(checksBadge({ inUse: 0, limit: 2, waiting: 0 }), "");
  assert.equal(checksBadge({ inUse: 1, limit: 2, waiting: 0 }), " · checks 1/2");
  assert.equal(checksBadge({ inUse: 2, limit: 2, waiting: 3 }), " · checks 2/2, 3 waiting");
});

test("workspacesBadge shows the pool only while it is full or a run waits", () => {
  assert.equal(workspacesBadge(undefined), "");
  assert.equal(workspacesBadge({ leased: 3, limit: 8, waiting: 0 }), "");
  assert.equal(workspacesBadge({ leased: 8, limit: 8, waiting: 0 }), " · workspaces 8/8");
  assert.equal(workspacesBadge({ leased: 8, limit: 8, waiting: 2 }), " · workspaces 8/8, 2 waiting");
});
