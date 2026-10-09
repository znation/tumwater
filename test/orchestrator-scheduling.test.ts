import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { pollRunnerReasons } from "../src/orchestrator/orchestrator-scheduling.js";
import { newMaintenanceQuotaGateState, pollMaintenanceQuotaGate } from "../src/gates/maintenance-quota.js";
import { OnceRound } from "../src/scheduling/once-round.js";
import { pollFleetHold } from "../src/fleet/fleet-polls.js";
import { heldProviders } from "../src/fleet/fleet-hold.js";
import type { LoopRunner } from "../src/loop/loop.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import type { WorkLandedCache } from "../src/scheduling/work-landed-cache.js";
import { CLAIM_IDLE_MAX_MS } from "../src/scheduling/claims.js";
import { eventsLogPath } from "../src/paths.js";
import { tmpdir, twoPlansDoc } from "./fixtures/repo-fixtures.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { HOUR } from "./helpers/oracles.js";

// The scheduling pass's per-provider hold block (PLANS.md 2026-10-05): a storm at provider P
// holds the roles whose tick model is on P while roles on a healthy provider Q keep ticking,
// the reviewer's provider being held blocks EVERY role (with the review gate on, nothing
// could land), and — the seam the 2026-10-06 review called out as untested — a storm, its
// lift, and the SUBSEQUENT poll run through scheduling end with the previously held role
// admitted again: a lifted hold never keeps blocking.

const T0 = 1_000_000_000;

/** A runner as the scheduling pass reads it (structural stand-in: role, config, and the
 * LoopState fields isEligible touches — idle, never ticked, due now). */
function fakeRunner(role: string, config: TumwaterConfig): LoopRunner {
  return {
    role,
    config,
    state: {
      running: false,
      ticks: 0,
      nextRunAt: 0,
      resumePending: false,
      lastMainHead: "",
      recentOutcomes: "",
    },
  } as unknown as LoopRunner;
}

function schedulingCtx(root: string, runners: readonly LoopRunner[], roleProviders: Map<string, string | undefined>) {
  return {
    root,
    runners,
    once: new OnceRound([], false),
    now: T0 + 10_000,
    mainHead: "",
    userPaused: false,
    quietNow: false,
    pausedRoles: new Set<string>(),
    capPaused: new Set<string>(),
    maintenanceQuota: { allowance: Number.POSITIVE_INFINITY, used: 0, held: false },
    bootstrapHeld: new Set<string>(),
    bootstrapActive: false,
    budgetPausedRoles: new Set<string>(),
    probeRoles: new Set<string>(),
    reviewStrongPaused: false,
    roleQuietHeld: new Set<string>(),
    heldProviders: new Set<string | undefined>() as ReadonlySet<string | undefined>,
    reviewHeld: false,
    roleProviders,
    openBugsNow: false,
    workBacklogOpen: false,
    holdForRestart: false,
    diskHeld: false,
    deferredDue: new Map<string, boolean>(),
    workLandedSince: {} as unknown as WorkLandedCache,
  };
}

test("a storm at provider P holds only P's roles through scheduling, and the lift re-admits them on a later poll", async () => {
  const root = tmpdir("tumwater-scheduling-hold-");
  // The reviewer sits on the healthy provider Q, so this test isolates the per-provider
  // block: P's storm must not reach through the review gate (that is the next test's case).
  const config = { ...defaultConfig(), review: { ...defaultConfig().review, model: "Q/reviewer" } };
  const runners = [fakeRunner("feature", config), fakeRunner("perf", config), fakeRunner("dry", config)];
  const roleProviders = new Map([
    ["feature", "P"],
    ["perf", "P"],
    ["dry", "Q"],
  ]);

  // The fleet's runs: two roles fail with 429s on provider P inside the window; dry runs on
  // the healthy provider Q. The hold poll trips P's hold only.
  const holdRunners = [
    { role: "feature", provider: "P", lastRateLimit: { at: T0 } },
    { role: "perf", provider: "P", lastRateLimit: { at: T0 + 1_000 } },
    { role: "dry", provider: "Q" },
  ];
  const holds = pollFleetHold(root, new Map(), holdRunners, T0 + 1_000);
  const held = heldProviders(holds);
  assert.deepEqual([...held], ["P"]);

  // Roles on P start no tick; the role on Q keeps ticking (the reviewer is on Q too, so no
  // review-gate full block is in play here).
  const heldCtx = schedulingCtx(root, runners, roleProviders);
  heldCtx.heldProviders = held;
  heldCtx.reviewHeld = false;
  const reasonsHeld = await pollRunnerReasons(heldCtx);
  assert.equal(reasonsHeld.has(runners[0]!), false, "a role on the held provider starts no tick");
  assert.equal(reasonsHeld.has(runners[1]!), false, "its sibling on the same provider is held too");
  assert.equal(reasonsHeld.has(runners[2]!), true, "a role on the healthy provider keeps ticking");

  // The lift: P's hold re-opens at its deadline; heldProviders() reads nothing. The
  // subsequent poll admits the previously held roles again — a lifted hold never keeps
  // blocking (the 2026-10-06 review's objection: key presence in the map is relapse memory).
  const liftedHolds = pollFleetHold(root, holds, [], holds.get("P")!.until!);
  const lifted = heldProviders(liftedHolds);
  assert.equal(lifted.size, 0, "the lift clears the held-provider set");
  assert.notEqual(liftedHolds.get("P"), undefined, "the lifted entry stays keyed for its relapse memory");
  const liftedCtx = schedulingCtx(root, runners, roleProviders);
  liftedCtx.heldProviders = lifted;
  liftedCtx.reviewHeld = false;
  const reasonsLifted = await pollRunnerReasons(liftedCtx);
  assert.equal(reasonsLifted.has(runners[0]!), true, "the previously held role is admitted again");
  assert.equal(reasonsLifted.has(runners[1]!), true);
  assert.equal(reasonsLifted.has(runners[2]!), true);
  assert.equal(reasonsLifted.get(runners[0]!), "startup");
});

/** A config whose feature role runs two instances, set through the schema field part 5a/7
 * added (`roles.<id>.instances`). */
function twoFeatureInstances(): TumwaterConfig {
  const config = defaultConfig();
  config.roles.feature = { enabled: true, instances: 2 };
  return config;
}

const TWO_PLANS = twoPlansDoc();

const ONE_BLOCKED_PLAN = [
  "# Plans",
  "",
  "## Planned",
  "",
  "### Base, part 1/2: first (planned 2026-01-01 by operator)",
  "",
  "Body.",
  "",
  "### Base, part 2/2: second (planned 2026-01-01 by operator; requires part 1/2 landed)",
  "",
  "Body.",
  "",
  "## Done",
  "",
].join("\n");

test("two feature instances take distinct entry claims in one poll", async () => {
  const root = tmpdir("tumwater-scheduling-claims-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  const reasons = await pollRunnerReasons(
    schedulingCtx(root, [feature, feature2], new Map([["feature", undefined], ["feature-2", undefined]])),
  );
  assert.equal(reasons.has(feature), true);
  assert.equal(reasons.has(feature2), true);
  assert.equal(feature.state.claim?.key, "alpha");
  assert.equal(feature2.state.claim?.key, "beta");
  assert.notEqual(feature.state.claim?.key, feature2.state.claim?.key);
});

test("an extra instance with no free entry is skipped and keeps its schedule", async () => {
  const root = tmpdir("tumwater-scheduling-idle-extra-");
  // One eligible plan and one blocked by the still-planned prerequisite: only the primary
  // gets the base plan; the blocked entry is never assigned.
  fs.writeFileSync(path.join(root, "PLANS.md"), ONE_BLOCKED_PLAN);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  const before = { nextRunAt: feature2.state.nextRunAt, backoffSeconds: feature2.state.backoffSeconds };
  const reasons = await pollRunnerReasons(
    schedulingCtx(root, [feature, feature2], new Map([["feature", undefined], ["feature-2", undefined]])),
  );
  assert.equal(reasons.has(feature), true);
  assert.equal(feature.state.claim?.key.startsWith("base"), true, "the eligible entry is claimed");
  assert.equal(reasons.has(feature2), false, "no free entry admits no extra instance");
  assert.equal(feature2.state.nextRunAt, before.nextRunAt);
  assert.equal(feature2.state.backoffSeconds, before.backoffSeconds);
  assert.equal(feature2.state.claim, undefined);
});

test("a claimed entry that lands releases the claim on the next poll", async () => {
  const root = tmpdir("tumwater-scheduling-release-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  const first = await pollRunnerReasons(
    schedulingCtx(root, [feature, feature2], new Map([["feature", undefined], ["feature-2", undefined]])),
  );
  assert.equal(first.has(feature), true);
  // Alpha moves to Done: its key leaves the Planned section, so the claim is released.
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    TWO_PLANS.replace(/### Alpha[^\n]*\n\nBody\.\n\n/, "").replace(
      "## Done",
      "## Done\n\n### Alpha (planned 2026-01-01 by operator; done 2026-01-02 by feature)",
    ),
  );
  await pollRunnerReasons(
    schedulingCtx(root, [feature, feature2], new Map([["feature", undefined], ["feature-2", undefined]])),
  );
  assert.equal(feature.state.claim, undefined);
});

test("lowering feature.instances releases a surplus instance's claim instead of holding it", async () => {
  const root = tmpdir("tumwater-scheduling-lowered-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  await pollRunnerReasons(
    schedulingCtx(root, [feature, feature2], new Map([["feature", undefined], ["feature-2", undefined]])),
  );
  assert.equal(feature2.state.claim?.key, "beta", "instance 2 starts holding the second entry");
  // Live reload lowers the instance count but leaves feature-2's runner in place; `loopEnabled`
  // skips its future ticks. Its claim must be released as `disabled`, freeing beta for a sibling
  // instead of locking it until the 24h stale sweep.
  config.roles.feature = { enabled: true, instances: 1 };
  const reasons = await pollRunnerReasons(
    schedulingCtx(root, [feature, feature2], new Map([["feature", undefined], ["feature-2", undefined]])),
  );
  assert.equal(feature2.state.claim, undefined, "the surplus instance's claim is released");
  assert.equal(reasons.has(feature2), false, "the surplus instance starts no tick");
  assert.equal(feature.state.claim?.key, "alpha", "the surviving instance keeps its own claim");
});

test("a single feature runner is not assigned a claim", async () => {
  const root = tmpdir("tumwater-scheduling-single-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  const feature = fakeRunner("feature", defaultConfig());
  const reasons = await pollRunnerReasons(
    schedulingCtx(root, [feature], new Map([["feature", undefined]])),
  );
  assert.equal(reasons.has(feature), true);
  assert.equal(feature.state.claim, undefined);
});

test("the reviewer's provider being held blocks every role through scheduling, and only while it stands", async () => {
  const root = tmpdir("tumwater-scheduling-review-");
  const runners = [fakeRunner("feature", defaultConfig()), fakeRunner("dry", defaultConfig())];
  const roleProviders = new Map([
    ["feature", "Q"],
    ["dry", "Q"],
  ]);

  // A storm on the strong tier's provider P while the review gate is on: nothing could land,
  // so every role is blocked — not just roles ticking on P.
  const heldCtx = schedulingCtx(root, runners, roleProviders);
  heldCtx.reviewHeld = true;
  const reasonsHeld = await pollRunnerReasons(heldCtx);
  assert.equal(reasonsHeld.size, 0, "no role starts a tick while the reviewer's provider is held");

  // When the review hold lifts, the roles tick again.
  const openCtx = schedulingCtx(root, runners, roleProviders);
  const reasonsOpen = await pollRunnerReasons(openCtx);
  assert.equal(reasonsOpen.size, 2, "both roles tick again once the review hold lifts");
});

/** Put a directory where the append-only events log belongs: every logEvent under `root`
 * throws EISDIR, while every other file under the real root still writes normally. The
 * scheduling pass runs inside the orchestrator's catch-less poll loop, so an unwritable
 * feed must not end the fleet: each converted event site has to survive the throw and
 * still perform the bookkeeping the event reports. */
function unwritableEvents(root: string): void {
  const file = eventsLogPath(root);
  fs.rmSync(file, { recursive: true, force: true });
  fs.mkdirSync(file, { recursive: true });
}

test("a claim assignment survives an unwritable events feed", async () => {
  const root = tmpdir("tumwater-scheduling-best-effort-assign-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  unwritableEvents(root);
  // Before the fix this poll rejected with EISDIR at the assignment's logEvent; the claim
  // must still be taken so the instance's work is not silently skipped.
  const reasons = await pollRunnerReasons(
    schedulingCtx(root, [feature, feature2], new Map([["feature", undefined], ["feature-2", undefined]])),
  );
  assert.equal(reasons.has(feature), true);
  assert.equal(feature.state.claim?.key, "alpha");
  assert.equal(feature2.state.claim?.key, "beta");
});

test("a claim release survives an unwritable events feed", async () => {
  const root = tmpdir("tumwater-scheduling-best-effort-release-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  await pollRunnerReasons(
    schedulingCtx(root, [feature, feature2], new Map([["feature", undefined], ["feature-2", undefined]])),
  );
  assert.equal(feature2.state.claim?.key, "beta");
  // Lower the instance count; the surplus instance's claim release logs an event.
  config.roles.feature = { enabled: true, instances: 1 };
  unwritableEvents(root);
  await pollRunnerReasons(
    schedulingCtx(root, [feature, feature2], new Map([["feature", undefined], ["feature-2", undefined]])),
  );
  assert.equal(feature2.state.claim, undefined, "the release happened despite the unwritable feed");
});

test("a stale-claim warning survives an unwritable events feed", async () => {
  const root = tmpdir("tumwater-scheduling-best-effort-stale-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  feature.state.claim = {
    file: "PLANS.md",
    key: "alpha",
    title: "Alpha",
    at: T0,
    source: "assigned",
  };
  feature2.state.claim = {
    file: "PLANS.md",
    key: "beta",
    title: "Beta",
    at: T0 - CLAIM_IDLE_MAX_MS - 1,
    source: "assigned",
  };
  unwritableEvents(root);
  await pollRunnerReasons(
    schedulingCtx(root, [feature, feature2], new Map([["feature", undefined], ["feature-2", undefined]])),
  );
  assert.equal(feature.state.claim?.key, "alpha", "the live claim is kept");
  // The stale claim was released (and may be re-assigned in the same poll): either way the
  // poll completed instead of rejecting on the warning's logEvent.
  assert.notEqual(feature2.state.claim?.at, T0 - CLAIM_IDLE_MAX_MS - 1);
});

test("a tick_deferred event survives an unwritable events feed", async () => {
  const root = tmpdir("tumwater-scheduling-best-effort-deferred-");
  const runner = fakeRunner("clean", defaultConfig());
  runner.state.lastResult = "no_change";
  runner.state.lastMainHead = "abc";
  runner.state.ticks = 1;
  unwritableEvents(root);
  const c = schedulingCtx(root, [runner], new Map([["clean", undefined]]));
  c.workBacklogOpen = true;
  const reasons = await pollRunnerReasons(c);
  assert.equal(reasons.has(runner), false, "the maintenance tick is still deferred");
  assert.equal(c.deferredDue.get("clean"), true, "the deferral edge is still remembered");
});

test("the bootstrap hold blocks maintenance through scheduling but admits plan and feature", async () => {
  const root = tmpdir("tumwater-scheduling-bootstrap-");
  const runners = [
    fakeRunner("plan", defaultConfig()),
    fakeRunner("feature", defaultConfig()),
    fakeRunner("clean", defaultConfig()),
  ];
  const ctx = schedulingCtx(
    root,
    runners,
    new Map([
      ["plan", undefined],
      ["feature", undefined],
      ["clean", undefined],
    ]),
  );
  ctx.bootstrapHeld = new Set(["clean"]);
  ctx.bootstrapActive = true;
  const reasons = await pollRunnerReasons(ctx);
  assert.equal(reasons.has(runners[2]!), false, "a bootstrap-held maintenance loop starts no tick");
  assert.equal(reasons.has(runners[0]!), true, "plan keeps ticking during bootstrap");
  assert.equal(reasons.has(runners[1]!), true, "feature keeps ticking during bootstrap");
});

test("the maintenance quota holds a maintenance loop; a fresh wake admits one tick anyway", async () => {
  const root = tmpdir("tumwater-scheduling-quota-");
  const runners = [fakeRunner("clean", defaultConfig()), fakeRunner("feature", defaultConfig())];
  const ctx = schedulingCtx(
    root,
    runners,
    new Map([
      ["clean", undefined],
      ["feature", undefined],
    ]),
  );
  ctx.maintenanceQuota = { allowance: 12, used: 12, held: true };
  const held = await pollRunnerReasons(ctx);
  assert.equal(held.has(runners[0]!), false, "a quota-held maintenance loop starts no tick");
  assert.equal(held.has(runners[1]!), true, "work loops are unaffected by the maintenance allowance");

  // A fresh operator wake is demand, not idle maintenance: it outranks the hold exactly as it
  // does the bootstrap and need-based deferrals, so `tumwater wake clean` runs one tick.
  const clean = runners[0]!;
  clean.state.wokenAt = T0 + 5_000;
  clean.state.lastTickEndedAt = T0 + 1_000;
  const woken = await pollRunnerReasons(ctx);
  assert.equal(woken.has(clean), true, "a fresh wake admits one tick while the quota holds");
});

test("the allowance's in-flight headroom starts at most one of two due maintenance loops per poll", async () => {
  const root = tmpdir("tumwater-scheduling-quota-race-");
  const runners = [fakeRunner("clean", defaultConfig()), fakeRunner("dry", defaultConfig())];
  const now = T0 + 10_000;
  // No work landings, so the floor allowance is 12; 11 maintenance landings leave exactly one
  // open slot in the rolling window.
  writeEvents(
    root,
    Array.from({ length: 11 }, (_, i) => ({
      ts: now - HOUR,
      loop: "clean",
      type: "merged",
      commit: `c${i}`,
    })),
  );
  const gate = pollMaintenanceQuotaGate(
    root,
    newMaintenanceQuotaGateState(),
    runners.map((r) => ({ role: r.role, enabled: true, running: false, hasQueuedLanding: false })),
    0,
    now,
  );
  assert.deepEqual(gate, { allowance: 12, used: 11, held: false }, "one slot is open");

  // First poll: both maintenance loops are due, but only one may take the open slot. The gate's
  // verdict is computed once, so the reservation has to be spent in the scheduling pass itself —
  // without it both loops would be admitted and the window would overshoot by one.
  const first = schedulingCtx(
    root,
    runners,
    new Map([
      ["clean", undefined],
      ["dry", undefined],
    ]),
  );
  first.maintenanceQuota = gate;
  const firstReasons = await pollRunnerReasons(first);
  assert.equal(firstReasons.has(runners[0]!), true, "the first due loop takes the open slot");
  assert.equal(firstReasons.has(runners[1]!), false, "the second waits its turn");

  // The first tick ends without landing (so the landed count, and the allowance, are unchanged).
  // Its backoff now makes it not due; the second takes the slot on the next poll — one tick,
  // not two, between the two starts.
  runners[0]!.state.lastTickEndedAt = now;
  runners[0]!.state.nextRunAt = now + HOUR;
  const second = schedulingCtx(
    root,
    runners,
    new Map([
      ["clean", undefined],
      ["dry", undefined],
    ]),
  );
  second.maintenanceQuota = gate;
  const secondReasons = await pollRunnerReasons(second);
  assert.equal(secondReasons.has(runners[0]!), false, "the first loop is back in its gap");
  assert.equal(secondReasons.has(runners[1]!), true, "the second loop starts one tick later");
});
