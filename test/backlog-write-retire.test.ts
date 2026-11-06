import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { retirePlan } from "../src/backlog/backlog-write.js";
import { plannedPlans, donePlans } from "../src/backlog/backlog.js";
import { strandedPlanEntriesFor } from "../src/backlog/backlog-structure.js";
import { queuedRolePrompts } from "../src/inbox/inbox.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
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
