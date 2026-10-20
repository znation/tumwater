import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { dequeuePrompt, inboxSize, queuedRolePrompts } from "../src/inbox/inbox.js";
import { DIRECTOR_PROMPT_MAX_CHARS, imagePromptGuidance, submitPrompt, submitRolePrompt } from "../src/inbox/inbox-submit.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { writeModelsFile } from "./fixtures/models-fixtures.js";
import { imageProbeKey, writeImageProbeCache } from "../src/doctor/image-probe.js";

// The submission pipeline (src/inbox/inbox-submit.ts): the shared length cap and the submit
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
  assert.equal(events[0]?.source, "director");
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

test("a role prompt's over-cap error names the target role's tick, not the director's", () => {
  const dir = tmpdir();
  const over = "x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 1);
  assert.throws(() => submitRolePrompt(dir, "qa", over), (err: unknown) => {
    const message = String((err as Error).message);
    // The cap is shared, but the reason names the role the prompt actually rides into:
    // `tumwater prompt --role qa` that says "director" points the operator at the wrong queue.
    return message.includes("the qa run's prefill") && !message.includes("director");
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

// Image input, part 5/5 (plans/image-input.md "Attachments"): the submit gate. An attachment
// to a role whose seam reads no images and that has no reroute target is refused before
// anything is queued or written; with a reroute target the prompt is accepted (its tick would
// rerun on the vision tier, so nothing is refused).
test("image prompts are refused when no configured model reads images, accepted when a tier reroutes", async () => {
  const dir = tmpdir();
  const modelsDir = tmpdir("inbox-image-");
  writeModelsFile(
    modelsDir,
    JSON.stringify({
      providers: {
        local: {
          models: [
            { id: "text" },
            { id: "vision", input: ["text", "image"] },
          ],
        },
      },
    }),
  );
  const img = [{ name: "shot.png", dataBase64: Buffer.from("x").toString("base64") }];
  const saved = process.env.PI_CODING_AGENT_DIR;
  try {
    // roleImageInfo reads pi's models catalog from the default path — point it at our temp one.
    process.env.PI_CODING_AGENT_DIR = modelsDir;

    // No configured model can read images: feature (default tier, text-only) has no target.
    writeConfig(dir, { model: { default: "local/text", strong: "local/text" } });
    assert.throws(() => submitRolePrompt(dir, "feature", "look at this", img), (err: unknown) => {
      const message = String((err as Error).message);
      return (
        message.includes("can't read images") &&
        message.includes("feature") &&
        message.includes("no configured model reads images") &&
        message.includes("models.json")
      );
    });
    assert.equal(queuedRolePrompts(dir, "feature").length, 0, "nothing was queued after the refusal");

    // A vision strong tier reroutes a blind read, so the same prompt is accepted and queued.
    writeConfig(dir, { model: { default: "local/text", strong: "local/vision" } });
    const queued = submitRolePrompt(dir, "feature", "look at this", img);
    assert.ok(queued.includes("[image attached: "));
    assert.equal(queuedRolePrompts(dir, "feature").length, 1);
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

// The same capability answers the CLI/GUI display: imagePromptGuidance names where a blind
// prompt runs (the notice surfaces print), and refuses with the fix when nothing reads images.
test("imagePromptGuidance returns a refusal or a reroute notice, and nothing when the role reads images", async () => {
  const dir = tmpdir();
  const modelsDir = tmpdir("inbox-guidance-");
  writeModelsFile(
    modelsDir,
    JSON.stringify({
      providers: {
        local: {
          models: [{ id: "text" }, { id: "vision", input: ["text", "image"] }],
        },
      },
    }),
  );
  const saved = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = modelsDir;
    writeConfig(dir, { model: { default: "local/text", strong: "local/vision" } });
    const guidance = imagePromptGuidance(dir, "feature");
    assert.deepEqual(guidance.refusal, undefined);
    assert.match(guidance.notice ?? "", /feature's model can't read images; this prompt runs on strong \(local\/vision\)/);
    // A vision role says nothing.
    writeConfig(dir, { model: { default: "local/vision", strong: "local/vision" } });
    assert.deepEqual(imagePromptGuidance(dir, "feature"), {});
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

// The gate reads the same probe cache the status rows and role page read (part 5/5): a claimed
// pi model whose doctor probe failed is text-only to the submit gate too, so the gate never
// grants image capability the surfaces report as absent (the review objection that the gate
// dropped readImageProbeCache).
test("imagePromptGuidance treats a probe-failed pi claim as text-only, matching the surfaces", async () => {
  const dir = tmpdir();
  const modelsDir = tmpdir("inbox-guidance-probe-");
  writeModelsFile(
    modelsDir,
    JSON.stringify({
      providers: {
        local: {
          models: [{ id: "vision", input: ["text", "image"] }],
        },
      },
    }),
  );
  const saved = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = modelsDir;
    writeConfig(dir, { model: { default: "local/vision", strong: "local/vision" } });
    // No probe verdict yet: the claim stands on the catalog, so the role reads images.
    assert.deepEqual(imagePromptGuidance(dir, "feature"), {});
    // A fresh failing probe overrides the claim: the role is text-only, and with no other tier
    // able to read images (its strong also probe-fails) the gate refuses instead of granting.
    writeImageProbeCache(dir, {
      [imageProbeKey("pi", "local", "vision")]: { verdict: "fail", detail: "answered 429", at: Date.now(), claim: true },
    });
    assert.match(imagePromptGuidance(dir, "feature").refusal ?? "", /can't read images/);
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});
