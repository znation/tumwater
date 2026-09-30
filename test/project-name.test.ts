import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { projectName } from "../src/project-name.js";

// Unit seam for project-name.ts — the one derivation of the project's display name. The
// dashboards' title (the status payload's `project` field), the TUI/status header, and init's
// brief heading all render through it, so the resolve-then-basename rule is load-bearing: a
// trailing separator or a relative root must yield the same name as its absolute form.

test("basename of an absolute root", () => {
  const root = path.join(os.tmpdir(), "my-project");
  assert.equal(projectName(root), "my-project");
});

test("resolving comes first: trailing separators and relative roots agree with their absolute form", () => {
  const root = path.join(os.tmpdir(), "my-project");
  assert.equal(projectName(root + path.sep), "my-project");
  assert.equal(projectName(path.relative(os.tmpdir(), root)), "my-project");
  assert.equal(projectName(path.relative(os.tmpdir(), root) + path.sep), "my-project");
});
