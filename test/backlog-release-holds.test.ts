import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { releaseEntry, tryReleaseEntry } from "../src/backlog/backlog-release.js";

// The order and scope of a release: one hold per release, Refused first, and only from the
// addressed entry. The byte-level release tests are in backlog-write-cancel.test.ts.

const REFUSED = "**Refused 2026-10-16 by bugfix: x**";
const WAITING = "**Waiting for the next failure 2026-10-16 by bugfix: y**";
const NEEDS_REVIEW = "**Needs review 2026-10-16 by feature: too large for one run**";

test("a release lifts the Refused note first and leaves the Waiting note for a second release", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  fs.writeFileSync(file, `# Bugs\n\n## Open\n\n### one\n\n${REFUSED}\n\n${WAITING}\n\nbody\n\n## Fixed\n`);
  assert.deepEqual(releaseEntry(repo, "bug", 1), { file: "BUGS.md", title: "one" });
  assert.equal(fs.readFileSync(file, "utf8"), `# Bugs\n\n## Open\n\n### one\n\n${WAITING}\n\nbody\n\n## Fixed\n`);
  releaseEntry(repo, "bug", 1);
  const released = "# Bugs\n\n## Open\n\n### one\n\nbody\n\n## Fixed\n";
  assert.equal(fs.readFileSync(file, "utf8"), released);
  assert.deepEqual(tryReleaseEntry(repo, "bug", 1, "one"), { status: "not_refused", title: "one" });
  assert.equal(fs.readFileSync(file, "utf8"), released);
});

test("a release touches only the addressed entry and keeps its Needs review note", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  const entries = (twoNotes: string) =>
    `# Bugs\n\n## Open\n\n### one\n\n${REFUSED}\n\nbody one\n\n### two\n\n${twoNotes}\n\nbody two\n\n## Fixed\n`;
  fs.writeFileSync(file, entries(`${REFUSED}\n\n${NEEDS_REVIEW}`));
  assert.deepEqual(releaseEntry(repo, "bug", 2), { file: "BUGS.md", title: "two" });
  assert.equal(fs.readFileSync(file, "utf8"), entries(NEEDS_REVIEW));
});
