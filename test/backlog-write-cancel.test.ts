import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { bodyStructureProblem, cancelBug, editPlan, tryCancelEntry, tryEditEntry } from "../src/backlog/backlog-write.js";
import { tryReleaseEntry, releaseEntry } from "../src/backlog/backlog-release.js";
import { openBugs, plannedPlans } from "../src/backlog/backlog.js";
import { queuedRolePrompts } from "../src/inbox/inbox.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { seededBugs } from "./fixtures/backlog-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

// The cancel half (`tumwater bug/plan --cancel <n>`): remove one operator-filed entry from
// the section that command writes, under the same primary-worktree lock. The in-process
// tests pin the byte-level removal (first/middle/last/only, fence safety, out-of-range no-op);
// the CLI tests pin dispatch, the no-wake rule, --json, and the non-decimal refusal.

test("cancelBug removes a middle entry and leaves every other byte apart from the join blank", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  const before = seededBugs();
  fs.writeFileSync(file, before);
  const removed = cancelBug(repo, 2);
  assert.equal(removed.file, "BUGS.md");
  assert.equal(removed.title, "second (reported by the user 2026-10-02)");
  const expected = before.replace(
    "### second (reported by the user 2026-10-02)\n\nbody two\n\n",
    "",
  );
  assert.equal(fs.readFileSync(file, "utf8"), expected);
  assert.deepEqual(openBugs(repo), [
    "first (reported by the user 2026-10-01)",
    "third (reported by the user 2026-10-03)",
  ]);
});

test("cancelBug removes the first and the last entry", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  const before = seededBugs();
  fs.writeFileSync(file, before);
  cancelBug(repo, 1);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    before.replace("### first (reported by the user 2026-10-01)\n\nbody one\n\n", ""),
  );
  // The file now holds two entries; the last of them is position 2.
  cancelBug(repo, 2);
  assert.deepEqual(openBugs(repo), ["second (reported by the user 2026-10-02)"]);
});

test("cancelling a section's only entry leaves the ## heading and no ### entry", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  fs.writeFileSync(
    file,
    [
      "# Bugs",
      "",
      "## Open",
      "",
      "### only (reported by the user 2026-10-01)",
      "",
      "body",
      "",
      "## Fixed",
      "",
      "_None yet._",
      "",
    ].join("\n"),
  );
  cancelBug(repo, 1);
  const md = fs.readFileSync(file, "utf8");
  assert.match(md, /## Open\n\n## Fixed\n/);
  assert.ok(!md.includes("### "), "no entry heading may remain");
  assert.deepEqual(openBugs(repo), []);
});

test("an entry quoting ## and ### inside a code fence is removed whole", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  fs.writeFileSync(
    file,
    [
      "# Bugs",
      "",
      "## Open",
      "",
      "### fenced (reported by the user 2026-10-01)",
      "",
      "```",
      "## Fixed",
      "### not an entry",
      "```",
      "",
      "### after (reported by the user 2026-10-02)",
      "",
      "body after",
      "",
      "## Fixed",
      "",
      "_None yet._",
      "",
    ].join("\n"),
  );
  cancelBug(repo, 1);
  const md = fs.readFileSync(file, "utf8");
  assert.ok(!md.includes("### fenced"), "the fenced entry is removed whole");
  assert.ok(!md.includes("### not an entry"), "the fence's quoted heading goes with it");
  assert.match(md, /### after /, "the entry after the quoted fence survives");
  assert.deepEqual(openBugs(repo), ["after (reported by the user 2026-10-02)"]);
});

test("an out-of-range cancel fails and leaves the file byte-identical", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli cancel oob");
  await cli(repo, "bug", "only symptom");
  const before = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  const r = await cli(repo, "bug", "--cancel", "4");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no open bug at position 4 \(1 in BUGS\.md\) — valid: 1-1\n$/);
  assert.equal(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), before);
  // An empty section (the init placeholder) has no entries either.
  const empty = await cli(repo, "plan", "--cancel", "1");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /no planned feature at position 1 \(0 in PLANS\.md\)/);
});

test("tumwater plan --cancel removes only from PLANS.md and wakes no role", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli plan cancel");
  await cli(repo, "bug", "a bug stays put");
  const bugBefore = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  await cli(repo, "plan", "Add an export command");
  await cli(repo, "plan", "Remove an export command");
  const queuedBefore = queuedRolePrompts(repo, "feature").length;
  const r = await cli(repo, "plan", "--cancel", "1");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /cancelled plan in PLANS\.md: Add an export command/);
  const remaining = plannedPlans(repo);
  assert.equal(remaining.length, 1);
  assert.match(remaining[0]!, /^Remove an export command \(reported by the user \d{4}-\d{2}-\d{2}\)$/);
  // No new prompt: a removal wakes nothing.
  assert.equal(queuedRolePrompts(repo, "feature").length, queuedBefore);
  // The bug file is untouched by a plan cancel.
  assert.equal(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), bugBefore);
});

test("tumwater bug --cancel --json prints {file, title} and removes the entry", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug cancel json");
  await cli(repo, "bug", "first symptom");
  await cli(repo, "bug", "second symptom");
  const r = await cli(repo, "bug", "--cancel", "2", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { file: string; title: string };
  assert.equal(payload.file, "BUGS.md");
  assert.match(payload.title, /^second symptom \(reported by the user \d{4}-\d{2}-\d{2}\)$/);
  assert.equal(openBugs(repo).length, 1);
  assert.match(openBugs(repo)[0]!, /^first symptom \(reported by the user \d{4}-\d{2}-\d{2}\)$/);
});

test("a non-decimal or positional cancel fails and writes nothing", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug cancel bad");
  await cli(repo, "bug", "a symptom");
  const before = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  let r = await cli(repo, "bug", "--cancel", "abc");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--cancel needs a positive integer/);
  r = await cli(repo, "bug", "--cancel", "1", "stray");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater bug takes no arguments/);
  assert.equal(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), before);
});


test("tryCancelEntry leaves the bytes cancelBug leaves, and reads titles the status payload uses", () => {
  const a = makeRepo();
  const b = makeRepo();
  fs.writeFileSync(path.join(a, "BUGS.md"), seededBugs());
  fs.writeFileSync(path.join(b, "BUGS.md"), seededBugs());
  const title = openBugs(a)[1]!;
  cancelBug(a, 2);
  assert.deepEqual(tryCancelEntry(b, "bug", 2, title), { status: "cancelled", file: "BUGS.md", title });
  assert.equal(fs.readFileSync(path.join(b, "BUGS.md"), "utf8"), fs.readFileSync(path.join(a, "BUGS.md"), "utf8"));
});

test("tryReleaseEntry leaves the bytes releaseEntry leaves and refuses without writing", () => {
  const md = "# Bugs\n\n## Open\n\n### one\n\n**Refused 2026-10-16 by bugfix: x**\n\nbody\n\n### two\n\nbody\n\n## Fixed\n";
  const a = makeRepo();
  const b = makeRepo();
  fs.writeFileSync(path.join(a, "BUGS.md"), md);
  fs.writeFileSync(path.join(b, "BUGS.md"), md);
  releaseEntry(a, "bug", 1);
  assert.deepEqual(tryReleaseEntry(b, "bug", 1, "one"), { status: "released", file: "BUGS.md", title: "one", lifted: "refused" });
  assert.equal(fs.readFileSync(path.join(b, "BUGS.md"), "utf8"), fs.readFileSync(path.join(a, "BUGS.md"), "utf8"));
  assert.ok(!fs.readFileSync(path.join(b, "BUGS.md"), "utf8").includes("Refused"));

  fs.writeFileSync(path.join(b, "BUGS.md"), md);
  assert.deepEqual(tryReleaseEntry(b, "bug", 1, "nope"), { status: "moved", title: "one" });
  assert.deepEqual(tryReleaseEntry(b, "bug", 9, "one"), { status: "gone" });
  assert.deepEqual(tryReleaseEntry(b, "bug", 2, "two"), { status: "not_refused", title: "two" });
  assert.equal(fs.readFileSync(path.join(b, "BUGS.md"), "utf8"), md);
});

test("releaseEntry lifts a waiting-for-the-next-failure note", () => {
  const md = "# Bugs\n\n## Open\n\n### one\n\n**Waiting for the next failure 2026-10-16 by bugfix: x**\n\nbody\n\n### two\n\nbody\n\n## Fixed\n";
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "BUGS.md"), md);
  releaseEntry(repo, "bug", 1);
  assert.equal(
    fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"),
    "# Bugs\n\n## Open\n\n### one\n\nbody\n\n### two\n\nbody\n\n## Fixed\n",
  );
});

test("tryCancelEntry answers gone and moved without writing", () => {
  const repo = makeRepo();
  assert.deepEqual(tryCancelEntry(repo, "plan", 1, "x"), { status: "gone" }); // no PLANS.md section entries
  const file = path.join(repo, "BUGS.md");
  fs.writeFileSync(file, seededBugs());
  const before = fs.readFileSync(file, "utf8");
  assert.deepEqual(tryCancelEntry(repo, "bug", 9, "x"), { status: "gone" });
  const moved = tryCancelEntry(repo, "bug", 1, "not the title");
  assert.deepEqual(moved, { status: "moved", title: openBugs(repo)[0] });
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

const PLANS3 = "# Plans\n\n## Planned\n\n### one (planned 2026-10-01 by plan)\n\nbody one\n\n### two (planned 2026-10-02 by plan)\n\nold\n\n### three\n\nbody three\n\n## Done\n\n### d\n\nx\n";

test("tryEditEntry rewrites the middle entry keeping its stamp and the body's lines", () => {
  const repo = makeRepo();
  const file = path.join(repo, "PLANS.md");
  fs.writeFileSync(file, PLANS3);
  const title = "two (planned 2026-10-02 by plan)";
  const out = tryEditEntry(repo, "plan", 2, title, "New  two (planned 2020-01-01 by x)", "line a\r\n\r\n- b\n");
  assert.deepEqual(out, { status: "edited", file: "PLANS.md", title: "New two" });
  assert.equal(
    fs.readFileSync(file, "utf8"),
    PLANS3.replace("### two (planned 2026-10-02 by plan)\n\nold\n", "### New two (planned 2026-10-02 by plan)\n\nline a\n\n- b\n"),
  );
});

test("tryEditEntry equals editPlan for a single-line body", () => {
  const a = makeRepo();
  const b = makeRepo();
  fs.writeFileSync(path.join(a, "PLANS.md"), PLANS3);
  fs.writeFileSync(path.join(b, "PLANS.md"), PLANS3);
  editPlan(a, 2, "T", "one line body", "");
  tryEditEntry(b, "plan", 2, "two (planned 2026-10-02 by plan)", "T", "one line body");
  assert.equal(fs.readFileSync(path.join(b, "PLANS.md"), "utf8"), fs.readFileSync(path.join(a, "PLANS.md"), "utf8"));
});

test("tryEditEntry answers gone and moved without writing", () => {
  const repo = makeRepo();
  const file = path.join(repo, "PLANS.md");
  fs.writeFileSync(file, PLANS3);
  assert.deepEqual(tryEditEntry(repo, "plan", 9, "x", "t", "b"), { status: "gone" });
  assert.deepEqual(tryEditEntry(repo, "plan", 1, "nope", "t", "b"), { status: "moved", title: "one (planned 2026-10-01 by plan)" });
  assert.equal(fs.readFileSync(file, "utf8"), PLANS3);
});

test("bodyStructureProblem allows quoted headings in a closed fence and flags bare headings and open fences", () => {
  assert.equal(bodyStructureProblem("a\n```\n## X\n### Y\n```\nb"), null);
  assert.match(bodyStructureProblem("a\n### Y") ?? "", /heading/);
  assert.match(bodyStructureProblem("a\n```\nb") ?? "", /fence open/);
});
