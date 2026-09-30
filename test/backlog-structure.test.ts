import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backlogStructureReason,
  duplicateHeadings,
  strandedPlanEntries,
  renderBacklogStructureBlock,
  type StrandedPlanEntry,
} from "../src/backlog-structure.js";
import { ensureWorktree } from "../src/worktree.js";
import { makeRepo, sh, tmpdir } from "./repo-fixtures.js";

/** Unit coverage for src/backlog-structure.ts — the stranded-plan detector (plans, part 3/4):
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
