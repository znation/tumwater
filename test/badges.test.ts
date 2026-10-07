/** The badges suite: the status header's badge fragments (budgetBadge, buildBadge,
 * mainCheckBadge, landingBadge, pauseBadge) and the humanSeconds phrasing they share. Split
 * out of status-model.test.ts when the badges moved from src/ui/status-model.ts to
 * src/ui/badges.ts — this suite travels with the new module the way status-model.test.ts
 * travels with the per-loop display model. */
import test from "node:test";
import assert from "node:assert/strict";
import { budgetBadge, diskBadge, landingBadge, mainCheckBadge, mainCountsFragment, pauseBadge, pauseCountdown } from "../src/ui/badges.js";

test("budgetBadge renders the standing daily-cost rule in every cap state", () => {
  // One home for the badge string (renderStatus's header and the payload's preformatted
  // budgetBadge field): n/a for an all-free fleet (checked first, in EVERY cap state — a
  // disabled free fleet still cannot accumulate spend), $X/$Y while enabled with priced
  // models, `· no cap` when disabled. Whole-dollar caps stay bare ($50); fractional ones
  // keep their cents ($12.34).
  assert.equal(budgetBadge({ spentUsd: 0, capUsd: 50, capHitAt: null, free: true, fallback: null }), " · budget: n/a", "all-free fleet reads n/a");
  assert.equal(budgetBadge({ spentUsd: 12.34, capUsd: 50, capHitAt: null, free: false, fallback: null }), " · budget: $12.34/$50 today", "whole-dollar cap stays bare");
  assert.equal(budgetBadge({ spentUsd: 0, capUsd: 12.34, capHitAt: null, free: false, fallback: null }), " · budget: $0.00/$12.34 today", "fractional cap keeps its cents");
  assert.equal(budgetBadge({ spentUsd: 7.5, capUsd: 0, capHitAt: null, free: false, fallback: null }), " · budget: $7.50 today · no cap", "disabled: spend shown, gate off");
  assert.equal(budgetBadge({ spentUsd: 0, capUsd: 0, capHitAt: null, free: true, fallback: null }), " · budget: n/a", "free outranks disabled too");
});

// The cost n/a fallback model (plans/fallback-model.md): while it carries the fleet the badge
// names it, and the loops keep their ordinary state cells — they are working, not stopped.
test("budgetBadge names the fallback model only while it is carrying the fleet", () => {
  const fallback = { provider: "omlx", model: "local-free" };
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback }),
    " · budget: $50.00/$50 today · fallback: local-free (cost n/a)",
    "at the cap with a usable fallback: the badge says what the fleet is running on now",
  );
  assert.equal(
    budgetBadge({ spentUsd: 10, capUsd: 50, capHitAt: null, free: false, fallback }),
    " · budget: $10.00/$50 today",
    "under the cap the fallback is not engaged, so the badge is byte-identical to before",
  );
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: null }),
    " · budget: $50.00/$50 today",
    "at the cap with no usable fallback: the fleet is paused, nothing to name",
  );
  // A fallback naming only a provider still identifies itself.
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: { provider: "omlx" } }),
    " · budget: $50.00/$50 today · fallback: omlx (cost n/a)",
  );
});

test("budgetBadge lists the tiers when the fallback resolves to two or more distinct pairs", () => {
  // Part 7b/8: the snapshot's tier map stands exactly in that state, and the badge lists
  // each tier's pair in tier order, borrowed ones marked by their `(from …)` suffix.
  const tiers = { small: "free/qwen-free (from default)", default: "free/qwen-free", strong: "free/llama-free" };
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: { provider: "free", model: "qwen-free" }, tiers }),
    " · budget: $50.00/$50 today · fallback: small: free/qwen-free (from default), default: free/qwen-free, strong: free/llama-free (cost n/a)",
    "a strong-tier borrow must be visible at a glance",
  );
  // A one-entry map (a torn snapshot — never emitted by status-data, which requires two
  // distinct pairs) falls back to the single-pair text, exactly like an absent map.
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: { provider: "free", model: "qwen-free" }, tiers: { default: "free/qwen-free" } }),
    " · budget: $50.00/$50 today · fallback: qwen-free (cost n/a)",
  );
  // Without the map — the single-fallback state the pre-tier badge saw — the single-pair
  // text stands byte-identical.
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: { provider: "omlx", model: "local-free" }, tiers: null }),
    " · budget: $50.00/$50 today · fallback: local-free (cost n/a)",
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
    "an all-free fleet never carries a forecast",
  );
});

// Merge queue 4/5 — the land queue's one payload field, three renderers: the header badge,
// the marker-driven row label, and the payload's preformatted field.
test("landingBadge shows the land queue depth and stays empty when idle", () => {
  // Empty at depth 0 keeps every existing header byte identical; the count while anything
  // is queued or landing (in-flight landings always count toward depth — their entry stays
  // in the queue until its outcome).
  assert.equal(landingBadge({ depth: 0 }), "", "idle queue adds nothing to the header");
  assert.equal(landingBadge({ depth: 1 }), " · land queue: 1");
  assert.equal(landingBadge({ depth: 3 }), " · land queue: 3");
});

// The timed-pause countdown (PLANS.md "Pause countdown"): the badge stands only while a
// FUTURE fleet deadline stands, so a role-only or indefinite pause and an expired marker
// leave the header unchanged — the read side treats an expired marker as unpaused, and the
// badge must never claim a countdown that is over.
test("pauseBadge counts down a standing fleet timed pause and stays empty otherwise", () => {
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
// fleet-alerts title): none when the deadline is absent or already past — an expired marker
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
test("diskBadge shows the hold or low space and stays empty otherwise", () => {
  assert.equal(diskBadge(undefined), "", "no disk block: header unchanged");
  assert.equal(diskBadge({ freeGB: 100, holdGB: 10, reclaimGB: 40, held: false }), "", "comfortable space: no badge");
  assert.equal(diskBadge({ freeGB: 30, holdGB: 10, reclaimGB: 40, held: false }), " · disk 30.0 GB free", "below the reclaim threshold informs");
  assert.equal(diskBadge({ freeGB: 8.2, holdGB: 10, reclaimGB: 40, held: true }), " · disk 8.2 GB free — holding new work", "the hold names itself");
  assert.equal(diskBadge({ freeGB: 8.2, holdGB: 10, reclaimGB: 0, held: false }), "", "reclaim disabled means no low badge");
});

test("diskBadge names the last reclaim's size and age, held or recovered", () => {
  const at = Date.UTC(2026, 9, 7, 12, 0, 0);
  const now = at + 5 * 60_000;
  const reclaimed = { at, mode: "pressure" as const, freedGB: 3.24 };
  assert.equal(
    diskBadge({ freeGB: 8.2, holdGB: 10, reclaimGB: 40, held: true, lastReclaim: reclaimed }, now),
    " · disk 8.2 GB free — holding new work · last reclaim freed 3.2 GB 5m ago",
    "a held fleet also names the reclaim that ran",
  );
  assert.equal(
    diskBadge({ freeGB: 100, holdGB: 10, reclaimGB: 40, held: false, lastReclaim: reclaimed }, now),
    " · last reclaim freed 3.2 GB 5m ago",
    "the reclaim stands on its own after space recovers",
  );
});
