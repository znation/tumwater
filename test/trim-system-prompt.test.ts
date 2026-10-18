import test from "node:test";
import assert from "node:assert/strict";
import trimSystemPrompt, { withoutDocsSection } from "../src/pi-extension/trim-system-prompt.js";

// The bundled trim-system-prompt extension (src/pi-extension/trim-system-prompt.ts): on every
// model, pi's system prompt goes out without its docs section; everything else in it is pi's own
// text.

/** pi 1.2.0's default system prompt, as it renders its sections (shortened). */
const SYSTEM = [
  "You are an expert coding assistant operating inside pi, a coding agent harness.",
  "<tools>\n- read: Read file contents\n- bash: Execute bash commands\n</tools>",
  "<rules>\n- Use read to examine files instead of cat or sed.\n</rules>",
  "<docs>\nPi documentation (read only when the user asks about pi itself):\n- Main documentation: /opt/pi/README.md\n</docs>",
  "<cwd>\n/work/tree\n</cwd>",
].join("\n\n");

test("withoutDocsSection cuts the docs section and keeps every other section byte for byte", () => {
  const trimmed = withoutDocsSection(SYSTEM);
  assert.ok(trimmed);
  assert.ok(!trimmed.includes("<docs>") && !trimmed.includes("Pi documentation"));
  assert.equal(trimmed, SYSTEM.replace(/\n\n<docs>[\s\S]*<\/docs>/, ""));
  assert.match(trimmed, /<\/rules>\n\n<cwd>\n\/work\/tree\n<\/cwd>$/);
});

test("withoutDocsSection leaves a prompt with no docs section alone", () => {
  assert.equal(withoutDocsSection("A custom system prompt."), null);
  // A docs section last in the prompt goes with the blank lines before it.
  assert.equal(withoutDocsSection("pre\n\n<docs>\nd\n</docs>"), "pre");
});

type Handler = (event: { systemPrompt?: unknown }, ctx?: { model?: { contextWindow?: unknown } }) => unknown;

function loadHandler(): Handler {
  let handler: Handler | undefined;
  trimSystemPrompt({
    on(event, fn) {
      assert.equal(event, "before_agent_start");
      handler = fn as Handler;
    },
  });
  assert.ok(handler);
  return handler;
}

test("the extension trims on every model, whatever window it declares", () => {
  const handler = loadHandler();
  const trimmed = { systemPrompt: withoutDocsSection(SYSTEM) };
  for (const window of [65_536, 131_072, 1_048_576]) {
    assert.deepEqual(handler({ systemPrompt: SYSTEM }, { model: { contextWindow: window } }), trimmed, String(window));
  }
  assert.deepEqual(handler({ systemPrompt: SYSTEM }, undefined), trimmed, "an unknown model is trimmed too");
  assert.equal(handler({ systemPrompt: "custom" }, { model: { contextWindow: 65_536 } }), undefined);
  assert.equal(handler({}, { model: { contextWindow: 65_536 } }), undefined);
});
