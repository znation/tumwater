import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config/config.js";
import { pollRunnerReasons } from "../src/orchestrator-scheduling.js";
import { OnceRound } from "../src/once-round.js";
import { pollFleetHold } from "../src/fleet/fleet-polls.js";
import { heldProviders } from "../src/fleet/fleet-hold.js";
import type { LoopRunner } from "../src/loop.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import type { WorkLandedCache } from "../src/work-landed-cache.js";
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
    roleQuietHeld: new Set<string>(),
    gate: "open" as const,
    probeDue: false,
    heldProviders: new Set<string | undefined>() as ReadonlySet<string | undefined>,
    reviewHeld: false,
    roleProviders,
    openBugsNow: false,
    workBacklogOpen: false,
    holdForRestart: false,
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