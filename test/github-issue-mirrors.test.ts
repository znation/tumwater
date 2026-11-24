import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mirrorStates, mirroredIssueNumbers, mirrorsAtTip } from "../src/github/issue-mirrors.js";
import { loggingGit, makeRepo, seedCommit, tmpdir } from "./fixtures/repo-fixtures.js";
import { readCapture } from "./helpers/read-capture.js";

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

test("a mirror heading in the live Verified section of BUGS.md is recorded as finished", () => {
  // The steering guide names `## Verified` as a finished mirror home a closed issue may sit in
  // (docs/steering.md), so a heading there must reach the close read as finished, not be skipped
  // as an unknown section. A phrase in that section's body stays unread: only a heading mirrors.
  const states = mirrorStates({
    "BUGS.md":
      "## Open\n\n### Live (mirrors GitHub issue #4)\n\n## Fixed\n\n## Verified\n\n### Crash (mirrors GitHub issue #9)\n\n- the sentence mirrors GitHub issue #11 is only quoted here\n",
  });
  assert.deepEqual(states.get(9), [
    { file: "BUGS.md", section: "Verified", heading: "Crash (mirrors GitHub issue #9)", retired: false },
  ]);
  assert.equal(states.has(11), false, "a body line under Verified mirrors nothing");
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

test("one file mirroring an issue in two sections lists the sections in the mirror's own order", () => {
  // The single walk harvests every section in file order, but the reader still visits them in
  // MIRROR_SECTIONS order, so an issue's entry list keeps the shape the per-section loop gave:
  // the Open entry before the Fixed one even though ## Fixed comes first in the file.
  const states = mirrorStates({
    "BUGS.md":
      "## Fixed\n\n### Old (mirrors GitHub issue #4; fixed 2026-11-01)\n\n## Open\n\n### Live (mirrors GitHub issue #4)\n",
  });
  assert.deepEqual(
    states.get(4)?.map((e) => e.section),
    ["Open", "Fixed"],
  );
});

test("every mirror section is read from its file, not just the first match", () => {
  const states = mirrorStates({
    "BUGS.md": "## Open\n\n### A (mirrors GitHub issue #1)\n",
    "PLANS.md": "## Planned\n\n### B (mirrors GitHub issue #2)\n",
    "BUGS-FIXED.md": "## Fixed\n\n### C (mirrors GitHub issue #3)\n",
    "PLANS-DONE.md": "## Done\n\n### D (mirrors GitHub issue #4)\n",
  });
  assert.deepEqual(
    [...states.entries()].sort(([a], [b]) => a - b).map(([n, es]) => `${n}:${es[0]?.section}`),
    ["1:Open", "2:Planned", "3:Fixed", "4:Done"],
  );
});

/** How many `git show` a logging-git log names. */
function showCount(logFile: string): number {
  return readCapture(logFile)
    .split("\n")
    .filter((line) => line.startsWith("show ")).length;
}

test("mirrorsAtTip reads the backlog once per branch tip: a repeat call at the same tip spawns no git show, and a new commit is seen", async () => {
  const repo = makeRepo(tmpdir("mirrors-cache-"));
  seedCommit(
    repo,
    "BUGS.md",
    "## Open\n\n### Crash (mirrors GitHub issue #5)\n\nbody\n",
    "add a mirrored bug",
  );
  const logFile = path.join(tmpdir("mirrors-cache-log-"), "git.log");
  const restore = loggingGit(logFile);
  try {
    const first = await mirrorsAtTip(repo, "main");
    assert.equal(first.get(5)?.[0]?.heading, "Crash (mirrors GitHub issue #5)");
    const readsAfterFirst = showCount(logFile);
    assert.ok(readsAfterFirst > 0, "the first read goes to git");
    assert.equal(readsAfterFirst, 4, "one cold read shows each of the four backlog files once");

    // The same tip: the states come from the cache, so no new `git show` runs.
    const again = await mirrorsAtTip(repo, "main");
    assert.equal(showCount(logFile), readsAfterFirst, "a repeat call at the same tip spawns no git show");
    assert.deepEqual(
      again.get(5),
      [{ file: "BUGS.md", section: "Open", heading: "Crash (mirrors GitHub issue #5)", retired: false }],
    );

    // A moved tip invalidates it: the mirror added by the new commit is seen.
    seedCommit(
      repo,
      "PLANS.md",
      "## Planned\n\n### Feature (mirrors GitHub issue #7)\n",
      "add a mirrored plan",
    );
    const afterCommit = await mirrorsAtTip(repo, "main");
    assert.ok(showCount(logFile) > readsAfterFirst, "a moved tip re-reads the backlog");
    assert.equal(afterCommit.get(7)?.[0]?.file, "PLANS.md");
    assert.equal(afterCommit.get(5)?.[0]?.section, "Open");
  } finally {
    restore();
  }
});

test("mirrorsAtTip hands the caller its own Map, so mutating a poll's result cannot poison the next poll at the same tip", async () => {
  // The cache comment promises a shallow Map copy over the same entry arrays: the caller may
  // add and delete keys freely (the orchestrator's queue step filters the map it is handed),
  // and the cached answer the next poll reads is untouched.
  const repo = makeRepo(tmpdir("mirrors-copy-"));
  seedCommit(repo, "BUGS.md", "## Open\n\n### Crash (mirrors GitHub issue #5)\n\nbody\n", "seed");
  const logFile = path.join(tmpdir("mirrors-copy-log-"), "git.log");
  const restore = loggingGit(logFile);
  try {
    const first = await mirrorsAtTip(repo, "main");
    const reads = showCount(logFile);
    assert.ok(reads > 0, "the first read goes to git");

    first.delete(5);
    first.set(99, [{ file: "BUGS.md", section: "Open", heading: "Injected (mirrors GitHub issue #99)", retired: false }]);
    assert.equal(first.get(5), undefined, "the caller's own map reflects its deletion");

    const again = await mirrorsAtTip(repo, "main");
    assert.equal(showCount(logFile), reads, "the mutated poll is still a cache hit at the same tip");
    assert.deepEqual(
      again.get(5),
      [{ file: "BUGS.md", section: "Open", heading: "Crash (mirrors GitHub issue #5)", retired: false }],
      "the cached states survive the previous caller's deletion",
    );
    assert.equal(again.has(99), false, "the caller's injected key is not in the next poll");
  } finally {
    restore();
  }
});

test("mirrorsAtTip runs uncached when the branch cannot be resolved: every poll re-reads the backlog and mirrors nothing", async () => {
  // The tip is resolved before the cache is consulted, so a branch git cannot name never puts an
  // answer under a key: a missing branch reads empty files every time rather than a cached answer
  // (and never poisons the real branch's entry, which is keyed by its own name).
  const repo = makeRepo(tmpdir("mirrors-notip-"));
  seedCommit(repo, "BUGS.md", "## Open\n\n### Crash (mirrors GitHub issue #5)\n\nbody\n", "seed");
  const logFile = path.join(tmpdir("mirrors-notip-log-"), "git.log");
  const restore = loggingGit(logFile);
  try {
    const first = await mirrorsAtTip(repo, "no-such-branch");
    assert.equal(first.size, 0, "a branch git cannot name mirrors nothing");
    const readsAfterFirst = showCount(logFile);
    assert.ok(readsAfterFirst > 0, "the unresolvable tip still pays for the backlog reads");

    const again = await mirrorsAtTip(repo, "no-such-branch");
    assert.equal(again.size, 0, "the second poll also mirrors nothing");
    assert.ok(
      showCount(logFile) > readsAfterFirst,
      "an unresolvable tip is not cached, so a repeat poll re-reads the backlog",
    );

    // The real branch is unaffected by the unkeyed failed reads.
    const real = await mirrorsAtTip(repo, "main");
    assert.equal(real.get(5)?.[0]?.heading, "Crash (mirrors GitHub issue #5)");
  } finally {
    restore();
  }
});
