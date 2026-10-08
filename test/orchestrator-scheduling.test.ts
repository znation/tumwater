import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { pollRunnerReasons } from "../src/orchestrator/orchestrator-scheduling.js";
import { OnceRound } from "../src/scheduling/once-round.js";
import { pollFleetHold } from "../src/fleet/fleet-polls.js";
import { heldProviders } from "../src/fleet/fleet-hold.js";
import type { LoopRunner } from "../src/loop/loop.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import type { WorkLandedCache } from "../src/scheduling/work-landed-cache.js";
import { tmpdir } from "./repo-fixtures.js";

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

/** A config whose feature role runs two instances: loop-ids.ts reads the count through a cast
 * until part 5/7 adds the schema field, so the test sets it the same way. */
function twoFeatureInstances(): TumwaterConfig {
  const config = defaultConfig();
  (config.roles as Record<string, { enabled?: boolean; instances?: number }>).feature = {
    enabled: true,
    instances: 2,
  };
  return config;
}

const TWO_PLANS = [
  "# Plans",
  "",
  "## Planned",
  "",
  "### Alpha (planned 2026-01-01 by operator)",
  "",
  "Body.",
  "",
  "### Beta (planned 2026-01-01 by operator)",
  "",
  "Body.",
  "",
  "## Done",
  "",
].join("\n");

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
