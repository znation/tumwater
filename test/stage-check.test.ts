import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { heldMovedFinding, pathTokens, planDependencyFinding, stageCheckFindings, waitingNoteFinding } from "../src/tick/stage-check.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";

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
  fs.writeFileSync(path.join(wt, "BUGS.md"), fixedBug("missingSymbolXyz"));

  const findings = await stageCheckFindings(wt, "main", EXEMPT, "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /its Fix paragraph names code that exists nowhere on this tree/);
  assert.match(findings[0]!, /missingSymbolXyz/);
});

test("the same edit naming a symbol that exists on the tree yields no finding", async () => {
  const { wt } = await repoWith({ "BUGS.md": BUGS_BASE });
  fs.writeFileSync(path.join(wt, "BUGS.md"), fixedBug("seed.txt"));

  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT, "feature"), []);
});

test("the false-fix check is scoped to exempt diffs, as at the gate", async () => {
  const { wt } = await repoWith({ "BUGS.md": BUGS_BASE });
  fs.writeFileSync(path.join(wt, "BUGS.md"), fixedBug("missingSymbolXyz"));
  // An untracked code file makes the diff non-exempt, so falseFixReason is out of scope.
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");

  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT, "feature"), []);
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

  const findings = await stageCheckFindings(wt, "main", EXEMPT, "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /PLANS\.md adds another "## Done" heading/);
});

test("a clean change yields no findings", async () => {
  const { wt } = await repoWith({ "BUGS.md": BUGS_BASE });
  fs.writeFileSync(
    path.join(wt, "BUGS.md"),
    BUGS_BASE + "\n### Another bug: details (found by qa 2026-10-06)\n\n**Symptom:** also broke.\n",
  );

  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT, "feature"), []);
});

test("a changed file still holding a conflict marker yields the conflict finding", async () => {
  const { wt } = await repoWith({ "a.txt": "base\n" });
  fs.writeFileSync(
    path.join(wt, "a.txt"),
    "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\nafter\n",
  );

  const findings = await stageCheckFindings(wt, "main", EXEMPT, "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /conflict markers remain in: a\.txt/);
});

test("a git failure yields no findings instead of throwing", async () => {
  assert.deepEqual(await stageCheckFindings(tmpdir("stage-check-norepo-"), "main", EXEMPT, "feature"), []);
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

  const findings = await stageCheckFindings(wt, "main", EXEMPT, "feature");

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

  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT, "feature"), []);
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

  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT, "feature"), []);
});

test("a stale reference ending a sentence is still reported", async () => {
  const { wt } = await repoWith({
    "config.ts": "export const config = 1;\n",
    "src/keep.ts": "export const keep = 1;\n",
    "README.md": "Moved from config.ts.\n",
  });
  fs.renameSync(path.join(wt, "config.ts"), path.join(wt, "src", "config.ts"));

  const findings = await stageCheckFindings(wt, "main", EXEMPT, "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /config\.ts was renamed to src\/config\.ts but is still named at: README\.md:\d+/);
});

test("an added line naming a nonexistent path yields a finding", async () => {
  const { wt } = await repoWith({
    "src/keep.ts": "export const keep = 1;\n",
    "README.md": "Start.\n",
  });
  fs.writeFileSync(path.join(wt, "README.md"), "Start.\nSee src/x/src/x/a.ts.\n");

  const findings = await stageCheckFindings(wt, "main", EXEMPT, "feature");

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

  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT, "feature"), []);
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

  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT, "feature"), []);
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

  const findings = await stageCheckFindings(wt, "main", EXEMPT, "feature");

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

  const findings = await stageCheckFindings(wt, "main", EXEMPT, "feature");

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

  const findings = await stageCheckFindings(wt, "main", EXEMPT, "feature");

  // The moved-from mention is still a stale reference (check (a) reports every remaining
  // reference), but it must not be reported as a path that does not exist (check (b)).
  assert.deepEqual(findings.filter((f) => f.includes("do not exist")), []);
});

test("removing a file's final newline yields the finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;\n" });
  fs.writeFileSync(path.join(wt, "src/a.ts"), "export const a = 1;");

  const findings = await stageCheckFindings(wt, "main", EXEMPT, "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /removes the final newline from: src\/a\.ts/);
});

test("a file whose base already lacked a final newline yields no finding", async () => {
  const { wt } = await repoWith({ "src/a.ts": "export const a = 1;" });
  fs.writeFileSync(path.join(wt, "src/a.ts"), "export const a = 2;");

  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT, "feature"), []);
});

test("a new text file without a final newline yields the finding", async () => {
  const { wt } = await repoWith({ "README.md": "hi\n" });
  fs.mkdirSync(path.join(wt, "src"), { recursive: true });
  fs.writeFileSync(path.join(wt, "src", "new.ts"), "export const n = 1;");

  const findings = await stageCheckFindings(wt, "main", EXEMPT, "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /removes the final newline from: src\/new\.ts/);
});

test("a remaining reference to a deleted path yields the stale-reference finding", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "export const a = 1;\n",
    "README.md": "See src/a.ts for details.\n",
  });
  fs.rmSync(path.join(wt, "src", "a.ts"));

  const findings = await stageCheckFindings(wt, "main", EXEMPT, "feature");

  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /src\/a\.ts was deleted but is still named at: README\.md:\d+/);
});

test("the git-level check leaves the index clean, so change detection still sees the worktree", async () => {
  const { wt } = await repoWith({
    "src/a.ts": "export const a = 1;\n",
    "README.md": "See src/a.ts for details.\n",
  });
  fs.rmSync(path.join(wt, "src", "a.ts"));

  await stageCheckFindings(wt, "main", EXEMPT, "feature");

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
  assert.equal(heldMovedFinding(held, [beta]), undefined, "a free entry is this tick's to take");
  assert.equal(heldMovedFinding(held, []), undefined, "nothing moved");
  assert.equal(heldMovedFinding(new Set(), [alpha]), undefined, "nothing held");
});

test("an uncommitted PRINCIPLES.md edit is a finding for a non-steward role only", async () => {
  const { wt } = await repoWith({ "PRINCIPLES.md": "# P\n" });
  fs.writeFileSync(path.join(wt, "PRINCIPLES.md"), "# P\n- x\n");

  const findings = await stageCheckFindings(wt, "main", EXEMPT, "feature");
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /PRINCIPLES\.md is edited by the feature role/);
  assert.deepEqual(await stageCheckFindings(wt, "main", EXEMPT, "steward"), []);
});

test("an uncommitted file holding a secret env value is a finding", async () => {
  const { wt } = await repoWith({ "README.md": "# T\n" });
  fs.writeFileSync(path.join(wt, "report.json"), "{}");
  process.env.TUMWATER_TEST_FAKE_TOKEN = "tw-secret-value-0123456789";
  try {
    fs.writeFileSync(path.join(wt, "report.json"), `{"env":"${process.env.TUMWATER_TEST_FAKE_TOKEN}"}\n`);
    const findings = await stageCheckFindings(wt, "main", EXEMPT, "feature");
    assert.equal(findings.length, 1, findings.join("\n"));
    assert.match(findings[0]!, /`report\.json` contains the value of \$TUMWATER_TEST_FAKE_TOKEN/);
  } finally {
    delete process.env.TUMWATER_TEST_FAKE_TOKEN;
  }
});

test("pathTokens returns each distinct path-shaped token in order", () => {
  assert.deepEqual(pathTokens("see `src/a/b.ts`, src/a/b.ts and (test/c.test.ts)."), ["src/a/b.ts", "test/c.test.ts"]);
  assert.deepEqual(pathTokens("plain words"), []);
  assert.deepEqual(pathTokens("README.md"), []);
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

  const findings = await stageCheckFindings(wt, "main", EXEMPT, "plan");

  assert.ok(findings.some((f) => f.includes("which no PLANS.md heading carries")), findings.join("\n"));
});

const PROG_A = "- **Progress 2026-10-15 (bugfix):** no repro.";
const PROG_A2 = "- **Progress 2026-10-16 (bugfix, second):** still no repro.";

function bugsDoc(open: string, fixed = "_None yet._"): string {
  return `# Bugs\n\n## Open\n\n${open}\n## Fixed\n\n${fixed}\n`;
}
const entryA = (extra = "") => `### Bug A: flake (found by qa 2026-10-01)\n\n**Symptom:** it broke.\n${PROG_A}\n${extra}`;
const entryB = (extra = "") => `### Bug B: other (found by qa 2026-10-02)\n\n**Symptom:** broke too.\n${PROG_A}\n${extra}`;
const WAIT_BASE = bugsDoc(`${entryA()}\n${entryB()}\n`);

test("waitingNoteFinding asks for the Waiting note when a Progress note lands on a still-open bug", () => {
  const head = bugsDoc(`${entryA(PROG_A2 + "\n")}\n${entryB()}\n`);
  const f = waitingNoteFinding(head, WAIT_BASE);
  assert.match(f ?? "", /"Bug A: flake \(found by qa 2026-10-01\)"/);
  assert.match(f ?? "", /Waiting for the next failure/);
  assert.doesNotMatch(f ?? "", /more/);
});

test("waitingNoteFinding stays quiet when the hold, a refusal, or no Progress change is present", () => {
  const w = "**Waiting for the next failure 2026-10-16 by bugfix: x**";
  const r = "**Refused 2026-10-16 by bugfix: nope**";
  for (const extra of [`${PROG_A2}\n\n${w}\n`, `${PROG_A2}\n\n${r}\n`]) {
    assert.equal(waitingNoteFinding(bugsDoc(`${entryA(extra)}\n${entryB()}\n`), WAIT_BASE), undefined);
  }
  assert.equal(waitingNoteFinding(WAIT_BASE, WAIT_BASE), undefined);
  assert.equal(waitingNoteFinding(WAIT_BASE.replace("it broke.", "it broke badly."), WAIT_BASE), undefined);
});

test("waitingNoteFinding ignores a bug moved to Fixed and a newly filed bug", () => {
  const fixed = bugsDoc(`${entryB()}\n`, `### Bug A: flake (found by qa 2026-10-01, fixed 2026-10-16)\n\n${PROG_A}\n${PROG_A2}\n`);
  assert.equal(waitingNoteFinding(fixed, WAIT_BASE), undefined);
  const added = bugsDoc(`${entryA()}\n${entryB()}\n### Bug C: new (found by qa 2026-10-16)\n\n${PROG_A}\n`);
  assert.equal(waitingNoteFinding(added, WAIT_BASE), undefined);
});

test("waitingNoteFinding names the first bug and counts the others", () => {
  const head = bugsDoc(`${entryA(PROG_A2 + "\n")}\n${entryB(PROG_A2 + "\n")}\n`);
  const f = waitingNoteFinding(head, WAIT_BASE);
  assert.match(f ?? "", /"Bug A: flake/);
  assert.match(f ?? "", /1 more/);
});

test("stageCheckFindings asks only a bugfix role for the Waiting note", async () => {
  const { wt } = await repoWith({ "BUGS.md": WAIT_BASE });
  fs.writeFileSync(path.join(wt, "BUGS.md"), bugsDoc(`${entryA(PROG_A2 + "\n")}\n${entryB()}\n`));
  for (const role of ["bugfix", "bugfix-2"]) {
    const findings = await stageCheckFindings(wt, "main", EXEMPT, role);
    assert.ok(findings.some((f) => f.includes("Waiting for the next failure")), role);
  }
  const other = await stageCheckFindings(wt, "main", EXEMPT, "feature");
  assert.ok(!other.some((f) => f.includes("Waiting for the next failure")));
});
