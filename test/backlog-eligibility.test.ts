import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withoutNeedsReviewNotes, withoutRefusalNotes, backlogHolds, backlogInProgress, cancelledClaimNote, eligibleEntries, entryHold, holdMark, holdsBacklogReaders, inProgressMark, mergedPrerequisiteRanges, refusalNote, refusedEntries, stalledEntries, waitingPartRanges, type EligibleEntry, type EntryHold, stillHeldNote } from "../src/backlog/backlog-eligibility.js";
import { entryKey, plannedPartKeys, prerequisitesMerged, planDependencyProblems, plansReleasedBy, plansWaitingOn, releasedPartsNote, requiredParts, seriesPart, type PartRef } from "../src/backlog/backlog-parts.js";
import { openBugEntries, plannedPlanEntries } from "../src/backlog/backlog.js";
import { openParenthetical, type BacklogEntry } from "../src/backlog/backlog-md.js";
import { saveRunnerState } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** Unit coverage for src/backlog/backlog-eligibility.ts (plans, parallel-work-instances,
 * part 2/7): a plan heading's prerequisite clause and the note holds decide which entries a
 * work role may take, and the backlog index renders the same verdicts as marks. */

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

test("requiredParts keeps the parts keyword out of a named series and bare refs inherit the clause's last named series", () => {
  // `<Series> parts a/n and b/n`: the keyword stays out of the series and the bare b/n inherits
  // the named series, not the entry's own.
  assert.deepEqual(
    requiredParts("Check-permit priority, part 2/2: x (planned 2026-10-23 by user; requires reviewer-as-role parts 1/4 and 3/4 landed)"),
    [
      { series: "reviewer-as-role", part: "1", of: 4 },
      { series: "reviewer-as-role", part: "3", of: 4 },
    ],
  );
  // `<Series> parts a/n, <Other> b/n`: a bare ref inherits the last named series.
  assert.deepEqual(
    requiredParts("Check-permit priority, part 2/2: x (planned 2026-10-23 by user; requires Disk floor parts 1/2 and 3/4 landed)"),
    [
      { series: "Disk floor", part: "1", of: 2 },
      { series: "Disk floor", part: "3", of: 4 },
    ],
  );
  // The same clause with a second named series directly follows one named range.
  assert.deepEqual(
    requiredParts("Check-permit priority, part 2/2: x (planned 2026-10-23 by user; requires reviewer-as-role parts 1/4, Worktree pool 3/4 landed)"),
    [
      { series: "reviewer-as-role", part: "1", of: 4 },
      { series: "Worktree pool", part: "3", of: 4 },
    ],
  );
  // A named range expands inclusively and still drops the keyword.
  assert.deepEqual(
    requiredParts("Check-permit priority, part 2/2: x (planned 2026-10-23 by user; requires reviewer-as-role parts 1/4–3/4 landed)"),
    [
      { series: "reviewer-as-role", part: "1", of: 4 },
      { series: "reviewer-as-role", part: "2", of: 4 },
      { series: "reviewer-as-role", part: "3", of: 4 },
    ],
  );
  // A named range followed by a bare one inherits the series for both.
  assert.deepEqual(
    requiredParts("Check-permit priority, part 2/2: x (planned 2026-10-23 by user; requires reviewer-as-role parts 1/4–2/4 and 3/4 landed)"),
    [
      { series: "reviewer-as-role", part: "1", of: 4 },
      { series: "reviewer-as-role", part: "2", of: 4 },
      { series: "reviewer-as-role", part: "3", of: 4 },
    ],
  );
});

test("requiredParts returns [] for a clause that does not parse and for a heading with no clause", () => {
  assert.deepEqual(requiredParts("Foo, part 1/2: x (planned 2026-10-01; merge that plan first)"), []);
  assert.deepEqual(requiredParts("Foo, part 1/2: x"), []);
  assert.deepEqual(requiredParts("Foo (planned 2026-10-01; requires something else entirely)"), []);
});

test("entryHold resolves a <Series> parts a/n and b/n clause to the named series, not the entry's own", () => {
  const own = "Check-permit priority, part 2/2: x (requires Disk floor parts 1/4 and 3/4 landed)";
  // Dropped hold: the clause's named prerequisite blocks the plan (before the fix the bare 3/4
  // resolved to the entry's own series, so the real prerequisite never held).
  const hold = entryHold(entry(own), [{ title: "Disk floor, part 1/4: a (planned 2026-10-23)", body: "" }]);
  assert.deepEqual(hold, { blockedBy: ["Disk floor 1/4"] });
  // Self-hold: a chapter of the entry's own series the clause never mentions must not block it.
  assert.equal(
    entryHold(entry(own), [{ title: "Check-permit priority, part 3/4: z (planned 2026-10-23)", body: "" }]),
    null,
  );
  // And with the named prerequisite merged or absent, no hold sticks to the own series.
  assert.equal(entryHold(entry(own), []), null);
});

test("entryHold reports blocked, refused and needs-review, and null when eligible", () => {
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
  // A plan rejected after its final revision round is written as one Needs-review note carrying
  // the reviewer's objections (gate-notes.ts), so it classifies needs-review, not a separate kind.
  assert.equal(
    entryHold(
      entry("Plan (planned 2026-10-01)", "**Needs review 2026-10-07 by feature: rejected after 2 review rounds**"),
      [],
    ),
    "needs-review",
  );
});

test("hold notes match only as their own line, and an indented note still holds", () => {
  const review = "**Needs review 2026-10-07 by feature: too large for one run**";
  const rejected = "**Needs review 2026-10-07 by feature: rejected after 2 review rounds**";
  // A prefix quoted inside prose is a mention, not a note.
  assert.equal(entryHold(entry("Plan", `the loop appends ${review} under the heading`), []), null);
  assert.equal(entryHold(entry("Plan", `the loop appends ${rejected} under the heading`), []), null);
  // Written on its own line — indented or not — it is the note it looks like.
  assert.equal(entryHold(entry("Plan", `body\n${review}`), []), "needs-review");
  assert.equal(entryHold(entry("Plan", `body\n  ${rejected}`), []), "needs-review");
});

test("a body mentioning 'requires' never blocks — only the heading's clause does", () => {
  assert.equal(entryHold(entry("Foo (planned 2026-10-01)", "This requires part 1/2 landed eventually."), []), null);
});

test("a Needs-review note parks the entry as needs-review at any held count", () => {
  assert.equal(entryHold(entry("Plan", `**Needs review 2026-10-23 by feature: too large for one run**`), []), "needs-review");
  assert.equal(entryHold(entry("Plan", `**Needs review 2026-10-23 by feature: too large for one run (held 3)**`), []), "needs-review");
  assert.equal(holdMark("needs-review"), " [blocked: needs review]");
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
  assert.equal(holdMark("refused"), " [blocked: refused]");
  assert.equal(holdMark("needs-review"), " [blocked: needs review]");
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
  // `feature` takes the plan the way a real run does (a queued merge keeps its claim until the
  // move tunes into main); a second plan-consuming role must not be handed the same entry.
  const owner = {
    ...loadRunnerState(dir, "feature"),
    claim: { file: "PLANS.md", key: "volume slider", title: "Volume slider", at: 1, source: "assigned" } as const,
  };
  saveRunnerState(dir, owner);
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
    ...loadRunnerState(dir, "feature-2"),
    claim: { file: "PLANS.md", key: "volume slider", title: "Volume slider", at: 1, source: "assigned" } as const,
  };
  saveRunnerState(dir, owner);
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

test("prerequisitesMerged returns the refs only when none is still planned", () => {
  const title = "S, part 2/2: x (planned 2026-10-12; requires part 1/2 landed)";
  const refs = [{ series: "S", part: "1", of: 2 }];
  assert.deepEqual(prerequisitesMerged(title, new Set()), refs);
  const planned = plannedPartKeys([{ title: "S, part 1/2: y", body: "" }]);
  assert.deepEqual(prerequisitesMerged(title, planned), []);
  assert.deepEqual(prerequisitesMerged("S, part 2/2: x (planned 2026-10-12)", new Set()), []);
  assert.deepEqual(prerequisitesMerged("S, part 2/2: x (planned 2026-10-12; requires part 1/2 landed. More", new Set()), refs);
});

test("withoutRefusalNotes drops Refused note lines and the blank line after one between blanks", () => {
  const note = "**Refused 2026-10-12 by feature: x**";
  assert.deepEqual(withoutRefusalNotes(["### t", "", note, "", "**Goal.** g"]), ["### t", "", "**Goal.** g"]);
  assert.deepEqual(withoutRefusalNotes(["### t", "", `  ${note}`, "", "**Goal.** g"]), ["### t", "", "**Goal.** g"]);
  assert.deepEqual(withoutRefusalNotes(["### t", note, "g"]), ["### t", "g"]);
  const kept = ["### t", "see **Refused 2026** here", "**Needs review 2026-10-12 by feature: big**"];
  assert.deepEqual(withoutRefusalNotes(kept), kept);
});

test("planDependencyProblems does not dangle a <Series> parts a/n and b/n clause", () => {
  const e = (title: string): BacklogEntry => ({ title, body: "" }) as BacklogEntry;
  const plan = "Check-permit priority, part 2/2: x (requires reviewer-as-role parts 1/4 and 3/4 landed)";
  // Both refs resolve to the reviewer-as-role series, so with them done nothing dangles and no
  // self ref to Check-permit priority appears.
  const done = ["reviewer-as-role, part 1/4: a (done 2026-10-23)", "reviewer-as-role, part 3/4: b (done 2026-10-23)"];
  assert.deepEqual(planDependencyProblems([e(plan)], done).dangling, []);
  // When the named prerequisite is missing, only it dangles — never the entry's own series.
  assert.deepEqual(planDependencyProblems([e(plan)], []).dangling, [
    { title: plan, ref: "reviewer-as-role 1/4" },
    { title: plan, ref: "reviewer-as-role 3/4" },
  ]);
});

test("planDependencyProblems flags a still-planned prerequisite named without a requires clause", () => {
  const e = (title: string): BacklogEntry => ({ title, body: "" }) as BacklogEntry;
  const b = "S, part 2/2: b (planned 2026-10-14 by plan; blocked by part 1/2 above)";
  assert.deepEqual(planDependencyProblems([e("S, part 1/2: a"), e(b)], []).misworded, [{ title: b, ref: "S 1/2" }]);
  assert.deepEqual(planDependencyProblems([e(b)], ["S, part 1/2: a (done 2026-10-01)"]).misworded, []);
  const held = "S, part 2/2: b (requires part 1/2 landed; after part 1/2)"; // vocabulary-ok: PLANS.md heading syntax
  assert.deepEqual(planDependencyProblems([e("S, part 1/2: a"), e(held)], []).misworded, []);
  assert.deepEqual(planDependencyProblems([e("S, part 1/2: a"), e("Plain plan (after part 1/2)")], []).misworded, []);
});

test("planDependencyProblems finds dangling refs, unparsed clauses and cycles", () => {
  const e = (title: string): BacklogEntry => ({ title, body: "" }) as BacklogEntry;
  const done = ["S, part 1/3: a (done 2026-10-01)"];
  const ok = planDependencyProblems([e("S, part 2/3: b (requires part 1/3 landed)")], done);
  assert.deepEqual(ok, { cycle: null, dangling: [], unparsed: [], misworded: [] });
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
  assert.deepEqual(planDependencyProblems([e("Free plan")], []), { cycle: null, dangling: [], unparsed: [], misworded: [] });
});

test("backlogInProgress names the runner holding each entry's claim; inProgressMark labels it", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "# Plans\n## Planned\n### Volume slider (planned 2026-10-09)\nA.\n### Mute button (planned 2026-10-09)\nB.\n## Done\n_None._\n",
  );
  fs.writeFileSync(path.join(dir, "BUGS.md"), "# Bugs\n## Open\n### Crash on start (reported 2026-10-09)\nC.\n## Fixed\n_None._\n");
  assert.deepEqual(backlogInProgress(dir), { plans: [null, null], bugs: [null] });
  const claim = (key: string, title: string, file: "PLANS.md" | "BUGS.md") =>
    ({ file, key, title, at: 1, source: "assigned" }) as const;
  saveRunnerState(dir, { ...loadRunnerState(dir, "feature-2"), claim: claim("volume slider", "Volume slider", "PLANS.md") });
  saveRunnerState(dir, { ...loadRunnerState(dir, "bugfix"), claim: claim("crash on start", "Crash on start", "BUGS.md") });
  assert.deepEqual(backlogInProgress(dir), { plans: ["feature-2", null], bugs: ["bugfix"] });
  assert.equal(inProgressMark(null), "");
  assert.equal(inProgressMark("feature-2"), " [working on it: feature #2]");
});

test("cancelledClaimNote is empty unclaimed and names the role and the abort command", () => {
  assert.equal(cancelledClaimNote(null), "");
  const note = cancelledClaimNote("feature-2");
  assert.ok(note.includes("feature #2 is still working on it"), note);
  assert.ok(note.includes("`tumwater abort --role feature-2`"), note);
});

test("plansWaitingOn follows requires clauses transitively and stops on a cycle", () => {
  const entry = (title: string): BacklogEntry => ({ title, body: "" } as BacklogEntry);
  const planned = [
    "S, part 1/3: a",
    "S, part 2/3: b (requires part 1/3 landed)",
    "S, part 3/3: c (requires part 2/3 landed)",
    "Other",
    "T, part 1/1: d (requires S 1/3 landed)",
  ].map(entry);
  assert.equal(requiredParts(planned[1]!.title).length, 1);
  assert.deepEqual(plansWaitingOn(planned, 0), [1, 2, 4]);
  assert.deepEqual(plansWaitingOn(planned, 2), []);
  assert.deepEqual(plansWaitingOn(planned, 3), []);
  const cycle = [
    "X, part 1/2: a (requires part 2/2 landed)",
    "X, part 2/2: b (requires part 1/2 landed)",
  ].map(entry);
  assert.deepEqual(plansWaitingOn(cycle, 0), [1]);
});

test("mergedPrerequisiteRanges names each merged prerequisite's newest Done entry", () => {
  const dir = tmpdir();
  const c = "S, part 3/3: c (requires parts 1/3–2/3 landed)";
  const lines = [
    "# Plans", "## Planned", `### ${c}`, "body c", "## Done",
    "### s, part 2/3: b (done 2026-10-16)", "body b",
    "### S, part 1/3: a (done 2026-10-15)", "body a",
    "### S, part 1/3: a-old (done 2026-10-01)", "body old",
  ];
  fs.writeFileSync(path.join(dir, "PLANS.md"), lines.join("\n") + "\n");
  const got = mergedPrerequisiteRanges(dir, c);
  assert.deepEqual(
    got.map((e) => [e.title, e.start, e.end]),
    [
      ["S, part 1/3: a (done 2026-10-15)", 8, 9],
      ["s, part 2/3: b (done 2026-10-16)", 6, 7],
    ],
  );
  assert.deepEqual(mergedPrerequisiteRanges(dir, "Plain"), []);
  assert.deepEqual(mergedPrerequisiteRanges(dir, "S, part 3/3: c (requires part 9/9 landed)"), []);
  assert.deepEqual(mergedPrerequisiteRanges(tmpdir(), c), []);
});

test("waitingPartRanges names the planned parts that wait on an entry, with their ranges", () => {
  const dir = tmpdir();
  const lines = [
    "# Plans", "## Planned",
    "### S, part 1/3: a", "body a",
    "### Unrelated plan", "body u",
    "### S, part 2/3: b (requires part 1/3 landed)", "body b",
    "### S, part 3/3: c (requires part 2/3 landed)", "body c",
    "## Done", "_None._",
  ];
  fs.writeFileSync(path.join(dir, "PLANS.md"), lines.join("\n") + "\n");
  assert.deepEqual(
    waitingPartRanges(dir, "S, part 1/3: a").map((e) => [e.title, e.start, e.end]),
    [
      ["S, part 2/3: b (requires part 1/3 landed)", 7, 8],
      ["S, part 3/3: c (requires part 2/3 landed)", 9, 10],
    ],
  );
  assert.deepEqual(waitingPartRanges(dir, "S, part 3/3: c (requires part 2/3 landed)"), []);
  assert.deepEqual(waitingPartRanges(dir, "Unrelated plan"), []);
  assert.deepEqual(waitingPartRanges(dir, "Not there"), []);
  assert.deepEqual(waitingPartRanges(tmpdir(), "S, part 1/3: a"), []);
});

test("refusedEntries lists the refused plans then the refused bugs, and [] with no backlog files", () => {
  const empty = tmpdir();
  assert.deepEqual(refusedEntries(empty), []);
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    [
      "# Plans",
      "## Planned",
      "### Ready (planned 2026-10-04)",
      "body",
      "### Dead plan (planned 2026-10-03)",
      "**Refused 2026-10-07 by feature: no**",
      "### Needs a look (planned 2026-10-03)",
      "**Needs review 2026-10-07 by feature: too large for one run**",
      "## Done",
      "_None._",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "BUGS.md"),
    [
      "# Bugs",
      "## Open",
      "### Live (reported 2026-10-02)",
      "Repro.",
      "### Dead bug (reported 2026-10-02)",
      "**Refused 2026-10-07 by bugfix: not reproducible**",
      "## Fixed",
      "_None._",
    ].join("\n"),
  );
  assert.deepEqual(refusedEntries(dir), [
    { file: "plans", index: 1, title: "Dead plan (planned 2026-10-03)" },
    { file: "bugs", index: 1, title: "Dead bug (reported 2026-10-02)" },
  ]);
});

test("stalledEntries lists the needs-review plans and bugs, keeping file order", () => {
  assert.deepEqual(stalledEntries(tmpdir()), []);
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    [
      "# Plans",
      "## Planned",
      "### Ready (planned 2026-10-04)",
      "body",
      "### Needs review (planned 2026-10-03)",
      "**Needs review 2026-10-07 by feature: too large for one run**",
      "## Done",
      "_None._",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "BUGS.md"),
    [
      "# Bugs",
      "## Open",
      "### A held bug",
      "**Needs review 2026-10-07 by feature: too large for one run**",
      "## Fixed",
      "_None._",
    ].join("\n"),
  );
  assert.deepEqual(stalledEntries(dir), [
    { file: "plans", index: 1, title: "Needs review (planned 2026-10-03)", hold: "needs-review" },
    { file: "bugs", index: 0, title: "A held bug", hold: "needs-review" },
  ]);
});

test("withoutNeedsReviewNotes drops every Needs-review note line and keeps the rest", () => {
  const lines = [
    "### Plan (planned 2026-10-03)",
    "",
    "**Needs review 2026-10-07 by feature: too large for one run**",
    "",
    "**Needs review 2026-10-08 by feature: too large for one run**",
    "",
    "**Goal.** g",
  ];
  assert.deepEqual(withoutNeedsReviewNotes(lines), [
    "### Plan (planned 2026-10-03)",
    "",
    "**Goal.** g",
  ]);
  // A note that still carries the legacy `(held N)` tag drops its `**Previously held N−1**`
  // marker too, so a release leaves no surviving marker orphaned behind it.
  const legacy = [
    "### Plan (planned 2026-10-03)",
    "",
    "**Needs review 2026-10-08 by feature: too large for one run (held 8)**",
    "**Previously held 7**",
    "",
    "**Goal.** g",
  ];
  assert.deepEqual(withoutNeedsReviewNotes(legacy), [
    "### Plan (planned 2026-10-03)",
    "",
    "**Goal.** g",
  ]);
  // A flat note (the current writer emits no `(held N)` tag) drops the legacy marker beside
  // it too, so a release leaves no orphan even without a tag to pair them by.
  const flat = [
    "### Plan (planned 2026-10-03)",
    "",
    "**Needs review 2026-10-08 by feature: too large for one run**",
    "",
    "**Previously held 1**",
    "",
    "**Goal.** g",
  ];
  assert.deepEqual(withoutNeedsReviewNotes(flat), [
    "### Plan (planned 2026-10-03)",
    "",
    "**Goal.** g",
  ]);
  const untagged = ["### Plan (planned 2026-10-03)", "body"];
  assert.deepEqual(withoutNeedsReviewNotes(untagged), untagged);
});

test("plansReleasedBy lists only direct dependents of a cancelled part, by post-cancel position", () => {
  const entry = (title: string): BacklogEntry => ({ title, body: "" } as BacklogEntry);
  const afterCancel = [
    "Other (planned 2026-10-01)",
    "S, part 2/3: b (planned 2026-10-02; requires part 1/3 landed)",
    "S, part 3/3: c (planned 2026-10-02; requires part 2/3 landed)",
  ].map(entry);
  assert.deepEqual(plansReleasedBy(afterCancel, "S, part 1/3: a (planned 2026-10-01)"), [
    { position: 2, title: "S, part 2/3: b" },
  ]);
  assert.deepEqual(plansReleasedBy(afterCancel, "Not a series (planned 2026-10-01)"), []);
  const stillCarried = [...afterCancel, entry("S, part 1/3: a again (planned 2026-10-03)")];
  assert.deepEqual(plansReleasedBy(stillCarried, "S, part 1/3: a (planned 2026-10-01)"), []);
});

test("releasedPartsNote words none, one and several released parts", () => {
  const tail = " — cancel what cannot stand alone with `tumwater plan --cancel <n>`";
  assert.equal(releasedPartsNote([]), "");
  assert.equal(
    releasedPartsNote([{ position: 4, title: "A" }]),
    `plan #4 required it and no longer waits on it: A${tail}`,
  );
  assert.equal(
    releasedPartsNote([{ position: 4, title: "A" }, { position: 6, title: "B" }]),
    `plans #4, #6 required it and no longer wait on them: A; B${tail}`,
  );
});

test("stillHeldNote words a hold as holdMark does and is empty for none", () => {
  assert.equal(stillHeldNote(null), "");
  assert.equal(
    stillHeldNote({ blockedBy: ["Export series 1/2"] }),
    "still held [blocked: requires Export series 1/2]: no role takes it until that clears",
  );
  assert.equal(stillHeldNote("needs-review"), "still held [blocked: needs review]: no role takes it until that clears");
});
