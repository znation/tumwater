import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { backlogLines, openBugs, parseEntries, plannedPlans } from "../src/backlog.js";
import { tmpdir } from "./util.js";

const PLANS_MD = `# Plans

Planned features, written by the plan loop and implemented by the feature loop.

## Planned

### Show open bugs and planned features in the TUI/GUI (planned 2026-08-24)

**Goal:** The dashboard surfaces project status.
Body text that must not leak into titles — **bold**, \`code\`, lists, everything.

### Timestamp of last result (planned 2026-08-21, refined 2026-08-25)

## Done

### An old finished plan (done 2026-08-20)

Done entries must never appear in the planned list.
`;

const BUGS_MD = `# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.

## Open

### gen / peak ctx columns should show the current or last run (reported 2026-08-25)

**Symptom:** The columns accumulate across a loop's whole lifetime.

### Merge conflicts logged as warnings although they are normal operation (reported 2026-08-25)

## Fixed

### A fixed bug (fixed 2026-08-24)

_None else yet._
`;

test("parseEntries returns only the requested section's ### headings, full text kept", () => {
  assert.deepEqual(parseEntries(PLANS_MD, "Planned"), [
    "Show open bugs and planned features in the TUI/GUI (planned 2026-08-24)",
    "Timestamp of last result (planned 2026-08-21, refined 2026-08-25)",
  ]);
  assert.deepEqual(parseEntries(PLANS_MD, "Done"), ["An old finished plan (done 2026-08-20)"]);
});

test("parseEntries stops at the next ## section and ignores body text", () => {
  // The Done entry sits after a second ## line — it must not leak into Planned.
  assert.ok(!parseEntries(PLANS_MD, "Planned").some((t) => t.includes("old finished")));
  // Body lines under an entry (bold, code, prose) never become titles.
  const entries = parseEntries(BUGS_MD, "Open");
  assert.equal(entries.length, 2);
  for (const e of entries) {
    assert.ok(!e.startsWith("**") && !e.includes("Symptom"));
  }
});

test("parseEntries handles a missing section and placeholder lines", () => {
  assert.deepEqual(parseEntries(PLANS_MD, "Backlog"), []);
  // _None yet._ placeholders are not headings — an empty seeded file yields no entries.
  const seeded = `# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n_None yet._\n`;
  assert.deepEqual(parseEntries(seeded, "Planned"), []);
});

test("plannedPlans reads PLANS.md fresh; missing file yields []", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "PLANS.md"), PLANS_MD);
  assert.equal(plannedPlans(root).length, 2);
  // A later edit is visible on the next read (no caching). The entry must land inside
  // Planned — appending to the file end would file it under Done.
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    PLANS_MD.replace("## Done", "### A brand new plan (planned 2026-08-25)\n\n## Done"),
  );
  assert.equal(plannedPlans(root)[2], "A brand new plan (planned 2026-08-25)");
  assert.deepEqual(plannedPlans(tmpdir()), []);
});

test("openBugs reads BUGS.md's Open section only; missing file yields []", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "BUGS.md"), BUGS_MD);
  assert.deepEqual(openBugs(root), [
    "gen / peak ctx columns should show the current or last run (reported 2026-08-25)",
    "Merge conflicts logged as warnings although they are normal operation (reported 2026-08-25)",
  ]);
  assert.deepEqual(openBugs(tmpdir()), []);
});

test("backlogLines renders subheaders with counts, entries in order", () => {
  assert.deepEqual(backlogLines(["plan A"], ["bug B"]), [
    "plans (1):",
    "plan A",
    "open bugs (1):",
    "bug B",
  ]);
});

test("backlogLines renders (none) under an empty section's subheader", () => {
  assert.deepEqual(backlogLines([], ["bug B"]), [
    "plans (0):",
    "(none)",
    "open bugs (1):",
    "bug B",
  ]);
  assert.deepEqual(backlogLines(["plan A"], []), [
    "plans (1):",
    "plan A",
    "open bugs (0):",
    "(none)",
  ]);
});

test("backlogLines with nothing at all is a single self-explanatory line", () => {
  assert.deepEqual(backlogLines([], []), ["(no planned features or open bugs)"]);
});
