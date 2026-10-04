import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { dequeuePrompt, inboxSize, queuedRolePrompts } from "../src/inbox.js";
import { DIRECTOR_PROMPT_MAX_CHARS, submitPrompt, submitRolePrompt } from "../src/inbox-submit.js";
import { eventsOfType } from "./log-fixtures.js";
import { tmpdir } from "./repo-fixtures.js";

// The submission pipeline (src/inbox-submit.ts): the shared length cap and the submit
// wrappers the TUI, GUI, and CLI go through. The queue store's mechanics are pinned in
// test/inbox.test.ts; the image side in test/inbox-attachments.test.ts.

test("submitPrompt trims, enqueues, and logs a prompt_enqueued event", () => {
  const dir = tmpdir();
  const long = "x".repeat(120);
  const queued = submitPrompt(dir, `  ${long}  `);
  assert.equal(queued, long); // trimmed
  assert.equal(inboxSize(dir), 1);
  assert.equal(dequeuePrompt(dir), long);
  const events = eventsOfType(dir, "prompt_enqueued");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.loop, "director");
  assert.equal(
    String(events[0]?.preview),
    `${"x".repeat(79)}…`, // preview capped at 80 chars, ellipsis included (truncate)
  );
});

test("submitPrompt rejects an over-long prompt before anything is queued or logged", () => {
  const dir = tmpdir();
  const over = "x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 1);
  assert.throws(() => submitPrompt(dir, over), (err: unknown) => {
    const message = String((err as Error).message);
    // Name the fix: the offending length, the ceiling, and why it exists.
    return (
      message.includes(`${over.length} chars`) &&
      message.includes(String(DIRECTOR_PROMPT_MAX_CHARS)) &&
      message.includes("prefill")
    );
  });
  assert.equal(inboxSize(dir), 0); // rejected before the queue write
  assert.equal(
    eventsOfType(dir, "prompt_enqueued").length,
    0, // and before the event log too
  );
  // Exactly at the cap is fine — the check is a ceiling, not a floor off by one.
  const queued = submitPrompt(dir, "x".repeat(DIRECTOR_PROMPT_MAX_CHARS));
  assert.equal(queued.length, DIRECTOR_PROMPT_MAX_CHARS);
  assert.equal(inboxSize(dir), 1);
});

test("submitPrompt's event preview never carries a lone surrogate", () => {
  const dir = tmpdir();
  submitPrompt(dir, `${"x".repeat(78)}🎉y`); // the emoji straddles the cut point (code unit 79)
  const events = eventsOfType(dir, "prompt_enqueued");
  assert.equal(events.length, 1);
  // The pair is dropped whole rather than split: no lone high surrogate at the cut.
  assert.equal(String(events[0]?.preview), `${"x".repeat(78)}…`);
});

test("a role prompt's over-cap error names the target loop's tick, not the director's", () => {
  const dir = tmpdir();
  const over = "x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 1);
  assert.throws(() => submitRolePrompt(dir, "qa", over), (err: unknown) => {
    const message = String((err as Error).message);
    // The cap is shared, but the reason names the loop the prompt actually rides into:
    // `tumwater prompt --role qa` that says "director" points the operator at the wrong queue.
    return message.includes("the qa tick's prefill") && !message.includes("director");
  });
  assert.equal(inboxSize(dir, "qa"), 0); // rejected before the queue write
  assert.equal(eventsOfType(dir, "prompt_enqueued").length, 0);
});

test("the director prompt length cap applies to role prompts too", () => {
  const dir = tmpdir();
  const long = "x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 1);
  assert.throws(() => submitRolePrompt(dir, "qa", long), /shorten it to at most/);
  assert.deepEqual(queuedRolePrompts(dir, "qa"), [], "an over-long prompt is never queued");
});

test("an image-carrying prompt is capped on its composed text, not its body alone", () => {
  const dir = tmpdir();
  // The body fits (50 chars of headroom) but the four [image attached: …] reference
  // lines push the composed text past the cap — the lines ride into the tick's prefill
  // exactly like the body, so the cap must see them.
  const body = "x".repeat(DIRECTOR_PROMPT_MAX_CHARS - 50);
  const images = Array.from({ length: 4 }, (_, i) => ({
    name: `shot${i}.png`,
    dataBase64: Buffer.from("a").toString("base64"),
  }));
  assert.throws(() => submitRolePrompt(dir, "qa", body, images), (err: unknown) => {
    const message = String((err as Error).message);
    return message.includes("chars") && message.includes(String(DIRECTOR_PROMPT_MAX_CHARS));
  });
  assert.equal(queuedRolePrompts(dir, "qa").length, 0, "nothing was queued");
  assert.equal(eventsOfType(dir, "prompt_enqueued").length, 0, "and nothing was logged");
  // The images saved before the length check fired are removed again: with no queue
  // file, nothing would ever dequeue them, so they must not linger in the inbox dir.
  const inboxDir = `${dir}/.tumwater/inbox/qa`;
  assert.ok(!fs.existsSync(inboxDir) || fs.readdirSync(inboxDir).length === 0, "no orphan image files remain");
  // The same composition under the cap still queues fine.
  const short = submitRolePrompt(dir, "qa", "look at this", images);
  assert.ok(short.includes("[image attached: "));
  assert.equal(queuedRolePrompts(dir, "qa").length, 1);
});
