import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { openBugs, plannedPlans } from "../src/backlog/backlog.js";
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

test("plan --list prints the Planned entries numbered with their eligibility marks", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), seededPlansForList());
  const r = await cli(repo, "plan", "--list");
  assert.equal(r.code, 0);
  assert.equal(
    r.stdout,
    [
      "planned features in PLANS.md:",
      "1. Export series, part 1/2: add export (planned 2026-10-01)",
      "2. Export series, part 2/2: add import (planned 2026-10-02) (requires Export series 1/2 landed) [blocked: requires Export series 1/2]",
      "",
    ].join("\n"),
  );
});

test("bug --list prints the Open entries numbered with their eligibility marks", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "BUGS.md"), seededBugsForList());
  const r = await cli(repo, "bug", "--list");
  assert.equal(r.code, 0);
  assert.equal(
    r.stdout,
    [
      "open bugs in BUGS.md:",
      "1. held bug (reported by the operator 2026-10-01) [refused]",
      "2. open bug (reported by the operator 2026-10-02)",
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
  assert.equal(
    (await cli(repo, "plan", "--list")).stdout,
    ["planned features in PLANS.md:", "1. Rewritten (planned 2026-10-01)", ""].join("\n"),
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
});

