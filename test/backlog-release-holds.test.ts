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
  assert.deepEqual(releaseEntry(repo, "bug", 1), { file: "BUGS.md", title: "one", lifted: "refused" });
  assert.equal(fs.readFileSync(file, "utf8"), `# Bugs\n\n## Open\n\n### one\n\n${WAITING}\n\nbody\n\n## Fixed\n`);
  assert.deepEqual(releaseEntry(repo, "bug", 1), { file: "BUGS.md", title: "one", lifted: "waiting-for-failure" });
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
  assert.deepEqual(releaseEntry(repo, "bug", 2), { file: "BUGS.md", title: "two", lifted: "refused" });
  assert.equal(fs.readFileSync(file, "utf8"), entries(NEEDS_REVIEW));
});

test("a release lifts a held-for-operator Needs review note and its previously-held line", () => {
  const repo = makeRepo();
  const file = path.join(repo, "PLANS.md");
  fs.writeFileSync(
    file,
    `# Plans\n\n## Planned\n\n### one\n\n${NEEDS_REVIEW} (held 3)\n**Previously held 2**\n\n**Goal.** g\n\n## Done\n`,
  );
  assert.deepEqual(releaseEntry(repo, "plan", 1), { file: "PLANS.md", title: "one", lifted: "held-for-operator" });
  assert.equal(fs.readFileSync(file, "utf8"), `# Plans\n\n## Planned\n\n### one\n\n**Goal.** g\n\n## Done\n`);
});

test("a release refuses a below-threshold Needs review note and writes nothing", () => {
  const repo = makeRepo();
  const file = path.join(repo, "PLANS.md");
  const input = `# Plans\n\n## Planned\n\n### one\n\n**Needs review 2026-10-16 by feature: too large for one run (held 2)**\n\n## Done\n`;
  fs.writeFileSync(file, input);
  assert.deepEqual(tryReleaseEntry(repo, "plan", 1, "one"), { status: "not_refused", title: "one" });
  assert.equal(fs.readFileSync(file, "utf8"), input);
});
