import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backlogStructureReason,
  finishedTitle,
  doubleBlockFixedEntries,
  duplicateHeadings,
  strandedPlanEntries,
  renderBacklogStructureBlock,
  actionableEntryRanges,
  renderBacklogIndexBlock,
  groupBlockedSeries,
  type StrandedPlanEntry,
} from "../src/backlog/backlog-structure.js";
import { DONE_DATE_RE, FIXED_DATE_RE } from "../src/backlog/backlog.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { loadLoopState, saveLoopState } from "../src/loop/loop-state.js";
import { makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";

/** Unit coverage for src/backlog/backlog-structure.ts — the stranded-plan detector (plans, part
 * 3/4):
 * a `### ` heading with plan dates filed under the wrong `## ` section of PLANS.md is invisible
 * to every section-scoped reader, so the detector re-reads the whole document fence-aware and
 * reports the misplaced headings with the section each sits in. */

function plansDoc(body: string): string {
  return `# Plans\n\nPlanned features, written by the plan loop.\n\n${body}`;
}

test("a (planned …) entry directly under the only ## Done — the 2026-09-25 shape — is stranded", () => {
  const md = plansDoc(`## Done

### Timed pause support (planned 2026-09-25)

**Goal.** It waited here for hours.

## Planned

_None yet._`);
  assert.deepEqual(strandedPlanEntries(md), [
    { title: "Timed pause support (planned 2026-09-25)", section: "Done" },
  ]);
});

test("a Done entry whose heading carries its done date is not stranded", () => {
  const md = plansDoc(`## Done

### Timed pause support (planned 2026-09-25, done 2026-09-26)

**Goal.** Landed.

## Planned

_None yet._`);
  assert.deepEqual(strandedPlanEntries(md), []);
});

test("a done date on a wrapped second heading line is matched", () => {
  const md = plansDoc(`## Done

### Timed pause support (planned 2026-09-02, done
2026-09-03)

**Goal.** Landed, wrapped heading.

## Planned

_None yet._`);
  assert.deepEqual(strandedPlanEntries(md), []);
});

test("an entry under ## Planned that already carries a done date is stranded", () => {
  const md = plansDoc(`## Planned

### Already built twice (planned 2026-09-01, done 2026-09-02)

**Goal.** The feature loop may implement this again.

## Done

_None yet._`);
  assert.deepEqual(strandedPlanEntries(md), [
    { title: "Already built twice (planned 2026-09-01, done 2026-09-02)", section: "Planned" },
  ]);
});

test("a stranded-looking heading inside a fenced block is ignored", () => {
  const md = plansDoc(`## Done

Example landing note:

\`\`\`md
### Not a real entry (planned 2026-09-25)
\`\`\`

## Planned

_None yet._`);
  assert.deepEqual(strandedPlanEntries(md), []);
});

test("other sections and sectionless content are out of scope; dates in bodies never match", () => {
  const md = plansDoc(`## Planned

### A real plan (planned 2026-09-20)

**Goal.** References (done 2026-09-21) in body prose are metadata of no heading.

## Done

### Landed work (planned 2026-09-10, done 2026-09-11)

## Verified

### Not a plans section — a planned-looking heading here is not the detector's business (planned 2026-09-25)`);
  assert.deepEqual(strandedPlanEntries(md), []);
});

test("this repo's current PLANS.md yields nothing", () => {
  // ../../ from test/ (or dist/test/): the repo root, whichever tree the suite runs from.
  const md = fs.readFileSync(fileURLToPath(new URL("../../PLANS.md", import.meta.url)), "utf8");
  const stranded: StrandedPlanEntry[] = strandedPlanEntries(md);
  assert.deepEqual(stranded, []);
});

test("the clean tick's block lists each stranded heading with its section; a clean file gives none", () => {
  const dir = tmpdir("backlog-structure-block-");
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    plansDoc(`## Done

### Timed pause support (planned 2026-09-25)

## Planned

### Already built twice (planned 2026-09-01, done 2026-09-02)`),
  );
  const block = renderBacklogStructureBlock(dir);
  assert.ok(block);
  assert.match(block, /<backlog-structure>/);
  assert.match(block, /\(now under ## Done\) Timed pause support \(planned 2026-09-25\)/);
  assert.match(block, /\(now under ## Planned\) Already built twice \(planned 2026-09-01, done 2026-09-02\)/);
  // A clean file: no block at all, so the prompt is unchanged in the common case.
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    plansDoc(`## Done

### Landed (planned 2026-09-10, done 2026-09-11)

## Planned

_None yet._`),
  );
  assert.equal(renderBacklogStructureBlock(dir), undefined);
});

test("a missing PLANS.md gives no block instead of throwing", () => {
  assert.equal(renderBacklogStructureBlock(tmpdir("backlog-structure-missing-")), undefined);
});

test("renderBacklogStructureBlock re-reads PLANS.md whose stat changed", () => {
  const dir = tmpdir();
  const plans = path.join(dir, "PLANS.md");
  fs.writeFileSync(plans, plansDoc(`## Done\n\n### Landed (planned 2026-09-10, done 2026-09-11)`));
  assert.equal(renderBacklogStructureBlock(dir), undefined);
  // A larger rewrite guarantees a new size (and mtime) even on a filesystem with coarse
  // clocks, so the stat-keyed cache must miss and re-read.
  fs.writeFileSync(
    plans,
    plansDoc(`## Done\n\n### Timed pause support (planned 2026-09-25)\n\nBody.`),
  );
  assert.match(renderBacklogStructureBlock(dir) ?? "", /\(now under ## Done\) Timed pause support/);
});

// ── backlogStructureReason — the heading-set check at the gate and the landing re-check ──
// (plans: "Backlog structure check at the review gate and the in-lock landing re-check",
// part 2/4) A change that duplicates or drops a `## ` section heading must not reach main.

/** A repo whose main carries `base` as a backlog file, plus the improve worktree whose HEAD
 * commit replaces it with `head` — the shape backlogStructureReason measures: the diff's
 * merge-base is main's tip, so the two contents compare directly. */
async function structureFixture(file: string, base: string, head: string): Promise<string> {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, file), base);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "base backlog");
  const wt = await ensureWorktree(root, "improve", "main");
  fs.writeFileSync(path.join(wt, file), head);
  sh(wt, "git", "add", "-A");
  // An unchanged head is a legitimate fixture (an unchanged backlog file among touched ones);
  // git refuses an empty commit, so commit only when the tree actually differs.
  if (sh(wt, "git", "status", "--porcelain")) sh(wt, "git", "commit", "-m", "head backlog");
  return wt;
}

test("backlogStructureReason rejects a head that adds a second ## Done where the base had one", async () => {
  const wt = await structureFixture(
    "PLANS.md",
    "## Planned\n\n### A (planned 2026-09-25)\n",
    "## Done\n\n### A (planned 2026-09-25, done 2026-09-26)\n\n## Done\n\n### B (planned 2026-09-26)\n",
  );
  const reason = await backlogStructureReason(wt, "main", ["PLANS.md"]);
  assert.match(reason!, /^PLANS.md /);
  assert.match(reason!, /## Done/);
});

test("backlogStructureReason rejects a head that drops a section the base had", async () => {
  const wt = await structureFixture(
    "PLANS.md",
    "## Planned\n\n### A (planned 2026-09-25)\n\n## Done\n\n### B (planned 2026-09-01, done 2026-09-02)\n",
    "## Planned\n\n### A (planned 2026-09-25)\n",
  );
  const reason = await backlogStructureReason(wt, "main", ["PLANS.md"]);
  assert.match(reason!, /^PLANS.md /);
  assert.match(reason!, /drops the "## Done" section/);
});

test("backlogStructureReason ignores a heading quoted inside a fenced block", async () => {
  const wt = await structureFixture(
    "PLANS.md",
    "## Planned\n",
    "## Planned\n\n### A (planned 2026-09-25)\n\n```md\n## Done\n## Done\n```\n",
  );
  assert.equal(await backlogStructureReason(wt, "main", ["PLANS.md"]), undefined);
});

test("backlogStructureReason passes when the base already had the duplicate and it stays", async () => {
  // The new entry carries a done date deliberately: a planned-only entry under ## Done is the
  // new-plan rule's (part 4/4) rejection now, and this test pins the heading-set rule only.
  const wt = await structureFixture(
    "PLANS.md",
    "## Done\n\n### A\n\n## Done\n\n### B\n",
    "## Done\n\n### A\n\n## Done\n\n### B\n\n### C (planned 2026-09-25, done 2026-09-26)\n",
  );
  assert.equal(await backlogStructureReason(wt, "main", ["PLANS.md"]), undefined);
});

test("backlogStructureReason passes a change that removes a duplicate", async () => {
  const wt = await structureFixture(
    "PLANS.md",
    "## Done\n\n### A\n\n## Done\n\n### B\n",
    "## Done\n\n### A\n\n### B\n",
  );
  assert.equal(await backlogStructureReason(wt, "main", ["PLANS.md"]), undefined);
});

test("backlogStructureReason passes an unchanged BUGS.md with sections this repo's template lacks", async () => {
  const bugs = "## Open\n\n_Nothing yet._\n\n## Fixed\n\n_Nothing yet._\n\n## Verified\n\n_Nothing yet._\n";
  const wt = await structureFixture("BUGS.md", bugs, bugs);
  assert.equal(await backlogStructureReason(wt, "main", ["BUGS.md"]), undefined);
});

// ── doubleBlockFixedEntries — a headingless Fixed record cannot hide in its neighbor ─────
// (BUGS.md 2026-10-08) parseEntryDetails opens an entry only at a `### ` line, so a record
// that lost its heading is absorbed into the entry above it; the false-fix guard then reads
// the merged body as one record and no section reader lists the hidden one.

test("doubleBlockFixedEntries names a Fixed body that absorbed a headingless record", () => {
  const md =
    "## Fixed\n\n### A (fixed 2026-10-01)\n\n" +
    "**Symptom:** x.\n\n**Fix:** `a` does it.\n\n" +
    "**Symptom:** hidden record.\n\n**Fix:** `b` does it.\n";
  assert.deepEqual(doubleBlockFixedEntries(md), ["A (fixed 2026-10-01)"]);
  // A quoted `**Symptom:**`/`**Fix:**` inside a fenced block is body content, never a block.
  const fenced =
    "## Fixed\n\n### B (fixed 2026-10-01)\n\n" +
    "**Symptom:** x.\n\n**Fix:** `a` does it.\n\n" +
    "```md\n**Symptom:** quoted\n\n**Fix:** `b` does it.\n```\n";
  assert.deepEqual(doubleBlockFixedEntries(fenced), []);
});

test("backlogStructureReason rejects a head Fixed body that absorbed a headingless record", async () => {
  const base =
    "## Open\n\n_None._\n\n## Fixed\n\n### A (fixed 2026-10-01)\n\n" +
    "**Symptom:** x.\n\n**Fix:** `a` does it.\n";
  const head =
    base + "\n**Symptom:** hidden record.\n\n**Fix:** `b` does it.\n";
  const wt = await structureFixture("BUGS.md", base, head);
  const reason = await backlogStructureReason(wt, "main", ["BUGS.md"]);
  assert.match(reason!, /^BUGS\.md's Fixed entry/);
  assert.match(reason!, /more than one/);
});

test("backlogStructureReason passes when the multi-block Fixed body was already in the base", async () => {
  const shared =
    "## Open\n\n_None._\n\n## Fixed\n\n### A (fixed 2026-10-01)\n\n" +
    "**Symptom:** x.\n\n**Fix:** `a` does it.\n\n" +
    "**Symptom:** an already-merged record.\n\n**Fix:** `b` does it.\n";
  // A code-only edit elsewhere in BUGS.md; the pre-existing absorbed record stays put.
  const wt = await structureFixture("BUGS.md", shared, shared + "\n- an unrelated tail line\n");
  assert.equal(await backlogStructureReason(wt, "main", ["BUGS.md"]), undefined);
});

test("backlogStructureReason passes a first-time backlog file whose headings the base never had", async () => {
  const wt = await structureFixture(
    "PLANS.md",
    "seed\n",
    "## Planned\n\n### A (planned 2026-09-25)\n",
  );
  assert.equal(await backlogStructureReason(wt, "main", ["PLANS.md"]), undefined);
});

test("backlogStructureReason ignores files outside the backlog set", async () => {
  assert.equal(await backlogStructureReason(".", "main", ["docs/notes.md", "src/foo.ts"]), undefined);
});

// ── backlogStructureReason — the new-plan-under-Done rule (plans, part 4/4) ─────────────
// A change that ADDS a plan entry directly under the only `## Done` — the most common
// stranding (PLANS.md 9eaae5ac) — is rejected at the gate and the landing re-check alike.

test("backlogStructureReason rejects a head that files a new plan directly under the only ## Done", async () => {
  const wt = await structureFixture(
    "PLANS.md",
    "## Planned\n",
    "## Planned\n\n## Done\n\n### Feature B (planned 2026-09-26)\n\n**Goal.** New work.\n",
  );
  const reason = await backlogStructureReason(wt, "main", ["PLANS.md"]);
  assert.match(reason!, /^PLANS\.md files "Feature B \(planned 2026-09-26\)"/);
  assert.match(reason!, /file it under "## Planned"/);
});

test("backlogStructureReason passes the same new plan filed under ## Planned", async () => {
  const wt = await structureFixture(
    "PLANS.md",
    "## Planned\n",
    "## Planned\n\n### Feature B (planned 2026-09-26)\n\n**Goal.** New work.\n",
  );
  assert.equal(await backlogStructureReason(wt, "main", ["PLANS.md"]), undefined);
});

test("backlogStructureReason passes a Planned → Done move that keeps only its (planned …) date", async () => {
  // The cd31355e shape: through mid-September entries moved without gaining a done date.
  // A move is not a stranding — the base already carried the entry's key.
  const wt = await structureFixture(
    "PLANS.md",
    "## Planned\n\n### Pre-flight environment check (planned 2026-09-05)\n",
    "## Planned\n\n## Done\n\n### Pre-flight environment check (planned 2026-09-05)\n",
  );
  assert.equal(await backlogStructureReason(wt, "main", ["PLANS.md"]), undefined);
});

test("backlogStructureReason passes a new Done entry whose done date wraps to the heading's second line", async () => {
  const wt = await structureFixture(
    "PLANS.md",
    "## Planned\n",
    "## Planned\n\n## Done\n\n### Feature B (planned 2026-09-26,\ndone 2026-09-27)\n",
  );
  assert.equal(await backlogStructureReason(wt, "main", ["PLANS.md"]), undefined);
});

test("backlogStructureReason passes a new entry filed directly as done", async () => {
  const wt = await structureFixture(
    "PLANS.md",
    "## Planned\n",
    "## Planned\n\n## Done\n\n### Feature B (planned 2026-09-26, done 2026-09-27)\n",
  );
  assert.equal(await backlogStructureReason(wt, "main", ["PLANS.md"]), undefined);
});

test("backlogStructureReason passes a heading quoted inside a fenced block", async () => {
  const wt = await structureFixture(
    "PLANS.md",
    "## Planned\n",
    "## Planned\n\n```md\n## Done\n\n### Feature B (planned 2026-09-26)\n```\n",
  );
  assert.equal(await backlogStructureReason(wt, "main", ["PLANS.md"]), undefined);
});

test("backlogStructureReason passes a pre-existing stranded entry — the clean loop's repair owns those", async () => {
  const wt = await structureFixture(
    "PLANS.md",
    "## Planned\n\n## Done\n\n### Old plan (planned 2026-09-01)\n",
    "## Planned\n\n### Fresh (planned 2026-09-26)\n\n## Done\n\n### Old plan (planned 2026-09-01)\n",
  );
  assert.equal(await backlogStructureReason(wt, "main", ["PLANS.md"]), undefined);
});

test("duplicateHeadings lists each title that appears more than once, fence-aware", () => {
  assert.deepEqual(
    duplicateHeadings("## Done\n\n## Planned\n\n## Done\n\n```md\n## Done\n```\n"),
    ["Done"],
  );
  assert.deepEqual(duplicateHeadings("## Open\n\n## Fixed\n\n## Verified\n"), []);
});

test("actionableEntryRanges reports each entry's 1-based line range under the named section", () => {
  const md = [
    "# BUGS", // 1
    "", // 2
    "## Open", // 3
    "", // 4
    "### First bug", // 5
    "body line", // 6
    "", // 7
    "### Second bug", // 8
    "more", // 9
    "", // 10
    "## Fixed", // 11
    "", // 12
    "### Old bug", // 13
    "old body", // 14
  ].join("\n");
  assert.deepEqual(actionableEntryRanges(md, "Open"), [
    { title: "First bug", start: 5, end: 7 },
    { title: "Second bug", start: 8, end: 10 },
  ]);
  assert.deepEqual(actionableEntryRanges(md, "Fixed"), [{ title: "Old bug", start: 13, end: 14 }]);
});

test("actionableEntryRanges ignores ### headings inside fenced code and ends at EOF", () => {
  // lines: 1 ## Open, 2 blank, 3 ### Real, 4 ```md, 5 ### quoted, 6 ```, 7 body
  const md = "## Open\n\n### Real\n```md\n### quoted\n```\nbody\n";
  assert.deepEqual(actionableEntryRanges(md, "Open"), [{ title: "Real", start: 3, end: 7 }]);
});

test("renderBacklogIndexBlock lists actionable entries with ranges and strips stamp suffixes", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "# Plans\n## Planned\n### Ship it (planned 2026-10-01)\nDo the thing.\n## Done\n_None._\n",
  );
  fs.writeFileSync(
    path.join(dir, "BUGS.md"),
    "# Bugs\n## Open\n### Broken (reported 2026-10-02)\nRepro.\n## Fixed\n_None._\n",
  );
  fs.writeFileSync(path.join(dir, "QUESTIONS.md"), "# Questions\n## Open\n_None yet._\n");
  const block = renderBacklogIndexBlock(dir);
  assert.ok(block);
  assert.match(block, /<backlog-index>/);
  assert.match(block, /PLANS\.md ## Planned\n- 3-4: Ship it/);
  assert.match(block, /BUGS\.md ## Open\n- 3-4: Broken/);
  assert.doesNotMatch(block, /## Done/);
  assert.doesNotMatch(block, /## Fixed/);
});

test("renderBacklogIndexBlock marks an entry carrying a Needs-replan note", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "# Plans\n## Planned\n### One (planned 2026-10-01)\nbody\n### Two (planned 2026-10-02)\n" +
      "**Needs replan 2026-10-07 by feature: rejected after 2 review rounds**\n## Done\n_None._\n",
  );
  const block = renderBacklogIndexBlock(dir);
  assert.ok(block);
  assert.match(block, /- 3-4: One\n/);
  assert.match(block, /- 5-6: Two \[blocked: needs replan\]/);
});

test("renderBacklogIndexBlock marks a held entry as blocked, refused or needing review", () => {
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
      "### Refused one (planned 2026-10-03)",
      "**Refused 2026-10-07 by feature: no**",
      "### Review one (planned 2026-10-04)",
      "**Needs review 2026-10-07 by feature: too large for one run**",
      "## Done",
      "_None._",
    ].join("\n"),
  );
  const block = renderBacklogIndexBlock(dir) ?? "";
  assert.match(block, /- 3-4: Base, part 1\/2: x\n/);
  assert.match(block, /- 5-6: Later, part 2\/2: y \[blocked: requires Base 1\/2\]/);
  assert.match(block, /- 7-8: Refused one \[blocked: refused\]/);
  assert.match(block, /- 9-10: Review one \[blocked: needs review\]/);
});

test("renderBacklogIndexBlock blocks a BUGS.md entry whose prerequisite plan is unlanded", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "# Plans\n## Planned\n### Base, part 1/2: x (planned 2026-10-01)\nbody\n## Done\n_None._\n",
  );
  fs.writeFileSync(
    path.join(dir, "BUGS.md"),
    "# Bugs\n## Open\n### Bug (reported 2026-10-02; requires Base 1/2 landed)\nrepro\n## Fixed\n_None._\n",
  );
  const block = renderBacklogIndexBlock(dir) ?? "";
  // The eligibility gate (eligibleEntries) and `tumwater backlog`'s holds judge a bug against
  // the still-planned set too, so the prompt index must word the same hold: a bugfix loop must
  // not read this entry as eligible.
  assert.match(block, /BUGS\.md ## Open\n- 3-4: Bug \[blocked: requires Base 1\/2\]/);
});

test("renderBacklogIndexBlock re-reads a backlog file whose stat changed", () => {
  const dir = tmpdir();
  const bugs = path.join(dir, "BUGS.md");
  fs.writeFileSync(bugs, "# Bugs\n## Open\n### First (reported 2026-10-02)\nRepro.\n## Fixed\n_None._\n");
  assert.match(renderBacklogIndexBlock(dir) ?? "", /BUGS\.md ## Open\n- 3-4: First/);
  // A larger rewrite guarantees a new size (and mtime) even on a filesystem with coarse
  // clocks, so the stat-keyed section cache must miss and re-read.
  fs.writeFileSync(bugs, "# Bugs\n## Open\n### Second (reported 2026-10-03)\nA longer repro line.\n## Fixed\n_None._\n");
  const block = renderBacklogIndexBlock(dir) ?? "";
  assert.match(block, /BUGS\.md ## Open\n- 3-4: Second/);
  assert.doesNotMatch(block, /First/);
});

function doneDoc(n: number): string {
  let out = "# Plans\n## Planned\n_None yet._\n## Done\n";
  for (let i = 1; i <= n; i++) out += `### D${i} (done 2026-10-0${i}; planned 2026-09-01 by plan)\nbody ${i}\n`;
  return out;
}

test("renderBacklogIndexBlock lists the newest five Done entries with stripped stamps", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "PLANS.md"), doneDoc(7));
  const block = renderBacklogIndexBlock(dir) ?? "";
  assert.match(block, /PLANS\.md ## Done \(newest 5\)\n- 5-6: D1\n- 7-8: D2\n- 9-10: D3\n- 11-12: D4\n- 13-14: D5\n/);
  assert.doesNotMatch(block, /D6|D7|done 2026/);
});

test("renderBacklogIndexBlock lists Fixed entries after the QUESTIONS.md Open lines", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "PLANS.md"), "# Plans\n## Planned\n_None yet._\n## Done\n_None._\n");
  fs.writeFileSync(
    path.join(dir, "BUGS.md"),
    "# Bugs\n## Open\n_None._\n## Fixed\n### F1 (found by bug 2026-10-02)\nx\n### F2 (found by bug 2026-10-01)\ny\n",
  );
  fs.writeFileSync(path.join(dir, "QUESTIONS.md"), "# Q\n## Open\n### Q1\nask\n## Answered\n_None._\n");
  const block = renderBacklogIndexBlock(dir) ?? "";
  assert.match(block, /BUGS\.md ## Fixed \(newest 2\)\n- 5-6: F1\n- 7-8: F2\n/);
  assert.ok(block.indexOf("QUESTIONS.md ## Open") < block.indexOf("BUGS.md ## Fixed"));
});

test("renderBacklogIndexBlock returns a block for a lone Done entry and ignores fenced headings", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "# Plans\n## Planned\n_None yet._\n## Done\n### Only (done 2026-10-01)\n```\n### Fake\n```\n",
  );
  const block = renderBacklogIndexBlock(dir) ?? "";
  assert.match(block, /PLANS\.md ## Done \(newest 1\)\n- 5-8: Only\n/);
  assert.doesNotMatch(block, /Fake/);
});

test("renderBacklogIndexBlock re-reads a Done section whose stat changed", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "PLANS.md"), doneDoc(1));
  assert.match(renderBacklogIndexBlock(dir) ?? "", /newest 1\)/);
  fs.writeFileSync(path.join(dir, "PLANS.md"), doneDoc(3));
  assert.match(renderBacklogIndexBlock(dir) ?? "", /newest 3\)/);
});

test("renderBacklogIndexBlock marks an entry another role has claimed as in flight", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "# Plans\n## Planned\n### Volume slider (planned 2026-10-09)\nbody\n## Done\n_None._\n",
  );
  fs.writeFileSync(path.join(dir, "BUGS.md"), "# Bugs\n## Open\n_None yet._\n## Fixed\n_None._\n");
  // `feature` claimed the plan and its landing is queued (the move to Done merges later), so
  // every other role's shared index must read it as taken rather than list it as open work.
  const owner = {
    ...loadLoopState(dir, "feature"),
    claim: { file: "PLANS.md", key: "volume slider", title: "Volume slider", at: 1, source: "assigned" } as const,
  };
  saveLoopState(dir, owner);
  const block = renderBacklogIndexBlock(dir) ?? "";
  assert.match(block, /- 3-4: Volume slider \[in flight by feature\]/);
});

test("renderBacklogIndexBlock marks an entry a parallel-work instance has claimed as in flight by that instance", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "# Plans\n## Planned\n### Volume slider (planned 2026-10-09)\nbody\n## Done\n_None._\n",
  );
  fs.writeFileSync(path.join(dir, "BUGS.md"), "# Bugs\n## Open\n_None yet._\n## Fixed\n_None._\n");
  // A parallel-work instance's claim lives at .tumwater/state/feature-2.json, which the
  // built-in catalog never names; the shared index must still read it as taken by that
  // instance rather than list the plan as open for every other base to re-implement.
  const owner = {
    ...loadLoopState(dir, "feature-2"),
    claim: { file: "PLANS.md", key: "volume slider", title: "Volume slider", at: 1, source: "assigned" } as const,
  };
  saveLoopState(dir, owner);
  const block = renderBacklogIndexBlock(dir) ?? "";
  assert.match(block, /- 3-4: Volume slider \[in flight by feature-2\]/);
});

test("renderBacklogIndexBlock collapses a multi-part series' blocked parts to one line", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    [
      "# Plans",
      "## Planned",
      "### S, part 1/4: ready (planned 2026-10-01)",
      "body",
      "### S, part 2/4: b (planned 2026-10-02; requires S 1/4 landed)",
      "body",
      "### S, part 3/4: c (planned 2026-10-03; requires S 2/4 landed)",
      "body",
      "### S, part 4/4: d (planned 2026-10-04; requires S 3/4 landed)",
      "body",
      "## Done",
      "_None._",
    ].join("\n"),
  );
  const block = renderBacklogIndexBlock(dir) ?? "";
  // part 1/4 stays eligible on its own line; the three blocked parts collapse to one line that
  // spans from part 2's start (5) to part 4's end (10).
  assert.match(block, /- 3-4: S, part 1\/4: ready\n/);
  assert.match(block, /- 5-10: S, 3 blocked parts \(2\/4–4\/4\) \[blocked: each waits on an earlier part\]/);
  assert.doesNotMatch(block, /part 2\/4: b/);
  assert.doesNotMatch(block, /part 3\/4: c/);
  assert.doesNotMatch(block, /part 4\/4: d/);
});

test("renderBacklogIndexBlock joins non-contiguous blocked parts into separate ranges", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    [
      "# Plans",
      "## Planned",
      "### S, part 1/5: a (planned 2026-10-01)",
      "body",
      "### S, part 2/5: b (planned 2026-10-02; requires S 1/5 landed)",
      "body",
      "### S, part 3/5: c (planned 2026-10-03)",
      "body",
      "### S, part 4/5: d (planned 2026-10-04; requires S 3/5 landed)",
      "body",
      "### S, part 5/5: e (planned 2026-10-05; requires S 4/5 landed)",
      "body",
      "## Done",
      "_None._",
    ].join("\n"),
  );
  const block = renderBacklogIndexBlock(dir) ?? "";
  assert.match(block, /- 3-4: S, part 1\/5: a\n/);
  assert.match(block, /- 7-8: S, part 3\/5: c\n/);
  assert.match(block, /- 5-12: S, 3 blocked parts \(2\/5, 4\/5–5\/5\) \[blocked: each waits on an earlier part\]/);
});

test("renderBacklogIndexBlock keeps a refused and a claimed blocked part out of the collapsed line", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    [
      "# Plans",
      "## Planned",
      "### T, part 1/6: a (planned 2026-10-01)",
      "body",
      "### T, part 2/6: b (planned 2026-10-02; requires T 1/6 landed)",
      "**Refused 2026-10-07 by feature: no**",
      "### T, part 3/6: c (planned 2026-10-03; requires T 2/6 landed)",
      "body",
      "### T, part 4/6: d (planned 2026-10-04; requires T 3/6 landed)",
      "body",
      "### T, part 5/6: e (planned 2026-10-05; requires T 4/6 landed)",
      "body",
      "### T, part 6/6: f (planned 2026-10-06; requires T 5/6 landed)",
      "body",
      "## Done",
      "_None._",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "BUGS.md"), "# Bugs\n## Open\n_None yet._\n## Fixed\n_None._\n");
  // The parallel-work instance `feature` owns part 3/6, so it must keep its own in-flight line
  // instead of being swallowed by the collapsed series.
  const owner = {
    ...loadLoopState(dir, "feature"),
    claim: { file: "PLANS.md", key: "t, part 3/6: c", title: "T, part 3/6: c", at: 1, source: "assigned" } as const,
  };
  saveLoopState(dir, owner);
  const block = renderBacklogIndexBlock(dir) ?? "";
  assert.match(block, /- 3-4: T, part 1\/6: a\n/);
  // The refused part and the claimed part keep their own lines and are not counted.
  assert.match(block, /- 5-6: T, part 2\/6: b \[blocked: refused\]/);
  assert.match(block, /- 7-8: T, part 3\/6: c \[blocked: requires T 2\/6\] \[in flight by feature\]/);
  assert.match(block, /- 9-14: T, 3 blocked parts \(4\/6–6\/6\) \[blocked: each waits on an earlier part\]/);
});

test("renderBacklogIndexBlock does not collapse a BUGS.md entry blocked by a plan", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "# Plans\n## Planned\n### Base, part 1/2: x (planned 2026-10-01)\nbody\n## Done\n_None._\n",
  );
  fs.writeFileSync(
    path.join(dir, "BUGS.md"),
    [
      "# Bugs",
      "## Open",
      "### SomeBug, part 1/2: b (reported 2026-10-02; requires Base 1/2 landed)",
      "repro",
      "### SomeBug, part 2/2: c (reported 2026-10-03; requires Base 1/2 landed)",
      "repro",
      "## Fixed",
      "_None._",
    ].join("\n"),
  );
  const block = renderBacklogIndexBlock(dir) ?? "";
  assert.match(block, /BUGS\.md ## Open\n- 3-4: SomeBug, part 1\/2: b \[blocked: requires Base 1\/2\]/);
  assert.match(block, /- 5-6: SomeBug, part 2\/2: c \[blocked: requires Base 1\/2\]/);
});

test("renderBacklogIndexBlock returns undefined when the actionable sections are empty", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "PLANS.md"), "# Plans\n## Planned\n_None yet._\n");
  assert.equal(renderBacklogIndexBlock(dir), undefined);
});

test("groupBlockedSeries groups a series' blocked parts and leaves other rows alone", () => {
  const blocked = { blockedBy: ["x"] };
  const row = (title: string, hold: unknown = blocked, claimer?: string) => ({
    title,
    hold: hold as never,
    claimer,
  });
  const rows = [
    row("S, part 1/4: a", null),
    row("S, part 2/4: b"),
    row("S, part 3/4: c"),
    row("S, part 4/4: d"),
    row("T, part 2/3: lone"),
    row("U, part 2/3: claimed", blocked, "feature-2"),
  ];
  const groups = groupBlockedSeries(rows);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups[0], { kind: "row", row: rows[0] });
  assert.deepEqual(groups[1], { kind: "series", series: "S", rows: rows.slice(1, 4) });
  assert.deepEqual(groups[2], { kind: "row", row: rows[4] });
  assert.deepEqual(groups[3], { kind: "row", row: rows[5] });
});

test("finishedTitle strips the completion stamp from every heading shape", () => {
  const cases: [string, RegExp, string][] = [
    ["X (planned 2026-10-01 by plan; touches src/x) — done 2026-10-03", DONE_DATE_RE, "X"],
    ["P (planned 2026-10-01 by plan; done 2026-10-02)", DONE_DATE_RE, "P"],
    ["Y (found by bugfix 2026-10-01) — fixed 2026-10-02", FIXED_DATE_RE, "Y"],
    ["Y2 (found by bugfix 2026-10-01; fixed 2026-10-02 by bugfix loop)", FIXED_DATE_RE, "Y2"],
    ["Z (split 2026-10-01 from W, now under ## Fixed); fixed 2026-10-04 by bugfix loop)", FIXED_DATE_RE, "Z (split 2026-10-01 from W, now under ## Fixed)"],
    ['V (observed 2026-10-04: status read "npm"), fixed 2026-10-04 by bugfix loop)', FIXED_DATE_RE, 'V (observed 2026-10-04: status read "npm")'],
    ["R (found 2026-10-01) — fixed 2026-10-02, re-landed 2026-10-05", FIXED_DATE_RE, "R"],
    ["U (planned 2026-10-01 by plan)", DONE_DATE_RE, "U"],
    ["T with no stamp", FIXED_DATE_RE, "T with no stamp"],
  ];
  for (const [input, re, want] of cases) {
    const got = finishedTitle(input, re);
    assert.equal(got, want, input);
    assert.equal(re.test(got), false, `dateRe matches the result for ${input}`);
  }
});
