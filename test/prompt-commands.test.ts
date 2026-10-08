import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmdPrompt } from "../src/inbox/prompt-commands.js";
import { enqueueRolePrompt, inboxSize, dequeuePrompt, dequeueRolePrompt, queuedRolePrompts } from "../src/inbox/inbox.js";
import { eventsOfType } from "./log-fixtures.js";
import { notBeforeMs } from "../src/inbox/prompt-not-before.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { defaultConfig } from "../src/config/config.js";
import { writeJsonFile } from "../src/files/json-files.js";
import { configPath, roleInboxDir } from "../src/paths.js";
import { tmpdir } from "./repo-fixtures.js";
import { expectFailAsync, expectOkAsync as expectOk } from "./helpers/exit-capture.js";

/** src/inbox/prompt-commands.ts's own tests: the `tumwater prompt` CLI layer had no in-process
 * coverage (only the store behind it, inbox.ts, was pinned directly), so its list render,
 * per-loop position numbering, cancel resolution, and enqueue confirmations are exercised
 * here against real queue files in a temp project root. cmdPrompt spawns no child process —
 * every branch reads or writes queue/marker files — so the exit-capture helpers' in-process
 * capture is safe for it (see test/helpers/exit-capture.ts's scope limit). */

function makeRoot(): string {
  const root = tmpdir();
  // Enqueue and cancel with --role resolve valid ids through loadConfig, which needs a
  // config file; the defaults name every catalog loop.
  writeJsonFile(configPath(root), defaultConfig());
  return root;
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
  const o = await expectFailAsync(() => cmdPrompt(root, ["--role", "no-such-loop", "hello"]));
  assert.match(o, /tumwater: .*no-such-loop/);
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
  const o = await expectFailAsync(() => cmdPrompt(root, ["--cancel", "1"]));
  assert.match(o, /position 1 is queued for more than one loop/);
  assert.match(o, /--role/);
  // Nothing was removed by the refused cancel.
  assert.equal(inboxSize(root, DIRECTOR_ROLE), 1);
  assert.equal(inboxSize(root, "clean"), 1);
});

test("prompt cancel without --role misses cleanly when no loop's queue reaches the position", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, "clean", "only one");
  const o = await expectFailAsync(() => cmdPrompt(root, ["--cancel", "3"]));
  assert.match(o, /no prompt at position 3 \(1 queued across all loops\)/);
});

test("prompt cancel --role succeeds in scope and fails out of range with the queue count", async () => {
  const root = makeRoot();
  enqueueRolePrompt(root, "clean", "a");
  enqueueRolePrompt(root, "clean", "b");
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--cancel", "1", "--role", "clean"]));
  // A --role-scoped cancel already names the loop in the command, so the reply does not repeat it.
  assert.equal(stdout, "cancelled: a\n");
  assert.equal(inboxSize(root, "clean"), 1);
  const o = await expectFailAsync(() => cmdPrompt(root, ["--cancel", "5", "--role", "clean"]));
  assert.match(o, /no prompt at position 5 \(1 queued\)/);
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
test("prompt --at 90m queues a prompt whose marker decodes to now+90m", async (t) => {
  const root = makeRoot();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--at", "90m", "re-check coverage"]));
  // The confirmation names the delivery delay in the same duration vocabulary --at parsed.
  assert.match(stdout, /queued for the director loop — delivers in 90m/);
  const file = fs.readdirSync(dirOf(root, DIRECTOR_ROLE)).filter((f) => f.endsWith(".md"))[0];
  const text = fs.readFileSync(path.join(dirOf(root, DIRECTOR_ROLE), file ?? ""), "utf8");
  assert.equal(notBeforeMs(text), Date.now() + 90 * 60_000);
  // The store's deliverability filter sees it as not yet deliverable.
  assert.equal(inboxSize(root), 0);
});

test("prompt --at composes with --role and defers that loop's queue", async (t) => {
  const root = makeRoot();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await expectOk(() => cmdPrompt(root, ["--at", "2h", "--role", "clean", "look again"]));
  const file = fs.readdirSync(dirOf(root, "clean")).filter((f) => f.endsWith(".md"))[0];
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
  t.mock.timers.tick(91 * 60_000);
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

  // One prompt_edited event under the target loop per successful edit.
  const events = eventsOfType(root, "prompt_edited");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.loop, "bugfix");
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

  // Two loops show "1." in --list: the ambiguity names them and the --role escape hatch.
  const ambiguous = await expectFailAsync(() => cmdPrompt(root, ["--edit", "1", "edited"]));
  assert.match(ambiguous, /position 1 is queued for more than one loop \(director, clean\) — name one with --role <id>/);
  assert.deepEqual(queuedRolePrompts(root, "clean"), ["also first"], "an ambiguity edits nothing");

  const missing = await expectFailAsync(() => cmdPrompt(root, ["--edit", "5", "edited"]));
  assert.match(missing, /no prompt at position 5 \(1 queued across all loops\)/);

  // Cancel clean's entry, so only the director holds position 1: the edit resolves there
  // and its confirmation names the loop, since the caller scoped nothing.
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
  assert.match((await expectFailAsync(() => cmdPrompt(root, ["--edit", "1", "fix", "--file", "x.txt"]))), /--file only queues a prompt/);
  assert.match((await expectFailAsync(() => cmdPrompt(root, ["old", "--edit", "1", "new"]))), /unexpected argument "old"/);

  const outOfRange = await expectFailAsync(() => cmdPrompt(root, ["--role", "bugfix", "--edit", "9", "new"]));
  assert.match(outOfRange, /no prompt at position 9 \(1 queued\)/);
  assert.equal(eventsOfType(root, "prompt_edited").length, 0, "no event on a failed edit");
});

// --- --attach <path> ---

test("prompt --attach saves the image beside the queue file, ends the text with the reference line, and names the count", async () => {
  const root = makeRoot();
  const img = path.join(root, "shot.png");
  fs.writeFileSync(img, Buffer.from("png-bytes"));
  const { stdout } = await expectOk(() => cmdPrompt(root, ["--role", "feature", "--attach", img, "fix the layout"]));
  assert.match(stdout, /queued for the feature loop with 1 image\(s\)/);
  const dir = dirOf(root, "feature");
  const md = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.equal(md.length, 1);
  const text = fs.readFileSync(path.join(dir, md[0] as string), "utf8");
  // The reference line is the queue file's last line, naming the absolute saved path.
  const refLine = text.trimEnd().split("\n").pop() as string;
  const m = refLine.match(/^\[image attached: (.+)\]$/) ?? [];
  const saved = m[1] as string;
  assert.ok(fs.statSync(saved).size > 0, "the image bytes landed beside the queue file");
  assert.equal(path.basename(saved), (md[0] as string).replace(/\.md$/, "") + ".png");
  // The queued text the loop dequeues carries the same reference line.
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
  assert.match(stdout, /with 2 image\(s\)/);
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
