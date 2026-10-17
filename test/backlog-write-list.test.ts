import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { entryKey } from "../src/backlog/backlog-eligibility.js";
import { openBugs, plannedPlans, entryAgeSuffix } from "../src/backlog/backlog.js";
import { loadLoopState, saveLoopState } from "../src/loop/loop-state.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

// The list half (`tumwater plan/bug --list`): the numbered read counterpart of the
// --edit/--cancel writes, sharing one fixture shape (a plan blocked by a still-planned
// prerequisite, a bug held by a Refused note) so a printed position can be pinned against the
// entry the write half actually acts on.

/** A PLANS.md with two `## Planned` entries in one series: part 1 eligible, part 2 blocked by
 * the still-planned part 1 through its heading's `requires … landed` clause. */
function seededPlansForList(): string {
  return [
    "# Plans",
    "",
    "## Planned",
    "",
    "### Export series, part 1/2: add export (planned 2026-10-01)",
    "",
    "body one",
    "",
    "### Export series, part 2/2: add import (planned 2026-10-02) (requires Export series 1/2 landed)",
    "",
    "body two",
    "",
    "## Done",
    "",
    "_None yet._",
    "",
  ].join("\n");
}

/** A BUGS.md with two `## Open` entries: position 1 is held by a Refused note, position 2 is
 * eligible. */
function seededBugsForList(): string {
  return [
    "# Bugs",
    "",
    "## Open",
    "",
    "### held bug (reported by the operator 2026-10-01)",
    "",
    "**Refused 2026-10-01 by bugfix: not reproducible.**",
    "",
    "### open bug (reported by the operator 2026-10-02)",
    "",
    "body two",
    "",
    "## Fixed",
    "",
    "_None yet._",
    "",
  ].join("\n");
}

test("plan --list prints the Planned entries numbered with their eligibility marks and age", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), seededPlansForList());
  const r = await cli(repo, "plan", "--list");
  assert.equal(r.code, 0);
  const p1 = "Export series, part 1/2: add export (planned 2026-10-01)";
  const p2 = "Export series, part 2/2: add import (planned 2026-10-02) (requires Export series 1/2 landed)";
  assert.equal(
    r.stdout,
    [
      "planned features in PLANS.md:",
      `1. ${p1}${entryAgeSuffix(p1)}`,
      `2. ${p2} [blocked: requires Export series 1/2]${entryAgeSuffix(p2)}`,
      "",
    ].join("\n"),
  );
});

test("bug --list prints the Open entries numbered with their eligibility marks and age", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "BUGS.md"), seededBugsForList());
  const r = await cli(repo, "bug", "--list");
  assert.equal(r.code, 0);
  const b1 = "held bug (reported by the operator 2026-10-01)";
  const b2 = "open bug (reported by the operator 2026-10-02)";
  assert.equal(
    r.stdout,
    [
      "open bugs in BUGS.md:",
      `1. ${b1} [blocked: refused]${entryAgeSuffix(b1)}`,
      `2. ${b2}${entryAgeSuffix(b2)}`,
      "",
    ].join("\n"),
  );
});

test("plan/bug --list --json carries positions, verbatim bodies, and holds", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), seededPlansForList());
  fs.writeFileSync(path.join(repo, "BUGS.md"), seededBugsForList());
  const plans = JSON.parse((await cli(repo, "plan", "--list", "--json")).stdout) as {
    entries: { position: number; title: string; body: string; hold: unknown }[];
  };
  assert.deepEqual(plans.entries.map((e) => e.position), [1, 2]);
  assert.equal(plans.entries[0]!.title, "Export series, part 1/2: add export (planned 2026-10-01)");
  assert.equal(plans.entries[0]!.body, "body one");
  assert.equal(plans.entries[0]!.hold, null);
  assert.equal(plans.entries[1]!.body, "body two");
  assert.deepEqual(plans.entries[1]!.hold, { blockedBy: ["Export series 1/2"] });
  const bugs = JSON.parse((await cli(repo, "bug", "--list", "--json")).stdout) as {
    entries: { position: number; title: string; body: string; hold: unknown }[];
  };
  assert.deepEqual(bugs.entries.map((e) => e.position), [1, 2]);
  assert.equal(bugs.entries[0]!.title, "held bug (reported by the operator 2026-10-01)");
  assert.equal(bugs.entries[0]!.hold, "refused");
  assert.equal(bugs.entries[1]!.hold, null);
});

test("a --list position is the entry --cancel and --edit act on", async () => {
  const repo = makeRepo();
  await initProject(repo, "list position cancel edit");
  fs.writeFileSync(path.join(repo, "PLANS.md"), seededPlansForList());
  // Position 2 is the blocked part 2; --cancel 2 removes exactly it.
  const cancelled = await cli(repo, "plan", "--cancel", "2");
  assert.equal(cancelled.code, 0);
  assert.match(cancelled.stdout, /cancelled plan in PLANS\.md: Export series, part 2\/2/);
  assert.deepEqual(plannedPlans(repo), ["Export series, part 1/2: add export (planned 2026-10-01)"]);
  // Position 1 is now the surviving part 1; --edit 1 rewrites it in place.
  const edited = await cli(repo, "plan", "--edit", "1", "Rewritten", "new body");
  assert.equal(edited.code, 0);
  const rewritten = "Rewritten (planned 2026-10-01)";
  assert.equal(
    (await cli(repo, "plan", "--list")).stdout,
    ["planned features in PLANS.md:", `1. ${rewritten}${entryAgeSuffix(rewritten)}`, ""].join("\n"),
  );
  // And for bugs: --cancel 2 removes the entry --list numbered 2.
  const brepo = makeRepo();
  await initProject(brepo, "list position bug cancel");
  fs.writeFileSync(path.join(brepo, "BUGS.md"), seededBugsForList());
  const bcancel = await cli(brepo, "bug", "--cancel", "2");
  assert.equal(bcancel.code, 0);
  assert.match(bcancel.stdout, /cancelled bug in BUGS\.md: open bug/);
  assert.deepEqual(openBugs(brepo), ["held bug (reported by the operator 2026-10-01)"]);
});

test("plan/bug --list prints the no-entries line for an empty or missing file", async () => {
  const repo = makeRepo();
  // Missing files: makeRepo seeds only seed.txt.
  assert.equal((await cli(repo, "plan", "--list")).stdout, "no planned features\n");
  assert.equal((await cli(repo, "bug", "--list")).stdout, "no open bugs\n");
  // Present but empty sections.
  fs.writeFileSync(
    path.join(repo, "PLANS.md"),
    ["# Plans", "", "## Planned", "", "_None yet._", "", "## Done", "", "_None yet._", ""].join("\n"),
  );
  fs.writeFileSync(
    path.join(repo, "BUGS.md"),
    ["# Bugs", "", "## Open", "", "_None yet._", "", "## Fixed", "", "_None yet._", ""].join("\n"),
  );
  assert.equal((await cli(repo, "plan", "--list")).stdout, "no planned features\n");
  assert.equal((await cli(repo, "bug", "--list")).stdout, "no open bugs\n");
  // --json still prints the document, with an empty entries array.
  const r = await cli(repo, "plan", "--list", "--json");
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { entries: [] });
});

test("plan --list refuses a positional, an unknown flag, and repeated flags", async () => {
  const repo = makeRepo();
  let r = await cli(repo, "plan", "--list", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater plan takes no arguments/);
  r = await cli(repo, "plan", "--list", "--bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /takes no arguments \(got "--bogus"\)/);
  r = await cli(repo, "plan", "--list", "--list");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--list may only be given once/);
  r = await cli(repo, "bug", "--list", "--json", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json may only be given once/);
});

test("help topics name the --list forms", async () => {
  const repo = makeRepo();
  let r = await cli(repo, "help", "bug");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /tumwater bug --list \[--json\]/);
  r = await cli(repo, "help", "plan");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /tumwater plan --list \[--json\]/);
  assert.match(r.stdout, /tumwater plan --list --done/);
  r = await cli(repo, "help", "bug");
  assert.match(r.stdout, /tumwater bug --list --done/);
});

test("plan --list --done lists the newest done plans, and bug --list --done an empty Fixed", async () => {
  const repo = makeRepo();
  const done = Array.from({ length: 12 }, (_, i) => `### Done ${i + 1} (done 2026-10-${String(i + 1).padStart(2, "0")})\n`);
  fs.writeFileSync(
    path.join(repo, "PLANS.md"),
    `# Plans\n\n## Planned\n\n### Still planned\n\n## Done\n\n${done.join("\n")}`,
  );
  let r = await cli(repo, "plan", "--list", "--done");
  assert.equal(r.code, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines[0], "done plans in PLANS.md, newest first:");
  assert.equal(lines[1], "1. Done 1 (done 2026-10-01)");
  assert.equal(lines[10], "10. Done 10 (done 2026-10-10)");
  assert.equal(lines[11], "(2 older; -n 12 shows more)");
  assert.doesNotMatch(r.stdout, /Still planned/);
  r = await cli(repo, "plan", "--list", "--done", "-n", "12");
  assert.doesNotMatch(r.stdout, /older/);
  assert.match(r.stdout, /Done 12/);
  r = await cli(repo, "plan", "--list", "--done", "--json");
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.entries.length, 10);
  assert.equal(doc.older, 2);
  assert.equal(doc.entries[0].completedOn, "2026-10-01");
  fs.writeFileSync(path.join(repo, "BUGS.md"), "# Bugs\n\n## Open\n\n## Fixed\n\n_None yet._\n");
  assert.equal((await cli(repo, "bug", "--list", "--done")).stdout, "no fixed bugs\n");
});

test("--list -n needs --done, and --done refuses repeats and stands only with --list", async () => {
  const repo = makeRepo();
  let r = await cli(repo, "plan", "--list", "-n", "3");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /-n needs --done/);
  r = await cli(repo, "plan", "--list", "--done", "--done");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--done may only be given once/);
  r = await cli(repo, "plan", "--done");
  assert.equal(r.code, 1);
});


test("plan --list marks the entry a role is working on, and --json carries inProgress", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), seededPlansForList());
  const p1 = "Export series, part 1/2: add export (planned 2026-10-01)";
  saveLoopState(repo, {
    ...loadLoopState(repo, "feature-2"),
    claim: { file: "PLANS.md", key: entryKey(p1), title: p1, at: 1, source: "assigned" },
  });
  const r = await cli(repo, "plan", "--list");
  assert.ok(r.stdout.includes(`1. ${p1} [working on it: feature #2]${entryAgeSuffix(p1)}`), r.stdout);
  const j = JSON.parse((await cli(repo, "plan", "--list", "--json")).stdout) as {
    entries: { inProgress: string | null }[];
  };
  assert.deepEqual(j.entries.map((e) => e.inProgress), ["feature-2", null]);
});

test("plan --list shows a blocked series as one line with its positions", async () => {
  const repo = makeRepo();
  fs.writeFileSync(
    path.join(repo, "PLANS.md"),
    [
      "# Plans",
      "",
      "## Planned",
      "",
      "### Unrelated plan (planned 2026-10-01)",
      "",
      "b",
      "",
      "### S, part 1/3: one (planned 2026-10-01)",
      "",
      "b",
      "",
      "### S, part 2/3: two (planned 2026-10-01) (requires S 1/3 landed)",
      "",
      "b",
      "",
      "### S, part 3/3: three (planned 2026-10-01) (requires S 2/3 landed)",
      "",
      "b",
      "",
      "### Final plan (planned 2026-10-01)",
      "",
      "b",
      "",
      "## Done",
      "",
      "_None yet._",
      "",
    ].join("\n"),
  );
  const r = await cli(repo, "plan", "--list");
  assert.equal(r.code, 0);
  const lines = r.stdout.split("\n");
  assert.match(lines[1]!, /^1\. Unrelated plan/);
  assert.match(lines[2]!, /^2\. S, part 1\/3: one/);
  assert.equal(lines[3], "3–4. S, 2 blocked parts (2/3–3/3) [blocked: each waits on an earlier part]");
  assert.match(lines[4]!, /^5\. Final plan/);
  assert.equal(
    lines[5],
    "(each blocked series is one line; --show <n> prints a part, --json lists every entry)",
  );
  assert.match((await cli(repo, "plan", "--show", "4")).stdout, /S, part 3\/3: three/);
  const json = JSON.parse((await cli(repo, "plan", "--list", "--json")).stdout) as {
    entries: { position: number }[];
  };
  assert.deepEqual(json.entries.map((e) => e.position), [1, 2, 3, 4, 5]);
});
