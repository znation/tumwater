import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnReadyChild, stopChild } from "./helpers/child-process.js";
import { fileURLToPath } from "node:url";
import { initProject } from "../src/init/init.js";
import { fileBug, filePlan, cancelBug, editBug, editPlan } from "../src/backlog/backlog-write.js";
import { DIRECTOR_PROMPT_MAX_CHARS } from "../src/inbox/inbox-submit.js";
import { openBugs, plannedPlans } from "../src/backlog/backlog.js";
import { queuedRolePrompts } from "../src/inbox/inbox.js";
import { primaryWorktreeLockPath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

// The operator-authored backlog writes (`tumwater bug` / `tumwater plan`): the appendEntry
// semantics (placement before the next `## ` heading, placeholder removal, missing-file
// seeding, fenced safety) in-process, plus the CLI smoke tests (confirmation, wake, --json,
// empty-argument failures, help topics) spawned through the CLI like the prompt queue's.

test("fileBug appends an operator-stamped entry to ## Open and the readers list it", async () => {
  const repo = makeRepo();
  await initProject(repo, "bug write test");
  const filed = fileBug(repo, "the config parser rejects empty values", 'tumwater bug "<symptom>"');
  const md = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  assert.match(md, /### the config parser rejects empty values \(reported by the operator \d{4}-\d{2}-\d{2}\)/);
  assert.equal(filed.file, "BUGS.md");
  assert.equal(filed.title, "the config parser rejects empty values");
  assert.match(filed.stamp, /^reported by the operator \d{4}-\d{2}-\d{2}$/);
  // Placement: the entry sits before ## Fixed.
  assert.ok(md.indexOf("### the config parser") < md.indexOf("## Fixed"));
  const expected = `the config parser rejects empty values (${filed.stamp})`;
  assert.deepEqual(openBugs(repo), [expected]);
});

test("a second filed bug lands after the first, and the _None yet._ placeholder goes", async () => {
  const repo = makeRepo();
  await initProject(repo, "bug write two");
  fileBug(repo, "first symptom", 'tumwater bug "<symptom>"');
  fileBug(repo, "second symptom", 'tumwater bug "<symptom>"');
  const md = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  assert.ok(!md.includes("_None yet._\n\n### first"), "placeholder must not sit above the first entry");
  const open = md.slice(md.indexOf("## Open"), md.indexOf("## Fixed"));
  assert.ok(open.indexOf("first symptom") < open.indexOf("second symptom"));
  // Only the Fixed section may still carry a placeholder.
  assert.ok(md.slice(md.indexOf("## Fixed")).includes("_None yet._"));
});

test("filePlan appends to ## Planned with the body as entry text", async () => {
  const repo = makeRepo();
  await initProject(repo, "plan write test");
  const filed = filePlan(repo, "Add an export command", "keep it JSON first", 'tumwater plan "<title>" [body...]');
  const md = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  assert.match(md, /### Add an export command \(reported by the operator \d{4}-\d{2}-\d{2}\)/);
  assert.match(md, /keep it JSON first/);
  assert.ok(md.indexOf("### Add an export command") < md.indexOf("## Done"));
  assert.equal(filed.file, "PLANS.md");
  assert.deepEqual(plannedPlans(repo)[0]!.startsWith("Add an export command"), true);
});

test("a missing BUGS.md/PLANS.md is seeded with the init scaffolding rather than failing", async () => {
  const repo = makeRepo();
  fileBug(repo, "symptom on a bare repo", 'tumwater bug "<symptom>"');
  filePlan(repo, "title on a bare repo", "", 'tumwater plan "<title>" [body...]');
  const bugs = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  const plans = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  assert.match(bugs, /^# Bugs\n/);
  assert.match(bugs, /## Open/);
  assert.match(bugs, /## Fixed/);
  assert.match(bugs, /### symptom on a bare repo/);
  assert.match(plans, /^# Plans\n/);
  assert.match(plans, /### title on a bare repo/);
});

test("a symptom whose text quotes markdown is folded to one line, never a phantom section", async () => {
  const repo = makeRepo();
  await initProject(repo, "bug write fold");
  fileBug(repo, "crashes on\n## Open\n fenced input", 'tumwater bug "<symptom>"');
  const md = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  assert.equal((md.match(/^## /gm) ?? []).length, 2); // ## Open and ## Fixed only.
  assert.equal(openBugs(repo).length, 1);
});

test("an entry's fenced block quoting ## headings does not end the section early", async () => {
  const repo = makeRepo();
  await initProject(repo, "bug write fence");
  fileBug(repo, "first symptom", 'tumwater bug "<symptom>"');
  const file = path.join(repo, "BUGS.md");
  const seeded = fs.readFileSync(file, "utf8");
  fs.writeFileSync(
    file,
    seeded.replace("### first symptom", '### first symptom\n\n```\n## Fixed\n```\n'),
  );
  fileBug(repo, "second symptom", 'tumwater bug "<symptom>"');
  const md = fs.readFileSync(file, "utf8");
  const open = md.slice(md.indexOf("## Open"));
  assert.ok(open.indexOf("second symptom") > open.indexOf("```"), "the entry must land after the quoted fence");
  assert.ok(open.indexOf("second symptom") < open.lastIndexOf("## Fixed"), "the quoted ## Fixed must not end ## Open");
});

test("a filed entry keeps the blank-line separators the rest of the backlog files use", async () => {
  const repo = makeRepo();
  await initProject(repo, "bug write separators");
  fileBug(repo, "first symptom", 'tumwater bug "<symptom>"');
  fileBug(repo, "second symptom", 'tumwater bug "<symptom>"');
  const bugs = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  // The entry heading never abuts the next ## heading: one blank line between the last
  // line of the section and ## Fixed, like the init template and every loop-written move.
  assert.match(bugs, /### second symptom[^\n]*\n\n## Fixed\n/, "entry must be blank-separated from ## Fixed");
  // The same for a plan whose body is the last line before ## Done.
  filePlan(repo, "Add an export command", "keep it JSON first", 'tumwater plan "<title>" [body...]');
  const plans = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  assert.match(plans, /keep it JSON first\n\n## Done\n/, "plan body must be blank-separated from ## Done");
  // A file that lacks the target section grows it at the end with the body blank-separated
  // under its heading (the no-## Open fallback path).
  const bare = makeRepo();
  fs.writeFileSync(path.join(bare, "BUGS.md"), "# Bugs\n\n## Fixed\n\n_None yet._\n");
  fileBug(bare, "symptom with a body shape", 'tumwater bug "<symptom>"');
  const grown = fs.readFileSync(path.join(bare, "BUGS.md"), "utf8");
  assert.match(grown, /## Open\n\n### symptom with a body shape[^\n]*\n$/, "grown section keeps the template's blank-line shape");
});

test("an unreadable BUGS.md fails the write instead of seeding over it", async () => {
  // A transient read failure (EACCES, EMFILE) is not the same as a missing file: treating
  // it as "absent" makes appendEntry write the init template plus the entry over the real
  // file, destroying every existing entry. The read must tolerate only ENOENT.
  const repo = makeRepo();
  await initProject(repo, "bug write unreadable");
  fileBug(repo, "existing bug", 'tumwater bug "<symptom>"');
  const file = path.join(repo, "BUGS.md");
  const before = fs.readFileSync(file, "utf8");
  fs.chmodSync(file, 0o000);
  let err: unknown;
  try {
    fileBug(repo, "new bug", 'tumwater bug "<symptom>"');
  } catch (e) {
    err = e;
  } finally {
    fs.chmodSync(file, 0o644); // restore so the assertion and harness cleanup can read it
  }
  assert.match(String(err), /EACCES/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("tumwater bug files the entry, confirms, and wakes the bugfix loop", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug test");
  const r = await cli(repo, "bug", "the config parser rejects empty values");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /filed bug in BUGS\.md: the config parser rejects empty values/);
  const queued = queuedRolePrompts(repo, "bugfix");
  assert.equal(queued.length, 1);
  assert.match(queued[0]!, /Operator filed a new bug with `tumwater bug`/);
  assert.match(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), /### the config parser rejects empty values \(reported by the operator/);
});

test("tumwater plan files the entry and wakes the feature loop", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli plan test");
  const r = await cli(repo, "plan", "Add an export command", "keep", "it", "JSON", "first");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /filed plan in PLANS\.md: Add an export command/);
  const queued = queuedRolePrompts(repo, "feature");
  assert.equal(queued.length, 1);
  assert.match(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), /keep it JSON first/);
});

test("tumwater bug --json prints the {file, title, stamp} payload", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug json");
  const r = await cli(repo, "bug", "a symptom", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { file: string; title: string; stamp: string };
  assert.equal(payload.file, "BUGS.md");
  assert.equal(payload.title, "a symptom");
  assert.match(payload.stamp, /^reported by the operator \d{4}-\d{2}-\d{2}$/);
});

test("a repeated --json fails with the shared duplicate-flag wording and writes nothing", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug dup json");
  const r = await cli(repo, "bug", "a symptom", "--json", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json may only be given once/);
  // The refusal precedes the write and the wake: the entry never lands and no prompt queues.
  assert.match(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), /_None yet\._/);
  assert.equal(queuedRolePrompts(repo, "bugfix").length, 0);
});

test("a symptom that fits the cap but whose wake prompt does not fails before any write", async () => {
  // The boundary the preflight exists for: the title itself is under the submission cap,
  // but title plus the wake template's fixed overhead is one char over — the exact window
  // where submitRolePromptAndWake would throw after the write, half-applying the command.
  // Probe: file a 1-char bug on a scratch repo and read the queued wake's length — the
  // template's fixed overhead is that length minus 1.
  const probe = makeRepo();
  await initProject(probe, "wake cap probe");
  await cli(probe, "bug", "x");
  const queued = queuedRolePrompts(probe, "bugfix");
  assert.equal(queued.length, 1);
  const overhead = (queued[0] ?? "").length - 1;
  const title = "x".repeat(DIRECTOR_PROMPT_MAX_CHARS - overhead + 1);
  assert.ok(title.length <= DIRECTOR_PROMPT_MAX_CHARS); // the title alone fits the cap
  const repo = makeRepo();
  await initProject(repo, "wake cap boundary");
  const r = await cli(repo, "bug", title);
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`the prompt is ${DIRECTOR_PROMPT_MAX_CHARS + 1} chars`));
  assert.match(r.stderr, /rides into the bugfix tick's prefill/);
  assert.match(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), /_None yet\._/);
  assert.equal(queuedRolePrompts(repo, "bugfix").length, 0);
});

test("empty or missing arguments fail with the usage line and write nothing", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug empty");
  let r = await cli(repo, "bug");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater bug "<symptom>"/);
  r = await cli(repo, "plan");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater plan "<title>"/);
  r = await cli(repo, "bug", "   ");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /bug needs a symptom/);
  assert.match(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), /_None yet\._/);
  assert.equal(queuedRolePrompts(repo, "bugfix").length, 0);
  assert.equal(queuedRolePrompts(repo, "feature").length, 0);
});

// The cross-process primary-worktree race: `tumwater bug` rewrites BUGS.md while the lander
// fast-forwards the same working tree in the primary checkout. Without a shared lock the later
// whole-file write drops the other's change. The child holds the primary-worktree lock,
// snapshots BUGS.md, and writes that stale snapshot back once it has seen the parent's write (an
// unlocked parent's lands immediately; a locked one waits for the lock). The fix serializes the
// parent's read→write, so the filed entry survives the child's write-back.
test("a filed bug cannot be clobbered by a landing that fast-forwards the same file", async () => {
  const repo = makeRepo();
  await initProject(repo, "backlog write race");
  const bugsFile = path.join(repo, "BUGS.md");
  const lock = primaryWorktreeLockPath(repo);
  const ready = path.join(repo, "child-ready");
  const lockModule = fileURLToPath(new URL("../src/concurrency/lock.js", import.meta.url));
  const holder = spawnReadyChild(
    `const fs = require("node:fs");
     import(${JSON.stringify(lockModule)}).then(({ withStateLock }) => withStateLock(${JSON.stringify(lock)}, () => {
       const snapshot = fs.readFileSync(${JSON.stringify(bugsFile)}, "utf8");
       fs.writeFileSync(${JSON.stringify(ready)}, "1");
       const parentFiled = () => { try { return fs.readFileSync(${JSON.stringify(bugsFile)}, "utf8").includes("operator symptom"); } catch { return false; } };
       const deadline = Date.now() + 1500;
       while (Date.now() < deadline && !parentFiled()) {
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
       }
       fs.writeFileSync(${JSON.stringify(bugsFile)}, snapshot);
     }));`,
    () => fs.existsSync(ready),
    "the holder child never took the primary-worktree lock",
  );
  try {
    await holder.ready;
    fileBug(repo, "operator symptom", 'tumwater bug "<symptom>"');
    await holder.exited;
    assert.ok(
      fs.readFileSync(bugsFile, "utf8").includes("operator symptom"),
      "the filed entry survives the lander's stale write-back",
    );
  } finally {
    await stopChild(holder);
  }
});

test("help topics resolve for bug and plan", async () => {
  const repo = makeRepo();
  for (const [cmd, re] of [
    ["bug", /tumwater bug "<symptom>" \[--json\]/],
    ["plan", /tumwater plan "<title>" \[body\.\.\.\] \[--json\]/],
  ] as const) {
    const r = await cli(repo, "help", cmd);
    assert.equal(r.code, 0);
    assert.match(r.stdout, re);
  }
});

// The cancel half (`tumwater bug/plan --cancel <n>`): remove one operator-filed entry from
// the section that command writes, under the same primary-worktree lock. The in-process
// tests pin the byte-level removal (first/middle/last/only, fence safety, out-of-range no-op);
// the CLI tests pin dispatch, the no-wake rule, --json, and the non-decimal refusal.

/** A hand-written BUGS.md with three body-carrying entries, so a removal test can compare
 * bytes rather than only the readers' titles. */
function seededBugs(): string {
  return [
    "# Bugs",
    "",
    "## Open",
    "",
    "### first (reported by the operator 2026-10-01)",
    "",
    "body one",
    "",
    "### second (reported by the operator 2026-10-02)",
    "",
    "body two",
    "",
    "### third (reported by the operator 2026-10-03)",
    "",
    "body three",
    "",
    "## Fixed",
    "",
    "_None yet._",
    "",
  ].join("\n");
}

test("cancelBug removes a middle entry and leaves every other byte apart from the join blank", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  const before = seededBugs();
  fs.writeFileSync(file, before);
  const removed = cancelBug(repo, 2);
  assert.equal(removed.file, "BUGS.md");
  assert.equal(removed.title, "second (reported by the operator 2026-10-02)");
  const expected = before.replace(
    "### second (reported by the operator 2026-10-02)\n\nbody two\n\n",
    "",
  );
  assert.equal(fs.readFileSync(file, "utf8"), expected);
  assert.deepEqual(openBugs(repo), [
    "first (reported by the operator 2026-10-01)",
    "third (reported by the operator 2026-10-03)",
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
    before.replace("### first (reported by the operator 2026-10-01)\n\nbody one\n\n", ""),
  );
  // The file now holds two entries; the last of them is position 2.
  cancelBug(repo, 2);
  assert.deepEqual(openBugs(repo), ["second (reported by the operator 2026-10-02)"]);
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
      "### only (reported by the operator 2026-10-01)",
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
      "### fenced (reported by the operator 2026-10-01)",
      "",
      "```",
      "## Fixed",
      "### not an entry",
      "```",
      "",
      "### after (reported by the operator 2026-10-02)",
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
  assert.deepEqual(openBugs(repo), ["after (reported by the operator 2026-10-02)"]);
});

test("an out-of-range cancel fails and leaves the file byte-identical", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli cancel oob");
  await cli(repo, "bug", "only symptom");
  const before = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  const r = await cli(repo, "bug", "--cancel", "4");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no open bug at position 4 \(1 in BUGS\.md\)/);
  assert.equal(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), before);
  // An empty section (the init placeholder) has no entries either.
  const empty = await cli(repo, "plan", "--cancel", "1");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /no planned feature at position 1 \(0 in PLANS\.md\)/);
});

test("tumwater plan --cancel removes only from PLANS.md and wakes no loop", async () => {
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
  assert.match(remaining[0]!, /^Remove an export command \(reported by the operator \d{4}-\d{2}-\d{2}\)$/);
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
  assert.match(payload.title, /^second symptom \(reported by the operator \d{4}-\d{2}-\d{2}\)$/);
  assert.equal(openBugs(repo).length, 1);
  assert.match(openBugs(repo)[0]!, /^first symptom \(reported by the operator \d{4}-\d{2}-\d{2}\)$/);
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

// The edit half (`tumwater bug/plan --edit <n>`): replace one operator-filed entry in place
// under the same primary-worktree lock, preserving its position and its original stamp.

test("editBug replaces a middle entry's title in place and keeps every other byte", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  const before = [
    "# Bugs",
    "",
    "## Open",
    "",
    "### first (reported by the operator 2026-10-01)",
    "",
    "body one",
    "",
    "### second (reported by the operator 2026-10-02)",
    "",
    "### third (reported by the operator 2026-10-03)",
    "",
    "## Fixed",
    "",
    "_None yet._",
    "",
  ].join("\n");
  fs.writeFileSync(file, before);
  const edited = editBug(repo, 2, "the corrected symptom", 'tumwater bug "<symptom>"');
  assert.equal(edited.file, "BUGS.md");
  assert.equal(edited.title, "the corrected symptom");
  assert.equal(
    fs.readFileSync(file, "utf8"),
    before.replace(
      "### second (reported by the operator 2026-10-02)",
      "### the corrected symptom (reported by the operator 2026-10-02)",
    ),
  );
  assert.deepEqual(openBugs(repo), [
    "first (reported by the operator 2026-10-01)",
    "the corrected symptom (reported by the operator 2026-10-02)",
    "third (reported by the operator 2026-10-03)",
  ]);
});

test("editBug replaces the first and the last entry, dropping a bug's stale body", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  fs.writeFileSync(file, seededBugs());
  editBug(repo, 1, "corrected first", 'tumwater bug "<symptom>"');
  // A bug has no body, so the rebuilt entry is its heading alone: the old body goes with it.
  assert.match(
    fs.readFileSync(file, "utf8"),
    /### corrected first \(reported by the operator 2026-10-01\)\n\n### second /,
  );
  editBug(repo, 3, "corrected third", 'tumwater bug "<symptom>"');
  assert.deepEqual(openBugs(repo), [
    "corrected first (reported by the operator 2026-10-01)",
    "second (reported by the operator 2026-10-02)",
    "corrected third (reported by the operator 2026-10-03)",
  ]);
});

test("editing an entry that quotes ## and ### inside a code fence replaces it whole", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  fs.writeFileSync(
    file,
    [
      "# Bugs",
      "",
      "## Open",
      "",
      "### fenced (reported by the operator 2026-10-01)",
      "",
      "```",
      "## Fixed",
      "### not an entry",
      "```",
      "",
      "### after (reported by the operator 2026-10-02)",
      "",
      "## Fixed",
      "",
      "_None yet._",
      "",
    ].join("\n"),
  );
  editBug(repo, 1, "replaced fenced", 'tumwater bug "<symptom>"');
  const md = fs.readFileSync(file, "utf8");
  assert.ok(!md.includes("### not an entry"), "the fence's quoted heading goes with the replaced entry");
  assert.match(md, /### replaced fenced \(reported by the operator 2026-10-01\)\n\n### after /);
  assert.deepEqual(openBugs(repo), [
    "replaced fenced (reported by the operator 2026-10-01)",
    "after (reported by the operator 2026-10-02)",
  ]);
});

test("edit text quoting ## headings is folded to one line, never a phantom section", () => {
  const repo = makeRepo();
  const file = path.join(repo, "BUGS.md");
  fs.writeFileSync(file, seededBugs());
  editBug(repo, 2, "quotes\n## Fixed\ninside", 'tumwater bug "<symptom>"');
  const md = fs.readFileSync(file, "utf8");
  assert.equal((md.match(/^## /gm) ?? []).length, 2); // ## Open and ## Fixed only.
  assert.match(openBugs(repo)[1]!, /^quotes ## Fixed inside \(reported by the operator 2026-10-02\)$/);
});

test("editPlan replaces a plan's heading and body in place, keeping its stamp and position", () => {
  const repo = makeRepo();
  const file = path.join(repo, "PLANS.md");
  const before = [
    "# Plans",
    "",
    "## Planned",
    "",
    "### first (planned 2026-10-01)",
    "",
    "first body",
    "",
    "### second (reported by the operator 2026-10-02)",
    "",
    "old body",
    "",
    "## Done",
    "",
    "_None yet._",
    "",
  ].join("\n");
  fs.writeFileSync(file, before);
  const edited = editPlan(repo, 2, "A corrected title", "corrected body text", 'tumwater plan "<title>" [body...]');
  assert.equal(edited.file, "PLANS.md");
  assert.equal(edited.title, "A corrected title");
  assert.equal(
    fs.readFileSync(file, "utf8"),
    before.replace(
      "### second (reported by the operator 2026-10-02)\n\nold body",
      "### A corrected title (reported by the operator 2026-10-02)\n\ncorrected body text",
    ),
  );
});

test("editPlan re-collapses a wrapped heading onto one line with its stamp intact", () => {
  const repo = makeRepo();
  const file = path.join(repo, "PLANS.md");
  fs.writeFileSync(
    file,
    [
      "# Plans",
      "",
      "## Planned",
      "",
      "### A wrapped heading (planned 2026-09-02,",
      "2026-09-03)",
      "",
      "old body",
      "",
      "## Done",
      "",
      "_None yet._",
      "",
    ].join("\n"),
  );
  editPlan(repo, 1, "A corrected wrapped heading", "new body", 'tumwater plan "<title>" [body...]');
  const md = fs.readFileSync(file, "utf8");
  assert.match(md, /### A corrected wrapped heading \(planned 2026-09-02, 2026-09-03\)\n\nnew body\n\n## Done\n/);
  assert.ok(!md.includes("\n2026-09-03)"), "the continuation line is folded into the heading");
});

test("tumwater bug --edit replaces the entry, confirms, and wakes no loop", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli bug edit");
  await cli(repo, "bug", "first symptom");
  await cli(repo, "bug", "second symptom");
  const queuedBefore = queuedRolePrompts(repo, "bugfix").length;
  const r = await cli(repo, "bug", "--edit", "2", "the corrected symptom");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /edited bug in BUGS\.md: the corrected symptom/);
  assert.equal(queuedRolePrompts(repo, "bugfix").length, queuedBefore);
  const bugs = openBugs(repo);
  assert.equal(bugs.length, 2);
  assert.match(bugs[1]!, /^the corrected symptom \(reported by the operator \d{4}-\d{2}-\d{2}\)$/);
});

test("tumwater plan --edit --json prints {file, title} and edits in place", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli plan edit json");
  await cli(repo, "plan", "Old title");
  const r = await cli(repo, "plan", "--edit", "1", "A corrected title", "corrected body", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { file: string; title: string };
  assert.equal(payload.file, "PLANS.md");
  assert.equal(payload.title, "A corrected title");
  const plans = plannedPlans(repo);
  assert.equal(plans.length, 1);
  assert.match(plans[0]!, /^A corrected title \(reported by the operator \d{4}-\d{2}-\d{2}\)$/);
  assert.match(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), /corrected body/);
});

test("an out-of-range or empty edit fails non-zero and leaves the file byte-identical", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli edit failures");
  await cli(repo, "bug", "only symptom");
  const bugsBefore = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  const plansBefore = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  let r = await cli(repo, "bug", "--edit", "4", "corrected");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no open bug at position 4 \(1 in BUGS\.md\)/);
  assert.equal(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), bugsBefore);
  r = await cli(repo, "plan", "--edit", "1", "corrected");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no planned feature at position 1 \(0 in PLANS\.md\)/);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), plansBefore);
  r = await cli(repo, "bug", "--edit", "abc", "corrected");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--edit needs a positive integer/);
  r = await cli(repo, "bug", "--edit", "1", "");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /bug needs a symptom: tumwater bug "<symptom>"/);
  assert.equal(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), bugsBefore);
  r = await cli(repo, "plan", "--edit", "1", "");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /plan needs a title: tumwater plan "<title>"/);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), plansBefore);
});

test("help topics name the --edit forms", async () => {
  const repo = makeRepo();
  let r = await cli(repo, "help", "bug");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /tumwater bug --edit <n> "<symptom>" \[--json\]/);
  r = await cli(repo, "help", "plan");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /tumwater plan --edit <n> "<title>" \[body\.\.\.\] \[--json\]/);
});

