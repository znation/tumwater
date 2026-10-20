import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { dequeuePrompt, inboxSize, queuedPrompts, queuedRolePrompts } from "../src/inbox/inbox.js";
import { submitPrompt, submitRolePrompt } from "../src/inbox/inbox-submit.js";
import { queueFileStamp } from "../src/files/file-queue.js";
import { truncate } from "../src/text/text.js";
import { inboxDir, roleInboxDir } from "../src/paths.js";
import { makeRepo, writeMalformedJson } from "./fixtures/repo-fixtures.js";
import { cli, CLI } from "./helpers/cli-harness.js";
import { spawnSync } from "node:child_process";

// The prompt queue's child-process tests — enqueue/list/cancel basics first, then
// flag-validation, per-role queues, and the broken-config policy the list mode follows. Spawned
// via the CLI so node --test can run
// them in parallel processes; the shared spawn helpers live in cli-harness.ts.
test("prompt queues for the director and logs an event; empty text fails", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt test");

  let r = await cli(repo, "prompt");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /prompt text required/);

  r = await cli(repo, "prompt", "add dark mode");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /added to the director's inbox/);
  assert.equal(inboxSize(repo), 1);
  assert.equal(dequeuePrompt(repo), "add dark mode");

  // The queueing is visible in `logs`.
  r = await cli(repo, "logs", "-n", "5");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /message added to the inbox: add dark mode/);
});
test("prompt --list shows queued prompts numbered in execution order", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt list");

  // An empty set of queues is a clean one-liner, not an error.
  let r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /every inbox is empty/);

  submitPrompt(repo, "first task");
  // Full text verbatim — including newlines: --list is the inspection command that shows
  // what a queued prompt actually says before you cancel it.
  submitPrompt(repo, "second\nwith a newline");
  r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^1\. first task \(queued \d+[smh] ago\)$/m);
  assert.match(r.stdout, /^2\. second\nwith a newline \(queued \d+[smh] ago\)$/m);
});

// The empty side of --role scoping: a role with nothing queued gets its own one-liner, the
// same clean answer the unscoped empty list gives — the grouped-listing test below covers the
// populated side.
test("prompt --list --role with an empty queue names the role, not an error", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt list role empty");

  const r = await cli(repo, "prompt", "--list", "--role", "qa");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^qa's inbox is empty$/m);
});

test("prompt --list --role takes a comma list and keeps each section's numbering", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt list role comma");

  let r = await cli(repo, "prompt", "--list", "--role", "qa,readme");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^every listed inbox is empty \(qa, readme\)$/m);

  submitPrompt(repo, "director task");
  submitRolePrompt(repo, "qa", "qa one");
  submitRolePrompt(repo, "qa", "qa two");
  submitRolePrompt(repo, "readme", "docs task");

  r = await cli(repo, "prompt", "--list", "--role", "qa,readme");
  assert.equal(r.code, 0);
  // List-wide order (the catalog puts readme first), not the flag order.
  const qaAt = r.stdout.indexOf("qa:");
  const readmeAt = r.stdout.indexOf("readme:");
  assert.ok(readmeAt >= 0 && qaAt > readmeAt, `readme before qa in:\n${r.stdout}`);
  assert.match(r.stdout, /^1\. qa one/m);
  assert.match(r.stdout, /^2\. qa two/m);
  assert.match(r.stdout, /^1\. docs task/m);
  assert.ok(!r.stdout.includes("director task"));

  const single = await cli(repo, "prompt", "--list", "--role", "qa");
  const dup = await cli(repo, "prompt", "--list", "--role", "qa,qa");
  assert.equal(dup.stdout.replace(/\d+[smh] ago/g, ""), single.stdout.replace(/\d+[smh] ago/g, ""));

  r = await cli(repo, "prompt", "--list", "--role", "director,readme", "--json");
  assert.equal(r.code, 0);
  const roles = new Set((JSON.parse(r.stdout) as { prompts: { role: string }[] }).prompts.map((p) => p.role));
  assert.deepEqual([...roles].sort(), ["director", "readme"]);
});

test("prompt --list --role rejects bad comma lists; enqueue keeps a single --role", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt list role comma bad");

  let r = await cli(repo, "prompt", "--list", "--role", "qa,nosuch");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nosuch/);
  r = await cli(repo, "prompt", "--list", "--role", ",");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--role needs a role id/);

  r = await cli(repo, "prompt", "--role", "qa,readme", "text");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /qa,readme/);
  assert.deepEqual(queuedRolePrompts(repo, "qa"), []);
});

test("prompt --cancel removes the Nth queued prompt and reports its text", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt cancel");

  submitPrompt(repo, "alpha");
  const long = `fix the ${"x".repeat(100)} bug`;
  submitPrompt(repo, long);
  submitPrompt(repo, "gamma");

  let r = await cli(repo, "prompt", "--cancel", "2");
  assert.equal(r.code, 0);
  // Over-long text is reported through truncate (80 chars + ellipsis), like every other
  // one-line label — never a raw multi-hundred-character line.
  assert.ok(
    r.stdout.includes(`cancelled (director): ${truncate(long, 80)}`),
    `expected the truncated report in:\n${r.stdout}`,
  );

  // The removal renumbers the queue and is visible in --list and logs.
  r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^1\. alpha \(queued \d+[smh] ago\)$/m);
  assert.match(r.stdout, /^2\. gamma \(queued \d+[smh] ago\)$/m);
  assert.ok(!r.stdout.includes("fix the"), "the cancelled prompt is gone from the list:\n" + r.stdout);

  r = await cli(repo, "logs", "-n", "5");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /message removed from the inbox: /);
});

test("prompt --cancel fails on out-of-range or non-numeric positions without side effects", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt cancel validation");

  submitPrompt(repo, "alpha");

  // Out of range: the error names the position and the size of the largest queue the list
  // shows, since a no-`--role` cancel addresses every role's numbered section, not just one.
  let r = await cli(repo, "prompt", "--cancel", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no prompt at position 2 \(longest inbox holds 1\)/);

  // Non-numeric or non-positive values are rejected by the parser before any file is touched.
  for (const bad of ["0", "abc", "1.5"]) {
    r = await cli(repo, "prompt", "--cancel", bad);
    assert.equal(r.code, 1, `--cancel ${bad} should fail`);
    assert.match(r.stderr, /--cancel needs a positive integer/);
  }

  // A missing value is its own error.
  r = await cli(repo, "prompt", "--cancel");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--cancel needs a position number/);

  assert.equal(inboxSize(repo), 1, "nothing touched on failure");
});

// The read-only list mode follows parseRoleScope's broken-config policy (the same one
// logs --transcript applies): a transiently broken tumwater.json must not take the inspection
// command down, while the state-changing modes keep the loud config error when an id is
// named — and never read the config at all when the target is the director queue.
test("prompt --list survives a broken tumwater.json; named-role writes still fail loudly", async () => {
  const repo = makeRepo();
  await initProject(repo, "broken config prompt list");
  writeMalformedJson(path.join(repo, "tumwater.json"));
  submitPrompt(repo, "survives");

  let r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^1\. survives \(queued \d+[smh] ago\)$/m);

  // The fallback relaxes the config READ, not the id validation: an unknown id is refused.
  r = await cli(repo, "prompt", "--list", "--role", "qa");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /qa's inbox is empty/);
  r = await cli(repo, "prompt", "--list", "--role", "nope");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role/);

  // Writing to a named role's queue is owed the config error, not a built-ins-only guess.
  r = await cli(repo, "prompt", "--role", "qa", "ship it");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.equal(inboxSize(repo), 1, "the broken config let nothing be written");

  // No --role: the director queue needs no config read, so steering still works.
  r = await cli(repo, "prompt", "steer the director");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /added to the director's inbox/);
  r = await cli(repo, "prompt", "--cancel", "2");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /cancelled \(director\): steer the director/);
});

// A no-`--role` cancel addresses the same per-role numbered sections `--list` prints, not the
// director's queue alone: one role holding the position cancels there, several are an
// ambiguity the error names with the --role escape hatch.
test("prompt --cancel without --role cancels the entry --list shows, whichever role holds it", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt cancel cross role");

  submitRolePrompt(repo, "qa", "qa task one");

  // The bug's repro: --list shows the entry under qa, and the bare cancel removes it.
  let r = await cli(repo, "prompt", "--list");
  assert.match(r.stdout, /qa:\n1\. qa task one \(queued \d+[smh] ago\)/);
  r = await cli(repo, "prompt", "--cancel", "1");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /cancelled \(qa\): qa task one/);
  assert.deepEqual(queuedRolePrompts(repo, "qa"), []);

  // Several roles showing the same N is ambiguous — the list itself shows two "1." lines —
  // so the error names the roles and the --role form, and touches no queue.
  submitPrompt(repo, "director task");
  submitRolePrompt(repo, "qa", "qa task two");
  r = await cli(repo, "prompt", "--cancel", "1");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /position 1 is in more than one role's inbox \(director, qa\)/);
  assert.match(r.stderr, /--role/);
  assert.deepEqual(queuedPrompts(repo), ["director task"]);
  assert.deepEqual(queuedRolePrompts(repo, "qa"), ["qa task two"]);

  // The documented --role form still wins outright, and the director stays the bare default
  // when only its queue is long enough.
  r = await cli(repo, "prompt", "--cancel", "1", "--role", "qa");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /cancelled: qa task two/);
  r = await cli(repo, "prompt", "--cancel", "1");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /cancelled \(director\): director task/);
});

test("prompt --cancel reports a concurrently dequeued prompt as gone and exits clean", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt cancel race");

  // A dangling symlink is the deterministic stand-in for the race: readdir lists it (so the
  // position exists) but readFileSync hits ENOENT — exactly what a queued file looks like when
  // the director dequeues it between listing and removal. Its name sorts after real prompts,
  // so it occupies position 2.
  submitPrompt(repo, "alpha");
  const raced = path.join(inboxDir(repo), `9999999999999-000001-${process.pid}.md`);
  fs.symlinkSync(path.join(repo, "no-such-prompt.md"), raced);

  // A concurrent dequeue is a normal race, not an error: exit 0 with the explanation.
  const r = await cli(repo, "prompt", "--cancel", "2");
  assert.equal(r.code, 0, `expected clean exit for a gone prompt:\n${r.stderr}`);
  assert.match(r.stdout, /prompt 2 is no longer in the inbox/);
  assert.match(r.stdout, /director already took it/);

  // Nothing was removed or logged: the prompt ran (or will), it was not cancelled.
  assert.ok(fs.lstatSync(raced).isSymbolicLink(), "the vanished file was left untouched");
  const logs = await cli(repo, "logs", "-n", "10");
  assert.equal(logs.code, 0);
  assert.ok(!logs.stdout.includes("prompt cancelled"), `no cancel event logged:\n${logs.stdout}`);

  // The sibling prompt is still queued and --list skips the vanished file instead of showing
  // a phantom position.
  const list = await cli(repo, "prompt", "--list");
  assert.equal(list.code, 0);
  assert.match(list.stdout, /^1\. alpha \(queued \d+[smh] ago\)$/m);
  assert.ok(!list.stdout.includes("2."), `no phantom second prompt:\n${list.stdout}`);
});

test("prompt --list and --cancel reject duplicates, combinations, and stray positionals", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt flag validation");

  // Duplicates keep their existing behavior (first wins) only for other commands; here the
  // modes are exclusive, so a second occurrence is always an error.
  let r = await cli(repo, "prompt", "--list", "--list");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--list may only be given once/);

  r = await cli(repo, "prompt", "--cancel", "1", "--cancel", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--cancel may only be given once/);

  // The two modes are mutually exclusive.
  r = await cli(repo, "prompt", "--list", "--cancel", "1");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--list and --cancel are mutually exclusive/);

  // Neither mode takes prompt text: a stray positional would otherwise be silently ignored.
  r = await cli(repo, "prompt", "--list", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unexpected argument "extra" — with --list there is no prompt text/);

  r = await cli(repo, "prompt", "--cancel", "1", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unexpected argument "extra" — with --cancel there is no prompt text/);

  // The failures are parse-time: nothing reaches the inbox.
  assert.equal(inboxSize(repo), 0, "nothing enqueued on failure");
});

// --- prompt --role: per-role queues from the CLI ---

test("prompt --role queues for one role only, wakes it, and validates the role", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli per-role prompt");

  // Queued for qa only: qa's queue holds it verbatim, the director's inbox is untouched, and
  // the targeted role is woken so a sleeping team sees the prompt within one poll.
  let r = await cli(repo, "prompt", "--role", "qa", "check", "the", "flow");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /added to qa's inbox/);
  assert.match(r.stdout, /wake requested for qa/);
  assert.deepEqual(queuedRolePrompts(repo, "qa"), ["check the flow"]);
  assert.equal(inboxSize(repo), 0);
  assert.deepEqual(queuedRolePrompts(repo, "director"), []);

  // An unknown role fails naming the valid ids — the same message every other --role
  // consumer prints — and queues nothing anywhere.
  r = await cli(repo, "prompt", "--role", "nope", "hi");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: nope \(valid ids: .*\bqa\b/);
  assert.deepEqual(queuedRolePrompts(repo, "nope"), []);

  // `--role director` is the historical queue: same behavior as the flagless form.
  r = await cli(repo, "prompt", "--role", "director", "route this");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /added to the director's inbox/);
  assert.equal(dequeuePrompt(repo), "route this");
});

test("prompt --list groups queues by role and --cancel removes from the named role's queue", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli per-role list");

  submitPrompt(repo, "director task");
  submitRolePrompt(repo, "qa", "qa task one");
  submitRolePrompt(repo, "qa", "qa task two");
  submitRolePrompt(repo, "readme", "docs task");

  // Grouped: the director first (the shared historical queue), then each role with queued
  // prompts, each section numbered from 1.
  let r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /director:\n1\. director task/);
  assert.match(r.stdout, /qa:\n1\. qa task one \(queued \d+[smh] ago\)\n2\. qa task two \(queued \d+[smh] ago\)/);
  assert.match(r.stdout, /readme:\n1\. docs task/);

  // Scoped by --role: only that role's queue, numbered from 1.
  r = await cli(repo, "prompt", "--list", "--role", "qa");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /qa:\n1\. qa task one \(queued \d+[smh] ago\)\n2\. qa task two \(queued \d+[smh] ago\)/);
  assert.ok(!r.stdout.includes("director task"));

  // Cancel is scoped too: qa's position 1 is qa's first prompt, and only qa's queue shrinks.
  r = await cli(repo, "prompt", "--cancel", "1", "--role", "qa");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /cancelled: qa task one/);
  assert.deepEqual(queuedRolePrompts(repo, "qa"), ["qa task two"]);
  assert.deepEqual(queuedRolePrompts(repo, "readme"), ["docs task"]);
  assert.deepEqual(queuedPrompts(repo), ["director task"]);
});

test("prompt --cancel --role fails on an out-of-range position with the role's count and no side effects", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt cancel role range");

  // The scoped form routes the position straight into cancelRolePrompt, so an out-of-range
  // position surfaces that throw (with the role's own queue length, not the cross-role
  // count the flagless form reports) as a failed command — and leaves the queue untouched.
  submitRolePrompt(repo, "qa", "qa task one");
  const r = await cli(repo, "prompt", "--cancel", "5", "--role", "qa");
  assert.equal(r.code, 1, `expected a failed exit:\n${r.stdout}`);
  assert.match(r.stderr, /no prompt at position 5 \(1 in the inbox\)/);

  // No side effects: the sole prompt is still queued and nothing was logged.
  assert.deepEqual(queuedRolePrompts(repo, "qa"), ["qa task one"]);
  const logs = await cli(repo, "logs", "-n", "10");
  assert.equal(logs.code, 0);
  assert.ok(!logs.stdout.includes("prompt cancelled"), `no cancel event logged:\n${logs.stdout}`);
});

test("prompt --cancel --role reports a concurrently dequeued prompt as gone and exits clean", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt cancel role race");

  // The same dangling-symlink stand-in as the flagless race test, planted in the role's own
  // queue directory: readdir lists it, readFileSync hits ENOENT — the role dequeued the
  // prompt between the operator's listing and the cancel.
  submitRolePrompt(repo, "qa", "qa task one");
  const raced = path.join(roleInboxDir(repo, "qa"), `9999999999999-000001-${process.pid}.md`);
  fs.symlinkSync(path.join(repo, "no-such-prompt.md"), raced);

  const r = await cli(repo, "prompt", "--cancel", "2", "--role", "qa");
  assert.equal(r.code, 0, `expected clean exit for a gone prompt:\n${r.stderr}`);
  assert.match(r.stdout, /prompt 2 is no longer in the inbox/);
  assert.match(r.stdout, /qa already took it/);

  // The vanished file was left untouched and the real prompt is still queued.
  assert.ok(fs.lstatSync(raced).isSymbolicLink(), "the vanished file was left untouched");
  assert.deepEqual(queuedRolePrompts(repo, "qa"), ["qa task one"]);
});

// --- prompt --top: move one queued prompt to the head of its role's queue (PLANS.md
// "tumwater prompt --top <n>") — the inbox-management twin of plan|bug --top, sharing --cancel's
// position resolution so the operator pulls an urgent prompt forward without cancel-and-retype.
test("prompt --top moves the Nth entry to the head of its role's inbox", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt top");

  submitPrompt(repo, "first task");
  submitPrompt(repo, "urgent task");
  submitPrompt(repo, "third task");

  // No --role: the position resolves like --cancel's flagless form, and the success line
  // names the resolved role.
  let r = await cli(repo, "prompt", "--top", "2");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /topped \(director\): urgent task/);

  // The list now shows the moved entry as line 1 of its role's section.
  r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^1\. urgent task \(queued \d+[smh] ago\)$/m);
  assert.match(r.stdout, /^2\. first task \(queued \d+[smh] ago\)$/m);
  assert.match(r.stdout, /^3\. third task \(queued \d+[smh] ago\)$/m);

  // A `--role`-scoped top names no role (it is in the user's own command) and moves there.
  submitRolePrompt(repo, "qa", "qa one");
  submitRolePrompt(repo, "qa", "qa two");
  r = await cli(repo, "prompt", "--top", "2", "--role", "qa");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^topped: qa two$/m);
  assert.deepEqual(queuedRolePrompts(repo, "qa"), ["qa two", "qa one"]);

  // A `prompt_topped` event is logged per successful move.
  r = await cli(repo, "logs", "--type", "prompt_topped");
  assert.equal(r.code, 0, r.stderr);
  assert.equal((r.stdout.match(/inbox message moved to the front:/g) ?? []).length, 2);
});

test("prompt --top resolves a bad position and a list-wide miss/ambiguity exactly like --cancel", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt top resolution");

  submitPrompt(repo, "only");

  // Out of range (flagless): the same cross-role count --cancel reports.
  let r = await cli(repo, "prompt", "--top", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no prompt at position 2 \(longest inbox holds 1\)/);

  // Non-numeric or non-positive values fail at parse time — --cancel's wording.
  for (const bad of ["0", "abc", "1.5"]) {
    r = await cli(repo, "prompt", "--top", bad);
    assert.equal(r.code, 1, `--top ${bad} should fail`);
    assert.match(r.stderr, /--top needs a positive integer/);
  }

  // Position 1 fails as "already first" — the moveEntryToTop precedent.
  r = await cli(repo, "prompt", "--top", "1");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /prompt 1 is already first/);

  // A list-wide ambiguity when several roles hold the position names them and the --role
  // escape hatch, touching nothing.
  submitRolePrompt(repo, "qa", "qa first");
  r = await cli(repo, "prompt", "--top", "1");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /position 1 is in more than one role's inbox \(director, qa\)/);
  assert.match(r.stderr, /--role/);
  assert.deepEqual(queuedPrompts(repo), ["only"]);
  assert.deepEqual(queuedRolePrompts(repo, "qa"), ["qa first"]);

  // A role-scoped out-of-range reports the role's own count.
  r = await cli(repo, "prompt", "--top", "5", "--role", "qa");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no prompt at position 5 \(1 in the inbox\)/);
  assert.deepEqual(queuedRolePrompts(repo, "qa"), ["qa first"]);
});

test("prompt --top --role reports a concurrently dequeued prompt as gone and exits clean", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt top role race");

  // The same dangling-symlink stand-in as the flagless and role cancel race tests, planted
  // as the higher-stamped entry so position 2 resolves to it: readdir lists it, the rename's
  // read hits ENOENT — the role dequeued the prompt between the operator's listing and
  // the move (movePromptToTop's gone outcome, which the top verb alone had never reported).
  submitRolePrompt(repo, "qa", "qa task one");
  const raced = path.join(roleInboxDir(repo, "qa"), `9999999999999-000001-${process.pid}.md`);
  fs.symlinkSync(path.join(repo, "no-such-prompt.md"), raced);

  const r = await cli(repo, "prompt", "--top", "2", "--role", "qa");
  assert.equal(r.code, 0, `expected clean exit for a gone prompt:\n${r.stderr}`);
  assert.match(r.stdout, /prompt 2 is no longer in the inbox/);
  assert.match(r.stdout, /qa already took it/);

  // The vanished file was left untouched and the real prompt is still queued, unmoved.
  assert.ok(fs.lstatSync(raced).isSymbolicLink(), "the vanished file was left untouched");
  assert.deepEqual(queuedRolePrompts(repo, "qa"), ["qa task one"]);
});

// --- prompt --list --json: the machine-readable render of the same listing (PLANS.md
// "prompt --list --json") — prose and JSON share one payload, so the positions --cancel
// consumes can never disagree with what a script reads.
test("prompt --list --json prints one JSON document matching the rendered list", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt list json");

  submitPrompt(repo, "director task");
  submitRolePrompt(repo, "qa", "qa task one");
  submitRolePrompt(repo, "qa", "qa task two");
  submitRolePrompt(repo, "readme", "docs task");

  // The payload holds every queued prompt — director first, then catalog order, empty
  // queues omitted — with per-role positions, full verbatim text, and the enqueue stamp
  // parsed from each queue filename (the age `prompt --list` shows). The expected stamps
  // come from the queue directories themselves, so the payload cannot drift from the names.
  const fileNames = (dir: string) =>
    fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const dirFiles = fileNames(inboxDir(repo));
  const [dirStamp] = dirFiles.map(queueFileStamp);
  const qaFiles = fileNames(roleInboxDir(repo, "qa"));
  const qaStamps = qaFiles.map(queueFileStamp);
  const readmeFiles = fileNames(roleInboxDir(repo, "readme"));
  let r = await cli(repo, "prompt", "--list", "--json");
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.deepEqual(payload, {
    prompts: [
      { role: "director", position: 1, file: dirFiles[0], text: "director task", queuedAtMs: dirStamp, notBeforeMs: null },
      { role: "readme", position: 1, file: readmeFiles[0], text: "docs task", queuedAtMs: readmeFiles.map(queueFileStamp)[0], notBeforeMs: null },
      { role: "qa", position: 1, file: qaFiles[0], text: "qa task one", queuedAtMs: qaStamps[0], notBeforeMs: null },
      { role: "qa", position: 2, file: qaFiles[1], text: "qa task two", queuedAtMs: qaStamps[1], notBeforeMs: null },
    ],
  });

  // The JSON positions are the same numbers the prose render prints: render both and
  // cross-check them, so the two shapes cannot drift. Only a group's first numbered line
  // follows the `role:` header, so the per-prompt check is the line itself.
  const prose = await cli(repo, "prompt", "--list");
  assert.equal(prose.code, 0);
  for (const p of payload.prompts) {
    assert.ok(prose.stdout.includes(`${p.position}. ${p.text}`), `prose missing ${p.role} ${p.position}`);
  }

  // Scoped by --role: that role's queue alone, numbered from 1.
  r = await cli(repo, "prompt", "--list", "--role", "qa", "--json");
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    prompts: [
      { role: "qa", position: 1, file: qaFiles[0], text: "qa task one", queuedAtMs: qaStamps[0], notBeforeMs: null },
      { role: "qa", position: 2, file: qaFiles[1], text: "qa task two", queuedAtMs: qaStamps[1], notBeforeMs: null },
    ],
  });

  // An empty queue still prints the document — the history --json empty-rows precedent.
  r = await cli(repo, "prompt", "--list", "--role", "clean", "--json");
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { prompts: [] });

  // --json is list-only: in enqueue or cancel mode it is refused by name, never prompt text
  // or a silent rider on a state change, and nothing reaches the queues.
  r = await cli(repo, "prompt", "hello", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json only applies to --list/);
  r = await cli(repo, "prompt", "--cancel", "1", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json only applies to --list/);
  r = await cli(repo, "prompt", "--list", "--json", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json may only be given once/);
  r = await cli(repo, "prompt", "--list=true");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--list takes no value/);
  r = await cli(repo, "prompt", "--json=true");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json takes no value/);
  assert.deepEqual(queuedPrompts(repo), ["director task"]);
  assert.deepEqual(queuedRolePrompts(repo, "qa"), ["qa task one", "qa task two"]);
});

// --- the queue filename's enqueue stamp, surfaced: prose lines carry ` (queued <age> ago)`
// and --json carries the absolute stamp (PLANS.md "prompt --list shows how long each prompt
// has waited" 1/2). A hand-placed file — a name queueFileName would never write — degrades
// to no age rather than a guessed one, and still cancels by position exactly as before.
test("prompt --list shows each prompt's age; a hand-placed file shows none", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt list age");

  submitPrompt(repo, "patient task");
  let r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0);
  // Just-enqueued buckets to whole seconds ("0s"), whatever the clock's sub-second part.
  assert.match(r.stdout, /^1\. patient task \(queued \d+[smh] ago\)$/m);

  // --json carries the absolute stamp, matching the queue filename the entry lives in.
  r = await cli(repo, "prompt", "--list", "--json");
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  const files = fs.readdirSync(inboxDir(repo)).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 1);
  const stamped = queueFileStamp(files[0]!);
  assert.equal(payload.prompts[0].queuedAtMs, stamped);

  // A hand-placed name has no stamp under the convention: no suffix in prose, null in JSON,
  // and the per-role position numbering --cancel consumes is untouched.
  fs.writeFileSync(path.join(inboxDir(repo), "hand-placed.md"), "by hand");
  r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^1\. patient task \(queued \d+[smh] ago\)$/m);
  assert.match(r.stdout, /^2\. by hand$/m, "the unstamped line must render without an age suffix");
  r = await cli(repo, "prompt", "--list", "--json");
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    prompts: [
      { role: "director", position: 1, file: files[0], text: "patient task", queuedAtMs: stamped, notBeforeMs: null },
      { role: "director", position: 2, file: "hand-placed.md", text: "by hand", queuedAtMs: null, notBeforeMs: null },
    ],
  });

  r = await cli(repo, "prompt", "--cancel", "2");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /cancelled \(director\): by hand/);
  r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^1\. patient task \(queued \d+[smh] ago\)$/m);
  assert.ok(!r.stdout.includes("by hand"));
});

test("prompt --file - reads the prompt from stdin", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt stdin");
  const r = spawnSync(process.execPath, [CLI, "prompt", "--file", "-"], {
    cwd: repo, timeout: 20_000, input: "hi from stdin\n", encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /added to the director's inbox/);
  // The queue layer's pre-existing trim (inbox-submit.ts) strips the trailing newline.
  assert.equal(dequeuePrompt(repo), "hi from stdin");
});
