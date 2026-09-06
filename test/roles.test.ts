import test from "node:test";
import assert from "node:assert/strict";
import {
  BASELINE_BLOCKED_ROLES,
  DIRECTOR_ROLE,
  ROLES,
  allRoleIds,
  roleById,
} from "../src/roles.js";

// roles.ts is the single source of truth for which loops exist. Its structural invariants are
// load-bearing but easy to break silently: a duplicated or empty id makes two loops share one
// worktree/branch/state file; a reordered catalog changes startup-burst scheduling priority;
// and BASELINE_BLOCKED_ROLES drifting from the catalog (a typo'd id, or a new code-producing
// role added without updating the set) disables red-main protection for that role with no
// error anywhere. prompt.test.ts pins each role's find-text content; these tests pin the
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
  // a duplicate would make two loops clobber each other's persistent state.
  assert.equal(new Set(ids).size, ids.length, "role ids are unique");
});

test("catalog order is scheduling priority: shipping work outranks hygiene", () => {
  // The orchestrator starts loops in catalog order (the startup burst), so the head of ROLES
  // decides which roles get their first tick when everything wakes at once.
  assert.ok(ROLES.length >= 2, "catalog has at least the two shipping roles");
  assert.equal(ROLES[0]!.id, "feature");
  assert.equal(ROLES[1]!.id, "bugfix");
});

test("BASELINE_BLOCKED_ROLES is exactly the code-producing catalog roles", () => {
  // Red-main policy (src/loop.ts): while main's own suite is red, only roles whose diff can
  // carry non-exempt (code) changes are blocked from starting an authoring run. Exempt:
  // bugfix — the designated healer; blocking it would leave only humans able to unblock a
  // red main — and the markdown-only charter roles plan/readme/steward/qa, whose diffs are
  // review-exempt by construction. The director is not a catalog role at all.
  const exempt = new Set([DIRECTOR_ROLE, "bugfix", "plan", "readme", "steward", "qa"]);
  const expected = ROLES.map((r) => r.id).filter((id) => !exempt.has(id));
  assert.deepEqual(
    [...BASELINE_BLOCKED_ROLES].sort(),
    [...expected].sort(),
    "blocked set matches the catalog minus the exempt roles",
  );
  // A typo'd id in the set would never match loop.role and silently skip the baseline check;
  // the deepEqual above catches it, but say so explicitly for the failure message.
  for (const id of BASELINE_BLOCKED_ROLES) {
    assert.ok(roleById(id), `blocked role ${JSON.stringify(id)} exists in the catalog`);
  }
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
    assert.ok(found && found.id === role.id, `roleById(${JSON.stringify(role.id)})`);
  }
  // The director is user-prompt-driven and has no find prompt by design — a Role for it
  // would let a tick prompt be built as if it were an ordinary loop.
  assert.equal(roleById(DIRECTOR_ROLE), undefined);
  assert.equal(roleById("no-such-role"), undefined);
});
