import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config/config.js";
import { fallbackModelFree, fleetModelsFree, piAgentDir, piModelsPath } from "../src/pi/pi-models.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { tmpdir, writeMalformedJson } from "./fixtures/repo-fixtures.js";

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
  assert.equal(piModelsPath({}, "/h"), path.join("/h", ".pi", "agent", "models.json"));
});

test("piAgentDir honors PI_CODING_AGENT_DIR with pi's tilde rule", () => {
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/x/agent" }, "/h"), "/x/agent");
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "~" }, "/h"), "/h");
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "~/cfg" }, "/h"), path.join("/h", "cfg"));
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "" }, "/h"), path.join("/h", ".pi", "agent"));
  assert.equal(
    piModelsPath({ PI_CODING_AGENT_DIR: "/x/agent" }, "/h"),
    path.join("/x/agent", "models.json"),
  );
});

test("fleetModelsFree reads the models.json under PI_CODING_AGENT_DIR", () => {
  const dir = path.dirname(writeModels());
  const file = piModelsPath({ PI_CODING_AGENT_DIR: dir });
  assert.equal(fleetModelsFree(fleetAt("lm-studio", "qwen3.8-27b"), file), true);
  assert.equal(fleetModelsFree(fleetAt("paid", "gpt-x"), file), false);
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
  assert.equal(fleetModelsFree(cfg, writeMalformedJson(writeModels())), false, "malformed JSON");
  assert.equal(fleetModelsFree(cfg, writeModels(JSON.stringify({ models: [] }))), false, "no providers key");
});

test("an unreadable definitions file exists but cannot be read: not free, never throws, and recovers", () => {
  const cfg = fleetAt("lm-studio", "qwen3.8-27b");
  // A directory at the models.json path stats fine — so the reader must actually attempt the
  // read — but readFileSync fails with EISDIR for every user (unlike a chmod-based fixture,
  // which a root test run would bypass). The failure must take the same safe direction as a
  // missing file: unverifiable is NOT free, and it must not throw into the status poll.
  const file = path.join(tmpdir("pi-models-dir-"), "models.json");
  fs.mkdirSync(file);
  assert.doesNotThrow(() => fleetModelsFree(cfg, file), "an unreadable file must not throw");
  assert.equal(fleetModelsFree(cfg, file), false, "unreadable is not free");
  // Recovery: the failed read is never cached, so once the path holds real definitions the
  // very next poll reads them and the answer flips.
  fs.rmdirSync(file);
  fs.writeFileSync(file, MODELS_JSON);
  assert.equal(fleetModelsFree(cfg, file), true, "recovers once the file is readable");
});

test("a malformed cost shape is unresolvable — never free, never throws", () => {
  const cfg = fleetAt("p", "m");
  // A non-object cost previously read as free (property access off a string/number yields
  // undefined), and a null one threw a TypeError straight into the status poll. Each must now
  // take the safe direction: unverifiable is not free.
  for (const cost of [null, "free", 0, [], { input: "0" }, { input: null }, { input: -1 }, { output: Number.NaN }]) {
    const file = writeModels(JSON.stringify({ providers: { p: { models: [{ id: "m", cost }] } } }));
    assert.doesNotThrow(() => fleetModelsFree(cfg, file), `cost ${JSON.stringify(cost)} must not throw`);
    assert.equal(fleetModelsFree(cfg, file), false, `cost ${JSON.stringify(cost)} is not free`);
  }
  // The zero shapes still read free: an empty cost object and explicitly-zero components.
  assert.equal(
    fleetModelsFree(cfg, writeModels(JSON.stringify({ providers: { p: { models: [{ id: "m", cost: {} }] } } }))),
    true,
    "an empty cost object declares no components — free",
  );
  assert.equal(
    fleetModelsFree(
      cfg,
      writeModels(JSON.stringify({ providers: { p: { models: [{ id: "m", cost: { input: 0, output: 0 } }] } } })),
    ),
    true,
    "explicit zeros stay free",
  );
});

test("a fleet with no enabled roles and review off cannot spend — free by construction", () => {
  const cfg = defaultConfig();
  for (const id of Object.keys(cfg.roles)) cfg.roles[id]!.enabled = false;
  cfg.review.enabled = false;
  // No definitions file at all: there is nothing to consult.
  assert.equal(fleetModelsFree(cfg, path.join(tmpdir(), "absent.json")), true);
});

test("rewriting models.json between polls flips the answer (stat-keyed cache stays fresh)", () => {
  const dir = tmpdir("pi-models-");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "models.json");
  const cfg = fleetAt("lm-studio", "m");
  // Distinct sizes so the stat key (dev/ino/mtime/size) changes even within one millisecond.
  fs.writeFileSync(file, JSON.stringify({ providers: { "lm-studio": { models: [{ id: "m" }] } } }));
  assert.equal(fleetModelsFree(cfg, file), true, "unpriced model reads free");
  fs.writeFileSync(
    file,
    JSON.stringify({ providers: { "lm-studio": { models: [{ id: "m", cost: { input: 1, output: 2 } }] } } }),
  );
  assert.equal(fleetModelsFree(cfg, file), false, "a price added after the first read is seen");
});

// --- The fallback model's freeness check (plans/fallback-model.md) ---

test("fallbackModelFree engages only a configured pair pi prices at zero", () => {
  const file = writeModels();
  // A paid fleet — the case the fallback exists for — with a free local pair named as its
  // fallback: both zero-cost shapes count (an absent cost field and an all-zero one).
  const paid = fleetAt("paid", "gpt-x");
  assert.equal(fleetModelsFree(paid, file), false, "the fleet itself is priced");
  assert.equal(
    fallbackModelFree({ ...paid, fallbackModel: { provider: "lm-studio", model: "qwen3.8-27b" } }, file),
    true,
    "an unpriced model is a cost n/a fallback",
  );
  assert.equal(
    fallbackModelFree({ ...paid, fallbackModel: { provider: "lm-studio", model: "zero-cost" } }, file),
    true,
    "an all-zero cost is a cost n/a fallback",
  );

  // Every way of failing to verify it is free is a refusal — the gate then pauses, because a
  // fallback that can spend would defeat the cap it exists to survive.
  assert.equal(fallbackModelFree(paid, file), false, "no fallback configured");
  assert.equal(
    fallbackModelFree({ ...paid, fallbackModel: { provider: "paid", model: "gpt-x" } }, file),
    false,
    "a priced fallback is refused",
  );
  assert.equal(
    fallbackModelFree({ ...paid, fallbackModel: { provider: "lm-studio", model: "no-such-model" } }, file),
    false,
    "an unknown model id is refused",
  );
  assert.equal(
    fallbackModelFree({ ...paid, fallbackModel: { provider: "no-such-provider", model: "qwen3.8-27b" } }, file),
    false,
    "an unknown provider is refused",
  );
  assert.equal(
    fallbackModelFree({ ...paid, fallbackModel: { provider: "lm-studio", model: "qwen3.8-27b" } }, path.join(file, "missing")),
    false,
    "a missing definitions file is refused — unverified is not free",
  );
});

test("fallbackModelFree resolves a map with no default entry through the borrow order", () => {
  const file = writeModels();
  const paid = fleetAt("paid", "gpt-x");
  // No `default` key: the default tier borrows small's free pair, exactly as the gate does -
  // the badge must not read no fallback while the fleet runs one.
  assert.equal(
    fallbackModelFree({ ...paid, fallback: { small: "lm-studio/qwen3.8-27b" } }, file),
    true,
    "default borrows small's free pair",
  );
  assert.equal(
    fallbackModelFree({ ...paid, fallback: { small: "paid/gpt-x" } }, file),
    false,
    "a priced borrowed pair is refused",
  );
});

test("a fallback naming one field falls back to the top-level value for the other", () => {
  const file = writeModels();
  // The same precedence every other override section uses: naming only the model keeps the
  // current provider, and naming only the provider keeps the current model.
  assert.equal(
    fallbackModelFree({ ...fleetAt("lm-studio", "paid-elsewhere"), fallbackModel: { model: "qwen3.8-27b" } }, file),
    true,
    "model-only fallback inherits the top-level provider",
  );
  assert.equal(
    fallbackModelFree({ ...fleetAt("paid", "qwen3.8-27b"), fallbackModel: { provider: "lm-studio" } }, file),
    true,
    "provider-only fallback inherits the top-level model",
  );
  // With no top-level value to inherit, the pair would fall through to pi's own default —
  // unverifiable, so refused.
  assert.equal(
    fallbackModelFree({ ...fleetAt(undefined, undefined), fallbackModel: { model: "qwen3.8-27b" } }, file),
    false,
    "a half-resolved pair is refused",
  );
});

// --- Model tiers (plans/model-tiers.md part 3/8) --------------------------------------------

test("a claude-routed selector is never free, even if models.json prices its namespace at zero", () => {
  // A models.json that even names a free `claude` provider must not make a claude run read
  // cost n/a: pi's pricing cannot see claude CLI billing (part 6/7 makes subscriptions free).
  const file = writeModels(JSON.stringify({ providers: { claude: { models: [{ id: "claude-sonnet-5-5" }] } } }));
  const cfg = fleetAt("claude", "claude-sonnet-5-5");
  cfg.agent = "claude";
  assert.equal(fleetModelsFree(cfg, file), false, "a claude-routed seam is not free");
  // The same for a fallback selector that routes to claude by its provider namespace.
  assert.equal(
    fallbackModelFree({ ...cfg, fallback: "claude/claude-sonnet-5-5" }, file),
    false,
    "a claude-routed fallback is refused",
  );
  // A non-agent provider under agent: claude still runs on pi and can be free.
  const piRouted = writeModels();
  const mixed = fleetAt("lm-studio", "qwen3.8-27b");
  mixed.agent = "claude";
  assert.equal(fleetModelsFree(mixed, piRouted), true, "a provider/id fallback runs on pi");
});

test("a subscription claude seam is free; API billing, overage, and an absent account keep today's refusal", () => {
  const file = writeModels(JSON.stringify({ providers: { claude: { models: [{ id: "claude-sonnet-5-5" }] } } }));
  const cfg = fleetAt("claude", "claude-sonnet-5-5");
  cfg.agent = "claude";
  const api = { billing: "api" as const, observedAt: 1, windows: {} };
  const sub = { billing: "subscription" as const, observedAt: 1, windows: {} };
  assert.equal(fleetModelsFree(cfg, file, null), false, "no account file reads no subscription");
  assert.equal(fleetModelsFree(cfg, file, api), false, "API billing is never free");
  assert.equal(fleetModelsFree(cfg, file, sub), true, "subscription claude is free");
  // A claude-routed fallback pair is accepted as free only under subscription billing.
  const withFallback = { ...cfg, fallback: "claude/claude-sonnet-5-5" };
  assert.equal(fallbackModelFree(withFallback, file, api), false, "an API claude fallback is refused");
  assert.equal(fallbackModelFree(withFallback, file, sub), true, "a subscription claude fallback is free");
  // An agent-less claude provider namespace under a subscription is free too.
  assert.equal(fleetModelsFree(fleetAt("claude", "claude-sonnet-5-5"), file, sub), true);
  // Overage is real money (plans/agent-backends.md §7): the subscription's overflow bills as API
  // spend, so a window using overage makes the seam — and a claude fallback — not free.
  const overage = {
    billing: "subscription" as const,
    observedAt: 1,
    windows: { five_hour: { status: "allowed", isUsingOverage: true, observedAt: 1 } },
  };
  assert.equal(fleetModelsFree(cfg, file, overage), false, "an overage subscription claude seam is not free");
  assert.equal(fallbackModelFree(withFallback, file, overage), false, "an overage claude fallback is refused");
});

test("a priced strong tier keeps the badge off even when every role runs a free model", () => {
  const file = writeModels();
  // Every role and the reviewer run the free model, but the strong tier names a paid one —
  // the conflict resolver (part 4/8) runs on strong, so spend it could reach counts.
  const cfg = fleetAt("lm-studio", "qwen3.8-27b");
  cfg.model = { default: "lm-studio/qwen3.8-27b", strong: "paid/gpt-x" };
  assert.equal(fleetModelsFree(cfg, file), false);
  // A free strong tier stays free.
  const freeStrong = fleetAt("lm-studio", "qwen3.8-27b");
  freeStrong.model = { default: "lm-studio/qwen3.8-27b", strong: "lm-studio/zero-cost" };
  assert.equal(fleetModelsFree(freeStrong, file), true);
  // No strong entry: nothing extra is consulted beyond the seams themselves.
  const noStrong = fleetAt("lm-studio", "qwen3.8-27b");
  noStrong.model = { default: "lm-studio/qwen3.8-27b" };
  assert.equal(fleetModelsFree(noStrong, file), true);
});
