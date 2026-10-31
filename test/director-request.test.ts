import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyDirectorRequest } from "../src/inbox/director-request.js";
import { directorRequestPath } from "../src/paths.js";
import { DIRECTOR_PROMPT_MAX_CHARS, submitRolePrompt } from "../src/inbox/inbox-submit.js";
import { inboxSize, queuedRolePrompts } from "../src/inbox/inbox.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { initializedWorktree } from "./fixtures/repo-fixtures.js";

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

test("an over-cap body is rejected by the queue cap and the file is still deleted", async () => {
  const { root, wt } = await initializedWorktree("bugfix");
  // A body over the cap makes the composed text (preamble + body + ask) over it too: the cap
  // is enforced on the final queued text, not the body alone.
  fs.writeFileSync(directorRequestPath(wt), "x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 10));

  const out = applyDirectorRequest(root, wt);
  assert.ok(out && "error" in out, "an error is returned");
  assert.match(out.error, /shorten it to at most/, "the cap's message names the length");
  assert.ok(!fs.existsSync(directorRequestPath(wt)), "the over-cap file is deleted too");
  assert.equal(inboxSize(root, "director"), 0, "nothing was queued");
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
