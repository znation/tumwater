/** Tests for src/scheduling/claims.ts — work-instance claims (plans/parallel-work-instances.md
 * "Claims", part 4/7): the pure assignment/release policies, the staged-move detection, and the
 * assignment note. The orchestrator integration is covered in orchestrator-scheduling.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CLAIM_IDLE_MAX_MS,
  assignNext,
  claimReleaseReason,
  heldKeys,
  listedKeys,
  movedOutEntries,
  stagedMovedEntries,
  workReserveCount,
  type ClaimRunner,
} from "../src/scheduling/claims.js";
import { freshLoopState, type LoopState } from "../src/loop/loop-state.js";
import { buildAssignmentNote } from "../src/gates/gate-prompts.js";
import { makeRepo, commitIn } from "./fixtures/repo-fixtures.js";

const PLANNED = [
  "# Plans",
  "",
  "## Planned",
  "",
  "### Plan A (planned 2026-01-01 by operator)",
  "",
  "Body A.",
  "",
  "### Plan B (planned 2026-01-01 by operator)",
  "",
  "Body B.",
  "",
  "## Done",
  "",
].join("\n");

function state(claim?: LoopState["claim"], overrides: Partial<LoopState> = {}): LoopState {
  return { ...freshLoopState("feature-2"), ...(claim ? { claim } : {}), ...overrides };
}

function runner(role: string, s: LoopState): ClaimRunner {
  return { role, state: s };
}

const claimA: LoopState["claim"] = {
  file: "PLANS.md",
  key: "plan a",
  title: "Plan A (planned 2026-01-01 by operator)",
  at: 1000,
  source: "assigned",
};

test("assignNext takes the first free entry in file order", () => {
  const free = [
    { key: "a", title: "A", start: 1, end: 2 },
    { key: "b", title: "B", start: 3, end: 4 },
  ];
  assert.equal(assignNext(free)?.key, "a");
  assert.equal(assignNext([]), null);
});

test("heldKeys counts a claim still listed and eligible and drops the rest", () => {
  const runners = [
    runner("feature", state({ ...claimA })),
    runner("feature-2", state({ ...claimA, key: "gone", title: "Gone" })),
    runner("feature-3", state({ ...claimA, key: "held", title: "Held" })),
  ];
  const eligible = new Set(["plan a", "held"]);
  const listed = new Set(["plan a", "held", "gone"]);
  assert.deepEqual([...heldKeys(runners, eligible, listed)].sort(), ["held", "plan a"]);
});

test("claimReleaseReason releases left, ineligible, disabled-idle and stale-idle claims", () => {
  const ctx = {
    listedKeys: new Set(["plan a"]),
    eligibleKeys: new Set(["plan a"]),
    now: 1000,
    hasQueuedLanding: false,
    enabled: true,
  };
  const held = runner("feature-2", state({ ...claimA }));
  assert.equal(claimReleaseReason(held, ctx), null);

  assert.equal(
    claimReleaseReason(runner("feature-2", state({ ...claimA })), {
      ...ctx,
      listedKeys: new Set<string>(),
      eligibleKeys: new Set<string>(),
    }),
    "left",
  );
  assert.equal(
    claimReleaseReason(runner("feature-2", state({ ...claimA })), {
      ...ctx,
      eligibleKeys: new Set<string>(),
    }),
    "ineligible",
  );
  assert.equal(claimReleaseReason(runner("feature-2", state({ ...claimA })), { ...ctx, enabled: false }), "disabled");
  // 25 h old and idle: stale.
  assert.equal(
    claimReleaseReason(runner("feature-2", state({ ...claimA })), { ...ctx, now: claimA.at + CLAIM_IDLE_MAX_MS + 1 }),
    "stale",
  );
});

test("an idle extra with a revision, a queued landing, a resume or a running tick keeps its claim", () => {
  const ctx = {
    listedKeys: new Set(["plan a"]),
    eligibleKeys: new Set(["plan a"]),
    now: claimA.at + CLAIM_IDLE_MAX_MS + 1,
    hasQueuedLanding: false,
    enabled: false,
  };
  assert.equal(claimReleaseReason(runner("feature-2", state({ ...claimA }, { revision: { sha: "x", round: 1, at: 1 } })), ctx), null);
  assert.equal(claimReleaseReason(runner("feature-2", state({ ...claimA })), { ...ctx, hasQueuedLanding: true }), null);
  assert.equal(claimReleaseReason(runner("feature-2", state({ ...claimA }, { resumePending: true })), ctx), null);
  assert.equal(claimReleaseReason(runner("feature-2", state({ ...claimA }, { running: true })), ctx), null);
});

test("movedOutEntries names the entries a staged change dropped from its section", () => {
  const head = PLANNED.replace(/### Plan B[\s\S]*?\n\n/, "").replace("## Done", "## Done\n\n### Plan B (planned 2026-01-01 by operator; done 2026-01-02 by feature)\n");
  const moved = movedOutEntries(PLANNED, head, "Planned");
  assert.deepEqual(moved.map((m) => m.key), ["plan b"]);
  assert.deepEqual(movedOutEntries(PLANNED, PLANNED, "Planned"), []);
});

test("listedKeys and stagedMovedEntries read a repo's Planned section", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), PLANNED);
  commitIn(repo, "plans");
  assert.deepEqual([...listedKeys(repo, "feature")].sort(), ["plan a", "plan b"]);
  // The working tree moves Plan B out of Planned (into Done).
  const head = PLANNED.replace("## Done", "## Done\n\n### Plan B (planned 2026-01-01 by operator; done 2026-01-02 by feature)\n").replace(/### Plan B[^\n]*\n\nBody B\.\n\n/, "");
  fs.writeFileSync(path.join(repo, "PLANS.md"), head);
  const moved = await stagedMovedEntries(repo, "main", "feature");
  assert.deepEqual(moved.map((m) => m.key), ["plan b"]);
  assert.equal(moved[0]!.file, "PLANS.md");
  assert.match(moved[0]!.title, /Plan B/);
});

test("buildAssignmentNote names the entry, its range and the alternatives", () => {
  const note = buildAssignmentNote(
    { file: "PLANS.md", title: "Plan A", source: "assigned" },
    { start: 9, end: 20 },
  );
  assert.match(note, /<assigned-entry>/);
  assert.match(note, /"Plan A" \(PLANS\.md lines 9-20\)/);
  assert.match(note, /assigned you ONE backlog entry/);
  assert.match(note, /too large for one run/);
  assert.match(note, /Refused note/);
  // A staged claim reads as the change's own move, and a missing range still names the file.
  const staged = buildAssignmentNote({ file: "BUGS.md", title: "Bug X", source: "staged" });
  assert.match(staged, /Your change moved ONE backlog entry/);
  assert.match(staged, /"Bug X" \(BUGS\.md\)/);
});

test("workReserveCount withholds permits only while a claim role is idle with work", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), PLANNED);
  const idle = runner("feature", state());
  const opts = { maxConcurrent: 6, enabled: new Set(["feature"]), queuedLandingRoles: new Set<string>() };
  // One idle feature with two eligible entries: min(floor(6/3), 1) = 1.
  assert.equal(workReserveCount(repo, [idle], opts), 1);
  // Floor(cap/3) bounds the count.
  assert.equal(workReserveCount(repo, [idle], { ...opts, maxConcurrent: 3 }), 1);
  // A running or landing work loop has nothing to reserve for.
  assert.equal(
    workReserveCount(repo, [runner("feature", state(undefined, { running: true }))], opts),
    0,
  );
  assert.equal(
    workReserveCount(repo, [idle], { ...opts, queuedLandingRoles: new Set(["feature"]) }),
    0,
  );
  // A disabled loop reserves nothing.
  assert.equal(workReserveCount(repo, [idle], { ...opts, enabled: new Set() }), 0);
});

test("workReserveCount caps at a third of maxConcurrent and counts claim holders", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), PLANNED);
  const opts = {
    maxConcurrent: 6,
    enabled: new Set(["feature", "feature-2"]),
    queuedLandingRoles: new Set<string>(),
  };
  // Two idle instances and two eligible entries: both reserve, capped at floor(6/3) = 2.
  assert.equal(workReserveCount(repo, [runner("feature", state()), runner("feature-2", state())], opts), 2);
  // One eligible entry, held by one instance: the holder counts, the sibling with no free
  // entry does not.
  const oneEntry = PLANNED.replace(/### Plan B[\s\S]*?\n\nBody B\.\n\n/, "");
  const repo2 = makeRepo();
  fs.writeFileSync(path.join(repo2, "PLANS.md"), oneEntry);
  assert.equal(
    workReserveCount(repo2, [runner("feature", state()), runner("feature-2", state({ ...claimA }))], opts),
    1,
  );
});
