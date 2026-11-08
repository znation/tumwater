import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { submitPrompt, submitRolePrompt } from "../src/inbox/inbox-submit.js";
import { inboxDir } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

// `tumwater prompt --show <n>` — the read-only detail view of one queued prompt, the
// twin of `questions --show` and `plan --show`. It prints the whole prompt (never the preview
// ellipsis), the header names the role and position with the same age/countdown wording `--list`
// uses (queuedAgeSuffix is the shared home of that string), `--role` scopes like `--cancel`, and
// `--json` prints the queued row as data. Spawned via the CLI, like the other prompt queue tests.

test("prompt --show prints a long queued prompt in full with its header and age", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt show full");

  submitPrompt(repo, "short first");
  const long = "please: " + Array(4).fill("a line that runs past the eighty-character preview").join(" ");
  submitPrompt(repo, long);

  // --show prints position 2 under a header naming the role and the same age suffix --list
  // renders for that row, and the full text verbatim, not a preview (promptPreview's 80-char
  // ellipsis stays in the event log and the dashboard, never in this view).
  const r = await cli(repo, "prompt", "--show", "2");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^director #2 \(queued \d+[smh] ago\)$/m);
  assert.ok(r.stdout.includes(long), `the show view prints the whole prompt:\n${r.stdout}`);
  assert.ok(!r.stdout.includes("…"), `no preview ellipsis in the show view:\n${r.stdout}`);
});

test("prompt --show of a deferred prompt shows the countdown and no marker line", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt show deferred");

  let r = await cli(repo, "prompt", "--at", "1h", "deferred task");
  assert.equal(r.code, 0, r.stderr);

  // A pending --at deferral shows `(delivers in <duration>)` instead of the age, exactly as
  // the deferred --list row does, and the marker line is plumbing, never content.
  r = await cli(repo, "prompt", "--show", "1");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^director #1 \(delivers in 1h\)$/m);
  assert.ok(!r.stdout.includes("not-before"), "the marker line is plumbing, not content");
  assert.ok(r.stdout.includes("deferred task"), "the prompt text prints under the header");
});

test("prompt --show --role scopes to that role's queue", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt show role");

  submitRolePrompt(repo, "qa", "qa one");
  submitRolePrompt(repo, "qa", "qa two");
  submitRolePrompt(repo, "readme", "docs one");

  const r = await cli(repo, "prompt", "--show", "2", "--role", "qa");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^qa #2 \(queued \d+[smh] ago\)$/m);
  assert.ok(r.stdout.includes("qa two"), `shows qa's second prompt:\n${r.stdout}`);
});

test("prompt --show without --role reports a shared position as ambiguous and a miss as missing", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt show ambiguous");

  // Two roles hold position 1: the list itself shows two "1." lines, so the show must name
  // both and offer the --role escape hatch, the same wording --cancel prints.
  submitRolePrompt(repo, "qa", "qa one");
  submitRolePrompt(repo, "readme", "docs one");
  let r = await cli(repo, "prompt", "--show", "1");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /position 1 is in more than one role's inbox \((qa, readme|readme, qa)\) — name one with --role <id>/);

  // A position past every queue misses with the longest-queue length, the --cancel wording.
  r = await cli(repo, "prompt", "--show", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no prompt at position 2 \(longest inbox holds 1\)/);
});

test("prompt --show of an empty set of queues misses naming the empty longest queue", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt show empty");

  const r = await cli(repo, "prompt", "--show", "1");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no prompt at position 1 \(longest inbox holds 0\)/);
});

test("prompt --show 1 --json prints the queued row with its fields", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt show json");

  submitPrompt(repo, "alpha");
  const r = await cli(repo, "prompt", "--show", "1", "--json");
  assert.equal(r.code, 0, r.stderr);
  const row = JSON.parse(r.stdout) as {
    role: string;
    position: number;
    file: string;
    text: string;
    queuedAtMs: number;
    notBeforeMs: number | null;
  };
  // The same QueuedListRow shape --list --json's {prompts} array carries.
  assert.equal(row.role, "director");
  assert.equal(row.position, 1);
  assert.ok(row.file.endsWith(".md"), `queue-file basename addresses the entry: ${row.file}`);
  assert.equal(row.text, "alpha");
  assert.ok(Number.isInteger(row.queuedAtMs) && row.queuedAtMs > 0, `enqueue stamp parsed from the filename: ${row.queuedAtMs}`);
  assert.equal(row.notBeforeMs, null);
});

test("prompt --show reports a concurrently dequeued prompt as gone and exits clean", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt show race");

  // A dangling symlink is the deterministic stand-in for the race, exactly as the --cancel
  // race test builds it: readdir lists it (so the position resolves) but reading the file hits
  // ENOENT (a concurrent dequeue), so the row reads gone and the verb exits clean.
  submitPrompt(repo, "alpha");
  const raced = path.join(inboxDir(repo), `9999999999999-000001-${process.pid}.md`);
  fs.symlinkSync(path.join(repo, "no-such-prompt.md"), raced);

  const r = await cli(repo, "prompt", "--show", "2");
  assert.equal(r.code, 0, `expected clean exit for a gone prompt:\n${r.stderr}`);
  assert.match(r.stdout, /prompt 2 is no longer in the inbox/);
  assert.match(r.stdout, /director already took it/);

  // Nothing was removed: the prompt (or its ghost) was not touched by a read-only verb.
  assert.ok(fs.lstatSync(raced).isSymbolicLink(), "the vanished file was left untouched");
});
