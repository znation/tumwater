import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strandedPlanEntries, renderBacklogStructureBlock, type StrandedPlanEntry } from "../src/backlog-structure.js";
import { tmpdir } from "./repo-fixtures.js";

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
