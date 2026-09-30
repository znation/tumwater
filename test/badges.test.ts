/** The badges suite: the status header's badge fragments (budgetBadge, buildBadge,
 * mainCheckBadge, landingBadge, pauseBadge) and the humanSeconds phrasing they share. Split
 * out of status-model.test.ts when the badges moved from src/ui/status-model.ts to
 * src/ui/badges.ts — this suite travels with the new module the way status-model.test.ts
 * travels with the per-loop display model. */
import test from "node:test";
import assert from "node:assert/strict";
import { budgetBadge, landingBadge, mainCheckBadge, mainCountsFragment, pauseBadge } from "../src/ui/badges.js";

test("budgetBadge renders the standing daily-cost rule in every cap state", () => {
  // One home for the badge string (renderStatus's header and the payload's preformatted
  // budgetBadge field): n/a for an all-free fleet (checked first, in EVERY cap state — a
  // disabled free fleet still cannot accumulate spend), $X/$Y while enabled with priced
  // models, `· no cap` when disabled. Whole-dollar caps stay bare ($50); fractional ones
  // keep their cents ($12.34).
  assert.equal(budgetBadge({ spentUsd: 0, capUsd: 50, free: true, fallback: null }), " · budget: n/a", "all-free fleet reads n/a");
  assert.equal(budgetBadge({ spentUsd: 12.34, capUsd: 50, free: false, fallback: null }), " · budget: $12.34/$50 today", "whole-dollar cap stays bare");
  assert.equal(budgetBadge({ spentUsd: 0, capUsd: 12.34, free: false, fallback: null }), " · budget: $0.00/$12.34 today", "fractional cap keeps its cents");
  assert.equal(budgetBadge({ spentUsd: 7.5, capUsd: 0, free: false, fallback: null }), " · budget: $7.50 today · no cap", "disabled: spend shown, gate off");
  assert.equal(budgetBadge({ spentUsd: 0, capUsd: 0, free: true, fallback: null }), " · budget: n/a", "free outranks disabled too");
});

// The cost n/a fallback model (plans/fallback-model.md): while it carries the fleet the badge
// names it, and the loops keep their ordinary state cells — they are working, not stopped.
test("budgetBadge names the fallback model only while it is carrying the fleet", () => {
  const fallback = { provider: "omlx", model: "local-free" };
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, free: false, fallback }),
    " · budget: $50.00/$50 today · fallback: local-free (cost n/a)",
    "at the cap with a usable fallback: the badge says what the fleet is running on now",
  );
  assert.equal(
    budgetBadge({ spentUsd: 10, capUsd: 50, free: false, fallback }),
    " · budget: $10.00/$50 today",
    "under the cap the fallback is not engaged, so the badge is byte-identical to before",
  );
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, free: false, fallback: null }),
    " · budget: $50.00/$50 today",
    "at the cap with no usable fallback: the fleet is paused, nothing to name",
  );
  // A fallback naming only a provider still identifies itself.
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, free: false, fallback: { provider: "omlx" } }),
    " · budget: $50.00/$50 today · fallback: omlx (cost n/a)",
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
