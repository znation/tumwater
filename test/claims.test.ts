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
  planBacklogFull,
  stagedMovedEntries,
  workReserveCount,
  type ClaimRunner,
} from "../src/scheduling/claims.js";
import { defaultConfig } from "../src/config/config.js";
import { freshRunnerState, type RunnerState } from "../src/runner/runner-state.js";
import { buildAssignmentNote } from "../src/prompt/gate-notes.js";
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

function state(claim?: RunnerState["claim"], overrides: Partial<RunnerState> = {}): RunnerState {
  return { ...freshRunnerState("feature-2"), ...(claim ? { claim } : {}), ...overrides };
}

function runner(role: string, s: RunnerState): ClaimRunner {
  return { role, state: s };
}

const claimA: RunnerState["claim"] = {
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

test("claimReleaseReason releases left, ineligible, disabled-idle, paused-idle and stale-idle claims", () => {
  const ctx = {
    listedKeys: new Set(["plan a"]),
    eligibleKeys: new Set(["plan a"]),
    now: 1000,
    hasQueuedMerge: false,
    enabled: true,
    paused: false,
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
  assert.equal(claimReleaseReason(runner("feature-2", state({ ...claimA })), { ...ctx, paused: true }), "paused");
  // 25 h old and idle: stale.
  assert.equal(
    claimReleaseReason(runner("feature-2", state({ ...claimA })), { ...ctx, now: claimA.at + CLAIM_IDLE_MAX_MS + 1 }),
    "stale",
  );
});

test("an idle extra with a revision, a queued merge, a resume or a run in progress keeps its claim", () => {
  const ctx = {
    listedKeys: new Set(["plan a"]),
    eligibleKeys: new Set(["plan a"]),
    now: claimA.at + CLAIM_IDLE_MAX_MS + 1,
    hasQueuedMerge: false,
    enabled: false,
    paused: false,
  };
  assert.equal(claimReleaseReason(runner("feature-2", state({ ...claimA }, { revision: { sha: "x", round: 1, at: 1 } })), ctx), null);
  assert.equal(claimReleaseReason(runner("feature-2", state({ ...claimA })), { ...ctx, hasQueuedMerge: true }), null);
  assert.equal(claimReleaseReason(runner("feature-2", state({ ...claimA }, { resumePending: true })), ctx), null);
  assert.equal(claimReleaseReason(runner("feature-2", state({ ...claimA }, { running: true })), ctx), null);
  const paused = { ...ctx, paused: true };
  assert.equal(claimReleaseReason(runner("feature-2", state({ ...claimA }, { revision: { sha: "x", round: 1, at: 1 } })), paused), null);
  assert.equal(claimReleaseReason(runner("feature-2", state({ ...claimA })), { ...paused, hasQueuedMerge: true }), null);
  assert.equal(claimReleaseReason(runner("feature-2", state({ ...claimA }, { resumePending: true })), paused), null);
  assert.equal(claimReleaseReason(runner("feature-2", state({ ...claimA }, { running: true })), paused), null);
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

test("listedKeys caches an unchanged PLANS.md and re-reads a changed one", (t) => {
  const repo = makeRepo();
  const plans = path.join(repo, "PLANS.md");
  fs.writeFileSync(plans, PLANNED);
  assert.deepEqual([...listedKeys(repo, "feature")].sort(), ["plan a", "plan b"]);

  // Cache hit: the file's stat is unchanged, so a repeat poll must serve the cached ranges
  // without re-reading the whole file. Count only this file's reads.
  const original = fs.readFileSync.bind(fs);
  let reads = 0;
  t.mock.method(fs, "readFileSync", ((...args: unknown[]) => {
    if (args[0] === plans) reads++;
    return original(...(args as [string | URL, "utf8"]));
  }) as typeof fs.readFileSync);
  try {
    assert.deepEqual([...listedKeys(repo, "feature")].sort(), ["plan a", "plan b"]);
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(reads, 0, "an unchanged backlog file must not be re-read");

  // A larger rewrite guarantees a new size (and mtime) even on a filesystem with coarse
  // clocks, so the stat-keyed cache must miss and the fresh walk must yield the new entry.
  fs.writeFileSync(plans, PLANNED.replace("### Plan A", "### Plan Zeta"));
  assert.deepEqual([...listedKeys(repo, "feature")].sort(), ["plan b", "plan zeta"]);
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
  assert.doesNotMatch(note, /do not exist in your checkout/);
});

test("buildAssignmentNote lists the entry's missing paths, capped at 10", () => {
  const claim = { file: "PLANS.md", title: "Plan A", source: "assigned" as const };
  const range = { start: 9, end: 20 };
  const one = buildAssignmentNote(claim, range, ["src/gone.ts"]);
  assert.match(one, /do not exist in your checkout: `src\/gone\.ts`/);
  assert.match(one, /"Plan A" \(PLANS\.md lines 9-20\)/);
  assert.match(one, /Refused note/);
  const many = buildAssignmentNote(claim, range, Array.from({ length: 12 }, (_, i) => `src/p${i}.ts`));
  assert.match(many, /`src\/p9\.ts`, and 2 more\./);
  assert.doesNotMatch(many, /p10\.ts/);
});

test("workReserveCount withholds permits only while a claim role is idle with work", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), PLANNED);
  const idle = runner("feature", state());
  const opts = { maxConcurrent: 6, enabled: new Set(["feature"]), queuedMergeRoles: new Set<string>() };
  // One idle feature with two eligible entries: min(floor(6/3), 1) = 1.
  assert.equal(workReserveCount(repo, [idle], opts), 1);
  // Floor(cap/3) bounds the count.
  assert.equal(workReserveCount(repo, [idle], { ...opts, maxConcurrent: 3 }), 1);
  // A work role that is running or merging has nothing to reserve for.
  assert.equal(
    workReserveCount(repo, [runner("feature", state(undefined, { running: true }))], opts),
    0,
  );
  assert.equal(
    workReserveCount(repo, [idle], { ...opts, queuedMergeRoles: new Set(["feature"]) }),
    0,
  );
  // A disabled role reserves nothing.
  assert.equal(workReserveCount(repo, [idle], { ...opts, enabled: new Set() }), 0);
});

test("workReserveCount drops an idle work role whose provider is full (per-provider headroom)", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), PLANNED);
  const idle = runner("feature", state());
  const opts = {
    maxConcurrent: 6,
    enabled: new Set(["feature"]),
    queuedMergeRoles: new Set<string>(),
  };
  // No predicate (or one that says the provider has headroom): the idle work role reserves.
  assert.equal(workReserveCount(repo, [idle], opts), 1);
  assert.equal(workReserveCount(repo, [idle], { ...opts, providerHasHeadroom: () => true }), 1);
  // A full (or capped-and-full) provider cannot use the reserved permit, so the role withholds
  // nothing — a maintenance run on another provider may take the slot instead.
  assert.equal(workReserveCount(repo, [idle], { ...opts, providerHasHeadroom: () => false }), 0);
});

test("workReserveCount caps at a third of maxConcurrent and counts claim holders", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), PLANNED);
  const opts = {
    maxConcurrent: 6,
    enabled: new Set(["feature", "feature-2"]),
    queuedMergeRoles: new Set<string>(),
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

test("planBacklogFull: eligible plans reach the target and no plan is marked", () => {
  const plans = (...entries: string[]) => {
    const repo = makeRepo();
    fs.writeFileSync(
      path.join(repo, "PLANS.md"),
      `# Plans\n\n## Planned\n\n${entries.join("\n")}\n## Done\n\n_None yet._\n`,
    );
    return repo;
  };
  const cfg = defaultConfig();
  const entry = (title: string, note = "") => `### ${title} (planned 2026-01-01 by plan)\n${note}\nBody.\n`;
  assert.equal(planBacklogFull(plans(entry("A"), entry("B")), cfg), true);
  assert.equal(planBacklogFull(plans(entry("A")), cfg), false);
  assert.equal(
    planBacklogFull(plans(entry("A"), entry("B"), entry("C", "**Needs review 2026-01-02 by feature: too large for one run**\n")), cfg),
    false,
    "a needs-review mark keeps the plan role running",
  );
  assert.equal(
    planBacklogFull(plans(entry("A"), entry("B", "**Refused 2026-01-02 by feature: no**\n")), cfg),
    false,
    "a refused plan does not count",
  );
  assert.equal(
    planBacklogFull(
      plans(
        entry("A"),
        entry("B, part 1/2: x", "**Refused 2026-01-02 by feature: no**\n"),
        `### B, part 2/2: x (planned 2026-01-01 by plan; requires part 1/2 landed)\nBody.\n`,
      ),
      cfg,
    ),
    false,
    "a plan blocked by a prerequisite does not count",
  );
});

test("workReserveCount counts only the places instances leaves free, not every idle runner id", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), PLANNED);
  const ids = ["feature", "feature-2", "feature-3", "feature-4"];
  const opts = {
    maxConcurrent: 30,
    enabled: new Set(ids),
    queuedMergeRoles: new Set<string>(),
    instancesOf: () => 2,
  };
  const idle = ids.map((id) => runner(id, state()));
  assert.equal(workReserveCount(repo, idle, opts), 2, "four idle runner ids, two places");
  const oneRunning = [runner("feature", state(undefined, { running: true })), ...idle.slice(1)];
  assert.equal(workReserveCount(repo, oneRunning, opts), 1, "a running runner takes one of the two places");
});
