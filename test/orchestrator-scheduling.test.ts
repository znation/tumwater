import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { pollRunnerReasons } from "../src/orchestrator/orchestrator-scheduling.js";
import { newMaintenanceQuotaGateState, pollMaintenanceQuotaGate } from "../src/gates/maintenance-quota.js";
import { OnceRound } from "../src/scheduling/once-round.js";
import { pollTeamHold } from "../src/team/team-polls.js";
import { TEAM_OPEN, heldProviders, windowHeldProviders, type TeamHold } from "../src/team/team-hold.js";
import type { LoopRunner } from "../src/runner/runner.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import type { WorkMergedCache } from "../src/scheduling/work-merged-cache.js";
import { loadLoopState, saveLoopState } from "../src/runner/runner-state.js";
import { statePath } from "../src/paths.js";
import { CLAIM_IDLE_MAX_MS } from "../src/scheduling/claims.js";
import { assembleTickPrompt } from "../src/tick/tick-prompt.js";
import { enqueueMerge } from "../src/merge/merge-queue.js";
import { setRef } from "../src/git/git.js";
import { mergeRefName } from "../src/paths.js";
import { initializedRepo, mainSha, tmpdir, twoPlansDoc } from "./fixtures/repo-fixtures.js";
import { unwritableEvents, writeEvents } from "./fixtures/log-fixtures.js";
import { enqueueRolePrompt } from "../src/inbox/inbox.js";
import { HOUR } from "./helpers/oracles.js";

// The scheduling pass's per-provider hold block (PLANS.md 2026-10-05): a storm at provider P
// holds the roles whose tick model is on P while roles on a healthy provider Q keep ticking,
// the reviewer's provider being held blocks EVERY role (with the review gate on, nothing
// could merge), and — the seam the 2026-10-06 review called out as untested — a storm, its
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
      role,
      running: false,
      runs: 0,
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
    budgetPausedRoles: new Set<string>(),
    probeRoles: new Set<string>(),
    reviewStrongPaused: false,
    roleQuietHeld: new Set<string>(),
    heldProviders: new Set<string | undefined>() as ReadonlySet<string | undefined>,
    windowHeldProviders: new Set<string | undefined>() as ReadonlySet<string | undefined>,
    reviewHeld: false,
    roleProviders,
    openBugsNow: false,
    workBacklogOpen: false,
    planBacklogFull: false,
    holdForRestart: false,
    diskHeld: false,
    deferredDue: new Map<string, boolean>(),
    workMergedSince: {} as unknown as WorkMergedCache,
  };
}

test("a storm at provider P holds only P's roles through scheduling, and the lift re-admits them on a later poll", async () => {
  const root = tmpdir("tumwater-scheduling-hold-");
  // The reviewer sits on the healthy provider Q, so this test isolates the per-provider
  // block: P's storm must not reach through the review gate (that is the next test's case).
  const config = { ...defaultConfig(), review: { ...defaultConfig().review, model: "Q/reviewer" } };
  const runners = [fakeRunner("feature", config), fakeRunner("perf", config), fakeRunner("dedupe", config)];
  const roleProviders = new Map([
    ["feature", "P"],
    ["perf", "P"],
    ["dedupe", "Q"],
  ]);

  // The team's runs: two roles fail with 429s on provider P inside the window; dry runs on
  // the healthy provider Q. The hold poll trips P's hold only.
  const holdRunners = [
    { role: "feature", provider: "P", lastRateLimit: { at: T0 } },
    { role: "perf", provider: "P", lastRateLimit: { at: T0 + 1_000 } },
    { role: "dedupe", provider: "Q" },
  ];
  const holds = pollTeamHold(root, new Map(), holdRunners, T0 + 1_000);
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
  const liftedHolds = pollTeamHold(root, holds, [], holds.get("P")!.until!);
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

test("a subscription-window hold stops the director too, while a 429-storm hold still exempts it", async () => {
  const root = tmpdir("tumwater-scheduling-window-director-");
  const config = defaultConfig();
  const runners = [fakeRunner("director", config)];
  enqueueRolePrompt(root, "director", "hi");
  const roleProviders = new Map<string, string | undefined>([["director", "claude"]]);
  const hold = (kind: "subscription-window" | "rate-limit"): ReadonlyMap<string | undefined, TeamHold> =>
    new Map([["claude", { ...TEAM_OPEN, provider: "claude", until: T0 + HOUR, kind }]]);

  const window = schedulingCtx(root, runners, roleProviders);
  window.heldProviders = heldProviders(hold("subscription-window"));
  window.windowHeldProviders = windowHeldProviders(hold("subscription-window"));
  assert.equal((await pollRunnerReasons(window)).has(runners[0]!), false, "window hold: director waits");

  const storm = schedulingCtx(root, runners, roleProviders);
  storm.heldProviders = heldProviders(hold("rate-limit"));
  storm.windowHeldProviders = windowHeldProviders(hold("rate-limit"));
  assert.equal((await pollRunnerReasons(storm)).has(runners[0]!), true, "429 hold: director keeps running");
});

test("a director holding a kept merge pin with an empty inbox is due as leftover, unless its pin is already queued", async () => {
  const repo = await initializedRepo();
  const runners = [fakeRunner("director", defaultConfig())];
  const roleProviders = new Map<string, string | undefined>();
  assert.equal((await pollRunnerReasons(schedulingCtx(repo, runners, roleProviders))).has(runners[0]!), false, "no pin, no prompt: idle");

  const sha = mainSha(repo);
  await setRef(repo, mergeRefName("director"), sha);
  const due = await pollRunnerReasons(schedulingCtx(repo, runners, roleProviders));
  assert.equal(due.get(runners[0]!), "leftover");

  enqueueMerge(repo, { role: "director", sha, run: 1, summary: "kept", enqueuedAt: Date.now() });
  assert.equal((await pollRunnerReasons(schedulingCtx(repo, runners, roleProviders))).has(runners[0]!), false, "a queued pin is the interlock's to hold");
});

test("a director whose pin sits at the conflict cap awaiting hand-back is not offered leftover", async () => {
  const repo = await initializedRepo();
  const runners = [fakeRunner("director", defaultConfig())];
  const sha = mainSha(repo);
  await setRef(repo, mergeRefName("director"), sha);
  runners[0]!.state.mergeConflicts = { sha, count: 2 };
  const roleProviders = new Map<string, string | undefined>();
  assert.equal((await pollRunnerReasons(schedulingCtx(repo, runners, roleProviders))).has(runners[0]!), false, "only a prompt owes the hand-back");
  runners[0]!.state.conflictHandback = { sha, at: Date.now(), reason: "merge", applied: false };
  assert.equal((await pollRunnerReasons(schedulingCtx(repo, runners, roleProviders))).get(runners[0]!), "leftover", "a handed-back lineage at the cap is discarded promptlessly");
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
  assert.equal(feature2.state.skipReason, "no-free-entry");
  assert.equal(loadLoopState(root, "feature-2").skipReason, "no-free-entry");
});

test("a claimed entry that merges releases the claim on the next poll", async () => {
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

test("a released claim is saved to disk before the runner ticks again", async () => {
  const root = tmpdir("tumwater-scheduling-release-saved-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  const roles = () => new Map([["feature", undefined], ["feature-2", undefined]]);
  await pollRunnerReasons(schedulingCtx(root, [feature, feature2], roles()));
  assert.equal(feature2.state.claim?.key, "beta");
  saveLoopState(root, feature2.state);
  assert.equal(loadLoopState(root, "feature-2").claim?.key, "beta");
  // Both entries leave Planned: no free entry, so feature-2 is an idle extra and gets no tick.
  fs.writeFileSync(path.join(root, "PLANS.md"), "# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n");
  await pollRunnerReasons(schedulingCtx(root, [feature, feature2], roles()));
  assert.equal(feature2.state.claim, undefined);
  assert.equal(loadLoopState(root, "feature-2").claim, undefined, "the release reached the state file");
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

test("pausing one instance releases its claim so a sibling can take the entry", async () => {
  const root = tmpdir("tumwater-scheduling-paused-instance-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  const roles = () => new Map([["feature", undefined], ["feature-2", undefined]]);
  await pollRunnerReasons(schedulingCtx(root, [feature, feature2], roles()));
  assert.equal(feature2.state.claim?.key, "beta");
  await pollRunnerReasons({
    ...schedulingCtx(root, [feature, feature2], roles()),
    pausedRoles: new Set(["feature-2"]),
  });
  assert.equal(feature2.state.claim, undefined, "the paused instance gives its entry back");
  assert.equal(loadLoopState(root, "feature-2").claim, undefined, "the release reached the state file");
  assert.equal(feature.state.claim?.key, "alpha");
});

test("pausing instance 1 under its feature-1 key releases its claim and leaves feature-2 working", async () => {
  const root = tmpdir("tumwater-scheduling-paused-instance-one-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  const roles = () => new Map([["feature", undefined], ["feature-2", undefined]]);
  await pollRunnerReasons(schedulingCtx(root, [feature, feature2], roles()));
  assert.equal(feature.state.claim?.key, "alpha");
  const reasons = await pollRunnerReasons({
    ...schedulingCtx(root, [feature, feature2], roles()),
    pausedRoles: new Set(["feature-1"]),
  });
  assert.equal(feature.state.claim, undefined, "the paused instance 1 gives its entry back");
  assert.equal(reasons.has(feature), false, "instance 1 starts no tick");
  assert.equal(reasons.has(feature2), true, "feature-2 is not stopped");
  assert.equal(feature2.state.claim?.key, "beta");
});

test("pausing the whole feature role keeps every instance's claim", async () => {
  const root = tmpdir("tumwater-scheduling-paused-role-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  const roles = () => new Map([["feature", undefined], ["feature-2", undefined]]);
  await pollRunnerReasons(schedulingCtx(root, [feature, feature2], roles()));
  await pollRunnerReasons({
    ...schedulingCtx(root, [feature, feature2], roles()),
    pausedRoles: new Set(["feature", "feature-2"]),
  });
  assert.equal(feature2.state.claim?.key, "beta");
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

test("a busy unclaimed base holds the group so a new instance cannot take its entry", async () => {
  const root = tmpdir("tumwater-scheduling-busy-base-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  // The base took alpha while it was the only runner (single-runner bases record no claim) and
  // is mid-tick when the live reload raises `instances` and spawns feature-2. The group must
  // hold assignment until the base settles rather than hand alpha to the sibling.
  feature.state.running = true;
  const reasons = await pollRunnerReasons(
    schedulingCtx(root, [feature, feature2], new Map([["feature", undefined], ["feature-2", undefined]])),
  );
  assert.equal(feature2.state.claim, undefined, "the added instance is not assigned the base's in-flight entry");
  assert.equal(reasons.has(feature2), false, "and it starts no tick while the group holds");
});

test("a base with an outstanding revision and no claim also holds the group", async () => {
  const root = tmpdir("tumwater-scheduling-busy-revision-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  // The base's change is out of the merge queue for a revision (state.revision) and it never
  // recorded a claim: the same unclaimed-mid-entry shape, caught while the base is idle.
  feature.state.revision = { sha: "deadbeef", round: 1, at: T0 };
  const reasons = await pollRunnerReasons(
    schedulingCtx(root, [feature, feature2], new Map([["feature", undefined], ["feature-2", undefined]])),
  );
  assert.equal(feature2.state.claim, undefined, "the revision holds the group too");
  // The holder itself must still tick: only its revision can settle the hold, so skipping it
  // too deadlocks every instance (the 2026-10-09 team stall).
  assert.equal(reasons.has(feature), true, "the base still ticks to finish its revision");
  assert.equal(feature.state.claim, undefined, "and is assigned no new entry");
});

test("a sibling held by an unclaimed mid-entry runner records claim-hold, cleared once admitted", async () => {
  const root = tmpdir("tumwater-scheduling-skip-claim-hold-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  feature.state.revision = { sha: "deadbeef", round: 1, at: T0 };
  const roleProviders = new Map([["feature", undefined], ["feature-2", undefined]]);
  await pollRunnerReasons(schedulingCtx(root, [feature, feature2], roleProviders));
  assert.equal(feature2.state.skipReason, "claim-hold");
  assert.equal(loadLoopState(root, "feature-2").skipReason, "claim-hold");
  feature.state.revision = undefined;
  const reasons = await pollRunnerReasons(schedulingCtx(root, [feature, feature2], roleProviders));
  assert.equal(reasons.has(feature2), true, "the hold cleared, so the sibling is admitted");
  assert.equal(feature2.state.skipReason, undefined);
  assert.equal(loadLoopState(root, "feature-2").skipReason, undefined);
});

test("a deferred maintenance role records its deferral once per episode", async () => {
  const root = tmpdir("tumwater-scheduling-skip-deferred-");
  const clean = fakeRunner("clean", defaultConfig());
  clean.state.runs = 1;
  clean.state.lastResult = "no_change";
  clean.state.lastMainHead = "abc"; // a deferral needs a prior head to compare against
  const ctx = () => ({
    ...schedulingCtx(root, [clean], new Map([["clean", undefined]])),
    workBacklogOpen: true,
    planBacklogFull: false,
  });
  const reasons = await pollRunnerReasons(ctx());
  assert.equal(reasons.has(clean), false, "the open backlog defers the due role");
  assert.equal(clean.state.skipReason, "deferred-backlog");
  assert.equal(loadLoopState(root, "clean").skipReason, "deferred-backlog");
  const file = statePath(root, "clean");
  fs.rmSync(file);
  await pollRunnerReasons(ctx());
  assert.equal(fs.existsSync(file), false, "the unchanged verdict does not rewrite the state file");
});

test("the reviewer's provider being held blocks every role through scheduling, and only while it stands", async () => {
  const root = tmpdir("tumwater-scheduling-review-");
  const runners = [fakeRunner("feature", defaultConfig()), fakeRunner("dedupe", defaultConfig())];
  const roleProviders = new Map([
    ["feature", "Q"],
    ["dedupe", "Q"],
  ]);

  // A storm on the strong tier's provider P while the review gate is on: nothing could merge,
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
 * feed must not end the team: each converted event site has to survive the throw and
 * still perform the bookkeeping the event reports. */

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

test("a run_deferred event survives an unwritable events feed", async () => {
  const root = tmpdir("tumwater-scheduling-best-effort-deferred-");
  const runner = fakeRunner("clean", defaultConfig());
  runner.state.lastResult = "no_change";
  runner.state.lastMainHead = "abc";
  runner.state.runs = 1;
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
  clean.state.lastRunEndedAt = T0 + 1_000;
  const woken = await pollRunnerReasons(ctx);
  assert.equal(woken.has(clean), true, "a fresh wake admits one tick while the quota holds");
});

test("the allowance's in-flight headroom starts at most one of two due maintenance loops per poll", async () => {
  const root = tmpdir("tumwater-scheduling-quota-race-");
  const runners = [fakeRunner("clean", defaultConfig()), fakeRunner("dedupe", defaultConfig())];
  const now = T0 + 10_000;
  // No work merges, so the floor allowance is 12; 11 maintenance merges leave exactly one
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
    runners.map((r) => ({ role: r.role, enabled: true, running: false, hasQueuedMerge: false })),
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
      ["dedupe", undefined],
    ]),
  );
  first.maintenanceQuota = gate;
  const firstReasons = await pollRunnerReasons(first);
  assert.equal(firstReasons.has(runners[0]!), true, "the first due loop takes the open slot");
  assert.equal(firstReasons.has(runners[1]!), false, "the second waits its turn");

  // The first tick ends without merge (so the merged count, and the allowance, are unchanged).
  // Its backoff now makes it not due; the second takes the slot on the next poll — one tick,
  // not two, between the two starts.
  runners[0]!.state.lastRunEndedAt = now;
  runners[0]!.state.nextRunAt = now + HOUR;
  const second = schedulingCtx(
    root,
    runners,
    new Map([
      ["clean", undefined],
      ["dedupe", undefined],
    ]),
  );
  second.maintenanceQuota = gate;
  const secondReasons = await pollRunnerReasons(second);
  assert.equal(secondReasons.has(runners[0]!), false, "the first loop is back in its gap");
  assert.equal(secondReasons.has(runners[1]!), true, "the second loop starts one tick later");
});

test("an unassigned primary is told the entries its siblings hold, and the prompt names them", async () => {
  const root = tmpdir("tumwater-scheduling-held-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  fs.writeFileSync(path.join(root, "README.md"), "# proj\n");
  const config = defaultConfig();
  config.roles.feature = { enabled: true, instances: 3 };
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  const feature3 = fakeRunner("feature-3", config);
  const claim = (key: string) => ({ file: "PLANS.md" as const, key, title: key, at: 1_000_010_000, source: "assigned" as const });
  feature2.state.claim = claim("alpha");
  feature3.state.claim = claim("beta");
  const roleProviders = new Map([["feature", undefined], ["feature-2", undefined], ["feature-3", undefined]]);
  await pollRunnerReasons(schedulingCtx(root, [feature, feature2, feature3], roleProviders));
  assert.equal(feature.state.claim, undefined);
  assert.equal(feature.state.heldElsewhere?.length, 2);
  const result = assembleTickPrompt({ root, config, role: "feature", state: feature.state });
  assert.match(result?.prompt ?? "", /<held-entries>[\s\S]*do not pick, edit, or implement them/);
  assert.match(result?.prompt ?? "", /- ".*"/);
});

test("a stale held-entries list is cleared once the role has no claim group", async () => {
  const root = tmpdir("tumwater-scheduling-held-stale-");
  fs.writeFileSync(path.join(root, "PLANS.md"), TWO_PLANS);
  fs.writeFileSync(path.join(root, "README.md"), "# proj\n");
  const config = defaultConfig();
  config.roles.feature = { enabled: true, instances: 1 };
  const feature = fakeRunner("feature", config);
  feature.state.heldElsewhere = ["alpha"];
  await pollRunnerReasons(schedulingCtx(root, [feature], new Map([["feature", undefined]])));
  assert.equal(feature.state.heldElsewhere, undefined);
});

// The feature stand-down: a feature runner with no eligible plan skips its scheduled and
// main-moved ticks, and a `run --once` round settles every skipped feature runner.
const ONE_REFUSED_PLAN = [
  "# Plans",
  "",
  "## Planned",
  "",
  "### Refused thing (planned 2026-01-01 by operator)",
  "",
  "**Refused 2026-01-02 by feature: no**",
  "",
  "Body.",
  "",
  "## Done",
  "",
].join("\n");

function tickedFeature(config: TumwaterConfig, role = "feature"): LoopRunner {
  const r = fakeRunner(role, config);
  r.state.runs = 1;
  r.state.nextRunAt = T0;
  r.state.backoffSeconds = 30;
  return r;
}

for (const [label, plans] of [["a refused-only PLANS.md", ONE_REFUSED_PLAN], ["no PLANS.md", undefined]] as const) {
  test(`a single feature runner stands down with ${label}`, async () => {
    const root = tmpdir("tumwater-scheduling-standdown-");
    if (plans) fs.writeFileSync(path.join(root, "PLANS.md"), plans);
    const feature = tickedFeature(defaultConfig());
    const reasons = await pollRunnerReasons(schedulingCtx(root, [feature], new Map([["feature", undefined]])));
    assert.equal(reasons.has(feature), false);
    assert.equal(feature.state.skipReason, "no-free-entry");
    assert.equal(loadLoopState(root, "feature").skipReason, "no-free-entry");
    assert.equal(feature.state.nextRunAt, T0);
    assert.equal(feature.state.backoffSeconds, 30);
  });
}

test("a once round settles an extra feature instance with no free entry", async () => {
  const root = tmpdir("tumwater-scheduling-once-extra-");
  fs.writeFileSync(path.join(root, "PLANS.md"), ONE_BLOCKED_PLAN);
  const config = twoFeatureInstances();
  const feature = fakeRunner("feature", config);
  const feature2 = fakeRunner("feature-2", config);
  const ctx = schedulingCtx(root, [feature, feature2], new Map([["feature", undefined], ["feature-2", undefined]]));
  ctx.once = new OnceRound([feature, feature2], true);
  await pollRunnerReasons(ctx);
  assert.equal(ctx.once.reasons.get("feature-2"), "no free entry");
  assert.equal(ctx.once.isSettled(feature2), true);
});

test("a once round settles a primary feature runner with no eligible plan", async () => {
  const root = tmpdir("tumwater-scheduling-once-primary-");
  fs.writeFileSync(path.join(root, "PLANS.md"), ONE_REFUSED_PLAN);
  const feature = tickedFeature(defaultConfig());
  const ctx = schedulingCtx(root, [feature], new Map([["feature", undefined]]));
  ctx.once = new OnceRound([feature], true);
  await pollRunnerReasons(ctx);
  assert.equal(ctx.once.reasons.get("feature"), "no free entry");
});

test("a nothing-eligible feature runner is still admitted on demand, startup, revision, or an eligible plan", async () => {
  const admitted = async (setup: (r: LoopRunner, root: string) => void, plans = ONE_REFUSED_PLAN) => {
    const root = tmpdir("tumwater-scheduling-standdown-admit-");
    fs.writeFileSync(path.join(root, "PLANS.md"), plans);
    const r = tickedFeature(defaultConfig());
    setup(r, root);
    const reasons = await pollRunnerReasons(schedulingCtx(root, [r], new Map([["feature", undefined]])));
    return reasons.has(r);
  };
  assert.equal(await admitted(() => {}), false, "control: stands down");
  assert.equal(await admitted((r) => { r.state.wokenAt = T0 + 5; r.state.lastRunEndedAt = T0; }), true, "wake");
  assert.equal(await admitted((r) => { r.state.runs = 0; }), true, "startup");
  assert.equal(await admitted((_r, root) => { enqueueRolePrompt(root, "feature", "hi"); }), true, "queued prompt");
  assert.equal(await admitted((r) => { r.state.revision = { feedback: "fix" } as never; }), true, "revision");
  assert.equal(await admitted(() => {}, TWO_PLANS), true, "an eligible plan");
});

// The bugfix stand-down: open bugs that are all held leave nothing for the charter to do.
const bugsFile = (...entries: string[]) => ["# Bugs", "", "## Open", "", ...entries, "## Fixed", ""].join("\n");
const REFUSED_BUG = "### Held bug (found by x 2026-01-01)\n\n**Refused 2026-01-02 by bugfix: no**\n\nBody.\n";
const OPEN_BUG = "### Live bug (found by x 2026-01-01)\n\nBody.\n";

test("a bugfix runner whose open bugs are all held stands down", async () => {
  const root = tmpdir("tumwater-scheduling-bugfix-standdown-");
  fs.writeFileSync(path.join(root, "BUGS.md"), bugsFile(REFUSED_BUG));
  const bugfix = tickedFeature(defaultConfig(), "bugfix");
  const ctx = schedulingCtx(root, [bugfix], new Map([["bugfix", undefined]]));
  ctx.openBugsNow = true;
  ctx.once = new OnceRound([bugfix], true);
  const reasons = await pollRunnerReasons(ctx);
  assert.equal(reasons.has(bugfix), false);
  assert.equal(bugfix.state.skipReason, "no-free-entry");
  assert.equal(loadLoopState(root, "bugfix").skipReason, "no-free-entry");
  assert.equal(bugfix.state.nextRunAt, T0);
  assert.equal(bugfix.state.backoffSeconds, 30);
  assert.equal(ctx.once.reasons.get("bugfix"), "no free entry");
});

test("a held-only bugfix runner is still admitted on demand, startup, revision, or an eligible bug", async () => {
  const admitted = async (setup: (r: LoopRunner, root: string) => void, bugs = bugsFile(REFUSED_BUG)) => {
    const root = tmpdir("tumwater-scheduling-bugfix-admit-");
    fs.writeFileSync(path.join(root, "BUGS.md"), bugs);
    const r = tickedFeature(defaultConfig(), "bugfix");
    setup(r, root);
    const ctx = schedulingCtx(root, [r], new Map([["bugfix", undefined]]));
    ctx.openBugsNow = true;
    return (await pollRunnerReasons(ctx)).has(r);
  };
  assert.equal(await admitted(() => {}), false, "control: stands down");
  assert.equal(await admitted((r) => { r.state.wokenAt = T0 + 5; r.state.lastRunEndedAt = T0; }), true, "wake");
  assert.equal(await admitted((r) => { r.state.runs = 0; }), true, "startup");
  assert.equal(await admitted((_r, root) => { enqueueRolePrompt(root, "bugfix", "hi"); }), true, "queued prompt");
  assert.equal(await admitted((r) => { r.state.revision = { feedback: "fix" } as never; }), true, "revision");
  assert.equal(await admitted(() => {}, bugsFile(REFUSED_BUG, OPEN_BUG)), true, "an eligible bug");
});

test("a due-now plan runner is admitted while PLANS.md has planning room, skipped once full", async () => {
  const root = tmpdir("tumwater-scheduling-plan-");
  const r = fakeRunner("plan", defaultConfig());
  // A non-empty lastMainHead with an empty poll mainHead keeps the main-moved wake from
  // confusing the case; workBacklogOpen short-circuits the workMergedSince git query (the
  // harness path uses a real cache), so the admission decision keys on planBacklogFull alone.
  r.state.runs = 1;
  r.state.lastRunEndedAt = T0;
  r.state.nextRunAt = T0;
  r.state.lastMainHead = "abc";

  const ctx = () => ({
    ...schedulingCtx(root, [r], new Map([["plan", undefined]])),
    workBacklogOpen: true,
  });

  const admitted = await pollRunnerReasons(ctx());
  assert.ok(admitted.has(r), "plan is admitted while PLANS.md has planning room");

  // Mark the backlog full; the same due-now runner is now held on its 3600 s clock.
  const skipped = await pollRunnerReasons({ ...ctx(), planBacklogFull: true });
  assert.ok(!skipped.has(r), "plan is skipped once PLANS.md holds its plan target");
});

test("a bugfix runner in search mode is not stood down", async () => {
  const root = tmpdir("tumwater-scheduling-bugfix-search-");
  const bugfix = tickedFeature(defaultConfig(), "bugfix");
  await pollRunnerReasons(schedulingCtx(root, [bugfix], new Map([["bugfix", undefined]])));
  assert.notEqual(bugfix.state.skipReason, "no-free-entry");
});
