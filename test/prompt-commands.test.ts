import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmdPrompt } from "../src/inbox/prompt-commands.js";
import { enqueueRolePrompt, inboxSize, dequeuePrompt, dequeueRolePrompt, listWideScope, queuedListRows, queuedRolePrompts, renderQueuedList } from "../src/inbox/inbox.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { notBeforeMs } from "../src/inbox/prompt-not-before.js";
import { imageReferencePaths } from "../src/inbox/inbox-attachments.js";
import { queueFileStamp } from "../src/files/file-queue.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { DIRECTOR_PROMPT_MAX_CHARS } from "../src/inbox/inbox-submit.js";
import { defaultConfig } from "../src/config/config.js";
import { writeJsonFile } from "../src/files/json-files.js";
import { configPath, roleInboxDir } from "../src/paths.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { writeModelsFile } from "./fixtures/models-fixtures.js";
import { expectFailAsync, expectOkAsync as expectOk } from "./helpers/exit-capture.js";
import { setEnv } from "./helpers/env.js";

/** src/inbox/prompt-commands.ts's own tests: the `tumwater prompt` CLI layer had no in-process
 * coverage (only the store behind it, inbox.ts, was pinned directly), so its list render,
 * per-role position numbering, cancel resolution, and enqueue confirmations are exercised
 * here against real queue files in a temp project root. cmdPrompt spawns no child process —
 * every branch reads or writes queue/marker files — so the exit-capture helpers' in-process
 * capture is safe for it (see test/helpers/exit-capture.ts's scope limit). */

function makeRoot(): string {
  const root = tmpdir();
  // Enqueue and cancel with --role resolve valid ids through loadConfig, which needs a
  // config file; the defaults name every catalog role.
  writeJsonFile(configPath(root), defaultConfig());
  return root;
}

function dirOf(root: string, role: string): string {
  return roleInboxDir(root, role);
}

test("prompt --list --json reports every role's queue with per-role positions and stamps", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, DIRECTOR_ROLE, "steer the director");
  enqueueRolePrompt(root, "clean", "first for clean");
  enqueueRolePrompt(root, "clean", "second for clean");
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--list", "--json"]));
  const payload = JSON.parse(stdout) as { prompts: { role: string; position: number; file: string; text: string; queuedAtMs: number | null }[] };
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
    // The row also carries the queue-file basename that addresses it, the address the
    // dashboard's Edit and the TUI Queued pane's Ctrl+E write through.
    assert.match(p.file, /^[^/\\]+\.md$/, "the row carries its queue-file basename");
  }
});

test("prompt --list prose groups by role, restarts numbering, and stamps the queue age", async () => {
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

test("queuedListRows/renderQueuedList is the list-shaped view the TUI Queued pane shares", () => {
  const root = makeRoot();
  enqueueRolePrompt(root, DIRECTOR_ROLE, "director note");
  enqueueRolePrompt(root, "clean", "clean one");
  enqueueRolePrompt(root, "clean", "clean two");
  // A deferred prompt (not-before in the future) shows its countdown, not an age.
  enqueueRolePrompt(root, "clean", "deliver later", Date.now() + 3_600_000);
  const lines = renderQueuedList(queuedListRows(root, null, listWideScope(root)), Date.now()).split("\n");
  assert.equal(lines[0], `${DIRECTOR_ROLE}:`);
  assert.match(lines[1]!, /^1\. director note \(queued \S+ ago\)$/);
  assert.equal(lines[2], "clean:");
  assert.match(lines[3]!, /^1\. clean one \(queued \S+ ago\)$/);
  assert.match(lines[4]!, /^2\. clean two \(queued \S+ ago\)$/);
  assert.match(lines[5]!, /^3\. deliver later \(delivers in /);
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
  assert.equal(prose.stdout.trim(), "every inbox is empty");
  const scoped = await expectOk(() => cmdPrompt(root, ["--list", "--role", "clean"]));
  assert.equal(scoped.stdout.trim(), "clean's inbox is empty");
  const json = await expectOk(() => cmdPrompt(root, ["--list", "--json"]));
  assert.deepEqual(JSON.parse(json.stdout), { prompts: [] });
});

test("prompt --list --role scopes the listing to that role's queue alone", async () => {
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

test("prompt enqueue defaults to the director queue and confirms; --role aims at one role", async () => {
  const root = makeRoot();
  const director = await expectOk(() => cmdPrompt(root, ["do the thing"]));
  assert.match(director.stdout, /added to the director's inbox/);
  assert.equal(inboxSize(root, DIRECTOR_ROLE), 1);
  assert.equal(inboxSize(root, "clean"), 0);
  const wakeup = await expectOk(() => cmdPrompt(root, ["--role", "clean", "clean something"]));
  assert.match(wakeup.stdout, /added to clean's inbox/);
  assert.equal(inboxSize(root, "clean"), 1);
  // The enqueue also wrote a wake marker through submitRolePromptAndWake: its return line.
  assert.equal(wakeup.stdout.trim().split("\n").length, 2);
});

test("prompt enqueue with an unknown --role fails with the shared unknown-role message", async () => {
  const root = makeRoot();
  const o = await expectFailAsync(() => cmdPrompt(root, ["--role", "no-such-role", "hello"]));
  assert.match(o, /tumwater: .*no-such-role/);
  assert.equal(inboxSize(root, "no-such-role"), 0);
});

test("prompt cancel without --role resolves across the listed sections and names the role", async () => {
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
  const o = await expectFailAsync(() => cmdPrompt(root, ["--cancel", "1"]));
  assert.match(o, /position 1 is in more than one role's inbox/);
  assert.match(o, /--role/);
  // Nothing was removed by the refused cancel.
  assert.equal(inboxSize(root, DIRECTOR_ROLE), 1);
  assert.equal(inboxSize(root, "clean"), 1);
});

test("prompt cancel without --role misses cleanly when no role's queue reaches the position", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, "clean", "only one");
  const o = await expectFailAsync(() => cmdPrompt(root, ["--cancel", "3"]));
  assert.match(o, /no prompt at position 3 \(longest inbox holds 1\) — valid: 1-1\n$/);
});

test("prompt cancel/edit without --role names the longest queue, not the total across roles", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, DIRECTOR_ROLE, "one");
  enqueueRolePrompt(root, DIRECTOR_ROLE, "two");
  enqueueRolePrompt(root, "clean", "only for clean");
  // --list shows three numbered entries (director 1-2, clean 1), but per-role numbering
  // means no position 99 exists; the miss must say the longest inbox holds 2, not report the
  // total 3 as a per-role position count or claim it is "across all roles".
  const miss = await expectFailAsync(() => cmdPrompt(root, ["--cancel", "99"]));
  assert.match(miss, /no prompt at position 99 \(longest inbox holds 2\)/);
  const editMiss = await expectFailAsync(() => cmdPrompt(root, ["--edit", "99", "x"]));
  assert.match(editMiss, /no prompt at position 99 \(longest inbox holds 2\)/);
  // Neither miss touched a queue.
  assert.equal(inboxSize(root, DIRECTOR_ROLE), 2);
  assert.equal(inboxSize(root, "clean"), 1);
});

// A list-wide miss on a completely empty inbox — no role holds any prompt — drops the
// "valid: 1-N" suffix (failQueueMiss's empty-range branch): with no queue at any length,
// there is no position any role's numbering can reach, so echoing a range would be wrong.
// The cancel and edit wordings share the same miss helper, so one flagless case pins the
// empty branch for both verbs.
test("prompt cancel/edit without --role miss cleanly on an empty inbox with no range suffix", async () => {
  const root = makeRoot(); // no prompt queued for any role
  const cancel = await expectFailAsync(() => cmdPrompt(root, ["--cancel", "1"]));
  assert.match(cancel, /no prompt at position 1 \(longest inbox holds 0\)\n$/);
  const edit = await expectFailAsync(() => cmdPrompt(root, ["--edit", "1", "x"]));
  assert.match(edit, /no prompt at position 1 \(longest inbox holds 0\)\n$/);
});

test("prompt cancel --role succeeds in scope and fails out of range with the queue count", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, "clean", "a");
  enqueueRolePrompt(root, "clean", "b");
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--cancel", "1", "--role", "clean"]));
  // A --role-scoped cancel already names the role in the command, so the reply does not repeat it.
  assert.equal(stdout, "cancelled: a\n");
  assert.equal(inboxSize(root, "clean"), 1);
  const o = await expectFailAsync(() => cmdPrompt(root, ["--cancel", "5", "--role", "clean"]));
  assert.match(o, /no prompt at position 5 \(1 in the inbox\) — valid: 1-1\n$/);
});

// ── prompt --top <n>: move one queued prompt to its role's head ────────────────
// inbox-top.test.ts pins the store (movePromptToTop/topQueuedFile), but the cmdPrompt
// `--top` subcommand's own dispatch — the list-wide resolve on no `--role`, the
// `--role`-scoped move, and the already-first refusal — had no command-level test, so
// the wrapper's branches ran only through the child CLI. cmdPrompt spawns no child, so
// the same exit-capture helpers pin them in-process here.

test("prompt --top without --role resolves across the listed sections and names the role", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, DIRECTOR_ROLE, "one");
  enqueueRolePrompt(root, DIRECTOR_ROLE, "two");
  enqueueRolePrompt(root, "clean", "clean note");
  // Position 2 exists only in the director's queue, so the list-wide top resolves there and
  // the no-`--role` reply names the role (the caller scoped nothing).
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--top", "2"]));
  assert.equal(stdout, "topped (director): two\n");
  // The moved prompt is now the head of its role's queue; the other queue is untouched.
  assert.deepEqual([dequeuePrompt(root), dequeuePrompt(root)], ["two", "one"]);
  assert.equal(inboxSize(root, "clean"), 1);
});

test("prompt --top --role moves within the role's own queue and omits the role from the reply", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, "clean", "a");
  enqueueRolePrompt(root, "clean", "b");
  enqueueRolePrompt(root, "clean", "c");
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--role", "clean", "--top", "3"]));
  // A --role-scoped top already names the role in the command, so the reply does not repeat it.
  assert.equal(stdout, "topped: c\n");
  assert.deepEqual([dequeueRolePrompt(root, "clean"), dequeueRolePrompt(root, "clean")], ["c", "a"]);
});

test("prompt --top without --role misses cleanly on an out-of-range position", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, "clean", "only one");
  const o = await expectFailAsync(() => cmdPrompt(root, ["--top", "5"]));
  assert.match(o, /no prompt at position 5 \(longest inbox holds 1\)/);
  assert.equal(inboxSize(root, "clean"), 1);
});

test("prompt --top on position 1 refuses already-first for the role with no write", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, "clean", "a");
  enqueueRolePrompt(root, "clean", "b");
  const o = await expectFailAsync(() => cmdPrompt(root, ["--role", "clean", "--top", "1"]));
  assert.match(o, /prompt 1 is already first/);
  // The refusal writes nothing: both prompts keep their order.
  assert.deepEqual([dequeueRolePrompt(root, "clean"), dequeueRolePrompt(root, "clean")], ["a", "b"]);
});

test("prompt --file queues the file's contents verbatim for the director", async () => {
  const root = makeRoot();
  const file = path.join(root, "note.md");
  fs.writeFileSync(file, "Refactor the parser.\nWith care.\n");
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--file", file]));
  assert.match(stdout, /added to the director's inbox/);
  assert.equal(inboxSize(root), 1);
  // The parser hands the file's contents to the enqueue path whole; the queue layer's
  // pre-existing trim (inbox-submit.ts) strips the trailing newline, so the queued text is
  // the file's content trimmed at the edges.
  assert.equal(dequeuePrompt(root), "Refactor the parser.\nWith care.");
});
test("prompt --at 90m queues a prompt whose marker decodes to now+90m", async (t) => {
  const root = makeRoot();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--at", "90m", "re-check coverage"]));
  // The confirmation names the delivery delay in the same duration vocabulary --at parsed.
  assert.match(stdout, /added to the director's inbox — delivers in 90m/);
  const file = fs.readdirSync(dirOf(root, DIRECTOR_ROLE)).find((f) => f.endsWith(".md"));
  const text = fs.readFileSync(path.join(dirOf(root, DIRECTOR_ROLE), file ?? ""), "utf8");
  assert.equal(notBeforeMs(text), Date.now() + 90 * 60_000);
  // The store's deliverability filter sees it as not yet deliverable.
  assert.equal(inboxSize(root), 0);
});

test("prompt --at composes with --role and defers that role's queue", async (t) => {
  const root = makeRoot();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await expectOk(() => cmdPrompt(root, ["--at", "2h", "--role", "clean", "look again"]));
  const file = fs.readdirSync(dirOf(root, "clean")).find((f) => f.endsWith(".md"));
  const text = fs.readFileSync(path.join(dirOf(root, "clean"), file ?? ""), "utf8");
  assert.equal(notBeforeMs(text), Date.now() + 2 * 3_600_000);
  assert.equal(inboxSize(root, "clean"), 0);
});

test("prompt --list shows a deferred prompt's countdown instead of its age", async (t) => {
  const root = makeRoot();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  enqueueRolePrompt(root, DIRECTOR_ROLE, "re-check coverage", Date.now() + 90 * 60_000);
  enqueueRolePrompt(root, DIRECTOR_ROLE, "deliverable now");
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--list"]));
  assert.match(stdout, /^1\. re-check coverage \(delivers in 2h\)$/m);
  // A deliverable entry keeps the age suffix; the countdown never replaces it.
  assert.match(stdout, /^2\. deliverable now \(queued \S+ ago\)$/m);
  const json = await expectOk(() => cmdPrompt(root, ["--list", "--json"]));
  const payload = JSON.parse(json.stdout) as { prompts: { notBeforeMs: number | null }[] };
  assert.equal(payload.prompts[0]?.notBeforeMs, Date.now() + 90 * 60_000);
  assert.equal(payload.prompts[1]?.notBeforeMs, null);
  // The queued preview never shows the marker line — plumbing, not content.
  t.mock.timers.tick(91 * 60_000); // retired-name-ok: node:test mock clock
  const due = await expectOk(() => cmdPrompt(root, ["--list"]));
  assert.match(due.stdout, /^1\. re-check coverage \(queued \S+ ago\)$/m);
});

test("prompt --list --json carries notBeforeMs for a deferred role prompt", async (t) => {
  const root = makeRoot();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  enqueueRolePrompt(root, "clean", "later", Date.now() + 60_000);
  const json = await expectOk(() => cmdPrompt(root, ["--list", "--role", "clean", "--json"]));
  const payload = JSON.parse(json.stdout) as { prompts: { notBeforeMs: number | null }[] };
  assert.equal(payload.prompts[0]?.notBeforeMs, Date.now() + 60_000);
});

test("prompt --at is refused in the read-only and destructive modes", async () => {
  const root = makeRoot();
  const list = await expectFailAsync(() => cmdPrompt(root, ["--list", "--at", "90m"]));
  assert.match(list, /--at only queues a prompt/);
  const cancel = await expectFailAsync(() => cmdPrompt(root, ["--cancel", "1", "--at", "90m"]));
  assert.match(cancel, /--at only queues a prompt/);
  // A malformed duration fails with parseDurationFlag's message before anything is queued.
  const bad = await expectFailAsync(() => cmdPrompt(root, ["--at", "nope", "hello"]));
  assert.match(bad, /--at needs a duration like 45s, 90m, 1h30m, or 2d/);
  const zero = await expectFailAsync(() => cmdPrompt(root, ["--at", "0m", "hello"]));
  assert.match(zero, /--at needs a duration like 45s, 90m, 1h30m, or 2d/);
  assert.equal(inboxSize(root), 0, "nothing was queued by the refused shapes");
});

test("prompt --edit --role rewrites the entry in place and keeps its list position and stamp", async () => {
  const root = makeRoot();
  const first = enqueueRolePrompt(root, "bugfix", "typo text");
  enqueueRolePrompt(root, "bugfix", "second");

  const { stdout } = await expectOk(() => cmdPrompt(root, ["--role", "bugfix", "--edit", "1", "fixed text"]));
  assert.match(stdout, /edited: fixed text/);

  // The queue file is the same one: the next --list shows the new text at position 1 with
  // the original queued <age> ago stamp, and the queue still holds exactly two entries.
  assert.equal(fs.existsSync(first), true);
  const list = await expectOk(() => cmdPrompt(root, ["--list", "--role", "bugfix"]));
  assert.match(list.stdout, /^1\. fixed text \(queued \S+ ago\)$/m);
  assert.match(list.stdout, /^2\. second \(queued \S+ ago\)$/m);

  // One prompt_edited event under the target role per successful edit.
  const events = eventsOfType(root, "prompt_edited");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.source, "bugfix");
});

test("prompt --edit --file rewrites the entry from a file, keeping inner blank lines", async () => {
  const root = makeRoot();
  const first = enqueueRolePrompt(root, "bugfix", "typo text");
  enqueueRolePrompt(root, "bugfix", "second");
  const f = path.join(tmpdir(), "edit.md");
  fs.writeFileSync(f, "first\n\nsecond paragraph\n");

  await expectOk(() => cmdPrompt(root, ["--role", "bugfix", "--edit", "1", "--file", f]));
  assert.equal(fs.existsSync(first), true);
  assert.match(fs.readFileSync(first, "utf8"), /first\n\nsecond paragraph\s*$/);
  const list = await expectOk(() => cmdPrompt(root, ["--list", "--role", "bugfix"]));
  assert.match(list.stdout, /^1\. first/m);
  assert.match(list.stdout, /^2\. second \(queued/m);
  assert.equal(eventsOfType(root, "prompt_edited").length, 1);

  const dir = dirOf(root, "bugfix");
  const snap = () => fs.readdirSync(dir).sort().map((n) => fs.readFileSync(path.join(dir, n), "utf8"));
  const before = snap();
  await expectFailAsync(() => cmdPrompt(root, ["--role", "bugfix", "--edit", "1", "--file", path.join(tmpdir(), "missing.md")]));
  assert.deepEqual(snap(), before);
});

test("prompt --edit keeps a pending --at deferral: same countdown, not doubled or dropped", async (t) => {
  const root = makeRoot();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  enqueueRolePrompt(root, "bugfix", "stale instruction", Date.now() + 45 * 60_000);

  const { stdout } = await expectOk(() => cmdPrompt(root, ["--role", "bugfix", "--edit", "1", "corrected instruction"]));
  assert.match(stdout, /edited: corrected instruction/);

  // The listing still shows the countdown (the marker survived, undoubled), and --json
  // carries the same not-before time.
  const list = await expectOk(() => cmdPrompt(root, ["--list", "--role", "bugfix"]));
  assert.match(list.stdout, /^1\. corrected instruction \(delivers in 45m\)$/m);
  const json = await expectOk(() => cmdPrompt(root, ["--list", "--role", "bugfix", "--json"]));
  const payload = JSON.parse(json.stdout) as { prompts: { notBeforeMs: number | null; text: string }[] };
  assert.equal(payload.prompts[0]?.notBeforeMs, Date.now() + 45 * 60_000);
  assert.equal(payload.prompts[0]?.text, "corrected instruction");
  assert.equal(eventsOfType(root, "prompt_edited").length, 1);
});

test("prompt --edit with no --role resolves by the --list numbering: ambiguity and miss", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, DIRECTOR_ROLE, "first");
  enqueueRolePrompt(root, "clean", "also first");

  // Two roles show "1." in --list: the ambiguity names them and the --role escape hatch.
  const ambiguous = await expectFailAsync(() => cmdPrompt(root, ["--edit", "1", "edited"]));
  assert.match(ambiguous, /position 1 is in more than one role's inbox \(director, clean\) — name one with --role <id>/);
  assert.deepEqual(queuedRolePrompts(root, "clean"), ["also first"], "an ambiguity edits nothing");

  const missing = await expectFailAsync(() => cmdPrompt(root, ["--edit", "5", "edited"]));
  assert.match(missing, /no prompt at position 5 \(longest inbox holds 1\)/);

  // Cancel clean's entry, so only the director holds position 1: the edit resolves there
  // and its confirmation names the role, since the caller scoped nothing.
  await expectOk(() => cmdPrompt(root, ["--cancel", "1", "--role", "clean"]));
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--edit", "1", "edited"]));
  assert.match(stdout, /edited \(director\): edited/);
  assert.deepEqual(queuedRolePrompts(root, DIRECTOR_ROLE), ["edited"]);
  assert.equal(eventsOfType(root, "prompt_edited").length, 1);
});

test("prompt --edit refuses the sibling modes and out-of-range positions exit non-zero", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, "bugfix", "queued");

  assert.match((await expectFailAsync(() => cmdPrompt(root, ["--list", "--edit", "1", "x"]))), /--list and --edit are mutually exclusive/);
  assert.match((await expectFailAsync(() => cmdPrompt(root, ["--edit", "1", "fix", "--file", "x.txt"]))), /unexpected argument "fix" — with --file the replacement text comes from the file/);
  assert.match((await expectFailAsync(() => cmdPrompt(root, ["old", "--edit", "1", "new"]))), /unexpected argument "old"/);

  const outOfRange = await expectFailAsync(() => cmdPrompt(root, ["--role", "bugfix", "--edit", "9", "new"]));
  assert.match(outOfRange, /no prompt at position 9 \(1 in the inbox\)/);
  assert.equal(eventsOfType(root, "prompt_edited").length, 0, "no event on a failed edit");
});

// --- --attach <path> ---

test("prompt --attach saves the image beside the queue file, ends the text with the reference line, and names the count", async () => {
  const root = makeRoot();
  const img = path.join(root, "shot.png");
  fs.writeFileSync(img, Buffer.from("png-bytes"));
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--role", "feature", "--attach", img, "fix the layout"]));
  assert.match(stdout, /added to feature's inbox with 1 image\b/);
  const dir = dirOf(root, "feature");
  const md = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.equal(md.length, 1);
  const text = fs.readFileSync(path.join(dir, md[0] as string), "utf8");
  // The reference line is the queue file's last line, naming the absolute saved path.
  const refLine = text.trimEnd().split("\n").pop() as string;
  const m = (/^\[image attached: (.+)\]$/.exec(refLine)) ?? [];
  const saved = m[1] as string;
  assert.ok(fs.statSync(saved).size > 0, "the image bytes landed beside the queue file");
  assert.equal(path.basename(saved), (md[0] as string).replace(/\.md$/, "") + ".png");
  // The queued text the role dequeues carries the same reference line.
  const dequeued = dequeueRolePrompt(root, "feature") as string;
  assert.match(dequeued, /\[image attached: .+\.png\]$/);
  assert.match(dequeued, /fix the layout/);
});

test("prompt --attach repeats up to 4 and fails the fifth with the count-cap message", async () => {
  const root = makeRoot();
  const paths: string[] = [];
  for (const ext of [".png", ".jpg", ".gif", ".bmp"]) {
    const p = path.join(root, `img${ext}`);
    fs.writeFileSync(p, "x");
    paths.push(p);
  }
  const { stdout } = await expectOk(() =>
    cmdPrompt(root, ["--attach", paths[0] as string, "--attach", paths[1] as string, "note"]),
  );
  assert.match(stdout, /with 2 images\b/);
  const fifth = path.join(root, "img5.png");
  fs.writeFileSync(fifth, "x");
  const over = await expectFailAsync(() =>
    cmdPrompt(root, ["--attach", paths[0] as string, "--attach", paths[1] as string, "--attach", paths[2] as string, "--attach", paths[3] as string, "--attach", fifth, "note"]),
  );
  assert.match(over, /at most 4 images per prompt \(got 5\)/);
  assert.equal(inboxSize(root), 1, "only the earlier successful enqueue is in the queue");
});

test("prompt --attach fails on a nonexistent path, an unsupported extension, and an oversized image — queue untouched", async () => {
  const root = makeRoot();
  const missing = await expectFailAsync(() => cmdPrompt(root, ["--attach", path.join(root, "nope.png"), "hello"]));
  assert.match(missing, /cannot read attached image/);
  const badExt = path.join(root, "notes.txt");
  fs.writeFileSync(badExt, "x");
  const ext = await expectFailAsync(() => cmdPrompt(root, ["--attach", badExt, "hello"]));
  assert.match(ext, /unsupported image type "\*\.txt"/);
  const big = path.join(root, "big.png");
  fs.writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1));
  const size = await expectFailAsync(() => cmdPrompt(root, ["--attach", big, "hello"]));
  assert.match(size, /at most 5242880 \(5 MiB\) per image/);
  // A directory whose name ends in an image extension: its stat size is under the cap, so
  // only the regular-file rule refuses it before readFileSync would fail with a raw EISDIR.
  const dir = path.join(root, "shots.png");
  fs.mkdirSync(dir);
  const dirFail = await expectFailAsync(() => cmdPrompt(root, ["--attach", dir, "hello"]));
  assert.match(dirFail, /is not a regular file/);
  assert.equal(inboxSize(root), 0, "none of the refused shapes queued anything");
});

test("prompt --attach refuses the path list's cheap rules before reading any file", async () => {
  const root = makeRoot();
  // Five paths that do not exist: only a check that runs before the reads can answer with the
  // count cap instead of the first path's read failure.
  const fivePaths = Array.from({ length: 5 }, (_, i) => ["--attach", path.join(root, `nope${i}.png`)]).flat();
  const over = await expectFailAsync(() => cmdPrompt(root, [...fivePaths, "note"]));
  assert.match(over, /at most 4 images per prompt \(got 5\)/);
  // A non-image extension on a path that does not exist: the extension rule fires before the
  // stat and the read, so the missing file is never named.
  const ext = await expectFailAsync(() => cmdPrompt(root, ["--attach", path.join(root, "nope.txt"), "note"]));
  assert.match(ext, /unsupported image type "\*\.txt"/);
  assert.equal(inboxSize(root), 0, "nothing was queued");
});

test("prompt --edit --attach appends the new image after the carried one, keeping position and stamp", async () => {
  const root = makeRoot();
  const imgA = path.join(root, "a.png");
  const imgB = path.join(root, "b.jpg");
  fs.writeFileSync(imgA, Buffer.from("png-a"));
  fs.writeFileSync(imgB, Buffer.from("jpg-b"));
  // Enqueue prompt 1 plain, then prompt 2 with one image, so --edit 2 has a carried set and
  // a queue position to preserve.
  enqueueRolePrompt(root, "feature", "first");
  await expectOk(() => cmdPrompt(root, ["--role", "feature", "--attach", imgA, "second"]));
  const dir = dirOf(root, "feature");
  const md = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const second = path.join(dir, md[1] as string);
  const stamp = queueFileStamp(path.basename(second));

  const { stdout } = await expectOk(() =>
    cmdPrompt(root, ["--role", "feature", "--edit", "2", "--attach", imgB, "new text"]),
  );
  assert.match(stdout, /edited: /);

  // The same queue file and enqueue stamp: the entry did not move. Its text now carries the
  // carried reference and the new one, both naming files on disk.
  assert.equal(fs.existsSync(second), true);
  assert.equal(queueFileStamp(path.basename(second)), stamp, "the filename is unchanged");
  const text = fs.readFileSync(second, "utf8");
  assert.match(text, /^new text\n\n\[image attached: .+\]\n\[image attached: .+\]$/);
  const refs = imageReferencePaths(text);
  assert.equal(refs.length, 2, "the carried reference and the new one");
  assert.ok(fs.existsSync(refs[0]!) && fs.existsSync(refs[1]!), "both image files exist");

  // --list shows both reference lines under position 1; the other entry keeps its position.
  const list = await expectOk(() => cmdPrompt(root, ["--list", "--role", "feature"]));
  assert.equal((list.stdout.match(/\[image attached: /g) ?? []).length, 2, "--list shows both reference lines");
  assert.match(list.stdout, /^1\. first \(queued /m, "the other entry keeps its position");
  assert.equal(eventsOfType(root, "prompt_edited").length, 1);
});

test("prompt --edit --attach fails on a bad path by name with the queue untouched", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, "bugfix", "queued");
  const bad = await expectFailAsync(() =>
    cmdPrompt(root, ["--role", "bugfix", "--edit", "1", "--attach", path.join(root, "nope.png"), "new"]),
  );
  assert.match(bad, /cannot read attached image/);
  assert.deepEqual(queuedRolePrompts(root, "bugfix"), ["queued"], "the queue is untouched");
  assert.equal(eventsOfType(root, "prompt_edited").length, 0, "no event on a failed edit");
});
// Image input: `--edit --attach` runs through the same gate as a fresh `--attach`
// (the review objection that the edit path bypassed it), so an image a role's model cannot
// read is refused for an edited prompt too — before a byte is written — and the peer-tier
// reroute (part 5g/6) no longer accepts it even with a vision peer tier.
test("prompt --edit --attach refuses an image the target role cannot read, even with a vision peer", async () => {
  const root = makeRoot();
  const modelsDir = tmpdir("cli-edit-img-");
  writeModelsFile(
    modelsDir,
    JSON.stringify({ providers: { local: { models: [{ id: "text" }, { id: "vision", input: ["text", "image"] }] } } }),
  );
  const img = path.join(root, "shot.png");
  fs.writeFileSync(img, Buffer.from("not-a-real-png"));
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", modelsDir);
  try {
    enqueueRolePrompt(root, "feature", "first");
    // No configured model can read images → the edited-in attachment is refused up front and
    // the queue is untouched.
    writeJsonFile(configPath(root), { ...defaultConfig(), model: { default: "local/text", strong: "local/text" } });
    const refused = await expectFailAsync(() =>
      cmdPrompt(root, ["--role", "feature", "--edit", "1", "--attach", img, "edited"]),
    );
    assert.match(refused, /feature's model can't read images and no configured model reads images for it/);
    assert.deepEqual(queuedRolePrompts(root, "feature"), ["first"], "the refused edit leaves the queue untouched");
    assert.equal(eventsOfType(root, "prompt_edited").length, 0, "no event on a refused edit");

    // A vision strong tier no longer reroutes a blind read (part 5g/6): refused too.
    writeJsonFile(configPath(root), { ...defaultConfig(), model: { default: "local/text", strong: "local/vision" } });
    const refused2 = await expectFailAsync(() =>
      cmdPrompt(root, ["--role", "feature", "--edit", "1", "--attach", img, "edited"]),
    );
    assert.match(refused2, /can't read images/);
    assert.deepEqual(queuedRolePrompts(root, "feature"), ["first"], "the queue is untouched");
    assert.equal(eventsOfType(root, "prompt_edited").length, 0, "no event on a refused edit");
  } finally {
    restoreAgentDir();
  }
});

test("prompt --edit --attach with no --role resolves the gate's target list-wide and edits there", async () => {
  const root = makeRoot();
  const modelsDir = tmpdir("cli-edit-listed-img-");
  writeModelsFile(
    modelsDir,
    JSON.stringify({ providers: { local: { models: [{ id: "text" }, { id: "vision", input: ["text", "image"] }] } } }),
  );
  const img = path.join(root, "shot.png");
  fs.writeFileSync(img, Buffer.from("not-a-real-png"));
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", modelsDir);
  try {
    // Feature's default tier reads images, so the attach gate passes and the edit lands (no
    // reroute notice remains, part 5g/6).
    writeJsonFile(configPath(root), { ...defaultConfig(), model: { default: "local/vision", strong: "local/vision" } });
    // The director's inbox is empty and only `feature` holds a queue entry, so the no-`--role`
    // position 1 resolves list-wide to `feature` — a non-director, the resolution the gate's
    // `role ?? failQueueMiss(resolveListedQueue(...))` null-arm makes (not the DIRECTOR_ROLE
    // fallback every --role-scoped branch uses) — and the edit lands there.
    enqueueRolePrompt(root, "feature", "first");
    const { stdout } = await expectOk(() => cmdPrompt(root, ["--edit", "1", "--attach", img, "edited"]));
    assert.match(stdout, /^edited \(feature\): edited/m);
    assert.equal(eventsOfType(root, "prompt_edited").length, 1);
  } finally {
    restoreAgentDir();
  }
});

// --- bare --edit <n> opens $VISUAL/$EDITOR ---

/** Run `fn` with VISUAL unset and EDITOR a node stub that records the buffer it got, then runs
 * `body` (JS over `file` and `text`). */
async function withEditor<T>(root: string, body: string | null, fn: () => Promise<T>): Promise<{ result: T; received: string | null }> {
  const received = path.join(root, "editor.received");
  const script = path.join(root, "editor.cjs");
  fs.writeFileSync(
    script,
    `const fs = require("fs"); const file = process.argv[2]; const text = fs.readFileSync(file, "utf8");\n` +
      `fs.writeFileSync(${JSON.stringify(received)}, text);\n${body ?? ""}\n`,
  );
  const saved = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };
  delete process.env.VISUAL;
  if (body === null) delete process.env.EDITOR;
  else process.env.EDITOR = `"${process.execPath}" "${script}"`;
  try {
    const result = await fn();
    return { result, received: fs.existsSync(received) ? fs.readFileSync(received, "utf8") : null };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("prompt --edit <n> with no text edits in $EDITOR, keeping the deferral marker and images", async () => {
  const root = makeRoot();
  const img = path.join(root, "shot.png");
  fs.writeFileSync(img, Buffer.from("png-bytes"));
  await expectOk(() => cmdPrompt(root, ["--role", "feature", "--at", "1h", "--attach", img, "old text"]));
  const file = path.join(dirOf(root, "feature"), fs.readdirSync(dirOf(root, "feature")).find((f) => f.endsWith(".md")) as string);
  const before = fs.readFileSync(file, "utf8");
  const { result, received } = await withEditor(root, `fs.writeFileSync(file, "new text\\n");`, () => expectOk(() => cmdPrompt(root, ["--edit", "1"])));
  assert.equal((received as string).trim(), "old text");
  assert.match(result.stdout, /^edited \(feature\): new text/);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /new text/);
  assert.doesNotMatch(after, /old text/);
  assert.equal(notBeforeMs(after) !== null, notBeforeMs(before) !== null);
  assert.equal(imageReferencePaths(after).length, 1);
  assert.match((await expectOk(() => cmdPrompt(root, ["--list"]))).stdout, /new text/);
});

test("prompt --edit <n> with an untouched buffer prints unchanged and leaves the file as it was", async () => {
  const root = makeRoot();
  await expectOk(() => cmdPrompt(root, ["--role", "clean", "same text"]));
  const dir = dirOf(root, "clean");
  const file = path.join(dir, fs.readdirSync(dir)[0] as string);
  const before = fs.readFileSync(file);
  const { result } = await withEditor(root, "", () => expectOk(() => cmdPrompt(root, ["--role", "clean", "--edit", "1"])));
  assert.match(result.stdout, /prompt 1 unchanged/);
  assert.ok(before.equals(fs.readFileSync(file)));
});

test("prompt --edit <n> refuses a buffer emptied in the editor, leaving the queue alone", async () => {
  const root = makeRoot();
  await expectOk(() => cmdPrompt(root, ["--role", "clean", "keep me"]));
  const dir = dirOf(root, "clean");
  const file = path.join(dir, fs.readdirSync(dir)[0] as string);
  const before = fs.readFileSync(file);
  const { result } = await withEditor(root, `fs.writeFileSync(file, "  \\n");`, () => expectFailAsync(() => cmdPrompt(root, ["--edit", "1"])));
  assert.match(result, /edited prompt is empty; nothing changed/);
  assert.ok(before.equals(fs.readFileSync(file)));
});

test("prompt --edit <n> fails on editor failure and on no editor, leaving the queue alone", async () => {
  const root = makeRoot();
  await expectOk(() => cmdPrompt(root, ["--role", "clean", "keep me"]));
  const dir = dirOf(root, "clean");
  const file = path.join(dir, fs.readdirSync(dir)[0] as string);
  const before = fs.readFileSync(file);
  const bad = await withEditor(root, "process.exit(3);", () => expectFailAsync(() => cmdPrompt(root, ["--edit", "1"])));
  assert.match(bad.result, /editor exited with status 3; nothing changed/);
  const none = await withEditor(root, null, () => expectFailAsync(() => cmdPrompt(root, ["--edit", "1"])));
  assert.match(none.result, /no editor: set \$VISUAL or \$EDITOR, or pass the new text or --file <path>/);
  assert.ok(before.equals(fs.readFileSync(file)));
});

test("prompt --edit <n> names an editor command sh could not find, not a bare status", async () => {
  const root = makeRoot();
  await expectOk(() => cmdPrompt(root, ["--role", "clean", "keep me"]));
  const saved = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };
  delete process.env.VISUAL;
  // A $EDITOR naming a binary that does not exist: sh reports it as 127 ("command not
  // found"). The message must say so and point at the env var, not print a bare exit code.
  process.env.EDITOR = "/definitely/not/a/real/editor-binary";
  try {
    const res = await expectFailAsync(() => cmdPrompt(root, ["--edit", "1"]));
    assert.match(res, /editor command was not found/);
    assert.match(res, /check \$EDITOR/);
    assert.doesNotMatch(res, /status 127/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("prompt --edit <n> with no text fails on an ambiguous or missing position before any editor runs", async () => {
  const root = makeRoot();
  await expectOk(() => cmdPrompt(root, ["--role", "clean", "a"]));
  await expectOk(() => cmdPrompt(root, ["--role", "feature", "b"]));
  const amb = await withEditor(root, "", () => expectFailAsync(() => cmdPrompt(root, ["--edit", "1"])));
  assert.match(amb.result, /in more than one role's inbox/);
  assert.equal(amb.received, null);
  const miss = await withEditor(root, "", () => expectFailAsync(() => cmdPrompt(root, ["--edit", "5"])));
  assert.match(miss.result, /no prompt at position/);
  assert.equal(miss.received, null);
});

test("prompt --edit <n> with --role and an out-of-range position fails before any editor runs", async () => {
  const root = makeRoot();
  await expectOk(() => cmdPrompt(root, ["--role", "clean", "one"]));
  // The bare editor form resolves the role directly, then reads the queue file at the
  // position; an out-of-range position fails on that read (naming the count) before an
  // editor ever opens, so the failure must not depend on $EDITOR being configured.
  const res = await withEditor(root, "", () => expectFailAsync(() => cmdPrompt(root, ["--role", "clean", "--edit", "5"])));
  assert.match(res.result, /no prompt at position 5 \(1 in the inbox\)/);
  assert.equal(res.received, null, "the editor never opened");
});

test("prompt --edit <n> reports gone when the file is dequeued while the editor is open", async () => {
  const root = makeRoot();
  await expectOk(() => cmdPrompt(root, ["--role", "clean", "vanishing"]));
  const dir = dirOf(root, "clean");
  const { result } = await withEditor(root, `fs.rmSync(${JSON.stringify(path.join(dir, fs.readdirSync(dir)[0] as string))}); fs.writeFileSync(file, "changed\\n");`, () => expectOk(() => cmdPrompt(root, ["--edit", "1"])));
  assert.match(result.stdout, /prompt 1 is no longer in the inbox/);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length, 0);
});

test("prompt --edit <n> reports gone when the file vanished before its body was read", async () => {
  const root = makeRoot();
  // listQueueFiles does not stat (inbox.ts), so a dangling symlink still occupies position 1,
  // while readQueuedPromptBody's readTextIfExists sees the ENOENT and reports gone — the bare
  //-edit form's concurrent-dequeue race without having to interleave an actual dequeue.
  const dir = dirOf(root, "clean");
  fs.mkdirSync(dir, { recursive: true }); // the bare-edit command never queues, so the inbox dir is not yet made
  fs.symlinkSync(path.join(dir, "vanished-target.md"), path.join(dir, `${Date.now()}-000001-${process.pid}.md`));
  const { result, received } = await withEditor(root, "", () => expectOk(() => cmdPrompt(root, ["--role", "clean", "--edit", "1"])));
  assert.match(result.stdout, /prompt 1 is no longer in the inbox/);
  assert.equal(received, null, "the editor never opened — gone is reported off the read, not the editor");
});

test("prompt --edit <n> with a buffer over the prompt cap fails with the length message, queue untouched", async () => {
  const root = makeRoot();
  await expectOk(() => cmdPrompt(root, ["--role", "clean", "short body"]));
  const dir = dirOf(root, "clean");
  const file = path.join(dir, fs.readdirSync(dir)[0] as string);
  const before = fs.readFileSync(file);
  // The edited text rides into the target run's prefill exactly like a queued prompt, so the
  // bare editor form enforces the same cap as a submission (editPromptAtFile, inbox-edit.ts).
  const over = "x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 1);
  const { result } = await withEditor(root, `fs.writeFileSync(file, ${JSON.stringify(over)});`, () =>
    expectFailAsync(() => cmdPrompt(root, ["--role", "clean", "--edit", "1"])),
  );
  assert.match(result, /rides into the clean run's prefill/);
  assert.ok(before.equals(fs.readFileSync(file)), "no write landed when the edit was rejected");
});

// Image input (plans/image-input.md "Attachments"): the CLI's `--attach` gate. An image to a
// role whose seam reads no images fails non-zero naming the fix and queues nothing — the
// peer-tier reroute was subtracted (part 5g/6), so a vision peer tier no longer accepts it either.
test("prompt --attach refuses an image the target role cannot read, even with a vision peer", async () => {
  const root = makeRoot();
  const modelsDir = tmpdir("cli-image-");
  writeModelsFile(
    modelsDir,
    JSON.stringify({ providers: { local: { models: [{ id: "text" }, { id: "vision", input: ["text", "image"] }] } } }),
  );
  const imgDir = tmpdir("cli-attach-");
  const img = path.join(imgDir, "shot.png");
  fs.writeFileSync(img, Buffer.from("not-a-real-png"));
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", modelsDir);
  try {
    // No configured model can read images → the attach is refused up front, nothing queued.
    writeJsonFile(configPath(root), { ...defaultConfig(), model: { default: "local/text", strong: "local/text" } });
    const o = await expectFailAsync(() => cmdPrompt(root, ["--role", "feature", "--attach", img, "look at this"]));
    assert.match(o, /feature's model can't read images and no configured model reads images for it/);
    assert.match(o, /models\.json/);
    assert.equal(queuedRolePrompts(root, "feature").length, 0, "the refused attachment queues nothing");

    // A vision strong tier no longer reroutes a blind read (part 5g/6): refused too.
    writeJsonFile(configPath(root), { ...defaultConfig(), model: { default: "local/text", strong: "local/vision" } });
    const o2 = await expectFailAsync(() => cmdPrompt(root, ["--role", "feature", "--attach", img, "look at this"]));
    assert.match(o2, /can't read images/);
    assert.equal(queuedRolePrompts(root, "feature").length, 0, "nothing queued even with a vision peer");
  } finally {
    restoreAgentDir();
  }
});
