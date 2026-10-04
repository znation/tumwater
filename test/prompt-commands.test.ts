import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmdPrompt } from "../src/prompt-commands.js";
import { enqueueRolePrompt, inboxSize, dequeuePrompt } from "../src/inbox.js";
import { DIRECTOR_ROLE } from "../src/roles.js";
import { defaultConfig } from "../src/config.js";
import { writeJsonFile } from "../src/json-files.js";
import { configPath, roleInboxDir } from "../src/paths.js";
import { tmpdir } from "./repo-fixtures.js";
import { attemptAsync } from "./exit-capture.js";

/** src/prompt-commands.ts's own tests: the `tumwater prompt` CLI layer had no in-process
 * coverage (only the store behind it, inbox.ts, was pinned directly), so its list render,
 * per-loop position numbering, cancel resolution, and enqueue confirmations are exercised
 * here against real queue files in a temp project root. cmdPrompt spawns no child process —
 * every branch reads or writes queue/marker files — so attemptAsync's in-process capture is
 * safe for it (see test/exit-capture.ts's scope limit). */

function makeRoot(): string {
  const root = tmpdir();
  // Enqueue and cancel with --role resolve valid ids through loadConfig, which needs a
  // config file; the defaults name every catalog loop.
  writeJsonFile(configPath(root), defaultConfig());
  return root;
}

async function expectOk(fn: () => Promise<unknown>): Promise<{ stdout: string; stderr: string }> {
  const o = await attemptAsync(fn);
  if (o.exited) assert.fail(`expected success, but process.exit(${o.code}) with:\n${o.stderr}`);
  return o;
}

async function expectFail(fn: () => Promise<unknown>): Promise<{ code: number; stderr: string }> {
  const o = await attemptAsync(fn);
  if (!o.exited) assert.fail(`expected process.exit, but the call returned`);
  return o;
}

function dirOf(root: string, role: string): string {
  return roleInboxDir(root, role);
}

test("prompt --list --json reports every loop's queue with per-loop positions and stamps", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, DIRECTOR_ROLE, "steer the director");
  enqueueRolePrompt(root, "clean", "first for clean");
  enqueueRolePrompt(root, "clean", "second for clean");
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--list", "--json"]));
  const payload = JSON.parse(stdout) as { prompts: { role: string; position: number; text: string; queuedAtMs: number | null }[] };
  assert.deepEqual(
    payload.prompts.map((p) => [p.role, p.position, p.text]),
    [
      [DIRECTOR_ROLE, 1, "steer the director"],
      ["clean", 1, "first for clean"],
      ["clean", 2, "second for clean"],
    ],
  );
  // Stamps come from the queue filename: a real enqueue is stamped within this test's window.
  const now = Date.now();
  for (const p of payload.prompts) {
    assert.ok(p.queuedAtMs !== null && p.queuedAtMs <= now && now - p.queuedAtMs < 60_000);
  }
});

test("prompt --list prose groups by loop, restarts numbering, and stamps the queue age", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, "clean", "clean one");
  enqueueRolePrompt(root, "clean", "clean two");
  enqueueRolePrompt(root, DIRECTOR_ROLE, "director note");
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--list"]));
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines[0]!, new RegExp(`^${DIRECTOR_ROLE}:$`));
  assert.match(lines[1]!, /^1\. director note \(queued \S+ ago\)$/);
  assert.match(lines[2]!, /^clean:$/);
  assert.match(lines[3]!, /^1\. clean one \(queued \S+ ago\)$/);
  assert.match(lines[4]!, /^2\. clean two \(queued \S+ ago\)$/);
});

test("prompt --list renders a hand-placed unstamped file without an age suffix", async () => {
  const root = makeRoot();
  // A filename whose leading run is not 13 digits is unstamped (queueFileStamp reads null):
  // the prose must render it exactly as it did before ages existed.
  fs.mkdirSync(dirOf(root, DIRECTOR_ROLE), { recursive: true });
  fs.writeFileSync(path.join(dirOf(root, DIRECTOR_ROLE), "2026-notes.md"), "hand placed");
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--list"]));
  assert.match(stdout, /^1\. hand placed$/m);
  assert.doesNotMatch(stdout, /queued/);
});

test("prompt --list on empty queues says so, in prose and JSON", async () => {
  const root = makeRoot();
  const prose = await expectOk(() => cmdPrompt(root, ["--list"]));
  assert.equal(prose.stdout.trim(), "nothing queued");
  const scoped = await expectOk(() => cmdPrompt(root, ["--list", "--role", "clean"]));
  assert.equal(scoped.stdout.trim(), "nothing queued for clean");
  const json = await expectOk(() => cmdPrompt(root, ["--list", "--json"]));
  assert.deepEqual(JSON.parse(json.stdout), { prompts: [] });
});

test("prompt --list --role scopes the listing to that loop's queue alone", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, DIRECTOR_ROLE, "director note");
  enqueueRolePrompt(root, "clean", "clean note");
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--list", "--role", "clean", "--json"]));
  const payload = JSON.parse(stdout) as { prompts: { role: string; position: number; text: string }[] };
  assert.equal(payload.prompts.length, 1);
  assert.equal(payload.prompts[0]?.role, "clean");
  const prose = await expectOk(() => cmdPrompt(root, ["--list", "--role", "clean"]));
  assert.doesNotMatch(prose.stdout, /director note/);
});

test("prompt enqueue defaults to the director queue and confirms; --role aims at one loop", async () => {
  const root = makeRoot();
  const director = await expectOk(() => cmdPrompt(root, ["do the thing"]));
  assert.match(director.stdout, /queued for the director loop/);
  assert.equal(inboxSize(root, DIRECTOR_ROLE), 1);
  assert.equal(inboxSize(root, "clean"), 0);
  const wakeup = await expectOk(() => cmdPrompt(root, ["--role", "clean", "clean something"]));
  assert.match(wakeup.stdout, /queued for the clean loop/);
  assert.equal(inboxSize(root, "clean"), 1);
  // The enqueue also wrote a wake marker through submitRolePromptAndWake: its return line.
  assert.equal(wakeup.stdout.trim().split("\n").length, 2);
});

test("prompt enqueue with an unknown --role fails with the shared unknown-role message", async () => {
  const root = makeRoot();
  const o = await expectFail(() => cmdPrompt(root, ["--role", "no-such-loop", "hello"]));
  assert.equal(o.code, 1);
  assert.match(o.stderr, /tumwater: .*no-such-loop/);
  assert.equal(inboxSize(root, "no-such-loop"), 0);
});

test("prompt cancel without --role resolves across the listed sections and names the loop", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, DIRECTOR_ROLE, "one");
  enqueueRolePrompt(root, DIRECTOR_ROLE, "two");
  enqueueRolePrompt(root, "clean", "clean note");
  // Position 2 only exists in the director's queue: that is where it cancels.
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--cancel", "2"]));
  assert.equal(stdout, "cancelled (director): two\n");
  assert.equal(inboxSize(root, DIRECTOR_ROLE), 1);
  assert.equal(inboxSize(root, "clean"), 1);
});

test("prompt cancel without --role reports an ambiguous position with a --role escape hatch", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, DIRECTOR_ROLE, "one");
  enqueueRolePrompt(root, "clean", "two");
  const o = await expectFail(() => cmdPrompt(root, ["--cancel", "1"]));
  assert.equal(o.code, 1);
  assert.match(o.stderr, /position 1 is queued for more than one loop/);
  assert.match(o.stderr, /--role/);
  // Nothing was removed by the refused cancel.
  assert.equal(inboxSize(root, DIRECTOR_ROLE), 1);
  assert.equal(inboxSize(root, "clean"), 1);
});

test("prompt cancel without --role misses cleanly when no loop's queue reaches the position", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, "clean", "only one");
  const o = await expectFail(() => cmdPrompt(root, ["--cancel", "3"]));
  assert.equal(o.code, 1);
  assert.match(o.stderr, /no prompt at position 3 \(1 queued across all loops\)/);
});

test("prompt cancel --role succeeds in scope and fails out of range with the queue count", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, "clean", "a");
  enqueueRolePrompt(root, "clean", "b");
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--cancel", "1", "--role", "clean"]));
  // A --role-scoped cancel already names the loop in the command, so the reply does not repeat it.
  assert.equal(stdout, "cancelled: a\n");
  assert.equal(inboxSize(root, "clean"), 1);
  const o = await expectFail(() => cmdPrompt(root, ["--cancel", "5", "--role", "clean"]));
  assert.equal(o.code, 1);
  assert.match(o.stderr, /no prompt at position 5 \(1 queued\)/);
});

test("prompt --file queues the file's contents verbatim for the director", async () => {
  const root = makeRoot();
  const file = path.join(root, "note.md");
  fs.writeFileSync(file, "Refactor the parser.\nWith care.\n");
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--file", file]));
  assert.match(stdout, /queued for the director loop/);
  assert.equal(inboxSize(root), 1);
  // The parser hands the file's contents to the enqueue path whole; the queue layer's
  // pre-existing trim (inbox-submit.ts) strips the trailing newline, so the queued text is
  // the file's content trimmed at the edges.
  assert.equal(dequeuePrompt(root), "Refactor the parser.\nWith care.");
});