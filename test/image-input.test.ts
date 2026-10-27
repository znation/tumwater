import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerAgentBackend } from "../src/agent/agent-backend.js";
import { piBackend } from "../src/pi/pi-backend.js";
import { claudeBackend } from "../src/agent/claude/claude-backend.js";
import { readPiProviders } from "../src/pi/pi-models.js";
import type { PiListedModels } from "../src/pi/pi-listed-models.js";
import { seamImageInput } from "../src/agent/image-input.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// Unit coverage for the image-input capability resolver (src/agent/image-input.ts, part 1/5):
// seamImageInput reads a seam's declared image input (claude via the backend hook, pi from
// models.json's `input` or the saved `--list-models` catalog). No probe, no process, no runtime
// behavior change.

// The real pi and claude adapters, so seamImageInput routes through the authentic hooks the
// registry owns (claude → true for every model, pi → models.json's input).
registerAgentBackend(piBackend);
registerAgentBackend(claudeBackend);

/** A models.json with text-only and vision models, all unpriced (free), plus pairs missing from
 * it for the null case. */
function writeModels(): string {
  const dir = tmpdir("image-input-models-");
  const file = path.join(dir, "models.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      providers: {
        local: {
          models: [
            { id: "text" }, // no input → pi's text-only default
            { id: "textlist", input: ["text"] }, // present without "image" → text-only
            { id: "vision", input: ["text", "image"] },
            { id: "smallvision", input: ["text", "image"] },
            { id: "fb-text" },
            { id: "fb-vision", input: ["text", "image"] },
          ],
        },
      },
    }),
  );
  return file;
}

test("seamImageInput: a claude seam reads true for any model", () => {
  // The provider is irrelevant — the backend hook owns the answer for claude.
  assert.equal(seamImageInput({ agent: "claude", model: "claude-opus-5-5" }, null), true);
  assert.equal(seamImageInput({ agent: "claude", model: "claude-sonnet-5-5" }, null), true);
});

test("seamImageInput: a pi pair follows models.json input — image → true, text-only or absent → false, missing pair → null", () => {
  const providers = readPiProviders(writeModels());
  // Declared image support.
  assert.equal(seamImageInput({ provider: "local", model: "vision" }, providers), true);
  // Declared text-only, either by an explicit input list without "image" or by omitting input.
  assert.equal(seamImageInput({ provider: "local", model: "textlist" }, providers), false);
  assert.equal(seamImageInput({ provider: "local", model: "text" }, providers), false);
  // A pair missing from models.json is unknown — never assumed, left to `tier models`.
  assert.equal(seamImageInput({ provider: "local", model: "ghost" }, providers), null);
  // Omitted provider/model names pi's default, which is not in the catalog → unknown.
  assert.equal(seamImageInput({ model: "anything" }, providers), null);
  // A missing definitions file is unknown for every pi pair.
  assert.equal(seamImageInput({ provider: "local", model: "vision" }, null), null);
});

// ── Pi's built-in catalog (plans/image-input.md "Capability"): a pair models.json does not
// define answers what `pi --list-models` last said.

const LISTED: PiListedModels = { checkedAt: 0, images: { "builtin/vision-x": true, "builtin/text-x": false } };

test("seamImageInput reads pi's listed images column for a pair models.json does not define", () => {
  const providers = readPiProviders(writeModels());
  const read = (model: string, listed: PiListedModels | null) =>
    seamImageInput({ provider: "builtin", model }, providers, listed);
  assert.equal(read("vision-x", LISTED), true);
  assert.equal(read("text-x", LISTED), false);
  assert.equal(read("other", LISTED), null);
  for (const model of ["vision-x", "text-x", "other"]) assert.equal(read(model, null), null);
  // models.json wins for a pair it defines, even when the listing says the opposite.
  const opposite: PiListedModels = { checkedAt: 0, images: { "local/vision": false, "local/text": true } };
  assert.equal(seamImageInput({ provider: "local", model: "vision" }, providers, opposite), true);
  assert.equal(seamImageInput({ provider: "local", model: "text" }, providers, opposite), false);
});
