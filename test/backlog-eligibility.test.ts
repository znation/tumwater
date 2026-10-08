import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  eligibleEntries,
  entryHold,
  entryKey,
  requiredParts,
  seriesPart,
  type EligibleEntry,
  type EntryHold,
  type PartRef,
} from "../src/backlog/backlog-eligibility.js";
import type { BacklogEntry } from "../src/backlog/backlog-md.js";
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
