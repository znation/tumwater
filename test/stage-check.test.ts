import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stageCheckFindings } from "../src/tick/stage-check.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { makeRepo, sh, tmpdir } from "./repo-fixtures.js";

// Unit coverage for src/tick/stage-check.ts (PLANS.md "Pre-queue self-check, part 1/2"):
// the landing gate's deterministic backlog checks run before a changed tick commits, so the
// author's still-open session can fix a finding instead of a rejection discarding the work.
// These tests drive the real checks over a worktree with uncommitted edits.

const EXEMPT = ["*.md", "docs/**"];

const BUGS_BASE = `# Bugs

## Open

### A bug: details (found by qa 2026-09-30)

**Symptom:** it broke.
`;

/** A repo whose main carries `files` (path → content), plus the improve worktree off main. */
async function repoWith(files: Record<string, string>): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "base");
  const wt = await ensureWorktree(root, "improve", "main");
  return { root, wt };
}

test("an md-only false-fix edit yields its symbol finding", async () => {
  const { wt } = await repoWith({ "BUGS.md": BUGS_BASE });
  fs.writeFileSync(
    path.join(wt, "BUGS.md"),
    `# Bugs

## Open

## Fixed

### A bug: details (found by qa 2026-09-30, fixed 2026-10-06)

**Fix:** \`missingSymbolXyz\` now does it.
`,
  );

  const findings = await stageCheckFindings(wt, "main", EXEMPT);

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /none of the symbols its Fix paragraph names exist/);
  assert.match(findings[0]!, /missingSymbolXyz/);
});

test("the same edit naming a symbol that exists on the tree yields no finding", async () => {
  const { wt } = await repoWith({ "BUGS.md": BUGS_BASE });
  fs.writeFileSync(
    path.join(wt, "BUGS.md"),
    `# Bugs

## Open

## Fixed

### A bug: details (found by qa 2026-09-30, fixed 2026-10-06)

**Fix:** \`seed.txt\` now does it.
`,
  );

  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT), []);
});

test("the false-fix check is scoped to exempt diffs, as at the gate", async () => {
  const { wt } = await repoWith({ "BUGS.md": BUGS_BASE });
  fs.writeFileSync(
    path.join(wt, "BUGS.md"),
    `# Bugs

## Open

## Fixed

### A bug: details (found by qa 2026-09-30, fixed 2026-10-06)

**Fix:** \`missingSymbolXyz\` now does it.
`,
  );
  // An untracked code file makes the diff non-exempt, so falseFixReason is out of scope.
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");

  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT), []);
});

test("a duplicated ## Done heading yields the structure finding", async () => {
  const base = `# Plans

## Planned

_None yet._

## Done

_None yet._
`;
  const { wt } = await repoWith({ "PLANS.md": base });
  fs.writeFileSync(
    path.join(wt, "PLANS.md"),
    `# Plans

## Planned

_None yet._

## Done

_None yet._

## Done

_None yet._
`,
  );

  const findings = await stageCheckFindings(wt, "main", EXEMPT);

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /PLANS\.md adds another "## Done" heading/);
});

test("a clean change yields no findings", async () => {
  const { wt } = await repoWith({ "BUGS.md": BUGS_BASE });
  fs.writeFileSync(
    path.join(wt, "BUGS.md"),
    BUGS_BASE + "\n### Another bug: details (found by qa 2026-10-06)\n\n**Symptom:** also broke.\n",
  );

  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT), []);
});

test("a git failure yields no findings instead of throwing", async () => {
  assert.deepEqual(await stageCheckFindings(tmpdir("stage-check-norepo-"), "main", EXEMPT), []);
});
