import test from "node:test";
import assert from "node:assert/strict";
import { mirrorStates, mirroredIssueNumbers } from "../src/github/issue-mirrors.js";

test("a heading that mirrors one issue names that issue number", () => {
  const found = mirroredIssueNumbers("### Heap OOM (mirrors GitHub issue #1; filed 2026-11-21 by director)\n");
  assert.deepEqual([...found], [1]);
});

test("the plural heading names every issue it lists", () => {
  const found = mirroredIssueNumbers("### Two reports (mirrors GitHub issues #12, #3)\n");
  assert.deepEqual([...found].sort((a, b) => a - b), [3, 12]);
});

test("issue #1 is not mirrored by a heading that names issue #12", () => {
  const found = mirroredIssueNumbers("### Twelve (mirrors GitHub issue #12)\n");
  assert.equal(found.has(12), true);
  assert.equal(found.has(1), false);
});

test("the phrase in a body line, not a heading, mirrors nothing", () => {
  const found = mirroredIssueNumbers("- the sentence mirrors GitHub issue #7 is only quoted here\n");
  assert.equal(found.size, 0);
});

test("a finished entry in the Fixed section is recorded as a finished mirror", () => {
  const states = mirrorStates({
    "BUGS-FIXED.md": "## Fixed\n\n### Crash (mirrors GitHub issue #5; fixed 2026-11-20)\n\nbody\n",
  });
  assert.deepEqual(states.get(5), [
    {
      file: "BUGS-FIXED.md",
      section: "Fixed",
      heading: "Crash (mirrors GitHub issue #5; fixed 2026-11-20)",
      retired: false,
    },
  ]);
});

test("an entry with a retired stamp in PLANS-DONE.md is recorded as retired", () => {
  const states = mirrorStates({
    "PLANS-DONE.md": "## Done\n\n### Gone (mirrors GitHub issue #6; retired 2026-11-02)\n",
  });
  assert.equal(states.get(6)?.[0]?.retired, true);
  assert.equal(states.get(6)?.[0]?.section, "Done");
});

test("a mirror heading in an open section of BUGS.md is recorded with its section", () => {
  const states = mirrorStates({
    "BUGS.md": "## Open\n\n### Open one (mirrors GitHub issues #3, #8)\n\n## Fixed\n\n",
  });
  assert.equal(states.get(3)?.[0]?.section, "Open");
  assert.equal(states.get(8)?.[0]?.file, "BUGS.md");
  assert.equal(states.has(1), false);
});

test("a heading inside a fenced block is not a mirror", () => {
  const states = mirrorStates({
    "PLANS.md": "## Planned\n\n```\n### Example (mirrors GitHub issue #9)\n```\n",
  });
  assert.equal(states.size, 0);
});
