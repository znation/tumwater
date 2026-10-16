import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  withoutRefusalNotes,
  backlogHolds,
  eligibleEntries,
  entryHold,
  entryKey,
  holdMark,
  holdsBacklogReaders,
  plannedPartKeys,
  prerequisitesLanded,
  refusalNote,
  planDependencyProblems,
  requiredParts,
  seriesPart,
  type EligibleEntry,
  type EntryHold,
  type PartRef,
} from "../src/backlog/backlog-eligibility.js";
import { openBugEntries, plannedPlanEntries } from "../src/backlog/backlog.js";
import { openParenthetical, type BacklogEntry } from "../src/backlog/backlog-md.js";
import { loadLoopState, saveLoopState } from "../src/loop/loop-state.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** Unit coverage for src/backlog/backlog-eligibility.ts (plans, parallel-work-instances,
 * part 2/7): a plan heading's prerequisite clause and the note holds decide which entries a
 * work loop may take, and the backlog index renders the same verdicts as marks. */

function entry(title: string, body = ""): BacklogEntry {
  return { title, body };
}

test("entryKey strips the stamp suffix and lowercases, so done/refused stamps leave it unchanged", () => {
  assert.equal(entryKey("Ship it (planned 2026-10-01)"), "ship it");
  assert.equal(entryKey("Ship it (planned 2026-10-01, done 2026-10-02)"), "ship it");
  assert.equal(entryKey("Ship it (reported 2026-10-02)"), "ship it");
  assert.equal(entryKey("Two   spaced\nTitle"), "two spaced title");
});

test("seriesPart reads an entry's own series and part, including the historical lettered parts", () => {
  const ref: PartRef | null = seriesPart(
    "Parallel work instances, part 2/7: mark backlog entries (planned 2026-10-07 by operator)",
  );
  assert.deepEqual(ref, { series: "Parallel work instances", part: "2", of: 7 });
  assert.deepEqual(seriesPart("Legacy, part 2a/3: x"), { series: "Legacy", part: "2a", of: 3 });
  assert.equal(seriesPart("Ship it (planned 2026-10-01)"), null);
});

test("requiredParts reads the trailing parenthetical, expands ranges, and resolves bare refs to the own series", () => {
  assert.deepEqual(
    requiredParts("Worktree pool, part 3/5: x (planned 2026-10-06 by operator; requires part 2/5 landed)"),
    [{ series: "Worktree pool", part: "2", of: 5 }],
  );
  assert.deepEqual(
    requiredParts("Worktree pool, part 4/5: x (planned 2026-10-06 by operator; requires parts 1/5–3/5 landed)"),
    [
      { series: "Worktree pool", part: "1", of: 5 },
      { series: "Worktree pool", part: "2", of: 5 },
      { series: "Worktree pool", part: "3", of: 5 },
    ],
  );
  assert.deepEqual(
    requiredParts(
      "Worktree pool, part 2/5: x (planned 2026-10-06 by operator; requires Disk floor 2/4 and Worktree pool 1/5 landed)",
    ),
    [
      { series: "Disk floor", part: "2", of: 4 },
      { series: "Worktree pool", part: "1", of: 5 },
    ],
  );
  assert.deepEqual(
    requiredParts(
      "Parallel work instances, part 5/7: x (planned 2026-10-07 by operator; requires parts 3/7 and 4/7, Robust conflict landing 2/2 and Worktree pool 4/5 landed)",
    ),
    [
      { series: "Parallel work instances", part: "3", of: 7 },
      { series: "Parallel work instances", part: "4", of: 7 },
      { series: "Robust conflict landing", part: "2", of: 2 },
      { series: "Worktree pool", part: "4", of: 5 },
    ],
  );
  // The historical lettered sub-plans parse too.
  assert.deepEqual(requiredParts("Legacy, part 6/8: x (planned 2026-09-01; requires parts 5a/8 and 5b/8 landed)"), [
    { series: "Legacy", part: "5a", of: 8 },
    { series: "Legacy", part: "5b", of: 8 },
  ]);
});

test("requiredParts returns [] for a clause that does not parse and for a heading with no clause", () => {
  assert.deepEqual(requiredParts("Foo, part 1/2: x (planned 2026-10-01; land that plan first)"), []);
  assert.deepEqual(requiredParts("Foo, part 1/2: x"), []);
  assert.deepEqual(requiredParts("Foo (planned 2026-10-01; requires something else entirely)"), []);
});

test("entryHold reports blocked, refused, needs-review and needs-replan, and null when eligible", () => {
  const planned: BacklogEntry[] = [{ title: "Disk floor, part 2/4: x (planned 2026-10-06)", body: "" }];
  const blocked = entryHold(
    entry("Worktree pool, part 2/5: x (planned 2026-10-06; requires Disk floor 2/4 landed)"),
    planned,
  );
  assert.deepEqual(blocked as EntryHold, { blockedBy: ["Disk floor 2/4"] });
  assert.equal(
    entryHold(entry("Worktree pool, part 2/5: x (planned 2026-10-06; requires part 2/5 landed)"), []),
    null,
  );
  assert.equal(entryHold(entry("Bug (reported 2026-10-02)", "**Refused 2026-10-07 by feature: no**"), []), "refused");
  assert.equal(
    entryHold(entry("Plan (planned 2026-10-01)", "**Needs review 2026-10-07 by feature: too large for one run**"), []),
    "needs-review",
  );
  assert.equal(
    entryHold(
      entry("Plan (planned 2026-10-01)", "**Needs replan 2026-10-07 by feature: rejected after 2 review rounds**"),
      [],
    ),
    "needs-replan",
  );
});

test("hold notes match only as their own line, and an indented note still holds", () => {
  const review = "**Needs review 2026-10-07 by feature: too large for one run**";
  const replan = "**Needs replan 2026-10-07 by feature: rejected after 2 review rounds**";
  // A prefix quoted inside prose is a mention, not a note.
  assert.equal(entryHold(entry("Plan", `the loop appends ${review} under the heading`), []), null);
  assert.equal(entryHold(entry("Plan", `the loop appends ${replan} under the heading`), []), null);
  // Written on its own line — indented or not — it is the note it looks like.
  assert.equal(entryHold(entry("Plan", `body\n${review}`), []), "needs-review");
  assert.equal(entryHold(entry("Plan", `body\n  ${replan}`), []), "needs-replan");
});

test("a body mentioning 'requires' never blocks — only the heading's clause does", () => {
  assert.equal(entryHold(entry("Foo (planned 2026-10-01)", "This requires part 1/2 landed eventually."), []), null);
});

test("eligibleEntries drops held entries, keeps file order, and attaches the index line ranges", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    [
      "# Plans", // 1
      "## Planned", // 2
      "### Prereq, part 1/2: base (planned 2026-10-01)", // 3
      "body", // 4
      "### Later, part 2/2: x (planned 2026-10-02; requires Prereq 1/2 landed)", // 5
      "body", // 6
      "### Ready (planned 2026-10-03)", // 7
      "body", // 8
      "## Done", // 9
      "_None._", // 10
    ].join("\n"),
  );
  const eligible: EligibleEntry[] = eligibleEntries(dir, "feature");
  assert.deepEqual(eligible, [
    { key: "prereq, part 1/2: base", title: "Prereq, part 1/2: base (planned 2026-10-01)", start: 3, end: 4 },
    { key: "ready", title: "Ready (planned 2026-10-03)", start: 7, end: 8 },
  ]);
});

test("holdMark renders each hold as its bracket tag and the empty string when eligible", () => {
  assert.equal(holdMark(null), "");
  assert.equal(holdMark("refused"), " [refused]");
  assert.equal(holdMark("needs-review"), " [needs review]");
  assert.equal(holdMark("needs-replan"), " [needs replan]");
  assert.equal(holdMark({ blockedBy: ["Prereq 1/2", "Disk floor 2/4"] }), " [blocked: requires Prereq 1/2, Disk floor 2/4]");
});

test("backlogHolds marks plans and bugs parallel to the payload, leaving an eligible entry null", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    [
      "# Plans",
      "## Planned",
      "### Base, part 1/2: x (planned 2026-10-01)",
      "body",
      "### Later, part 2/2: y (planned 2026-10-02; requires Base 1/2 landed)",
      "body",
      "### Needs a look (planned 2026-10-03)",
      "**Needs review 2026-10-07 by feature: too large for one run**",
      "### Ready (planned 2026-10-04)",
      "body",
      "## Done",
      "_None._",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "BUGS.md"),
    [
      "# Bugs",
      "## Open",
      "### Refused one (reported 2026-10-02)",
      "**Refused 2026-10-07 by bugfix: not reproducible**",
      "### Real (reported 2026-10-02)",
      "Repro.",
      "## Fixed",
      "_None._",
    ].join("\n"),
  );
  assert.deepEqual(backlogHolds(dir), {
    plans: [null, { blockedBy: ["Base 1/2"] }, "needs-review", null],
    bugs: ["refused", null],
  });
});

test("eligibleEntries reads BUGS.md's Open section for bugfix and drops a refused bug", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "BUGS.md"),
    [
      "# Bugs", // 1
      "## Open", // 2
      "### Real (reported 2026-10-02)", // 3
      "Repro.", // 4
      "### Refused one (reported 2026-10-02)", // 5
      "**Refused 2026-10-07 by bugfix: not reproducible**", // 6
      "## Fixed", // 7
      "_None._", // 8
    ].join("\n"),
  );
  assert.deepEqual(eligibleEntries(dir, "bugfix"), [
    { key: "real", title: "Real (reported 2026-10-02)", start: 3, end: 4 },
  ]);
});

test("eligibleEntries holds a plan another role's base has claimed, but keeps the owner's own claim", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "# Plans\n## Planned\n### Volume slider (planned 2026-10-09)\nDrive it through the backend.\n## Done\n_None._\n",
  );
  // `feature` takes the plan the way a real tick does (a queued landing keeps its claim until
  // the move tunes into main); a second plan-consuming role must not be handed the same entry.
  const owner = {
    ...loadLoopState(dir, "feature"),
    claim: { file: "PLANS.md", key: "volume slider", title: "Volume slider", at: 1, source: "assigned" } as const,
  };
  saveLoopState(dir, owner);
  // The owner's own base keeps the plan eligible (its release rules run unchanged)…
  assert.deepEqual(eligibleEntries(dir, "feature").map((e) => e.key), ["volume slider"]);
  // …while another base reads it as taken, so `improve` cannot re-implement it.
  assert.deepEqual(eligibleEntries(dir, "improve"), []);
  // A same-base sibling is also unaffected: the scheduling pass's own heldKeys owns that hold.
  assert.deepEqual(eligibleEntries(dir, "feature-2").map((e) => e.key), ["volume slider"]);
});

test("eligibleEntries holds a plan claimed by a parallel-work instance against every other base", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "# Plans\n## Planned\n### Volume slider (planned 2026-10-09)\nDrive it through the backend.\n## Done\n_None._\n",
  );
  // The claim comes from the parallel-work instance `feature-2`, whose state file lives at
  // .tumwater/state/feature-2.json — outside the built-in catalog allRoleIds enumerates. It
  // must still hold the plan against every other base, or `improve` re-implements it.
  const owner = {
    ...loadLoopState(dir, "feature-2"),
    claim: { file: "PLANS.md", key: "volume slider", title: "Volume slider", at: 1, source: "assigned" } as const,
  };
  saveLoopState(dir, owner);
  // Another base reads the instance's claim as in flight…
  assert.deepEqual(eligibleEntries(dir, "improve"), []);
  // …while the instance's own base keeps it eligible for its release rules.
  assert.deepEqual(eligibleEntries(dir, "feature").map((e) => e.key), ["volume slider"]);
});

test("eligibleEntries caches an unchanged PLANS.md and re-reads a changed one", (t) => {
  const dir = tmpdir();
  const plans = path.join(dir, "PLANS.md");
  fs.writeFileSync(plans, "# Plans\n## Planned\n### Alpha (planned 2026-10-01)\nBody.\n## Done\n_None._\n");
  assert.deepEqual(eligibleEntries(dir, "feature").map((e) => e.key), ["alpha"]);

  // Cache hit: the file's stat is unchanged, so a repeat poll must serve the cached ranges
  // without re-reading the whole file. Count only this file's reads.
  const original = fs.readFileSync.bind(fs);
  let reads = 0;
  t.mock.method(fs, "readFileSync", ((...args: unknown[]) => {
    if (args[0] === plans) reads++;
    return original(...(args as [string | URL, "utf8"]));
  }) as typeof fs.readFileSync);
  try {
    assert.deepEqual(eligibleEntries(dir, "feature").map((e) => e.key), ["alpha"]);
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(reads, 0, "an unchanged backlog file must not be re-read");

  // A larger rewrite guarantees a new size (and mtime) even on a filesystem with coarse
  // clocks, so the stat-keyed cache must miss and the fresh walk must yield the new entry.
  fs.writeFileSync(plans, "# Plans\n## Planned\n### Beta (planned 2026-10-02)\nA longer body line.\n## Done\n_None._\n");
  assert.deepEqual(eligibleEntries(dir, "feature").map((e) => e.key), ["beta"]);
});

test("backlogHolds caches an unchanged stat pair without re-running the readers, and re-derives when either file changes", (t) => {
  const dir = tmpdir();
  const plans = path.join(dir, "PLANS.md");
  const bugs = path.join(dir, "BUGS.md");
  fs.writeFileSync(plans, "# Plans\n## Planned\n### Alpha, part 1/2: x (planned 2026-10-01)\nbody\n## Done\n_None._\n");
  fs.writeFileSync(bugs, "# Bugs\n## Open\n### Real (reported 2026-10-02)\nRepro.\n## Fixed\n_None._\n");

  // Warm the holds cache: the first poll derives and caches both files' holds.
  assert.deepEqual(backlogHolds(dir), { plans: [null], bugs: [null] });

  // A repeat poll with unchanged files must be served from the holds cache without re-running
  // either reader — the 1-second /api/status poll and every TUI frame hit this path. Both
  // readers are themselves stat-cached, so the only way the holds cache's win shows is by
  // counting whether the derivation re-invokes them at all on an unchanged stat pair.
  let planCalls = 0;
  let bugCalls = 0;
  t.mock.method(holdsBacklogReaders, "plannedPlanEntries", (r: string) => {
    planCalls++;
    return plannedPlanEntries(r);
  });
  t.mock.method(holdsBacklogReaders, "openBugEntries", (r: string) => {
    bugCalls++;
    return openBugEntries(r);
  });
  try {
    assert.deepEqual(backlogHolds(dir), { plans: [null], bugs: [null] });
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(planCalls, 0, "an unchanged stat pair must not re-run the plans reader");
  assert.equal(bugCalls, 0, "an unchanged stat pair must not re-run the bugs reader");

  // A larger rewrite guarantees a new size (and mtime), so the stat-keyed cache must miss and
  // the fresh walk must yield the new hold.
  fs.writeFileSync(plans, "# Plans\n## Planned\n### Alpha, part 1/2: x (planned 2026-10-01; requires parts 1/2 landed)\nbody with a much longer line to guarantee a new size\n## Done\n_None._\n");
  assert.deepEqual(backlogHolds(dir), { plans: [{ blockedBy: ["Alpha 1/2"] }], bugs: [null] });
});

test("refusalNote returns the note line without its bold markers, and null for a mid-line mention", () => {
  assert.equal(
    refusalNote("intro\n  **Refused 2026-10-12 by feature: too big**\nmore"),
    "Refused 2026-10-12 by feature: too big",
  );
  assert.equal(refusalNote("prose quoting **Refused 2026-10-12 by x: y** inline"), null);
  assert.equal(refusalNote(""), null);
});

const WRAPPED = "Op writes, part 2/2: x (planned 2026-10-12 by plan; requires part 1/2 landed. It reuses part 1/2's module:";

test("requiredParts reads a parenthetical left open by a wrapped heading", () => {
  assert.deepEqual(requiredParts(WRAPPED), [{ series: "Op writes", part: "1", of: 2 }]);
  assert.deepEqual(requiredParts("Foo, part 1/2: x"), []);
});

test("entryHold blocks a wrapped heading while its prerequisite is planned", () => {
  const planned: BacklogEntry[] = [{ title: "Op writes, part 1/2: y (planned 2026-10-12)", body: "" }];
  assert.deepEqual(entryHold(entry(WRAPPED), planned), { blockedBy: ["Op writes 1/2"] });
  assert.equal(entryHold(entry(WRAPPED), []), null);
});

test("openParenthetical returns the outermost group still open", () => {
  assert.equal(openParenthetical("a (b) c"), "");
  assert.equal(openParenthetical("a (b (c))"), "");
  assert.equal(openParenthetical("no parens"), "");
  assert.equal(openParenthetical("a (b (c) d"), "b (c) d");
  assert.equal(openParenthetical("a) b (c"), "c");
});

test("prerequisitesLanded returns the refs only when none is still planned", () => {
  const title = "S, part 2/2: x (planned 2026-10-12; requires part 1/2 landed)";
  const refs = [{ series: "S", part: "1", of: 2 }];
  assert.deepEqual(prerequisitesLanded(title, new Set()), refs);
  const planned = plannedPartKeys([{ title: "S, part 1/2: y", body: "" }]);
  assert.deepEqual(prerequisitesLanded(title, planned), []);
  assert.deepEqual(prerequisitesLanded("S, part 2/2: x (planned 2026-10-12)", new Set()), []);
  assert.deepEqual(prerequisitesLanded("S, part 2/2: x (planned 2026-10-12; requires part 1/2 landed. More", new Set()), refs);
});

test("withoutRefusalNotes drops Refused note lines and the blank line after one between blanks", () => {
  const note = "**Refused 2026-10-12 by feature: x**";
  assert.deepEqual(withoutRefusalNotes(["### t", "", note, "", "**Goal.** g"]), ["### t", "", "**Goal.** g"]);
  assert.deepEqual(withoutRefusalNotes(["### t", "", `  ${note}`, "", "**Goal.** g"]), ["### t", "", "**Goal.** g"]);
  assert.deepEqual(withoutRefusalNotes(["### t", note, "g"]), ["### t", "g"]);
  const kept = ["### t", "see **Refused 2026** here", "**Needs review 2026-10-12 by feature: big**"];
  assert.deepEqual(withoutRefusalNotes(kept), kept);
});

test("planDependencyProblems finds dangling refs, unparsed clauses and cycles", () => {
  const e = (title: string): BacklogEntry => ({ title, body: "" }) as BacklogEntry;
  const done = ["S, part 1/3: a (done 2026-10-01)"];
  const ok = planDependencyProblems([e("S, part 2/3: b (requires part 1/3 landed)")], done);
  assert.deepEqual(ok, { cycle: null, dangling: [], unparsed: [] });
  const dangling = planDependencyProblems([e("S, part 2/3: b (requires T 1/3 landed)")], done);
  assert.deepEqual(dangling.dangling, [{ title: "S, part 2/3: b (requires T 1/3 landed)", ref: "T 1/3" }]);
  const unparsed = planDependencyProblems([e("Plain plan (requires part 1/2 landed)")], []);
  assert.deepEqual(unparsed.unparsed, ["Plain plan (requires part 1/2 landed)"]);
  const cyc = planDependencyProblems([
    e("S, part 1/2: a (requires part 2/2 landed)"),
    e("S, part 2/2: b (requires part 1/2 landed)"),
  ], []);
  assert.deepEqual(cyc.cycle, ["S 1/2", "S 2/2", "S 1/2"]);
  const self = planDependencyProblems([e("S, part 1/2: a (requires part 1/2 landed)")], []);
  assert.deepEqual(self.cycle, ["S 1/2", "S 1/2"]);
  assert.deepEqual(planDependencyProblems([e("Free plan")], []), { cycle: null, dangling: [], unparsed: [] });
});
