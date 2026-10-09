/** bootstrapStatus, bootstrapHoldsRole and pollBootstrapGate
 * (src/gates/bootstrap-gates.ts): the new-project bootstrap's verdict, hold set, completion
 * latch and one-shot event (plans/work-ratio.md, part 2/2). */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { defaultConfig } from "../src/config/config.js";
import {
  bootstrapHoldsRole,
  bootstrapStatus,
  newBootstrapGateState,
  pollBootstrapGate,
} from "../src/gates/bootstrap-gates.js";
import { bootstrapLatchPath } from "../src/paths.js";
import { readEvents } from "../src/events/event-read.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** A PLANS.md with `done` entries under `## Done` (and one Planned so the file reads real). */
function writePlans(root: string, done: string[], planned = ["A plan"]): void {
  const doneBlock = done.map((t) => `### ${t}\n\nbody\n`).join("\n");
  const plannedBlock = planned.map((t) => `### ${t}\n\nbody\n`).join("\n");
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    `# Plans\n\n## Planned\n\n${plannedBlock}\n## Done\n\n${doneBlock}`,
  );
}

function configWith(untilPlansDone?: number) {
  const c = defaultConfig();
  if (untilPlansDone !== undefined) c.bootstrap = { untilPlansDone };
  return c;
}

test("bootstrapStatus: null without bootstrap, active under the target, inactive at/after it", () => {
  const root = tmpdir("bootstrap-status-");
  writePlans(root, []);

  assert.equal(bootstrapStatus(root, defaultConfig()), null, "no bootstrap entry means inactive");

  const cfg = configWith(2);
  const active = bootstrapStatus(root, cfg);
  assert.deepEqual(
    { active: active?.active, plansDone: active?.plansDone, until: active?.untilPlansDone },
    { active: true, plansDone: 0, until: 2 },
  );

  writePlans(root, ["One done (done 2026-10-01)"]);
  assert.equal(bootstrapStatus(root, cfg)?.active, true, "one of two plans done is still active");

  writePlans(root, ["One done (done 2026-10-01)", "Two done (done 2026-10-02)"]);
  assert.equal(bootstrapStatus(root, cfg)?.active, false, "reaching the target ends bootstrap");
  assert.equal(fs.existsSync(bootstrapLatchPath(root)), false, "the read-only verdict writes nothing");
});

test("bootstrapHoldsRole: plan, feature and director never; bugfix only with no open bugs", () => {
  for (const role of ["plan", "feature", "feature-2", "director"]) {
    assert.equal(bootstrapHoldsRole(role, false), false, `${role} keeps ticking`);
  }
  assert.equal(bootstrapHoldsRole("bugfix", false), true, "bugfix is held while BUGS.md is empty");
  assert.equal(bootstrapHoldsRole("bugfix", true), false, "bugfix ticks once a bug is filed");
  assert.equal(bootstrapHoldsRole("clean", true), true, "maintenance stays held either way");
  assert.equal(bootstrapHoldsRole("clean-2", true), true, "instances follow their base role");
});

test("pollBootstrapGate: holds maintenance, admits the work roles and bugfix-with-bugs", () => {
  const root = tmpdir("bootstrap-hold-");
  writePlans(root, []);
  fs.writeFileSync(path.join(root, "BUGS.md"), "# Bugs\n\n## Open\n\n_None._\n");
  const state = newBootstrapGateState();
  const runners = ["plan", "feature", "director", "bugfix", "clean", "dry", "coverage"].map((role) => ({ role }));

  const held = pollBootstrapGate(root, state, runners, configWith(2), Date.now());
  assert.deepEqual(
    [...held].sort(),
    ["bugfix", "clean", "coverage", "dry"],
    "plan, feature and director tick; bugfix is held with no open bugs",
  );

  // A filed bug admits bugfix — the gate reads BUGS.md fresh each poll.
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "# Bugs\n\n## Open\n\n### Widget leaks (reported 2026-10-08)\n\nbody\n",
  );
  const withBug = pollBootstrapGate(root, state, runners, configWith(2), Date.now());
  assert.equal(withBug.has("bugfix"), false, "bugfix ticks once BUGS.md has an open entry");
  assert.equal(withBug.has("clean"), true, "the rest of maintenance stays held");
});

test("pollBootstrapGate: reaching the target latches, logs once, and lifts the hold for good", () => {
  const root = tmpdir("bootstrap-latch-");
  writePlans(root, ["One done (done 2026-10-01)"]);
  const cfg = configWith(2);
  const state = newBootstrapGateState();
  const runners = [{ role: "clean" }];

  assert.equal(pollBootstrapGate(root, state, runners, cfg, Date.now()).has("clean"), true);

  // The second plan lands: the next poll writes the latch, logs, and admits clean.
  writePlans(root, ["One done (done 2026-10-01)", "Two done (done 2026-10-02)"]);
  const completed = pollBootstrapGate(root, state, runners, cfg, Date.now());
  assert.equal(completed.has("clean"), false, "the completion poll lifts the hold");
  assert.equal(fs.existsSync(bootstrapLatchPath(root)), true, "the latch is written");
  const events = readEvents(root, 100).filter((e) => e.type === "bootstrap_complete");
  assert.equal(events.length, 1, "exactly one bootstrap_complete");
  assert.equal(events[0]!.loop, "harness");
  assert.equal(events[0]!.plansDone, 2);
  assert.equal(events[0]!.untilPlansDone, 2);

  // Compressing `## Done` back down must not re-enter bootstrap, and must not re-log.
  writePlans(root, []);
  assert.equal(pollBootstrapGate(root, state, runners, cfg, Date.now()).has("clean"), false, "the latch is permanent");
  assert.equal(
    readEvents(root, 100).filter((e) => e.type === "bootstrap_complete").length,
    1,
    "no second completion event",
  );
});

test("pollBootstrapGate: removing bootstrap from config lifts the hold without a latch", () => {
  const root = tmpdir("bootstrap-unset-");
  writePlans(root, []);
  const state = newBootstrapGateState();
  const runners = [{ role: "clean" }];

  assert.equal(pollBootstrapGate(root, state, runners, configWith(2), Date.now()).has("clean"), true);
  assert.equal(
    pollBootstrapGate(root, state, runners, defaultConfig(), Date.now()).has("clean"),
    false,
    "no bootstrap entry holds nothing",
  );
  assert.equal(fs.existsSync(bootstrapLatchPath(root)), false, "unsetting writes no latch");
});

test("pollBootstrapGate: an unwritable repo does not abort the completion poll", () => {
  const root = tmpdir("bootstrap-unwritable-");
  writePlans(root, ["One done (done 2026-10-01)", "Two done (done 2026-10-02)"]);
  const cfg = configWith(2);
  const state = newBootstrapGateState();
  // Put a regular file where `.tumwater` belongs: the latch write and the completion event
  // both fail (the latter with EISDIR-style ENOTDIR), so an unguarded writer or a raw
  // logEvent would end the orchestrator's catch-less loop. The poll must still lift the hold.
  const dir = path.dirname(bootstrapLatchPath(root));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, "not a directory\n");
  const held = pollBootstrapGate(root, state, [{ role: "clean" }], cfg, Date.now());
  assert.equal(held.has("clean"), false, "the completion poll lifts the hold despite the failed writes");
  assert.equal(state.active, false, "the gate state still records bootstrap as inactive");
});
