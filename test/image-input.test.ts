import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerAgentBackend } from "../src/agent/agent-backend.js";
import { piBackend } from "../src/pi/pi-backend.js";
import { claudeBackend } from "../src/agent/claude/claude-backend.js";
import { loadConfig } from "../src/config/config.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { readPiProviders } from "../src/pi/pi-models.js";
import type { PiListedModels } from "../src/pi/pi-listed-models.js";
import { imageReroute, imageRerouteTarget, seamImageInput } from "../src/agent/image-input.js";
import { imageProbeKey, IMAGE_PROBE_TTL_MS, type ImageProbeCache } from "../src/doctor/image-probe.js";
import { tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { readyRepo } from "./fixtures/doctor-fixtures.js";

// Unit coverage for the image-input capability resolver (src/agent/image-input.ts, part 1/5):
// seamImageInput reads a seam's declared image input (claude via the backend hook, pi from
// models.json's `input`), and imageRerouteTarget walks the borrow order for an image-capable
// peer tier, honorably only ever looking at free fallback pairs in the fallback regime. No
// probe, no process, no runtime behavior change. The doctor's `image input` check sits in
// test/doctor-model-checks.test.ts.

// The real pi and claude adapters, so seamImageInput routes through the authentic hooks the
// registry owns (claude → true for every model, pi → models.json's input).
registerAgentBackend(piBackend);
registerAgentBackend(claudeBackend);

/** A models.json with text-only and vision models, all unpriced (free) so the fallback regime
 * can use them, plus pairs missing from it for the null case. */
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

/** A full, validated TumwaterConfig (defaults overlaid) carrying just the model/fallback/roles
 * the test names. All catalog roles stay enabled by default — the reroute tests use roles whose
 * tier is fixed (feature → default, director → strong), so the extra roles do not interfere. */
function rerouteConfig(extra: Record<string, unknown>): TumwaterConfig {
  const root = readyRepo();
  writeConfig(root, extra);
  return loadConfig(root);
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

test("imageRerouteTarget: from default picks strong before small", () => {
  // The feature role rides the default tier.
  const config = rerouteConfig({ model: { default: "local/text", strong: "local/vision", small: "local/smallvision" } });
  const target = imageRerouteTarget(config, "feature", "primary", writeModels());
  assert.ok(target, "expected a reroute target");
  assert.equal(target?.provider, "local");
  assert.equal(target?.model, "vision"); // strong, before small
});

test("imageRerouteTarget: from strong never drops to small", () => {
  // The director rides the strong tier; strong's own model is gone, default is text-only, and
  // only small can read images — a strong-tier seam must not drop to small.
  const config = rerouteConfig({ model: { default: "local/text", strong: "local/text2", small: "local/smallvision" } });
  assert.equal(imageRerouteTarget(config, "director", "primary", writeModels()), null);
});

test("imageRerouteTarget: returns null when no other tier reads images", () => {
  const config = rerouteConfig({ model: { default: "local/text", strong: "local/textlist", small: "local/text2" } });
  assert.equal(imageRerouteTarget(config, "feature", "primary", writeModels()), null);
});

test("imageRerouteTarget: fallback regime considers only free fallback pairs, never a priced primary", () => {
  const models = writeModels();
  // strong's PRIMARY reads images, but in the fallback regime the reroute must look only at the
  // tiers' free fallback pairs — strong's declared fallback is text-only, so there is no target
  // even though the primary strong model could read images past the cap.
  const config = rerouteConfig({
    model: { default: "local/text", strong: "local/vision" },
    fallback: { default: "local/fb-text", strong: "local/fb-text" },
  });
  assert.equal(imageRerouteTarget(config, "feature", "fallback", models), null);

  // A vision free fallback on the strong tier gives the reroute its target.
  config.fallback = { default: "local/fb-text", strong: "local/fb-vision" };
  const target = imageRerouteTarget(config, "feature", "fallback", models);
  assert.ok(target, "expected a fallback-regime reroute target");
  assert.equal(target?.provider, "local");
  assert.equal(target?.model, "fb-vision");
});

test("imageReroute exposes the tier a surface names", () => {
  const config = rerouteConfig({ model: { default: "local/text", strong: "local/vision", small: "local/smallvision" } });
  const rr = imageReroute(config, "feature", "primary", writeModels());
  assert.ok(rr);
  assert.equal(rr?.tier, "strong");
  assert.equal(rr?.config.model, "vision");
});

// ── The live-probe seam (part 2/5): a cached failed probe drops a claimed model's capability.

test("seamImageInput honors a fresh cached failed probe (claimed model reads false)", () => {
  const providers = readPiProviders(writeModels());
  const probes: ImageProbeCache = {
    [imageProbeKey("pi", "local", "vision")]: { verdict: "fail", detail: 'answered "1234"', at: Date.now(), claim: true },
  };
  assert.equal(seamImageInput({ provider: "local", model: "vision" }, providers, probes), false);
});

test("seamImageInput ignores a stale failed probe (past the 7-day TTL)", () => {
  const providers = readPiProviders(writeModels());
  const probes: ImageProbeCache = {
    [imageProbeKey("pi", "local", "vision")]: {
      verdict: "fail",
      detail: "stale",
      at: Date.now() - IMAGE_PROBE_TTL_MS - 1,
      claim: true,
    },
  };
  assert.equal(seamImageInput({ provider: "local", model: "vision" }, providers, probes), true);
});

test("seamImageInput never overrides a claude seam (claude is never probed)", () => {
  assert.equal(seamImageInput({ agent: "claude", model: "claude-sonnet-5-5" }, null, {}), true);
});

test("imageReroute skips a strong tier whose probe failed and falls through to small", () => {
  const config = rerouteConfig({ model: { default: "local/text", strong: "local/vision", small: "local/smallvision" } });
  const probes: ImageProbeCache = {
    [imageProbeKey("pi", "local", "vision")]: { verdict: "fail", detail: "x", at: Date.now(), claim: true },
  };
  const target = imageRerouteTarget(config, "feature", "primary", writeModels(), null, probes);
  assert.ok(target);
  assert.equal(target?.model, "smallvision");
});

// The write-side/read-side link for a FALLBACK pair (objection: the doctor's fallback loop must
// cache under the same "pi" agent segment the readers look up, so a free fallback pair that
// fails its probe is dropped by imageReroute instead of promised as a reroute target).
test("imageReroute fallback regime drops a free fallback pair whose probe failed (cached under the pi agent key)", () => {
  const config = rerouteConfig({
    model: { default: "local/text", strong: "local/text" },
    fallback: { default: "local/fb-text", strong: "local/fb-vision" },
  });
  const models = writeModels();
  // Without a probe the vision free fallback is the reroute target (the existing test proves it).
  assert.equal(imageRerouteTarget(config, "feature", "fallback", models)?.model, "fb-vision");
  // A failed probe cached under imageProbeKey("pi", …) — the key the doctor's fallback loop now
  // writes — drops the free fallback pair, so there is no target that cannot actually see.
  const probes: ImageProbeCache = {
    [imageProbeKey("pi", "local", "fb-vision")]: { verdict: "fail", detail: 'answered "1234"', at: Date.now(), claim: true },
  };
  assert.equal(imageRerouteTarget(config, "feature", "fallback", models, null, probes), null);
});

// ── Pi's built-in catalog (plans/image-input.md "Capability"): a pair models.json does not
// define answers what `pi --list-models` last said.

const LISTED: PiListedModels = { checkedAt: 0, images: { "builtin/vision-x": true, "builtin/text-x": false } };

test("seamImageInput reads pi's listed images column for a pair models.json does not define", () => {
  const providers = readPiProviders(writeModels());
  const read = (model: string, listed: PiListedModels | null) =>
    seamImageInput({ provider: "builtin", model }, providers, undefined, listed);
  assert.equal(read("vision-x", LISTED), true);
  assert.equal(read("text-x", LISTED), false);
  assert.equal(read("other", LISTED), null);
  for (const model of ["vision-x", "text-x", "other"]) assert.equal(read(model, null), null);
  // models.json wins for a pair it defines, even when the listing says the opposite.
  const opposite: PiListedModels = { checkedAt: 0, images: { "local/vision": false, "local/text": true } };
  assert.equal(seamImageInput({ provider: "local", model: "vision" }, providers, undefined, opposite), true);
  assert.equal(seamImageInput({ provider: "local", model: "text" }, providers, undefined, opposite), false);
  // A fresh failed probe turns a listed claim false.
  const probes: ImageProbeCache = {
    [imageProbeKey("pi", "builtin", "vision-x")]: { verdict: "fail", detail: "no", at: Date.now(), claim: true },
  };
  assert.equal(seamImageInput({ provider: "builtin", model: "vision-x" }, providers, probes, LISTED), false);
});

test("imageReroute picks a tier whose built-in model pi lists as reading images", () => {
  const config = rerouteConfig({ model: { default: "local/text", strong: "builtin/vision-x" } });
  const models = writeModels();
  assert.equal(imageReroute(config, "feature", "primary", models, null, undefined, null, LISTED)?.tier, "strong");
  assert.equal(imageReroute(config, "feature", "primary", models), null);
});
