import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { editBug, editPlan } from "../src/backlog/backlog-write.js";
import { openBugs, plannedPlans } from "../src/backlog/backlog.js";
import { queuedRolePrompts } from "../src/inbox/inbox.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { seededBugs } from "./fixtures/backlog-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

// The edit half (`tumwater bug/plan --edit <n>`): replace one operator-filed entry in place
// under the same primary-worktree lock, preserving its position and its original stamp.

test("editBug replaces a middle entry's title in place and keeps every other byte", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  const before = [
    "# Bugs",
    "",
    "## Open",
    "",
    "### first (reported by the user 2026-10-01)",
    "",
    "body one",
    "",
    "### second (reported by the user 2026-10-02)",
    "",
    "### third (reported by the user 2026-10-03)",
    "",
    "## Fixed",
    "",
    "_None yet._",
    "",
  ].join("\n");
  fs.writeFileSync(file, before);
  const edited = editBug(repo, 2, "the corrected symptom", 'tumwater bug "<symptom>"');
  assert.equal(edited.file, "BUGS.md");
  assert.equal(edited.title, "the corrected symptom");
  assert.equal(
    fs.readFileSync(file, "utf8"),
    before.replace(
      "### second (reported by the user 2026-10-02)",
      "### the corrected symptom (reported by the user 2026-10-02)",
    ),
  );
  assert.deepEqual(openBugs(repo), [
    "first (reported by the user 2026-10-01)",
    "the corrected symptom (reported by the user 2026-10-02)",
    "third (reported by the user 2026-10-03)",
  ]);
});

test("editBug replaces the first and the last entry, dropping a bug's stale body", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  fs.writeFileSync(file, seededBugs());
  editBug(repo, 1, "corrected first", 'tumwater bug "<symptom>"');
  // A bug has no body, so the rebuilt entry is its heading alone: the old body goes with it.
  assert.match(
    fs.readFileSync(file, "utf8"),
    /### corrected first \(reported by the user 2026-10-01\)\n\n### second /,
  );
  editBug(repo, 3, "corrected third", 'tumwater bug "<symptom>"');
  assert.deepEqual(openBugs(repo), [
    "corrected first (reported by the user 2026-10-01)",
    "second (reported by the user 2026-10-02)",
    "corrected third (reported by the user 2026-10-03)",
  ]);
});

test("editing an entry that quotes ## and ### inside a code fence replaces it whole", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  fs.writeFileSync(
    file,
    [
      "# Bugs",
      "",
      "## Open",
      "",
      "### fenced (reported by the user 2026-10-01)",
      "",
      "```",
      "## Fixed",
      "### not an entry",
      "```",
      "",
      "### after (reported by the user 2026-10-02)",
      "",
      "## Fixed",
      "",
      "_None yet._",
      "",
    ].join("\n"),
  );
  editBug(repo, 1, "replaced fenced", 'tumwater bug "<symptom>"');
  const md = fs.readFileSync(file, "utf8");
  assert.ok(!md.includes("### not an entry"), "the fence's quoted heading goes with the replaced entry");
  assert.match(md, /### replaced fenced \(reported by the user 2026-10-01\)\n\n### after /);
  assert.deepEqual(openBugs(repo), [
    "replaced fenced (reported by the user 2026-10-01)",
    "after (reported by the user 2026-10-02)",
  ]);
});

test("edit text quoting ## headings is folded to one line, never a phantom section", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  fs.writeFileSync(file, seededBugs());
  editBug(repo, 2, "quotes\n## Fixed\ninside", 'tumwater bug "<symptom>"');
  const md = fs.readFileSync(file, "utf8");
  assert.equal((md.match(/^## /gm) ?? []).length, 2); // ## Open and ## Fixed only.
  assert.match(openBugs(repo)[1]!, /^quotes ## Fixed inside \(reported by the user 2026-10-02\)$/);
});

test("editPlan replaces a plan's heading and body in place, keeping its stamp and position", () => {
  const repo = makeRepo();
  const file = path.join(repo, "PLANS.md");
  const before = [
    "# Plans",
    "",
    "## Planned",
    "",
    "### first (planned 2026-10-01)",
    "",
    "first body",
    "",
    "### second (reported by the user 2026-10-02)",
    "",
    "old body",
    "",
    "## Done",
    "",
    "_None yet._",
    "",
  ].join("\n");
  fs.writeFileSync(file, before);
  const edited = editPlan(repo, 2, "A corrected title", "corrected body text", 'tumwater plan "<title>" [body...]');
  assert.equal(edited.file, "PLANS.md");
  assert.equal(edited.title, "A corrected title");
  assert.equal(
    fs.readFileSync(file, "utf8"),
    before.replace(
      "### second (reported by the user 2026-10-02)\n\nold body",
      "### A corrected title (reported by the user 2026-10-02)\n\ncorrected body text",
    ),
  );
});

test("editPlan re-collapses a wrapped heading onto one line with its stamp intact", () => {
  const repo = makeRepo();
  const file = path.join(repo, "PLANS.md");
  fs.writeFileSync(
    file,
    [
      "# Plans",
      "",
      "## Planned",
      "",
      "### A wrapped heading (planned 2026-09-02,",
      "2026-09-03)",
      "",
      "old body",
      "",
      "## Done",
      "",
      "_None yet._",
      "",
    ].join("\n"),
  );
  editPlan(repo, 1, "A corrected wrapped heading", "new body", 'tumwater plan "<title>" [body...]');
  const md = fs.readFileSync(file, "utf8");
  assert.match(md, /### A corrected wrapped heading \(planned 2026-09-02, 2026-09-03\)\n\nnew body\n\n## Done\n/);
  assert.ok(!md.includes("\n2026-09-03)"), "the continuation line is folded into the heading");
});

test("editing an unstamped entry does not adopt a stamp-like parenthetical from its body", () => {
  // A heading that closes its parens has no wrapped metadata, so the body line after it is
  // body, not heading: the body's `(planned …)` must not be reattached as the edited
  // heading's stamp (BUGS.md 2026-10-09).
  const repo = makeRepo();
  const file = path.join(repo, "PLANS.md");
  fs.writeFileSync(
    file,
    [
      "# Plans",
      "",
      "## Planned",
      "",
      "### A plain title with no stamp",
      "",
      "Intro prose (planned 2026-01-02)",
      "",
      "more body",
      "",
      "## Done",
      "",
      "_None yet._",
      "",
    ].join("\n"),
  );
  editPlan(repo, 1, "A corrected plain title", "new body", 'tumwater plan "<title>" [body...]');
  const md = fs.readFileSync(file, "utf8");
  assert.match(md, /### A corrected plain title\n\nnew body\n\n## Done\n/);
  assert.ok(
    !md.includes("(planned 2026-01-02)"),
    "the body's parenthetical is not reattached as the heading's stamp",
  );
});

test("tumwater bug --edit replaces the entry, confirms, and wakes no loop", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug edit");
  await cli(repo, "bug", "first symptom");
  await cli(repo, "bug", "second symptom");
  const queuedBefore = queuedRolePrompts(repo, "bugfix").length;
  const r = await cli(repo, "bug", "--edit", "2", "the corrected symptom");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /edited bug in BUGS\.md: the corrected symptom/);
  assert.equal(queuedRolePrompts(repo, "bugfix").length, queuedBefore);
  const bugs = openBugs(repo);
  assert.equal(bugs.length, 2);
  assert.match(bugs[1]!, /^the corrected symptom \(reported by the user \d{4}-\d{2}-\d{2}\)$/);
});

test("tumwater plan --edit --json prints {file, title} and edits in place", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli plan edit json");
  await cli(repo, "plan", "Old title");
  const r = await cli(repo, "plan", "--edit", "1", "A corrected title", "corrected body", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { file: string; title: string };
  assert.equal(payload.file, "PLANS.md");
  assert.equal(payload.title, "A corrected title");
  const plans = plannedPlans(repo);
  assert.equal(plans.length, 1);
  assert.match(plans[0]!, /^A corrected title \(reported by the user \d{4}-\d{2}-\d{2}\)$/);
  assert.match(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), /corrected body/);
});

test("an out-of-range or empty edit fails non-zero and leaves the file byte-identical", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli edit failures");
  await cli(repo, "bug", "only symptom");
  const bugsBefore = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  const plansBefore = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  let r = await cli(repo, "bug", "--edit", "4", "corrected");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no open bug at position 4 \(1 in BUGS\.md\)/);
  assert.equal(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), bugsBefore);
  r = await cli(repo, "plan", "--edit", "1", "corrected");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no planned feature at position 1 \(0 in PLANS\.md\)/);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), plansBefore);
  r = await cli(repo, "bug", "--edit", "abc", "corrected");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--edit needs a positive integer/);
  r = await cli(repo, "bug", "--edit", "1", "");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /bug needs a symptom: tumwater bug "<symptom>"/);
  assert.equal(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), bugsBefore);
  r = await cli(repo, "plan", "--edit", "1", "");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /plan needs a title: tumwater plan "<title>"/);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), plansBefore);
  // `--edit <n>` with no text and no --file opens the editor; with none configured it refuses.
  r = await cli(repo, "bug", "--edit", "1");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no editor: set \$VISUAL or \$EDITOR/);
  assert.equal(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), bugsBefore);
});

test("help topics name the --edit forms", async () => {
  const repo = makeRepo();
  let r = await cli(repo, "help", "bug");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /tumwater bug --edit <n> "<symptom>" \[--json\]/);
  r = await cli(repo, "help", "plan");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /tumwater plan --edit <n> "<title>" \[body\.\.\.\] \[--json\]/);
  assert.match(r.stdout, /tumwater plan --edit <n> --file <path> \[--json\]/);
  r = await cli(repo, "help", "bug");
  assert.match(r.stdout, /tumwater bug --edit <n> --file <path> \[--json\]/);
});

const planSeed = [
  "# Plans",
  "",
  "## Planned",
  "",
  "### one (planned 2026-10-01)",
  "",
  "### two (planned 2026-10-02)",
  "",
  "old body",
  "",
  "### three (planned 2026-10-03)",
  "",
  "## Done",
  "",
  "_None yet._",
  "",
].join("\n");

test("plan --edit --file keeps lines, stamp and neighbours; no wake", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli plan edit file");
  const plans = path.join(repo, "PLANS.md");
  fs.writeFileSync(plans, planSeed);
  const md = path.join(repo, "e.md");
  fs.writeFileSync(md, "# New title\n\n- one\n\n- two\n");
  const r = await cli(repo, "plan", "--edit", "2", "--file", md);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /edited plan in PLANS\.md: New title/);
  const want = planSeed.replace("### two (planned 2026-10-02)\n\nold body", "### New title (planned 2026-10-02)\n\n- one\n\n- two");
  assert.equal(fs.readFileSync(plans, "utf8"), want);
  assert.deepEqual(queuedRolePrompts(repo, "feature"), []);
});

test("bug --edit --file writes the body; positional edit drops it", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug edit file");
  const bugs = path.join(repo, "BUGS.md");
  fs.writeFileSync(bugs, "# Bugs\n\n## Open\n\n### a (reported by the user 2026-10-01)\n\n## Fixed\n\n_None yet._\n");
  const md = path.join(repo, "e.md");
  fs.writeFileSync(md, "sym\nline1\nline2\n");
  const r = await cli(repo, "bug", "--edit", "1", "--file", md, "--json");
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { file: "BUGS.md", title: "sym" });
  assert.match(fs.readFileSync(bugs, "utf8"), /### sym \(reported by the user 2026-10-01\)\n\nline1\nline2\n/);
  assert.equal((await cli(repo, "bug", "--edit", "1", "x")).code, 0);
  const after = fs.readFileSync(bugs, "utf8");
  assert.match(after, /### x \(/);
  assert.doesNotMatch(after, /line1/);
});

test("plan --edit --file refusals leave PLANS.md untouched", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli plan edit file refuse");
  const plans = path.join(repo, "PLANS.md");
  fs.writeFileSync(plans, planSeed);
  const w = (name: string, text: string): string => {
    const f = path.join(repo, name);
    fs.writeFileSync(f, text);
    return f;
  };
  const good = w("good.md", "T\nbody\n");
  const cases: [string[], RegExp][] = [
    [["--edit", "2", "--file", w("h.md", "T\n\n## Heading\n")], /cannot be written/],
    [["--edit", "2", "--file", w("f.md", "T\n\n```\ncode\n")], /cannot be written/],
    [["--edit", "2", "--file", w("e.md", "   \n")], /./],
    [["--edit", "9", "--file", good], /./],
    [["--edit", "2", "--file", good, "extra"], /unexpected argument "extra"/],
    [["--edit", "2", "--file", good, "--file", good], /--file may only be given once/],
    [["--edit", "2", "--file"], /--file needs a path/],
  ];
  for (const [args, re] of cases) {
    const r = await cli(repo, "plan", ...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, re);
    assert.equal(fs.readFileSync(plans, "utf8"), planSeed, args.join(" "));
  }
});

