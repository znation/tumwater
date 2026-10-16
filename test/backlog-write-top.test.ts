import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { moveEntryToTop, tryMoveEntryToTop } from "../src/backlog/backlog-write.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";

// `tumwater plan --top <n>`: moveEntryToTop reorders one entry to the head of ## Planned,
// moving its lines whole and leaving the rest of the file as it was.

const entry = (k: string) => `### ${k}\n\nbody ${k}\n`;

function seed(content: string): { repo: string; file: string } {
  const repo = makeRepo();
  const file = path.join(repo, "PLANS.md");
  fs.writeFileSync(file, content);
  return { repo, file };
}

const withDone = `# Plans\n\n## Planned\n\n${entry("a")}\n${entry("b")}\n${entry("c")}\n## Done\n\n### old\n\nold body\n`;

test("moveEntryToTop moves the last entry first and leaves ## Done untouched", () => {
  const { repo, file } = seed(withDone);
  assert.deepEqual(moveEntryToTop(repo, "plan", 3), { file: "PLANS.md", title: "c" });
  assert.equal(
    fs.readFileSync(file, "utf8"),
    `# Plans\n\n## Planned\n\n${entry("c")}\n${entry("a")}\n${entry("b")}\n## Done\n\n### old\n\nold body\n`,
  );
});

test("moveEntryToTop moves a middle entry above the first", () => {
  const { repo, file } = seed(withDone);
  moveEntryToTop(repo, "plan", 2);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    `# Plans\n\n## Planned\n\n${entry("b")}\n${entry("a")}\n${entry("c")}\n## Done\n\n### old\n\nold body\n`,
  );
});

test("moving the file's last entry keeps the file's trailing newline and doubles no blank", () => {
  const { repo, file } = seed(`## Planned\n\n${entry("a")}\n${entry("b")}\n${entry("c")}`);
  moveEntryToTop(repo, "plan", 3);
  assert.equal(fs.readFileSync(file, "utf8"), `## Planned\n\n${entry("c")}\n${entry("a")}\n${entry("b")}`);
  assert.ok(fs.readFileSync(file, "utf8").endsWith("### b\n\nbody b\n"));
});

test("a body holding a fenced ### line and a Refused note move whole", () => {
  const moved = "### q\n\n**Refused 2026-10-12 by feature: nope**\n\n```\n### quoted\n```\n";
  const { repo, file } = seed(`## Planned\n\n${entry("a")}\n${moved}\n## Done\n`);
  assert.equal(moveEntryToTop(repo, "plan", 2).title, "q");
  assert.equal(fs.readFileSync(file, "utf8"), `## Planned\n\n${moved}\n${entry("a")}\n## Done\n`);
});

test("position 1 and an out-of-range position fail and leave the file byte-identical", (t) => {
  const { repo, file } = seed(withDone);
  // fail() writes to stderr and exits the process; turn the exit into a throw.
  const stderr = t.mock.method(process.stderr, "write", () => true);
  t.mock.method(process, "exit", ((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as typeof process.exit);
  assert.throws(() => moveEntryToTop(repo, "plan", 1), /exit 1/);
  assert.match(String(stderr.mock.calls[0]?.arguments[0]), /plan #1 "a" is already first/);
  assert.throws(() => moveEntryToTop(repo, "plan", 9), /exit 1/);
  assert.equal(fs.readFileSync(file, "utf8"), withDone);
});

test("tryMoveEntryToTop leaves the bytes moveEntryToTop leaves and refuses without writing", () => {
  const a = seed(withDone);
  const b = seed(withDone);
  moveEntryToTop(a.repo, "plan", 3);
  assert.deepEqual(tryMoveEntryToTop(b.repo, "plan", 3, "c"), { status: "moved_to_top", file: "PLANS.md", title: "c" });
  assert.equal(fs.readFileSync(b.file, "utf8"), fs.readFileSync(a.file, "utf8"));

  const c = seed(withDone);
  assert.deepEqual(tryMoveEntryToTop(c.repo, "plan", 3, "wrong"), { status: "moved", title: "c" });
  assert.deepEqual(tryMoveEntryToTop(c.repo, "plan", 9, "c"), { status: "gone" });
  assert.deepEqual(tryMoveEntryToTop(c.repo, "plan", 1, "a"), { status: "already_first", title: "a" });
  assert.equal(fs.readFileSync(c.file, "utf8"), withDone);
});
