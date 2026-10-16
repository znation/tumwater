import test from "node:test";
import assert from "node:assert/strict";
import { roleLabel, roleTitle, ROLE_TITLES, CUSTOM_ROLE_TITLE } from "../src/roles/role-labels.js";
import { ROLES } from "../src/roles/role-catalog.js";

test("roleLabel shows instances as 'role #n' and leaves other ids alone", () => {
  assert.equal(roleLabel("feature-2"), "feature #2");
  assert.equal(roleLabel("bugfix-10"), "bugfix #10");
  for (const id of ["feature", "feature-1", "director", "nightly-2"]) assert.equal(roleLabel(id), id);
});

test("roleTitle resolves instances through their base and falls back for custom roles", () => {
  const feature = ROLES.find((r) => r.id === "feature")?.title;
  assert.equal(roleTitle("feature-3"), feature);
  assert.equal(roleTitle("director"), "runs your messages first");
  assert.equal(roleTitle("nightly"), CUSTOM_ROLE_TITLE);
  assert.equal(roleTitle("constructor"), "custom role");
  for (const r of ROLES) assert.ok((ROLE_TITLES[r.id] ?? "").length > 0, r.id);
});
