import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FINISHED_ARCHIVES } from "../src/backlog/backlog-md.js";
import { stageCheckFindings } from "../src/run/stage-check.js";
import { declaredNames } from "../src/run/stage-name-checks.js";
import {
  finishedDuplicateFindings,
  heldMovedFinding,
  planDependencyFinding,
  strayPlaceholderFinding,
  ungroundedRefusalFinding,
} from "../src/run/stage-backlog-checks.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

// Unit coverage for src/run/stage-check.ts (PLANS.md "Pre-queue self-check, part 1/2"):
// the merge gate's checks that still refuse a change run before a changed run commits, so the
// author's still-open session can fix a finding instead of a rejection discarding the work.
// These tests drive the real checks over a worktree with uncommitted edits.

const BUGS_BASE = `# Bugs

## Open

### A bug: details (found by qa 2026-09-30)

**Symptom:** it broke.
`;

/** A Fixed entry whose `**Fix:**` paragraph names `symbol` — the md-only false-fix fixture. */
function fixedBug(symbol: string): string {
  return `# Bugs

## Open

## Fixed

### A bug: details (found by qa 2026-09-30, fixed 2026-10-06)

**Fix:** \`${symbol}\` now does it.
`;
}

/** A repo whose main carries `files` (path → content), plus the improve worktree off main. */
async function repoWith(files: Record<string, string>): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  for (const [file, content] of Object.entries(files)) {
    writeFileDeep(path.join(root, file), content);
  }
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "base");
  const wt = await ensureWorktree(root, "improve", "main");
  return { root, wt };
}

test("an md-only false-fix edit no longer yields a staging finding", async () => {
  const { wt } = await repoWith({ "BUGS.md": BUGS_BASE });
  fs.writeFileSync(path.join(wt, "BUGS.md"), fixedBug("missingSymbolXyz"));

  // Since part 3m/3 a false fix claim is repairable by a later commit and reported by the main
  // watch on main's tip, so the stage self-check no longer spends the run's fix-up turn on it.
  assert.deepEqual(await stageCheckFindings(wt, "main", "feature"), []);
});

test("the same edit naming a symbol that exists on the tree yields no finding", async () => {
  const { wt } = await repoWith({ "BUGS.md": BUGS_BASE });
  fs.writeFileSync(path.join(wt, "BUGS.md"), fixedBug("seed.txt"));

  assert.deepEqual(await stageCheckFindings(wt, "main", "feature"), []);
});

test("a duplicated ## Done heading no longer yields a staging structure finding", async () => {
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

  const findings = await stageCheckFindings(wt, "main", "feature");

  // Since part 3m/3 a broken backlog structure is repairable by a later commit and reported by
  // the main watch on main's tip, so the stage self-check no longer spends the fix-up turn on it.
  assert.deepEqual(findings, []);
});

const X_PLAN = "X (planned 2026-10-18 by the plan role; done";
const doneMd = (...entries: string[]) => `# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n${entries.join("\n\n")}\n`;
const planEntry = (date: string, body: string) => `### ${X_PLAN} ${date} by the feature role)\n\n${body}`;

test("finishedDuplicateFindings flags a re-finished plan that the archive already holds under another done date", () => {
  const spec = FINISHED_ARCHIVES[0];
  const archived = doneMd(planEntry("2026-10-19", "Old body."));
  const empty = doneMd();
  const archive = { head: archived, base: archived };
  const found = finishedDuplicateFindings(spec, { head: doneMd(planEntry("2026-10-20", "New body.")), base: empty }, archive);
  assert.equal(found.length, 1);
  assert.match(found[0]!, /PLANS\.md's "## Done" entry "X .*" is already archived in PLANS-DONE\.md/);
  // The archived copy's exact heading and body is dropped by the sweep.
  assert.deepEqual(finishedDuplicateFindings(spec, { head: doneMd(planEntry("2026-10-19", "Old body.")), base: empty }, archive), []);
  // An entry the base already held under ## Done is not this change's.
  const had = doneMd(planEntry("2026-10-20", "New body."));
  assert.deepEqual(finishedDuplicateFindings(spec, { head: had, base: had }, archive), []);
});

test("finishedDuplicateFindings flags a second archive copy under a new stamp, and leaves an exact re-paste to the structure check", () => {
  const spec = FINISHED_ARCHIVES[0];
  const live = { head: doneMd(), base: doneMd() };
  const one = doneMd(planEntry("2026-10-19", "Body."));
  const two = doneMd(planEntry("2026-10-20", "Body."), planEntry("2026-10-19", "Body."));
  const found = finishedDuplicateFindings(spec, live, { head: two, base: one });
  assert.equal(found.length, 1);
  assert.match(found[0]!, /PLANS-DONE\.md holds "X .*" 2 times/);
  const repaste = doneMd(planEntry("2026-10-19", "Body."), planEntry("2026-10-19", "Body."));
  assert.deepEqual(finishedDuplicateFindings(spec, live, { head: repaste, base: one }), []);
  assert.deepEqual(finishedDuplicateFindings(spec, live, { head: two, base: two }), []);
});

test("finishedDuplicateFindings covers BUGS.md's ## Fixed against BUGS-FIXED.md", () => {
  const bug = (date: string) => `# Bugs\n\n## Open\n\n## Fixed\n\n### Y (found by the qa role 2026-10-18) — fixed ${date} by the bugfix role\n\nBody.\n`;
  const found = finishedDuplicateFindings(
    FINISHED_ARCHIVES[1],
    { head: bug("2026-10-20"), base: "" },
    { head: bug("2026-10-19"), base: bug("2026-10-19") },
  );
  assert.equal(found.length, 1);
  assert.match(found[0]!, /already archived in BUGS-FIXED\.md/);
});

test("a re-finished plan the archive already holds yields the finished-duplicate finding", async () => {
  const { wt } = await repoWith({
    "PLANS.md": doneMd(),
    "PLANS-DONE.md": doneMd(planEntry("2026-10-19", "Old body.")),
  });
  fs.writeFileSync(path.join(wt, "PLANS.md"), doneMd(planEntry("2026-10-20", "New body.")));

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /is already archived in PLANS-DONE\.md/);
});

test("a clean change yields no findings", async () => {
  const { wt } = await repoWith({ "BUGS.md": BUGS_BASE });
  fs.writeFileSync(
    path.join(wt, "BUGS.md"),
    BUGS_BASE + "\n### Another bug: details (found by qa 2026-10-06)\n\n**Symptom:** also broke.\n",
  );

  assert.deepEqual(await stageCheckFindings(wt, "main", "feature"), []);
});

test("a changed file still holding a conflict marker yields the conflict finding", async () => {
  const { wt } = await repoWith({ "a.txt": "base\n" });
  fs.writeFileSync(
    path.join(wt, "a.txt"),
    "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\nafter\n",
  );

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /conflict markers remain in: a\.txt/);
});

test("a git failure yields no findings instead of throwing", async () => {
  assert.deepEqual(await stageCheckFindings(tmpdir("stage-check-norepo-"), "main", "feature"), []);
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

  const findings = await stageCheckFindings(wt, "main", "feature");

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

  assert.deepEqual(await stageCheckFindings(wt, "main", "feature"), []);
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

  assert.deepEqual(await stageCheckFindings(wt, "main", "feature"), []);
});

test("a stale reference ending a sentence is still reported", async () => {
  const { wt } = await repoWith({
    "config.ts": "export const config = 1;\n",
    "src/keep.ts": "export const keep = 1;\n",
    "README.md": "Moved from config.ts.\n",
  });
  fs.renameSync(path.join(wt, "config.ts"), path.join(wt, "src", "config.ts"));

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /config\.ts was renamed to src\/config\.ts but is still named at: README\.md:\d+/);
});

// Record prose (the backlog files, their archives and plans/ design docs) names paths as they
// were or as a plan describes them, so the stale-reference scan skips it. On 2026-10-18 the scan
// listed a rename's own plan entry as stale; the author swept the backlog, turned the entry's
// "old → new" pairs into "new → new", and the reviewer rejected that.

test("a stale reference in record prose is not reported, while one in a doc still is", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "export const a = 1;\n",
    "README.md": "See src/a.ts for details.\n",
    "PLANS.md": "# Plans\n\n## Planned\n\n### Move a\n\nMove src/a.ts to src/x/a.ts.\n",
    "BUGS.md": "# Bugs\n\n## Open\n\n### A bug\n\nSeen in src/a.ts.\n",
    "BUGS-FIXED.md": "# Fixed bugs\n\n## Fixed\n\n### Old bug\n\n**Fix:** src/a.ts now does it.\n",
    "plans/design.md": "# Design\n\nsrc/a.ts holds the logic.\n",
  });
  fs.mkdirSync(path.join(wt, "src", "x"), { recursive: true });
  fs.renameSync(path.join(wt, "src", "a.ts"), path.join(wt, "src", "x", "a.ts"));

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /src\/a\.ts was renamed to src\/x\/a\.ts but is still named at: README\.md:\d+$/);
  for (const recordFile of ["PLANS.md", "BUGS.md", "BUGS-FIXED.md", "plans/design.md"]) {
    assert.ok(!findings[0]!.includes(`${recordFile}:`), `${recordFile} must not be listed`);
  }
});

test("a rename named only in record prose yields no stale-reference finding", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "export const a = 1;\n",
    "PLANS-DONE.md": "# Done plans\n\n## Done\n\n### Add a\n\nAdded src/a.ts.\n",
    "QUESTIONS.md": "# Questions\n\n## Open\n\n### Where does a live?\n\nIn src/a.ts?\n",
    "plans/design.md": "# Design\n\nsrc/a.ts holds the logic.\n",
  });
  fs.mkdirSync(path.join(wt, "src", "x"), { recursive: true });
  fs.renameSync(path.join(wt, "src", "a.ts"), path.join(wt, "src", "x", "a.ts"));

  assert.deepEqual(await stageCheckFindings(wt, "main", "feature"), []);
});

test("an added line naming a nonexistent path yields a finding", async () => {
  const { wt } = await repoWith({
    "src/keep.ts": "export const keep = 1;\n",
    "README.md": "Start.\n",
  });
  fs.writeFileSync(path.join(wt, "README.md"), "Start.\nSee src/x/src/x/a.ts.\n");

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /added lines name paths that do not exist in the tree/);
  assert.match(findings[0]!, /src\/x\/src\/x\/a\.ts/);
});

test("an added line in a test file naming a nonexistent path yields no finding", async () => {
  // Built from segments so this test source holds no literal path token for the stage check to
  // flag; the scratch worktree file the check reads still receives the real path.
  const keep = ["src", "keep.ts"].join("/");
  const testFile = ["test", "existing.test.ts"].join("/");
  const absent = ["src", "x", "src", "x", "a.ts"].join("/");
  const { wt } = await repoWith({
    [keep]: "export const keep = 1;\n",
    [testFile]: "export const x = 1;\n",
  });
  // Test fixtures routinely name paths from the software under test, which need not exist
  // here; the added-nonexistent-path heuristic is for real references, so it spares test/.
  fs.writeFileSync(
    path.join(wt, "test", "existing.test.ts"),
    `export const x = 1;\nconst f = "${absent}";\n`,
  );

  assert.deepEqual(await stageCheckFindings(wt, "main", "feature"), []);
});

test("an added line in a backlog prose file naming a nonexistent path yields no finding", async () => {
  // Planned features routinely name the file they will create, which is by definition absent
  // from the tree; the missing-path heuristic is for real references, so it spares the backlog
  // prose files. Built from segments so this test source holds no literal path token.
  const keep = ["src", "keep.ts"].join("/");
  const absent = ["src", "x", "src", "x", "a.ts"].join("/");
  const { wt } = await repoWith({
    [keep]: "export const keep = 1;\n",
    "PLANS.md": "Start.\n",
  });
  fs.writeFileSync(path.join(wt, "PLANS.md"), `Start.\nAdd a \`${absent}\` module.\n`);

  assert.deepEqual(await stageCheckFindings(wt, "main", "feature"), []);
});

test("an added line in a plans/ design doc naming a nonexistent path yields no finding", async () => {
  // A design doc names the files its plan will create, like a backlog entry does. Built from
  // segments so this test source holds no literal path token.
  const keep = ["src", "keep.ts"].join("/");
  const absent = ["src", "x", "src", "x", "a.ts"].join("/");
  const { wt } = await repoWith({
    [keep]: "export const keep = 1;\n",
    "plans/design.md": "Start.\n",
  });
  fs.writeFileSync(path.join(wt, "plans", "design.md"), `Start.\nAdd a \`${absent}\` module.\n`);

  assert.deepEqual(await stageCheckFindings(wt, "main", "feature"), []);
});

test("a source line naming the same absent path still yields the finding", async () => {
  const keep = ["src", "keep.ts"].join("/");
  const absent = ["src", "x", "src", "x", "a.ts"].join("/");
  const { wt } = await repoWith({
    [keep]: "export const keep = 1;\n",
    "PLANS.md": "Start.\n",
  });
  // The prose file is spared, but the same path named from a source file is still a real
  // reference and must keep the finding.
  fs.writeFileSync(path.join(wt, "PLANS.md"), `Start.\nAdd a \`${absent}\` module.\n`);
  fs.writeFileSync(path.join(wt, "src", "notes.ts"), `export const note = \"${absent}\";\n`);

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /added lines name paths that do not exist in the tree/);
  assert.ok(findings[0]!.includes(absent));
});

test("an added line outside test/ naming a nonexistent path still yields a finding", async () => {
  const keep = ["src", "keep.ts"].join("/");
  const testFile = ["test", "existing.test.ts"].join("/");
  const absent = ["src", "x", "src", "x", "a.ts"].join("/");
  const { wt } = await repoWith({
    [keep]: "export const keep = 1;\n",
    [testFile]: "export const x = 1;\n",
  });
  fs.writeFileSync(
    path.join(wt, "src", "notes.ts"),
    `export const note = "${absent}";\n`,
  );
  fs.writeFileSync(
    path.join(wt, "test", "existing.test.ts"),
    `export const x = 1;\nconst f = "${absent}";\n`,
  );

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /added lines name paths that do not exist in the tree/);
  assert.ok(findings[0]!.includes(absent));
});

test("a renamed-away path named as moved-from is not a nonexistent path", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "export const a = 1;\n",
    "src/x/keep.ts": "export const keep = 1;\n",
    "README.md": "Start.\n",
  });
  fs.renameSync(path.join(wt, "src", "a.ts"), path.join(wt, "src", "x", "a.ts"));
  fs.writeFileSync(path.join(wt, "README.md"), "Start.\nMoved src/a.ts to src/x/a.ts.\n");

  const findings = await stageCheckFindings(wt, "main", "feature");

  // The moved-from mention is still a stale reference (check (a) reports every remaining
  // reference), but it must not be reported as a path that does not exist (check (b)).
  assert.deepEqual(findings.filter((f) => f.includes("do not exist")), []);
});

test("removing a file's final newline yields the finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;\n" });
  fs.writeFileSync(path.join(wt, "src/a.ts"), "export const a = 1;");

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /removes the final newline from: src\/a\.ts/);
});

test("added lines with a broken participle yield the garbled-wording finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;\n" });
  fs.writeFileSync(
    path.join(wt, "src/a.ts"),
    "export const a = 1;\n// the role would have " + "ran twice\n// a never" + "-ran role\n",
  );

  const findings = (await stageCheckFindings(wt, "main", "feature")).filter((f) =>
    f.includes("garbled rename wording"),
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /src\/a\.ts:2/);
  assert.match(findings[0]!, /src\/a\.ts:3/);
});

test("added lines that stack run on run yield the garbled-wording finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;\n" });
  fs.mkdirSync(path.join(wt, "test"), { recursive: true });
  fs.writeFileSync(path.join(wt, "test/b.test.ts"), 'assert.ok(x, "no run was ' + 'running");\n');

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.ok(findings.some((f) => f.includes("garbled rename wording") && f.includes("test/b.test.ts:1")));
});

test("garbled wording in record prose, and a correct participle, yield no finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;\n", "PLANS.md": "# Plans\n" });
  fs.writeFileSync(path.join(wt, "PLANS.md"), "# Plans\nit would have " + "ran twice\n");
  fs.writeFileSync(
    path.join(wt, "src/a.ts"),
    "export const a = 1;\n// the role has run twice; it ran once today\n",
  );

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.deepEqual(findings.filter((f) => f.includes("garbled rename wording")), []);
});

test("garbled wording already on the base is not reported", async () => {
  const old = "// would have " + "ran\n";
  const { wt } = await repoWith({ "src/a.ts": old + "export const a = 1;\n" });
  fs.writeFileSync(path.join(wt, "src/a.ts"), old + "export const a = 2;\n");

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.deepEqual(findings.filter((f) => f.includes("garbled rename wording")), []);
});

test("a file whose base already lacked a final newline yields no finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;" });
  fs.writeFileSync(path.join(wt, "src/a.ts"), "export const a = 2;");

  assert.deepEqual(await stageCheckFindings(wt, "main", "feature"), []);
});

test("a new text file without a final newline yields the finding", async () => {
  const { wt } = await repoWith({ "README.md": "hi\n" });
  fs.mkdirSync(path.join(wt, "src"), { recursive: true });
  fs.writeFileSync(path.join(wt, "src", "new.ts"), "export const n = 1;");

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /removes the final newline from: src\/new\.ts/);
});

test("a remaining reference to a deleted path yields the stale-reference finding", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "export const a = 1;\n",
    "README.md": "See src/a.ts for details.\n",
  });
  fs.rmSync(path.join(wt, "src", "a.ts"));

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /src\/a\.ts was deleted but is still named at: README\.md:\d+/);
});

test("the git-level check leaves the index clean, so change detection still sees the worktree", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "export const a = 1;\n",
    "README.md": "See src/a.ts for details.\n",
  });
  fs.rmSync(path.join(wt, "src", "a.ts"));

  await stageCheckFindings(wt, "main", "feature");

  assert.equal(sh(wt, "git", "diff", "--cached", "--name-only"), "", "nothing is left staged");
  assert.match(sh(wt, "git", "status", "--porcelain"), /src\/a\.ts/, "the worktree change remains");
});

// BUGS.md 2026-10-12: an unassigned primary re-authored entries its siblings held. The held
// titles reach its prompt as advice; staging names a held entry the change moved anyway.
test("heldMovedFinding names a moved entry a sibling holds, and nothing otherwise", () => {
  const held = new Set(["alpha"]);
  const alpha = { key: "alpha", title: "Alpha (planned 2026-01-01 by operator)" };
  const beta = { key: "beta", title: "Beta (planned 2026-01-01 by operator)" };
  assert.match(
    heldMovedFinding(held, [beta, alpha]) ?? "",
    /moved a backlog entry another instance of this role is working on: "Alpha \(planned 2026-01-01 by operator\)".*revert every edit made for it/,
  );
  assert.equal(heldMovedFinding(held, [beta]), undefined, "a free entry is this run's to take");
  assert.equal(heldMovedFinding(held, []), undefined, "nothing moved");
  assert.equal(heldMovedFinding(new Set(), [alpha]), undefined, "nothing held");
});

test("an uncommitted PRINCIPLES.md edit is a finding for a non-steward role only", async () => {
  const { wt } = await repoWith({ "PRINCIPLES.md": "# P\n" });
  fs.writeFileSync(path.join(wt, "PRINCIPLES.md"), "# P\n- x\n");

  const findings = await stageCheckFindings(wt, "main", "feature");
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /PRINCIPLES\.md is edited by the feature role/);
  assert.deepEqual(await stageCheckFindings(wt, "main", "steward"), []);
});

test("an uncommitted file holding a secret env value is a finding", async () => {
  const { wt } = await repoWith({ "README.md": "# T\n" });
  fs.writeFileSync(path.join(wt, "report.json"), "{}");
  process.env.TUMWATER_TEST_FAKE_TOKEN = "tw-secret-value-0123456789";
  try {
    fs.writeFileSync(path.join(wt, "report.json"), `{"env":"${process.env.TUMWATER_TEST_FAKE_TOKEN}"}\n`);
    const findings = await stageCheckFindings(wt, "main", "feature");
    assert.equal(findings.length, 1, findings.join("\n"));
    assert.match(findings[0]!, /`report\.json` contains the value of \$TUMWATER_TEST_FAKE_TOKEN/);
  } finally {
    delete process.env.TUMWATER_TEST_FAKE_TOKEN;
  }
});

const DEP_BASE = `# Plans

## Planned

### S, part 1/2: a

body

### S, part 2/2: b (requires part 1/2 landed)

body

## Done

_None yet._
`;

test("planDependencyFinding reports only the requires-clause problems an edit adds", () => {
  assert.equal(planDependencyFinding(DEP_BASE, DEP_BASE), undefined);

  const dangling = DEP_BASE.replace("requires part 1/2 landed", "requires part 3/2 landed");
  const d = planDependencyFinding(dangling, DEP_BASE)!;
  assert.match(d, /S, part 2\/2: b/);
  assert.match(d, /S 3\/2/);

  const cyclic = DEP_BASE.replace("### S, part 1/2: a", "### S, part 1/2: a (requires part 2/2 landed)");
  const c = planDependencyFinding(cyclic, DEP_BASE)!;
  assert.ok(c.startsWith("PLANS.md's requires clauses now form a cycle"));
  assert.match(c, /S 1\/2/);
  assert.match(c, /S 2\/2/);

  const unparsed = DEP_BASE.replace("## Done", "### Other plan (requires nothing landed)\n\nbody\n\n## Done");
  assert.match(planDependencyFinding(unparsed, DEP_BASE)!, /"Other plan[^"]*".*names no part/);

  const misworded = DEP_BASE.replace("requires part 1/2 landed", "blocked by part 1/2");
  assert.match(planDependencyFinding(misworded, DEP_BASE)!, /names S 1\/2 as a prerequisite.*fix it before this change commits/);

  const edited = dangling.replace("body", "changed body");
  assert.equal(planDependencyFinding(edited, dangling), undefined);
});

test("a staged PLANS.md edit adding a dangling requires clause yields the dependency finding", async () => {
  const { wt } = await repoWith({ "PLANS.md": DEP_BASE });
  fs.writeFileSync(path.join(wt, "PLANS.md"), DEP_BASE.replace("requires part 1/2 landed", "requires part 3/2 landed"));

  const findings = await stageCheckFindings(wt, "main", "plan");

  assert.ok(findings.some((f) => f.includes("which no PLANS.md heading carries")), findings.join("\n"));
});

const bugsDoc = (open: string, fixed = "_None yet._"): string => {
  return `# Bugs\n\n## Open\n\n${open}\n## Fixed\n\n${fixed}\n`;
};

// Ungrounded-refusal check
// part instead of an objection to this entry spreads a refusal across a series (b9664a461).

const PLAN_DOC = (planned: string) => `# Plans\n\n## Planned\n\n${planned}\n## Done\n\n_None yet._\n`;
const part69 = (extra = "") => `### Codex backend, part 6/9: translator (planned 2026-10-20 by user)\n\n**Goal.** body.\n${extra}`;
const BAD_REFUSE = "**Refused 2026-10-21 by feature: re-authoring the Codex theme is directed not to happen — the feature run's refusal of part 2b/9 and this role's notes both record part 6/9 as abandoned; no consumer until part 7/9 lands behind unimplemented parts 4/9 and 5/9**";
const GOOD_REFUSE = "**Refused 2026-10-21 by feature: this entry grows complexity without justification and keeps fighting back**";

const PART6_BASE = PLAN_DOC(`${part69()}\n`);

test("ungroundedRefusalFinding flags a Refused note citing another part or a role's notes", () => {
  const head = PLAN_DOC(`${part69(BAD_REFUSE + "\n")}\n`);
  const f = ungroundedRefusalFinding("PLANS.md", head, PART6_BASE)!;
  assert.match(f, /Codex backend, part 6\/9/);
  assert.match(f, /do not refuse it/);
});

test("ungroundedRefusalFinding flags a cross-series part named without a comma", () => {
  const other = (extra = "") => `### Postgres, part 6/9: x (planned 2026-10-20 by user)\n\n**Goal.** b.\n${extra}`;
  const base = PLAN_DOC(`${other()}\n`);
  const head = PLAN_DOC(`${other("**Refused 2026-10-21 by feature: Codex part 6/9 is already abandoned**\n")}\n`);
  assert.match(ungroundedRefusalFinding("PLANS.md", head, base)!, /do not refuse it/);
});

test("ungroundedRefusalFinding flags a cross-series part named with comma and space", () => {
  const other = (extra = "") => `### Postgres, part 6/9: x (planned 2026-10-20 by user)\n\n**Goal.** b.\n${extra}`;
  const base = PLAN_DOC(`${other()}\n`);
  const head = PLAN_DOC(`${other("**Refused 2026-10-21 by feature: Codex, part 6/9 is already abandoned**\n")}\n`);
  assert.match(ungroundedRefusalFinding("PLANS.md", head, base)!, /do not refuse it/);
});

test("ungroundedRefusalFinding stays quiet for a grounded refusal that merely says notes", () => {
  const head = PLAN_DOC(`${part69(GOOD_REFUSE.replace("justification", "justification — note the duplicate is being removed") + "\n")}\n`);
  assert.equal(ungroundedRefusalFinding("PLANS.md", head, PART6_BASE), undefined);
});

test("ungroundedRefusalFinding stays quiet for a PRINCIPLES-grounded refusal and a pre-existing one", () => {
  const good = PLAN_DOC(`${part69(GOOD_REFUSE + "\n")}\n`);
  assert.equal(ungroundedRefusalFinding("PLANS.md", good, PART6_BASE), undefined);
  const already = PLAN_DOC(`${part69(BAD_REFUSE + "\n")}\n`);
  assert.equal(ungroundedRefusalFinding("PLANS.md", already, already), undefined);
});

test("ungroundedRefusalFinding names a BUGS.md bug and counts the others", () => {
  const bug = (t: string, extra = "") => `### ${t} (found by qa 2026-10-02)\n\n**Symptom:** broke.\n${extra}`;
  const bugs = (b: string) => bugsDoc(`${b}\n`);
  const refuse = (t: string) => `**Refused 2026-10-21 by feature: ${t}**`;
  const head = bugs(
    `${bug("Bug C: other", refuse("until part 7/9 lands") + "\n")}\n${bug("Bug D: twin", refuse("and this role's notes record it") + "\n")}\n`,
  );
  const f = ungroundedRefusalFinding("BUGS.md", head, bugs(`${bug("Bug C: other")}\n${bug("Bug D: twin")}\n`))!;
  assert.match(f, /Bug C/);
  assert.match(f, /1 more/);
});

test("stageCheckFindings flags a PLANS.md refusal citing another part, for any role", async () => {
  const { wt } = await repoWith({ "PLANS.md": PART6_BASE });
  fs.writeFileSync(path.join(wt, "PLANS.md"), PLAN_DOC(`${part69(BAD_REFUSE + "\n")}\n`));
  for (const role of ["feature", "bugfix"]) {
    const findings = await stageCheckFindings(wt, "main", role);
    assert.ok(findings.some((f) => f.includes("do not refuse it")), `${role}: ${findings.join("\n")}`);
  }
});

// Stale-name check: a removed compound identifier that a comment or doc still names.

test("a comment still naming a renamed function yields the stale-name finding", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "export function tickStartHeld() {}\n",
    "src/b.ts": "// see tickStartHeld\n",
  });
  fs.writeFileSync(path.join(wt, "src", "a.ts"), "export function runStartHeld() {}\n");

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /`tickStartHeld` was removed by this change but is still named at: src\/b\.ts:1/);

  fs.writeFileSync(path.join(wt, "src", "b.ts"), "// see runStartHeld\n");
  assert.deepEqual(await stageCheckFindings(wt, "main", "feature"), []);
});

test("a removed interface field still named in a doc yields the finding", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "export interface S {\n  abortedTicks: number;\n}\n",
    "README.md": "The abortedTicks field counts them.\n",
  });
  fs.writeFileSync(path.join(wt, "src", "a.ts"), "export interface S {\n  abortedRuns: number;\n}\n");

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /`abortedTicks` was removed .* README\.md:1/);
});

test("a removed name still declared elsewhere, quoted, marked retired-name-ok or in record prose yields no stale-name finding", async () => {
  const cases: Record<string, Record<string, string>> = {
    declared: { "src/b.ts": "export const tickStartHeld = 1;\n" },
    quoted: { "src/b.ts": 'const legacy = "tickStartHeld";\n' },
    marked: { "src/b.ts": "// tickStartHeld retired-name-ok: old name\n" },
    prose: { "PLANS.md": "# Plans\n\nThe tickStartHeld name.\n" },
  };
  for (const [label, extra] of Object.entries(cases)) {
    const { wt } = await repoWith({ "src/a.ts": "export function tickStartHeld() {}\n", ...extra });
    fs.writeFileSync(path.join(wt, "src", "a.ts"), "export function runStartHeld() {}\n");
    assert.deepEqual(await stageCheckFindings(wt, "main", "feature"), [], label);
  }
});

test("a removed single-word name is never a candidate", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "const status = 1;\n",
    "src/b.ts": "// the status of it\n",
  });
  fs.writeFileSync(path.join(wt, "src", "a.ts"), "const state = 1;\n");

  assert.deepEqual(await stageCheckFindings(wt, "main", "feature"), []);
});

test("declaredNames reads keyword and field declarations, not calls", () => {
  assert.deepEqual(declaredNames("export const FOO_BAR = 1;"), ["FOO_BAR"]);
  assert.deepEqual(declaredNames("async function fooBar(x) {"), ["fooBar"]);
  assert.deepEqual(declaredNames("interface FooBar {"), ["FooBar"]);
  assert.deepEqual(declaredNames("  readonly fooBar?: string;"), ["fooBar"]);
  assert.deepEqual(declaredNames("fooBar(x);"), []);
});

// PLANS.md "The pre-queue self-check flags a doc comment that the change detached from its
// declaration": the (e) check over the -U0 diff of JS/TS files.

const DOC_A = "/** Doc A. */\nexport function a() {}\n";
const DOC_ALIAS = "/** @deprecated Use b. */\nexport const old = b;\n\nexport function c() {}\n";
const INSERTED = "inserted between a doc comment";
const KEPT = "its doc comment was kept";

async function detachedFindings(files: Record<string, string>, edits: Record<string, string>): Promise<string[]> {
  const { wt } = await repoWith(files);
  for (const [file, content] of Object.entries(edits)) {
    writeFileDeep(path.join(wt, file), content);
  }
  return stageCheckFindings(wt, "main", "feature");
}

test("code inserted between a doc comment and its declaration yields the detached-doc finding", async () => {
  const findings = await detachedFindings(
    { "src/a.ts": DOC_A },
    { "src/a.ts": "/** Doc A. */\n\nfunction ins() {}\n\nexport function a() {}\n" },
  );
  const hits = findings.filter((f) => f.includes(INSERTED));

  assert.equal(hits.length, 1);
  assert.match(hits[0]!, /src\/a\.ts:1/);
});

test("a documented helper inserted under another doc also yields it", async () => {
  const findings = await detachedFindings(
    { "src/a.ts": DOC_A },
    { "src/a.ts": "/** Doc A. */\n\n/** Doc ins. */\nfunction ins() {}\n\nexport function a() {}\n" },
  );

  assert.match(findings.find((f) => f.includes(INSERTED)) ?? "", /src\/a\.ts:1/);
});

test("a deleted declaration whose doc comment stays yields the finding", async () => {
  const findings = await detachedFindings(
    { "test/f.ts": DOC_ALIAS },
    { "test/f.ts": "/** @deprecated Use b. */\n\nexport function c() {}\n" },
  );
  const hits = findings.filter((f) => f.includes(KEPT));

  assert.equal(hits.length, 1);
  assert.match(hits[0]!, /test\/f\.ts:1/);
});

test("deleting a declaration with its doc, adding a function after one, or editing one yields no detached-doc finding", async () => {
  const edits: [Record<string, string>, Record<string, string>][] = [
    [{ "test/f.ts": DOC_ALIAS }, { "test/f.ts": "\nexport function c() {}\n" }],
    [{ "src/a.ts": DOC_A }, { "src/a.ts": `${DOC_A}\n/** Doc z. */\nexport function z() {}\n` }],
    [{ "src/a.ts": DOC_A }, { "src/a.ts": "/** Doc A. */\nexport function a(x = 1) {}\n" }],
  ];
  for (const [base, head] of edits) {
    const findings = await detachedFindings(base, head);
    assert.deepEqual(findings.filter((f) => f.includes(INSERTED) || f.includes(KEPT)), []);
  }
});

test("a line comment inserted between a doc and its declaration yields no finding", async () => {
  const findings = await detachedFindings(
    { "src/a.ts": DOC_A },
    { "src/a.ts": "/** Doc A. */\n// eslint-disable-next-line no-console\nexport function a() {}\n" },
  );

  assert.deepEqual(findings.filter((f) => f.includes(INSERTED)), []);
});

test("a detached doc in a non-JS file is not reported", async () => {
  const findings = await detachedFindings(
    { "docs/a.md": DOC_A },
    { "docs/a.md": "/** Doc A. */\n\nfunction ins() {}\n\nexport function a() {}\n" },
  );

  assert.deepEqual(findings.filter((f) => f.includes(INSERTED) || f.includes(KEPT)), []);
});

// Moved-source check: a file that lost lines to another file and is still named elsewhere.
const MOVE_LINES = Array.from({ length: 12 }, (_, i) => `export const valueNumber${i} = ${i} * 1000;`);
const MOVE_BODY = `${MOVE_LINES.join("\n")}\n`;

async function movedFindings(
  base: Record<string, string>,
  head: Record<string, string | null>,
  keep = "lines moved to",
): Promise<string[]> {
  const { wt } = await repoWith(base);
  for (const [file, content] of Object.entries(head)) {
    const full = path.join(wt, file);
    if (content === null) {
      fs.rmSync(full);
      continue;
    }
    writeFileDeep(full, content);
  }
  return (await stageCheckFindings(wt, "main", "feature")).filter((f) => f.includes(keep));
}

const MOVE_BASE = { "src/big.ts": `export const keep = 1;\n${MOVE_BODY}`, "docs/x.md": "The bodies live in src/big.ts.\n" };

test("moving code out of a file that a doc still names yields the moved-source finding", async () => {
  const head = { "src/big.ts": "export const keep = 1;\n", "src/small.ts": MOVE_BODY };

  const findings = await movedFindings(MOVE_BASE, head);
  const fixed = await movedFindings(MOVE_BASE, { ...head, "docs/x.md": "The bodies live in src/small.ts.\n" });

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /src\/big\.ts had 12 lines moved to src\/small\.ts, but it is still named at: docs\/x\.md:1/);
  assert.deepEqual(fixed, []);
});

test("a reference inside the receiving file is reported too", async () => {
  const findings = await movedFindings(
    { "src/big.ts": MOVE_BASE["src/big.ts"] },
    { "src/big.ts": "export const keep = 1;\n", "src/small.ts": `// pinned in tests (src/big.ts)\n${MOVE_BODY}` },
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /src\/small\.ts:1/);
});

test("a move below the line threshold, a pure deletion, or a reference in record prose yields no moved-source finding", async () => {
  const partial = MOVE_LINES.slice(0, 5).join("\n") + "\n";
  const small = await movedFindings(MOVE_BASE, {
    "src/big.ts": `export const keep = 1;\n${MOVE_LINES.slice(5).join("\n")}\n`,
    "src/small.ts": partial,
  });
  const deleted = await movedFindings(MOVE_BASE, { "src/big.ts": "export const keep = 1;\n" });
  const prose = await movedFindings(
    { "src/big.ts": MOVE_BASE["src/big.ts"], "PLANS.md": "The bodies live in src/big.ts.\n" },
    { "src/big.ts": "export const keep = 1;\n", "src/small.ts": MOVE_BODY },
  );

  assert.deepEqual([small, deleted, prose], [[], [], []]);
});

test("archiving a backlog entry or moving a design-doc section is not a move source; a code move beside it still is", async () => {
  const entry = Array.from({ length: 12 }, (_, i) => `- Step ${i}: wire the finished part number ${i}.`).join("\n");
  const findings = await movedFindings(
    {
      ...MOVE_BASE,
      "PLANS.md": `# Plans\n\n### A plan\n\n${entry}\n`,
      "PLANS-DONE.md": "# Done plans\n",
      "plans/a.md": `# A\n\n${entry}\n`,
      "plans/b.md": "# B\n",
      "README.md": "Open work lives in PLANS.md; the design is in plans/a.md.\n",
    },
    {
      "PLANS.md": "# Plans\n",
      "PLANS-DONE.md": `# Done plans\n\n### A plan\n\n${entry}\n`,
      "plans/a.md": "# A\n",
      "plans/b.md": `# B\n\n${entry}\n`,
      "src/big.ts": "export const keep = 1;\n",
      "src/small.ts": MOVE_BODY,
    },
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /^src\/big\.ts had 12 lines moved to src\/small\.ts, but it is still named at: docs\/x\.md:1 /);
});

test("a basename-only reference is not reported", async () => {
  const findings = await movedFindings(
    { ...MOVE_BASE, "docs/x.md": "See big.ts.\n" },
    { "src/big.ts": "export const keep = 1;\n", "src/small.ts": MOVE_BODY },
  );

  assert.deepEqual(findings, []);
});

const movedNameOnly = (base: Record<string, string>, head: Record<string, string | null>): Promise<string[]> =>
  movedFindings(base, head, "still place it in");
const NAME_BASE = { "src/a.ts": "export function keepHere() {}\nexport function moveMe() {}\n" };
const NAME_HEAD = { "src/a.ts": "export function keepHere() {}\n", "src/b.ts": "export function moveMe() {}\n" };

test("a comment placing a moved function in its old file yields the moved-name finding", async () => {
  const findings = await movedNameOnly(
    { ...NAME_BASE, "src/c.ts": "// moveMe (src/a.ts) does it\n", "docs/x.md": "See `moveMe` in a.ts.\n" },
    NAME_HEAD,
  );
  const fixed = await movedNameOnly(
    { ...NAME_BASE, "src/c.ts": "// moveMe (src/a.ts) does it\n", "docs/x.md": "See `moveMe` in a.ts.\n" },
    { ...NAME_HEAD, "src/c.ts": "// moveMe (src/b.ts) does it\n", "docs/x.md": "See `moveMe` in b.ts.\n" },
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /`moveMe` moved from src\/a\.ts to src\/b\.ts, but docs\/x\.md:1, src\/c\.ts:1 still place it in a\.ts/);
  assert.deepEqual(fixed, []);
});

test("a moved name the old file still names, a comma-separated list, and record prose yield no moved-name finding", async () => {
  const kept = await movedNameOnly(
    { ...NAME_BASE, "src/c.ts": "// moveMe (src/a.ts) does it\n" },
    { ...NAME_HEAD, "src/a.ts": 'export function keepHere() {}\nexport { moveMe } from "./b.js";\n' },
  );
  const list = await movedNameOnly(
    { ...NAME_BASE, "src/c.ts": "// keepHere in src/a.ts, moveMe in src/b.ts\n" },
    NAME_HEAD,
  );
  const prose = await movedNameOnly({ ...NAME_BASE, "PLANS.md": "moveMe lived in src/a.ts\n" }, NAME_HEAD);

  assert.deepEqual([kept, list, prose], [[], [], []]);
});

test("strayPlaceholderFinding flags a placeholder added to a section that still holds entries", () => {
  const base = "# Plans\n\n## Planned\n\n### A\n\nBody.\n\n### B\n\nBody.\n\n## Done\n\n_None yet._\n";
  const head = base.replace("### B\n\nBody.\n\n", "_None yet._\n\n");

  assert.match(
    strayPlaceholderFinding("PLANS.md", head, base)!,
    /PLANS\.md's "## Planned" section holds 1 entry, but this change left the empty-section placeholder _None yet\._/,
  );
  assert.equal(strayPlaceholderFinding("PLANS.md", head, head), undefined);
  assert.equal(strayPlaceholderFinding("PLANS.md", "# Plans\n\n## Planned\n\n_None yet._\n", base), undefined);
  const fenced = "# Plans\n\n## Planned\n\n### A\n\n```\n_None yet._\n```\n";
  assert.equal(strayPlaceholderFinding("PLANS.md", fenced, base), undefined);
});

test("a placeholder added to a non-empty BUGS.md section yields the stray-placeholder finding", async () => {
  const { wt } = await repoWith({ "BUGS.md": "# Bugs\n\n## Open\n\n### One bug\n\nBody.\n" });
  fs.appendFileSync(path.join(wt, "BUGS.md"), "\n_None yet._\n");

  const findings = await stageCheckFindings(wt, "main", "docs");

  assert.equal(findings.filter((f) => f.includes("BUGS.md's \"## Open\" section holds 1 entry")).length, 1);
});

test("added lines that stack run on runs or running, or a run's run, yield the garbled-wording finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;\n" });
  fs.writeFileSync(
    path.join(wt, "src/a.ts"),
    "export const a = 1;\n" +
      "// while the role's next run" + " runs\n" +
      "// with no director run" + " running\n" +
      "// the authoring run's" + " run\n" +
      "// this run's pi" + " run\n" +
      "// across runs and" + " runs\n",
  );

  const findings = (await stageCheckFindings(wt, "main", "feature")).filter((f) =>
    f.includes("garbled rename wording"),
  );

  assert.equal(findings.length, 1);
  for (const n of [2, 3, 4, 5, 6]) assert.ok(findings[0]!.includes(`src/a.ts:${n} `), `line ${n}`);
});

test("a garbled phrase split across two added comment lines yields the garbled-wording finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;\n" });
  fs.writeFileSync(
    path.join(wt, "src/a.ts"),
    "export const a = 1;\n// the alert stays up while the role's next run" + "\n// runs and clears after\n",
  );

  const findings = (await stageCheckFindings(wt, "main", "feature")).filter((f) =>
    f.includes("garbled rename wording"),
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /src\/a\.ts:2-3/);
});

test("the prescribed agent-run wording yields no garbled-wording finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;\n" });
  fs.writeFileSync(
    path.join(wt, "src/a.ts"),
    "export const a = 1;\n// this run's agent run\n// the role has run twice; it ran once\n// a run, and then the next\n",
  );

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.deepEqual(findings.filter((f) => f.includes("garbled rename wording")), []);
});

test("added comment and doc lines with a doubled word yield the garbled-wording finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;\n" });
  fs.writeFileSync(
    path.join(wt, "src/a.ts"),
    "export const a = 1;\n// every idle role" + " role is waiting\nexport const b = 2; // the merge" + " merge resolver\n",
  );
  fs.mkdirSync(path.join(wt, "docs"), { recursive: true });
  fs.writeFileSync(path.join(wt, "docs/a.md"), "the role" + " role table\n");

  const findings = (await stageCheckFindings(wt, "main", "feature")).filter((f) =>
    f.includes("garbled rename wording"),
  );

  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes("src/a.ts:2 "));
  assert.ok(findings[0]!.includes("src/a.ts:3 "));
  assert.ok(findings[0]!.includes("docs/a.md:1 "));
});

test("a doubled word split across two added comment lines yields the garbled-wording finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;\n" });
  fs.writeFileSync(path.join(wt, "src/a.ts"), "export const a = 1;\n// the idle role" + "\n// role is waiting\n");

  const findings = (await stageCheckFindings(wt, "main", "feature")).filter((f) =>
    f.includes("garbled rename wording"),
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /src\/a\.ts:2-3/);
});

test("doubled words in code, in mixed case, after a hyphen, dot or slash, and that/had yield no garbled-wording finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;\n", "PLANS.md": "# Plans\n" });
  fs.writeFileSync(
    path.join(wt, "src/a.ts"),
    [
      "export const a = 1;",
      'export const cls = "btn btn-sm";',
      "// it printed [object Object] once",
      "// the team-wide wide-shallow alarm",
      "// the Readable.read read call",
      "// 40 chars/line line cap",
      "// so that that holds; it had had one",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(wt, "PLANS.md"), "the role" + " role\n");

  const findings = await stageCheckFindings(wt, "main", "feature");

  assert.deepEqual(findings.filter((f) => f.includes("garbled rename wording")), []);
});

test("a finished plan whose matches-nothing grep still matches yields the acceptance-grep finding", async () => {
  const entry = `### Rename it\n\n\`grep -rn oldName src\` ${"finds" + " nothing"}.`;
  const planned = "# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n";
  const { wt } = await repoWith({ "PLANS.md": planned + "_None yet._\n", "src/a.ts": "oldName\n" });
  fs.writeFileSync(path.join(wt, "PLANS.md"), `${planned}${entry}\n`);

  const findings = (await stageCheckFindings(wt, "main", "feature")).filter((f) => f.includes("src/a.ts:1"));

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /Rename it/);

  const held = await repoWith({ "PLANS.md": `${planned}${entry}\n`, "src/a.ts": "oldName\n" });
  fs.writeFileSync(path.join(held.wt, "PLANS.md"), `${planned}${entry}\n\nedited\n`);
  const again = await stageCheckFindings(held.wt, "main", "feature");
  assert.deepEqual(again.filter((f) => f.includes("src/a.ts:1")), []);
});
