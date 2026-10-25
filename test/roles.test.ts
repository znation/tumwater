import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFERRABLE_ROLES,
  DIRECTOR_ROLE,
  OBSERVER_ROLES,
  ROLES,
  allRoleIds,
  roleById,
  unknownRoleMessage,
} from "../src/roles/roles.js";
import { roleLabel } from "../src/roles/role-labels.js";

// role-catalog.ts is the single source of truth for which roles exist (roles.ts re-exports it).
// Its structural invariants are
// load-bearing but easy to break silently: a duplicated or empty id makes two roles share one
// worktree/branch/state file; a reordered catalog changes startup-burst scheduling priority;
// and an observer/deferrable set drifting from the catalog (a typo'd id, or a new role added
// without updating the set) disables scheduling carve-out with no error anywhere.
// prompt.test.ts pins each role's find-text content; these tests pin the
// catalog's shape and its consistency with the derived exports.

test("every catalog role has a unique, non-empty id, title, and find text", () => {
  const ids = ROLES.map((r) => r.id);
  for (const role of ROLES) {
    assert.ok(role.id.length > 0, "role id is non-empty");
    // Ids are spliced into .tumwater/worktrees/<id>, branch tumwater/<id>, and log file
    // names — whitespace or a slash would break the path or split the branch ref.
    assert.match(role.id, /^[^\s/]+$/, `role id ${JSON.stringify(role.id)} is a safe name`);
    assert.ok(role.title.trim().length > 0, `${role.id} has a title`);
    assert.ok(role.find.trim().length > 0, `${role.id} has find instructions`);
  }
  // Ids derive .tumwater/worktrees/<id>, branch tumwater/<id>, state and log file names —
  // a duplicate would make two roles clobber each other's persistent state.
  assert.equal(new Set(ids).size, ids.length, "role ids are unique");
});

test("catalog order is scheduling priority: shipping work outranks hygiene", () => {
  // The orchestrator starts roles in catalog order (the startup burst), so the head of ROLES
  // decides which roles get their first run when everything wakes at once.
  assert.ok(ROLES.length >= 2, "catalog has at least the two shipping roles");
  assert.equal(ROLES[0]!.id, "feature");
  assert.equal(ROLES[1]!.id, "bugfix");
});

test("OBSERVER_ROLES are catalog roles excluded from DEFERRABLE_ROLES", () => {
  // plans/observer-roles.md 1/2: observers schedule on their interval rather than the idle
  // ladder, so they must not also be deferrable — the two carve roles by the same charter.
  assert.ok(OBSERVER_ROLES.size > 0, "at least one observer (qa, selfcheck, feedback) is defined");
  // All observers ship an observation rather than a commit and so must never defer.
  assert.ok(
    OBSERVER_ROLES.has("qa") && OBSERVER_ROLES.has("selfcheck") && OBSERVER_ROLES.has("feedback"),
    "qa, selfcheck and feedback are observers",
  );
  for (const id of OBSERVER_ROLES) {
    assert.ok(roleById(id), `observer ${JSON.stringify(id)} exists in the catalog`);
    assert.ok(!DEFERRABLE_ROLES.has(id), `${id} is an observer, so it never defers`);
  }
});

test("the ci role exists after qa, is an observer, and is blocked by nothing", () => {
  // A ci role runs the CI workflow's own jobs at main's tip (part 1/3): its no_change means
  // "checked, green", so it schedules on the observer interval and never defers; it authors
  // code fixes, so it carries no baseline block (part 2/3 needs it to author while main is red).
  const ci = roleById("ci");
  assert.ok(ci, "roleById('ci') returns a role");
  assert.equal(ci.title, "CI parity runner");
  assert.equal(ci.tier, "default");
  assert.equal(ROLES.filter((r) => r.id === "ci").length, 1, "ci appears exactly once");
  const ids = ROLES.map((r) => r.id);
  assert.ok(ids.indexOf("ci") > ids.indexOf("qa"), "ci sits after qa in catalog order");
  assert.ok(OBSERVER_ROLES.has("ci"), "ci is an observer");
  assert.ok(!DEFERRABLE_ROLES.has("ci"), "ci is an observer, so it never defers");
  assert.ok(allRoleIds().includes("ci"), "allRoleIds lists ci");
  assert.equal(roleLabel("ci"), "CI", "ci renders as CI in role labels");
});

test("allRoleIds lists every catalog role exactly once, director appended last", () => {
  const ids = allRoleIds();
  assert.deepEqual(ids, [...ROLES.map((r) => r.id), DIRECTOR_ROLE]);
  // config defaults and CLI validation iterate this list — a duplicate would double-enable
  // or misreport a role.
  assert.equal(new Set(ids).size, ids.length, "no duplicate role ids");
});

test("roleById resolves every catalog id; the director and unknown ids yield undefined", () => {
  for (const role of ROLES) {
    const found = roleById(role.id);
    assert.ok(found?.id === role.id, `roleById(${JSON.stringify(role.id)})`);
  }
  // The director is user-prompt-driven and has no find prompt by design — a Role for it
  // would let a run prompt be built as if it were an ordinary role.
  assert.equal(roleById(DIRECTOR_ROLE), undefined);
  assert.equal(roleById("no-such-role"), undefined);
});

test("unknownRoleMessage appends a did-you-mean suggestion for a close typo, none for a distant one", () => {
  const ids = ["feature", "bugfix", "director"];
  // "feautre" sits one transposition-ish edit from "feature": suggestClosest finds it.
  assert.match(
    unknownRoleMessage("feautre", ids),
    /^unknown role: feautre \(valid ids: feature, bugfix, director\) — did you mean `feature`\?$/,
  );
  // "bogus" is beyond edit distance 2 of every id — the wording stays as before, so the
  // existing pins (cli-operators-team, role-view, gui) still match.
  assert.equal(unknownRoleMessage("bogus", ids), "unknown role: bogus (valid ids: feature, bugfix, director)");
});
