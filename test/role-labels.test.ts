import test from "node:test";
import assert from "node:assert/strict";
import { roleLabel } from "../src/roles/role-labels.js";

test("roleLabel shows instances as 'role #n' and leaves other ids alone", () => {
  assert.equal(roleLabel("feature-2"), "feature #2");
  assert.equal(roleLabel("bugfix-10"), "bugfix #10");
  for (const id of ["feature", "feature-1", "director", "nightly-2"]) assert.equal(roleLabel(id), id);
});
