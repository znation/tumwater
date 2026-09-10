import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import { fleetModelsFree, piModelsPath } from "../src/pi-models.js";
import type { TumwaterConfig } from "../src/types.js";
import { tmpdir } from "./util.js";

/** A models.json shaped like the one on a local-model machine: an unpriced model (no cost
 * field), an all-zero-cost model, and a paid one. */
const MODELS_JSON = JSON.stringify({
  providers: {
    "lm-studio": {
      baseUrl: "http://127.0.0.1:1234/v1",
      api: "openai-responses",
      models: [
        { id: "qwen3.8-27b", name: "qwen3.8-27b" }, // no cost field — free
        { id: "zero-cost", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, // all zero — free
      ],
    },
    paid: {
      models: [{ id: "gpt-x", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.4 } }],
    },
  },
});

function writeModels(content = MODELS_JSON): string {
  const dir = tmpdir("pi-models-");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "models.json");
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

/** A config with every role and the reviewer pointed at one provider/model. */
function fleetAt(provider: string | undefined, model: string | undefined): TumwaterConfig {
  const cfg = defaultConfig();
  cfg.provider = provider;
  cfg.model = model; // review falls back to the same top-level values
  return cfg;
}

test("piModelsPath points at pi's agent models.json under the home dir", () => {
  assert.match(piModelsPath(), /[/\\]\.pi[/\\]agent[/\\]models\.json$/);
});

test("a fleet whose every model is unpriced or zero-cost reads free", () => {
  const file = writeModels();
  assert.equal(fleetModelsFree(fleetAt("lm-studio", "qwen3.8-27b"), file), true, "no cost field");
  assert.equal(fleetModelsFree(fleetAt("lm-studio", "zero-cost"), file), true, "all-zero cost");
});

test("one paid model anywhere in the fleet keeps the dollar badge", () => {
  const file = writeModels();
  // Top-level pair is free; a single role override to a paid model must flip the answer.
  const cfg = fleetAt("lm-studio", "qwen3.8-27b");
  cfg.roles.clean!.provider = "paid";
  cfg.roles.clean!.model = "gpt-x";
  assert.equal(fleetModelsFree(cfg, file), false);

  // The reviewer's own override counts too — it runs pi as well.
  const reviewPaid = fleetAt("lm-studio", "qwen3.8-27b");
  reviewPaid.review.provider = "paid";
  reviewPaid.review.model = "gpt-x";
  assert.equal(fleetModelsFree(reviewPaid, file), false);

  // …but a disabled reviewer is not consulted: the same override with review off stays free.
  const reviewOff = fleetAt("lm-studio", "qwen3.8-27b");
  reviewOff.review.enabled = false;
  reviewOff.review.provider = "paid";
  reviewOff.review.model = "gpt-x";
  assert.equal(fleetModelsFree(reviewOff, file), true);
});

test("unresolvable pairs count as not free (the safe direction)", () => {
  const file = writeModels();
  // Omitted provider/model means pi's own default — it may well be a paid built-in.
  assert.equal(fleetModelsFree(defaultConfig(), file), false, "omitted pair");
  assert.equal(fleetModelsFree(fleetAt("lm-studio", undefined), file), false, "model omitted");
  // Known provider, unknown model id.
  assert.equal(fleetModelsFree(fleetAt("lm-studio", "no-such-model"), file), false);
  // Unknown provider (e.g. a pi built-in not in models.json).
  assert.equal(fleetModelsFree(fleetAt("openai", "gpt-x"), file), false);
});

test("missing or malformed definitions files count as not free, never throw", () => {
  const cfg = fleetAt("lm-studio", "qwen3.8-27b");
  assert.equal(fleetModelsFree(cfg, path.join(tmpdir(), "absent.json")), false, "missing file");
  assert.equal(fleetModelsFree(cfg, writeModels("{ not json")), false, "malformed JSON");
  assert.equal(fleetModelsFree(cfg, writeModels(JSON.stringify({ models: [] }))), false, "no providers key");
});

test("a fleet with no enabled roles and review off cannot spend — free by construction", () => {
  const cfg = defaultConfig();
  for (const id of Object.keys(cfg.roles)) cfg.roles[id]!.enabled = false;
  cfg.review.enabled = false;
  // No definitions file at all: there is nothing to consult.
  assert.equal(fleetModelsFree(cfg, path.join(tmpdir(), "absent.json")), true);
});
