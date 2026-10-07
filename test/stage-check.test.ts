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

// PLANS.md "Pre-queue self-check, part 2/2": the git-level path checks appended to
// stageCheckFindings. Each drives a scratch worktree with uncommitted edits; the function
// stages them itself.

test("a remaining reference to a renamed path yields the stale-reference finding", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "export const a = 1;\n",
    "README.md": "See src/a.ts for details.\n",
  });
  fs.mkdirSync(path.join(wt, "src", "x"), { recursive: true });
  fs.renameSync(path.join(wt, "src", "a.ts"), path.join(wt, "src", "x", "a.ts"));

  const findings = await stageCheckFindings(wt, "main", EXEMPT);

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /src\/a\.ts was renamed to src\/x\/a\.ts but is still named at: README\.md:\d+/);
});

test("updating the reference clears the stale-reference finding", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "export const a = 1;\n",
    "README.md": "See src/a.ts for details.\n",
  });
  fs.mkdirSync(path.join(wt, "src", "x"), { recursive: true });
  fs.renameSync(path.join(wt, "src", "a.ts"), path.join(wt, "src", "x", "a.ts"));
  fs.writeFileSync(path.join(wt, "README.md"), "See src/x/a.ts for details.\n");

  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT), []);
});

test("a reference to a rename's new path is not a stale reference to the old one", async () => {
  const { wt } = await repoWith({
    "config.ts": "export const config = 1;\n",
    "src/keep.ts": "export const keep = 1;\n",
    "README.md": "See src/config.ts for details.\n",
  });
  // A clean move of the root config.ts into src/ leaves README naming the new path; its
  // suffix must not be read as a stale reference to the old one.
  fs.renameSync(path.join(wt, "config.ts"), path.join(wt, "src", "config.ts"));

  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT), []);
});

test("a stale reference ending a sentence is still reported", async () => {
  const { wt } = await repoWith({
    "config.ts": "export const config = 1;\n",
    "src/keep.ts": "export const keep = 1;\n",
    "README.md": "Moved from config.ts.\n",
  });
  fs.renameSync(path.join(wt, "config.ts"), path.join(wt, "src", "config.ts"));

  const findings = await stageCheckFindings(wt, "main", EXEMPT);

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /config\.ts was renamed to src\/config\.ts but is still named at: README\.md:\d+/);
});

test("an added line naming a nonexistent path yields a finding", async () => {
  const { wt } = await repoWith({
    "src/keep.ts": "export const keep = 1;\n",
    "README.md": "Start.\n",
  });
  fs.writeFileSync(path.join(wt, "README.md"), "Start.\nSee src/x/src/x/a.ts.\n");

  const findings = await stageCheckFindings(wt, "main", EXEMPT);

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /added lines name paths that do not exist in the tree/);
  assert.match(findings[0]!, /src\/x\/src\/x\/a\.ts/);
});

test("a renamed-away path named as moved-from is not a nonexistent path", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "export const a = 1;\n",
    "src/x/keep.ts": "export const keep = 1;\n",
    "README.md": "Start.\n",
  });
  fs.renameSync(path.join(wt, "src", "a.ts"), path.join(wt, "src", "x", "a.ts"));
  fs.writeFileSync(path.join(wt, "README.md"), "Start.\nMoved src/a.ts to src/x/a.ts.\n");

  const findings = await stageCheckFindings(wt, "main", EXEMPT);

  // The moved-from mention is still a stale reference (check (a) reports every remaining
  // reference), but it must not be reported as a path that does not exist (check (b)).
  assert.deepEqual(findings.filter((f) => f.includes("do not exist")), []);
});

test("removing a file's final newline yields the finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;\n" });
  fs.writeFileSync(path.join(wt, "src/a.ts"), "export const a = 1;");

  const findings = await stageCheckFindings(wt, "main", EXEMPT);

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /removes the final newline from: src\/a\.ts/);
});

test("a file whose base already lacked a final newline yields no finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;" });
  fs.writeFileSync(path.join(wt, "src/a.ts"), "export const a = 2;");

  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT), []);
});

test("a new text file without a final newline yields the finding", async () => {
  const { wt } = await repoWith({ "README.md": "hi\n" });
  fs.mkdirSync(path.join(wt, "src"), { recursive: true });
  fs.writeFileSync(path.join(wt, "src", "new.ts"), "export const n = 1;");

  const findings = await stageCheckFindings(wt, "main", EXEMPT);

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /removes the final newline from: src\/new\.ts/);
});

test("a remaining reference to a deleted path yields the stale-reference finding", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "export const a = 1;\n",
    "README.md": "See src/a.ts for details.\n",
  });
  fs.rmSync(path.join(wt, "src", "a.ts"));

  const findings = await stageCheckFindings(wt, "main", EXEMPT);

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /src\/a\.ts was deleted but is still named at: README\.md:\d+/);
});

test("the git-level check leaves the index clean, so change detection still sees the worktree", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "export const a = 1;\n",
    "README.md": "See src/a.ts for details.\n",
  });
  fs.rmSync(path.join(wt, "src", "a.ts"));

  await stageCheckFindings(wt, "main", EXEMPT);

  assert.equal(sh(wt, "git", "diff", "--cached", "--name-only"), "", "nothing is left staged");
  assert.match(sh(wt, "git", "status", "--porcelain"), /src\/a\.ts/, "the worktree change remains");
});
