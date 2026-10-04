import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { fileBug, filePlan } from "../src/backlog-write.js";
import { openBugs, plannedPlans } from "../src/backlog.js";
import { queuedRolePrompts } from "../src/inbox.js";
import { makeRepo } from "./repo-fixtures.js";
import { cli } from "./cli-harness.js";

// The operator-authored backlog writes (`tumwater bug` / `tumwater plan`): the appendEntry
// semantics (placement before the next `## ` heading, placeholder removal, missing-file
// seeding, fenced safety) in-process, plus the CLI smoke tests (confirmation, wake, --json,
// empty-argument failures, help topics) spawned through the CLI like the prompt queue's.

test("fileBug appends an operator-stamped entry to ## Open and the readers list it", async () => {
  const repo = makeRepo();
  await initProject(repo, "bug write test");
  const filed = fileBug(repo, "the config parser rejects empty values", 'tumwater bug "<symptom>"');
  const md = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  assert.match(md, /### the config parser rejects empty values \(reported by the operator \d{4}-\d{2}-\d{2}\)/);
  assert.equal(filed.file, "BUGS.md");
  assert.equal(filed.title, "the config parser rejects empty values");
  assert.match(filed.stamp, /^reported by the operator \d{4}-\d{2}-\d{2}$/);
  // Placement: the entry sits before ## Fixed.
  assert.ok(md.indexOf("### the config parser") < md.indexOf("## Fixed"));
  const expected = `the config parser rejects empty values (${filed.stamp})`;
  assert.deepEqual(openBugs(repo), [expected]);
});

test("a second filed bug lands after the first, and the _None yet._ placeholder goes", async () => {
  const repo = makeRepo();
  await initProject(repo, "bug write two");
  fileBug(repo, "first symptom", 'tumwater bug "<symptom>"');
  fileBug(repo, "second symptom", 'tumwater bug "<symptom>"');
  const md = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  assert.ok(!md.includes("_None yet._\n\n### first"), "placeholder must not sit above the first entry");
  const open = md.slice(md.indexOf("## Open"), md.indexOf("## Fixed"));
  assert.ok(open.indexOf("first symptom") < open.indexOf("second symptom"));
  // Only the Fixed section may still carry a placeholder.
  assert.ok(md.slice(md.indexOf("## Fixed")).includes("_None yet._"));
});

test("filePlan appends to ## Planned with the body as entry text", async () => {
  const repo = makeRepo();
  await initProject(repo, "plan write test");
  const filed = filePlan(repo, "Add an export command", "keep it JSON first", 'tumwater plan "<title>" [body...]');
  const md = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  assert.match(md, /### Add an export command \(reported by the operator \d{4}-\d{2}-\d{2}\)/);
  assert.match(md, /keep it JSON first/);
  assert.ok(md.indexOf("### Add an export command") < md.indexOf("## Done"));
  assert.equal(filed.file, "PLANS.md");
  assert.deepEqual(plannedPlans(repo)[0]!.startsWith("Add an export command"), true);
});

test("a missing BUGS.md/PLANS.md is seeded with the init scaffolding rather than failing", async () => {
  const repo = makeRepo();
  fileBug(repo, "symptom on a bare repo", 'tumwater bug "<symptom>"');
  filePlan(repo, "title on a bare repo", "", 'tumwater plan "<title>" [body...]');
  const bugs = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  const plans = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  assert.match(bugs, /^# Bugs\n/);
  assert.match(bugs, /## Open/);
  assert.match(bugs, /## Fixed/);
  assert.match(bugs, /### symptom on a bare repo/);
  assert.match(plans, /^# Plans\n/);
  assert.match(plans, /### title on a bare repo/);
});

test("a symptom whose text quotes markdown is folded to one line, never a phantom section", async () => {
  const repo = makeRepo();
  await initProject(repo, "bug write fold");
  fileBug(repo, "crashes on\n## Open\n fenced input", 'tumwater bug "<symptom>"');
  const md = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  assert.equal((md.match(/^## /gm) ?? []).length, 2); // ## Open and ## Fixed only.
  assert.equal(openBugs(repo).length, 1);
});

test("an entry's fenced block quoting ## headings does not end the section early", async () => {
  const repo = makeRepo();
  await initProject(repo, "bug write fence");
  fileBug(repo, "first symptom", 'tumwater bug "<symptom>"');
  const file = path.join(repo, "BUGS.md");
  const seeded = fs.readFileSync(file, "utf8");
  fs.writeFileSync(
    file,
    seeded.replace("### first symptom", '### first symptom\n\n```\n## Fixed\n```\n'),
  );
  fileBug(repo, "second symptom", 'tumwater bug "<symptom>"');
  const md = fs.readFileSync(file, "utf8");
  const open = md.slice(md.indexOf("## Open"));
  assert.ok(open.indexOf("second symptom") > open.indexOf("```"), "the entry must land after the quoted fence");
  assert.ok(open.indexOf("second symptom") < open.lastIndexOf("## Fixed"), "the quoted ## Fixed must not end ## Open");
});

test("tumwater bug files the entry, confirms, and wakes the bugfix loop", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug test");
  const r = await cli(repo, "bug", "the config parser rejects empty values");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /filed bug in BUGS\.md: the config parser rejects empty values/);
  const queued = queuedRolePrompts(repo, "bugfix");
  assert.equal(queued.length, 1);
  assert.match(queued[0]!, /Operator filed a new bug with `tumwater bug`/);
  assert.match(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), /### the config parser rejects empty values \(reported by the operator/);
});

test("tumwater plan files the entry and wakes the feature loop", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli plan test");
  const r = await cli(repo, "plan", "Add an export command", "keep", "it", "JSON", "first");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /filed plan in PLANS\.md: Add an export command/);
  const queued = queuedRolePrompts(repo, "feature");
  assert.equal(queued.length, 1);
  assert.match(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), /keep it JSON first/);
});

test("tumwater bug --json prints the {file, title, stamp} payload", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug json");
  const r = await cli(repo, "bug", "a symptom", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { file: string; title: string; stamp: string };
  assert.equal(payload.file, "BUGS.md");
  assert.equal(payload.title, "a symptom");
  assert.match(payload.stamp, /^reported by the operator \d{4}-\d{2}-\d{2}$/);
});

test("empty or missing arguments fail with the usage line and write nothing", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug empty");
  let r = await cli(repo, "bug");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater bug "<symptom>"/);
  r = await cli(repo, "plan");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater plan "<title>"/);
  r = await cli(repo, "bug", "   ");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /bug needs a symptom/);
  assert.match(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), /_None yet\._/);
  assert.equal(queuedRolePrompts(repo, "bugfix").length, 0);
  assert.equal(queuedRolePrompts(repo, "feature").length, 0);
});

test("help topics resolve for bug and plan", async () => {
  const repo = makeRepo();
  for (const [cmd, re] of [
    ["bug", /tumwater bug "<symptom>" \[--json\]/],
    ["plan", /tumwater plan "<title>" \[body\.\.\.\] \[--json\]/],
  ] as const) {
    const r = await cli(repo, "help", cmd);
    assert.equal(r.code, 0);
    assert.match(r.stdout, re);
  }
});