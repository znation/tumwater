import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { retireBug, retirePlan } from "../src/backlog/backlog-write.js";
import { fixedBugEntries, openBugs, plannedPlans, donePlans } from "../src/backlog/backlog.js";
import { strandedPlanEntriesFor } from "../src/backlog/backlog-structure.js";
import { queuedRolePrompts } from "../src/inbox/inbox.js";
import { makeRepo, sh } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

// The retirement half (`tumwater plan --retire <n>`): move one planned entry to ## Done as a
// retired record — closed without being built — keeping its body and adding the retired stamp
// and audit body line. The in-process tests pin the byte-level move and the no-reason/reason
// bodies; the CLI tests pin dispatch, the JSON payload, the no-wake rule and the refusals.

const TWO_PLANS = [
  "# Plans",
  "",
  "Intro line.",
  "",
  "## Planned",
  "",
  "### Alpha (planned 2026-11-01 by the plan role)",
  "",
  "body alpha",
  "",
  "### Beta (planned 2026-11-02 by the plan role)",
  "",
  "body beta",
  "",
  "## Done",
  "",
  "_None yet._",
  "",
].join("\n");

test("retirePlan moves the middle entry to ## Done as retired, keeping other bytes", () => {
  const repo = makeRepo();
  const file = path.join(repo, "PLANS.md");
  fs.writeFileSync(file, TWO_PLANS);
  const retired = retirePlan(repo, 2);
  assert.equal(retired.file, "PLANS.md");
  assert.equal(retired.title, "Beta");
  assert.match(retired.retiredOn, /^\d{4}-\d{2}-\d{2}$/);
  const md = fs.readFileSync(file, "utf8");
  // Alpha stays position 1 under ## Planned.
  assert.match(md, /## Planned\n\n### Alpha \(planned 2026-11-01 by the plan role\)\n\nbody alpha/);
  assert.ok(!md.includes("## Planned\n\n### Beta"), "Beta leaves ## Planned");
  // The retired copy lands first under ## Done with the stamp and audit line, the retirement
  // appended inside the planned parenthetical like the plan role's own retired records.
  assert.match(
    md,
    /## Done\n\n### Beta \(planned 2026-11-02 by the plan role, retired \d{4}-\d{2}-\d{2} by the user\)\n\n\*\*Retired \d{4}-\d{2}-\d{2} by the user\*\*\n\nbody beta\n/,
  );
  // The placeholder is dropped and a done plan reads it back.
  assert.ok(!md.includes("_None yet._"), "the Done placeholder is dropped");
  assert.deepEqual(plannedPlans(repo), ["Alpha (planned 2026-11-01 by the plan role)"]);
  assert.equal(donePlans(repo).length, 1);
});

test("retirePlan records the reason in the first body line, and Beta is not stranded", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), TWO_PLANS);
  retirePlan(repo, 2, "superseded by something");
  const md = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  assert.match(
    md,
    /\*\*Retired \d{4}-\d{2}-\d{2} by the user: superseded by something\*\*/,
  );
  // A retired ## Done entry is finished, not stranded: it sits under Done with a retired stamp.
  assert.deepEqual(strandedPlanEntriesFor(repo), []);
});

test("retirePlan removes the first and last entry", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), TWO_PLANS);
  retirePlan(repo, 1);
  assert.deepEqual(plannedPlans(repo), ["Beta (planned 2026-11-02 by the plan role)"]);
  const md = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  assert.match(md, /### Alpha \(planned 2026-11-01 by the plan role, retired \d{4}-\d{2}-\d{2} by the user\)/);
  // Position 2 of the now-one-entry ## Planned is Beta.
  retirePlan(repo, 1);
  assert.deepEqual(plannedPlans(repo), []);
  assert.equal(donePlans(repo).length, 2);
});

test("tumwater plan --retire prints the retirement and wakes no role", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli plan retire");
  await cli(repo, "bug", "a bug stays put");
  const bugBefore = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  await cli(repo, "plan", "Add an export command");
  await cli(repo, "plan", "Remove an export command");
  const queuedBefore = queuedRolePrompts(repo, "feature").length;
  const r = await cli(repo, "plan", "--retire", "1");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /retired plan in PLANS\.md: Add an export command/);
  assert.deepEqual(plannedPlans(repo).map((t) => t.replace(/ \(reported by the user.*/, "")), [
    "Remove an export command",
  ]);
  // No new prompt: retiring closes an entry without building it, so nothing wakes.
  assert.equal(queuedRolePrompts(repo, "feature").length, queuedBefore);
  // The bug file is untouched by a plan retire.
  assert.equal(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), bugBefore);
});

test("tumwater plan --retire --json prints {file, title, retiredOn} and a reason when given", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli plan retire json");
  await cli(repo, "plan", "First plan here");
  await cli(repo, "plan", "Second plan here");
  const r = await cli(repo, "plan", "--retire", "1", "--reason", "superseded by the second", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { file: string; title: string; retiredOn: string; reason: string };
  assert.equal(payload.file, "PLANS.md");
  assert.equal(payload.title, "First plan here");
  assert.match(payload.retiredOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(payload.reason, "superseded by the second");
  // No reason: the payload carries no reason key.
  const plain = await cli(repo, "plan", "--retire", "1", "--json");
  const payload2 = JSON.parse(plain.stdout) as Record<string, unknown>;
  assert.equal(payload2.reason, undefined);
  assert.equal(payload2.retiredOn, payload.retiredOn);
});

test("a malformed or repeated --retire/--reason flag is refused before any write", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli plan retire bad");
  await cli(repo, "plan", "A plan");
  const before = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  let r = await cli(repo, "plan", "--retire", "1", "--reason");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--reason needs a reason/);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), before);
  r = await cli(repo, "plan", "--retire", "1", "--reason", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /plan --retire --reason needs a value \(the next token "--json" is a flag, not a value\)/);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), before);
  r = await cli(repo, "plan", "--retire", "1", "--reason", "   ");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--reason needs a reason/);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), before);
  r = await cli(repo, "plan", "--retire", "1", "--reason", "a", "--reason", "b");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--reason may only be given once/);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), before);
  r = await cli(repo, "plan", "--retire", "1", "--retire", "1");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--retire may only be given once/);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), before);
  r = await cli(repo, "plan", "--retire", "1", "--bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater plan takes no arguments/);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), before);
});

test("tumwater plan --retire out of range fails with the cancel wording", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli plan retire oob");
  const before = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  const r = await cli(repo, "plan", "--retire", "1");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no planned feature at position 1 \(0 in PLANS\.md\)/);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), before);
});

test("tumwater plan --retire keeps its commit subject", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli plan retire subject");
  await cli(repo, "plan", "A plan to retire");
  const r = await cli(repo, "plan", "--retire", "1");
  assert.equal(r.code, 0);
  assert.equal(sh(repo, "git", "log", "-1", "--format=%s"), "tumwater(operator): Retire plan: A plan to retire");
});

const TWO_BUGS = [
  "# Bugs",
  "",
  "Intro line.",
  "",
  "## Open",
  "",
  "### Alpha (found by the qa role 2026-11-01)",
  "",
  "body alpha",
  "",
  "### Beta (found by the qa role 2026-11-02)",
  "",
  "body beta",
  "",
  "## Fixed",
  "",
  "_None yet._",
  "",
].join("\n");

test("retireBug moves the middle entry to ## Fixed as retired, keeping other bytes and PLANS.md", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  fs.writeFileSync(file, TWO_BUGS);
  fs.writeFileSync(path.join(repo, "PLANS.md"), TWO_PLANS);
  const plansBefore = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  const retired = retireBug(repo, 2);
  assert.equal(retired.file, "BUGS.md");
  assert.equal(retired.title, "Beta");
  assert.match(retired.retiredOn, /^\d{4}-\d{2}-\d{2}$/);
  const md = fs.readFileSync(file, "utf8");
  // Alpha stays position 1 under ## Open.
  assert.match(md, /## Open\n\n### Alpha \(found by the qa role 2026-11-01\)\n\nbody alpha/);
  assert.ok(!md.includes("## Open\n\n### Beta"), "Beta leaves ## Open");
  // The retired copy lands first under ## Fixed with the stamp and audit line, the retirement
  // appended inside the found-by parenthetical.
  assert.match(
    md,
    /## Fixed\n\n### Beta \(found by the qa role 2026-11-02, retired \d{4}-\d{2}-\d{2} by the user\)\n\n\*\*Retired \d{4}-\d{2}-\d{2} by the user\*\*\n\nbody beta\n/,
  );
  assert.ok(!md.includes("_None yet._"), "the Fixed placeholder is dropped");
  assert.deepEqual(openBugs(repo), ["Alpha (found by the qa role 2026-11-01)"]);
  assert.equal(fixedBugEntries(repo).length, 1);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), plansBefore);
});

test("retireBug records the reason in the first body line, and an unstamped heading gets a fresh parenthetical", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "BUGS.md"), TWO_BUGS);
  retireBug(repo, 1, "duplicate of anything");
  const md = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  assert.match(md, /\*\*Retired \d{4}-\d{2}-\d{2} by the user: duplicate of anything\*\*/);
  // A heading with no parenthetical stamp gets a fresh (retired …) parenthetical.
  fs.writeFileSync(
    path.join(repo, "BUGS.md"),
    ["# Bugs", "", "## Open", "", "### Unstamped bug", "", "body", "", "## Fixed", "", "_None yet._", ""].join("\n"),
  );
  retireBug(repo, 1);
  const md2 = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  assert.match(
    md2,
    /### Unstamped bug \(retired \d{4}-\d{2}-\d{2} by the user\)\n\n\*\*Retired \d{4}-\d{2}-\d{2} by the user\*\*/,
  );
});

test("tumwater bug --retire moves the Nth open bug to ## Fixed, wakes no role, and commits it", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug retire");
  await cli(repo, "bug", "Alpha bug stays");
  await cli(repo, "bug", "Beta bug retires");
  const plansBefore = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  const queuedBefore = queuedRolePrompts(repo, "bugfix").length;
  const r = await cli(repo, "bug", "--retire", "2", "--reason", "duplicate of Alpha bug");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /retired bug in BUGS\.md: Beta bug retires/);
  // No new prompt: retiring closes an entry without fixing it, so nothing wakes.
  assert.equal(queuedRolePrompts(repo, "bugfix").length, queuedBefore);
  // The plan file is untouched by a bug retire.
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), plansBefore);
  assert.equal(sh(repo, "git", "log", "-1", "--format=%s"), "tumwater(operator): Retire bug: Beta bug retires");
  // The open list no longer lists it; the fixed list lists it first.
  assert.deepEqual(openBugs(repo).map((t) => t.replace(/ \(reported by the user.*/, "")), ["Alpha bug stays"]);
  const open = await cli(repo, "bug", "--list");
  assert.equal(open.code, 0);
  assert.ok(!open.stdout.includes("Beta bug retires"));
  const fixed = await cli(repo, "bug", "--list", "--done");
  assert.equal(fixed.code, 0);
  assert.match(fixed.stdout, /Beta bug retires/);
});

test("tumwater bug --retire --json prints {file, title, retiredOn} and a reason when given", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug retire json");
  await cli(repo, "bug", "First bug");
  await cli(repo, "bug", "Second bug");
  const r = await cli(repo, "bug", "--retire", "1", "--reason", "superseded by the second", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { file: string; title: string; retiredOn: string; reason: string };
  assert.equal(payload.file, "BUGS.md");
  assert.equal(payload.title, "First bug");
  assert.match(payload.retiredOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(payload.reason, "superseded by the second");
  // No reason: the payload carries no reason key.
  const plain = await cli(repo, "bug", "--retire", "1", "--json");
  const payload2 = JSON.parse(plain.stdout) as Record<string, unknown>;
  assert.equal(payload2.reason, undefined);
  assert.equal(payload2.retiredOn, payload.retiredOn);
});

test("a malformed or repeated bug --retire/--reason flag is refused before any write", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug retire bad");
  await cli(repo, "bug", "A bug");
  const bugsBefore = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  const plansBefore = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  const unchanged = () => {
    assert.equal(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), bugsBefore);
    assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), plansBefore);
  };
  let r = await cli(repo, "bug", "--retire", "1", "--reason");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /bug --retire --reason needs a reason/);
  unchanged();
  r = await cli(repo, "bug", "--retire", "1", "--reason", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /bug --retire --reason needs a value \(the next token "--json" is a flag, not a value\)/);
  unchanged();
  r = await cli(repo, "bug", "--retire", "1", "--reason", "   ");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /bug --retire --reason needs a reason/);
  unchanged();
  r = await cli(repo, "bug", "--retire", "1", "--reason", "a", "--reason", "b");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--reason may only be given once/);
  unchanged();
  r = await cli(repo, "bug", "--retire", "1", "--retire", "1");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--retire may only be given once/);
  unchanged();
  r = await cli(repo, "bug", "--retire", "1", "--bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater bug takes no arguments/);
  unchanged();
  r = await cli(repo, "bug", "--retire", "1", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater bug takes no arguments/);
  unchanged();
  r = await cli(repo, "bug", "--retire");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--retire needs a position number \(e\.g\. `--retire 2`\)/);
  unchanged();
  r = await cli(repo, "bug", "--retire", "0");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--retire needs a positive integer/);
  unchanged();
  r = await cli(repo, "bug", "--retire", "abc");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--retire needs a positive integer/);
  unchanged();
  r = await cli(repo, "bug", "--retire", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no open bug at position 2 \(1 in BUGS\.md\)/);
  unchanged();
});
