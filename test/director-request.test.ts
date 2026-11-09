import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyDirectorRequest } from "../src/inbox/director-request.js";
import { directorRequestPath } from "../src/paths.js";
import { DIRECTOR_PROMPT_MAX_CHARS, submitRolePrompt } from "../src/inbox/inbox-submit.js";
import { inboxSize, queuedRolePrompts } from "../src/inbox/inbox.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { withReadOnlyDir } from "./helpers/fs-faults.js";
import { initializedRepo, initializedWorktree, skipIfRoot, tmpdir } from "./fixtures/repo-fixtures.js";

/** Unit coverage for src/inbox/director-request.ts (INV-B8): the bugfix role's
 * cannot-reproduce handoff file is consumed into one director prompt and deleted on every
 * path, so it never enters a diff. */

test("an absent director request reads null and queues nothing", async () => {
  const { root, wt } = await initializedWorktree("bugfix");
  assert.equal(applyDirectorRequest(root, wt), null);
  assert.equal(inboxSize(root, "director"), 0);
  assert.deepEqual(eventsOfType(root, "prompt_enqueued"), []);
});

test("a valid director request queues the composed text under director and deletes the file", async () => {
  const { root, wt } = await initializedWorktree("bugfix");
  const body = "### entry heading\nattempt 1: test X fails with Y\nfailure message: Z";
  fs.writeFileSync(directorRequestPath(wt), body);

  const out = applyDirectorRequest(root, wt);
  assert.deepEqual(out, { queued: true });
  assert.ok(!fs.existsSync(directorRequestPath(wt)), "the file is deleted before staging");

  const queued = queuedRolePrompts(root, "director");
  assert.equal(queued.length, 1, "exactly one director prompt");
  const text = queued[0]!;
  assert.ok(text.includes("could not reproduce this bug"), "the fixed preamble rides first");
  assert.ok(text.includes(body), "the request body rides between the framing");
  assert.ok(text.includes("by director: <what the user must decide>"), "the fixed ask rides last");
  assert.ok(text.startsWith("The bugfix role could not reproduce this bug"), "preamble leads the text");

  const events = eventsOfType(root, "prompt_enqueued");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.source, "director", "the event names the director");
});

test("an empty or whitespace-only body is an error and the file is still deleted", async () => {
  const { root, wt } = await initializedWorktree("bugfix");
  fs.writeFileSync(directorRequestPath(wt), "   \n\t ");

  const out = applyDirectorRequest(root, wt);
  assert.deepEqual(out, { error: "director request body is empty" });
  assert.ok(!fs.existsSync(directorRequestPath(wt)), "the empty file is deleted too");
  assert.equal(inboxSize(root, "director"), 0, "nothing was queued");
});

test("an over-cap body is truncated to fit, queued, and the file is deleted", async () => {
  const { root, wt } = await initializedWorktree("bugfix");
  // A body over ~3659 chars makes the composed text (preamble + body + ask) over the 4096 cap
  // too: rather than reject and drop the request, the body is truncated to fit so the request
  // is always queued and the director is always told.
  fs.writeFileSync(directorRequestPath(wt), "x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 10));

  const out = applyDirectorRequest(root, wt);
  assert.deepEqual(out, { queued: true }, "an over-cap body is truncated and queued, not rejected");
  assert.ok(!fs.existsSync(directorRequestPath(wt)), "the over-cap file is deleted too");
  const queued = queuedRolePrompts(root, "director");
  assert.equal(queued.length, 1, "exactly one director prompt");
  assert.ok(queued[0]!.includes("…[body over the prompt cap; truncated]"), "the visible note signals the cap");
  assert.ok(queued[0]!.length <= DIRECTOR_PROMPT_MAX_CHARS, "the composed prompt fits the cap");
  assert.ok(!queued[0]!.includes("x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 10)), "the body was truncated, not queued whole");
});

test("an over-cap body carrying astral characters is truncated safely and still queued", async () => {
  const { root, wt } = await initializedWorktree("bugfix");
  // An astral-character body over the cap: the cut must leave the composed text valid UTF-16
  // (no lone surrogate) and under the cap, with the visible note.
  const pair = "\u{1F600}"; // 😀 — a two-code-unit astral character
  fs.writeFileSync(directorRequestPath(wt), (pair + "x").repeat(4000));

  const out = applyDirectorRequest(root, wt);
  assert.deepEqual(out, { queued: true }, "the over-cap body is truncated and queued, not dropped");
  const text = queuedRolePrompts(root, "director")[0]!;
  assert.ok(text.length <= DIRECTOR_PROMPT_MAX_CHARS, "the composed prompt fits the cap");
  assert.ok(text.includes("…[body over the prompt cap; truncated]"), "the visible note signals the cap");
  // A lone high surrogate (a high unit not followed by a low unit) would be a broken cut.
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])/.exec(text);
  assert.equal(lone, null, "no lone high surrogate in the composed text");
});

test("an injected queue throw returns its error and still deletes the file", async () => {
  const { root, wt } = await initializedWorktree("bugfix");
  fs.writeFileSync(directorRequestPath(wt), "body");
  const broken = (_root: string, _role: string, _text: string): string => {
    throw new Error("inbox broken");
  };

  const out = applyDirectorRequest(root, wt, broken);
  assert.deepEqual(out, { error: "inbox broken" });
  assert.ok(!fs.existsSync(directorRequestPath(wt)), "the file is deleted on the throw path too");
});

test("the default queue seam is submitRolePrompt: a real submit enqueues under director", async () => {
  const { root, wt } = await initializedWorktree("bugfix");
  fs.writeFileSync(directorRequestPath(wt), "the body");
  const out = applyDirectorRequest(root, wt);
  assert.deepEqual(out, { queued: true });
  const direct = submitRolePrompt(root, "director", "sanity");
  assert.equal(direct, "sanity");
  assert.equal(inboxSize(root, "director"), 2, "both prompts queued under director");
});

// The one failure the delete-on-every-path rule cannot absorb (INV-B8): the unlink itself
// fails — a permissions surprise on the worktree directory, the same shape as a full disk or
// an externally locked file. The queue happens before the unlink (the prompt is enqueued while
// the request is being consumed), so the director is still told and the file is still on disk
// for a retry, but the caller must surface the failed deletion as an error — never the silent
// { queued: true } the surviving file would otherwise read as — so the run warns and the file
// is never assumed gone. The worktree dir is made read-only, which lets the file be READ
// (searchable) but not unlinked; the queue directory lives under the repo, not the worktree,
// so only the unlink fails. (Mirrors config-request.test.ts's twin for the config-request path.)
test("a valid director request whose unlink fails is still queued, and the failed deletion surfaces as the error", async (t) => {
  if (skipIfRoot(t)) return;
  const root = await initializedRepo();
  const wt = tmpdir();
  fs.writeFileSync(directorRequestPath(wt), "attempt 1: test X fails with Y");
  await withReadOnlyDir(wt, async () => {
    const out = applyDirectorRequest(root, wt);
    assert.notEqual(out, null, "a present request file is never read as null");
    assert.ok(out && "error" in out, "the failed deletion is surfaced, not a clean queue");
    assert.match(out.error, /could not be deleted/, "the error names the undeletable file");
    assert.equal(queuedRolePrompts(root, "director").length, 1, "the queue preceded the failed cleanup, so the director is still told");
    assert.ok(fs.existsSync(directorRequestPath(wt)), "the undeletable request is still on disk for a retry");
  });
});
