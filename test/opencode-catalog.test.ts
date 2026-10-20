// The models.dev catalog fetch, parse and cache (plans/opencode-backend.md §7, PLANS.md
// "OpenCode backend, part 6a/7"): the parse keeps only the providers the config routes through
// OpenCode, the cache refreshes when stale or on a CLI-version change and survives a failed
// fetch with `billedAt` preserved, and `opencodeModelFree` is the single predicate part 6b/7's
// seam reads. The parse runs against the real 2.0.32 capture in
// test/fixtures/opencode-captures/models-catalog-entries.json (finding 10); the cache logic is
// exercised with injected fetch/version/clock so no network and no `opencode` binary is ever
// touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  opencodeModelFree,
  opencodeModelKey,
  observeOpencodeRun,
  parseOpencodeCatalog,
  readOpencodeCache,
  refreshOpencodeCatalog,
  writeOpencodeCache,
  type OpencodeCatalogCache,
  type CatalogFetch,
} from "../src/agent/opencode/opencode-catalog.js";
import { opencodeModelsPath } from "../src/paths.js";
import type { HarnessEventInput } from "../src/events/events.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** The real 2.0.32 catalogue capture (finding 10). From the compiled module
 * (dist/test) four levels up to the repo root; from the source module (test/) two. */
function catalogCapture(): unknown {
  const fromDist = fileURLToPath(new URL("../../test/fixtures/opencode-captures/models-catalog-entries.json", import.meta.url));
  const fromSrc = fileURLToPath(new URL("./fixtures/opencode-captures/models-catalog-entries.json", import.meta.url));
  const file = fs.existsSync(fromDist) ? fromDist : fromSrc;
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function fetchOf(body: unknown): CatalogFetch {
  return async () => body;
}

test("parseOpencodeCatalog keeps only the opencode provider by default, with the free model's fields", () => {
  const models = parseOpencodeCatalog(catalogCapture(), []);
  // The free model: free, 200k context, image input and low/high/max efforts (finding 9, 10).
  const free = models["opencode/deepseek-v4.1-flash-free"];
  assert.ok(free);
  assert.equal(free.free, true);
  assert.equal(free.context, 200000);
  assert.equal(free.images, true);
  assert.deepEqual(free.efforts, ["low", "high", "max"]);
  // A non-routed provider is not kept.
  assert.equal(models["opencode-go/deepseek-v4.1-flash"], undefined);
});

test("parseOpencodeCatalog keeps a provider the config routes through OpenCode, as priced", () => {
  const models = parseOpencodeCatalog(catalogCapture(), ["opencode-go"]);
  const go = models["opencode-go/deepseek-v4.1-flash"];
  assert.ok(go);
  assert.equal(go.free, false);
  assert.equal(go.inputPerM, 0.15);
  assert.equal(go.outputPerM, 0.6);
});

test("parseOpencodeCatalog reads the raw models.dev api.json shape, providers at the top level", () => {
  // The live GET /api.json returns the provider map directly (no `body` key); the capture wraps
  // that same map under `body`. Unwrap it to feed the raw shape the fetch actually produces.
  const raw = (catalogCapture() as { body?: unknown }).body;
  assert.ok(raw, "the capture wraps the provider map under body");
  const models = parseOpencodeCatalog(raw, ["opencode-go"]);
  const free = models["opencode/deepseek-v4.1-flash-free"];
  assert.ok(free);
  assert.equal(free.free, true);
  const go = models["opencode-go/deepseek-v4.1-flash"];
  assert.ok(go);
  assert.equal(go.free, false);
});

test("parseOpencodeCatalog treats a model with no cost block as not free", () => {
  const api = {
    opencode: { models: { plain: { limit: { context: 1000 } } } },
  };
  const models = parseOpencodeCatalog(api, []);
  const plain = models["opencode/plain"];
  assert.ok(plain);
  assert.equal(plain.free, false, "missing cost data is unknown, not $0");
  assert.equal(plain.context, 1000);
});

test("opencodeModelFree: free and unbilled is free; priced, unknown, or billed are not", () => {
  const cache: OpencodeCatalogCache = {
    fetchedAt: 1,
    models: {
      "opencode/free-a": { free: true },
      "opencode/free-billed": { free: true, billedAt: 5 },
      "opencode/priced": { free: false },
    },
  };
  assert.equal(opencodeModelFree(cache, "opencode/free-a"), true);
  assert.equal(opencodeModelFree(cache, "opencode/free-billed"), false);
  assert.equal(opencodeModelFree(cache, "opencode/priced"), false);
  assert.equal(opencodeModelFree(cache, "opencode/unknown"), false);
});

test("a fresh cache with the same CLI version is not refetched", async () => {
  let calls = 0;
  const fetchFn: CatalogFetch = async () => {
    calls += 1;
    throw new Error("should not fetch");
  };
  const root = tmpdir();
  await refreshOpencodeCatalog(root, {
    providers: [],
    fetch: fetchOf(catalogCapture()),
    cliVersion: "2.0.32",
    now: () => 1_000,
  });
  await refreshOpencodeCatalog(root, {
    providers: [],
    fetch: fetchFn,
    cliVersion: "2.0.32",
    now: () => 2_000,
  });
  assert.equal(calls, 0);
});

test("a stale cache refreshes and billedAt survives", async () => {
  const root = tmpdir();
  const first = await refreshOpencodeCatalog(root, {
    providers: ["opencode-go"],
    fetch: fetchOf(catalogCapture()),
    cliVersion: "2.0.32",
    now: () => 1_000,
  });
  // Mark a model billed (as part 6c/7 would), then refresh well past the 24 h TTL.
  const billed = first.models["opencode/deepseek-v4.1-flash-free"];
  assert.ok(billed);
  billed.billedAt = 123;
  // Part 6c/7 persists the billedAt demotion to the cache; persist it as that would.
  writeOpencodeCache(root, first);
  const second = await refreshOpencodeCatalog(root, {
    providers: ["opencode-go"],
    fetch: fetchOf(catalogCapture()),
    cliVersion: "2.0.32",
    now: () => 100 * 24 * 60 * 60 * 1000,
  });
  assert.ok(second.fetchedAt > first.fetchedAt);
  const kept = second.models["opencode/deepseek-v4.1-flash-free"];
  assert.ok(kept);
  assert.equal(kept.billedAt, 123);
});

test("a changed CLI version refreshes even when the cache is young", async () => {
  const root = tmpdir();
  await refreshOpencodeCatalog(root, {
    providers: [],
    fetch: fetchOf(catalogCapture()),
    cliVersion: "2.0.31",
    now: () => 1_000,
  });
  const second = await refreshOpencodeCatalog(root, {
    providers: [],
    fetch: fetchOf(catalogCapture()),
    cliVersion: "2.0.32",
    now: () => 2_000,
  });
  assert.equal(second.cliVersion, "2.0.32");
});

test("a failed fetch keeps the old cache and logs one warning", async () => {
  const root = tmpdir();
  await refreshOpencodeCatalog(root, {
    providers: [],
    fetch: fetchOf(catalogCapture()),
    cliVersion: "2.0.32",
    now: () => 1_000,
  });
  let warnings = 0;
  const failing: CatalogFetch = async () => {
    throw new Error("network down");
  };
  const result = await refreshOpencodeCatalog(root, {
    providers: ["opencode-go"],
    fetch: failing,
    cliVersion: "2.0.32",
    now: () => 100 * 24 * 60 * 60 * 1000,
    warn: () => {
      warnings += 1;
    },
  });
  assert.equal(warnings, 1);
  assert.equal(result.fetchedAt, 1_000, "kept the old cache rather than a fetchedAt reset");
  const kept = result.models["opencode/deepseek-v4.1-flash-free"];
  assert.ok(kept);
  assert.equal(kept.free, true);
});

test("observeOpencodeRun demotes a cached free model on a priced run, once", () => {
  const root = tmpdir();
  writeOpencodeCache(root, { fetchedAt: 1, models: { "opencode/free-m": { free: true } } });
  const logged: HarnessEventInput[] = [];
  const first = observeOpencodeRun(
    root,
    { model: "opencode/free-m", costUsd: 0.05 },
    { source: "feature", now: () => 42, log: (e) => logged.push(e) },
  );
  assert.ok(first, "a priced run on a free model returns the demoted cache");
  assert.equal(first.models["opencode/free-m"]?.billedAt, 42);
  assert.equal(opencodeModelFree(first, "opencode/free-m"), false, "demoted to priced");
  assert.equal(logged.length, 1, "logs the event once");
  assert.equal(logged[0]!.type, "opencode_free_model_billed");
  assert.equal(logged[0]!.model, "opencode/free-m");
  assert.equal(logged[0]!.costUsd, 0.05);
  // A second priced run re-reads the persisted cache (billedAt survives a reload), so it logs
  // nothing and changes nothing — the demotion is stable across reads.
  const second = observeOpencodeRun(
    root,
    { model: "opencode/free-m", costUsd: 0.04 },
    { source: "feature", log: (e) => logged.push(e) },
  );
  assert.equal(second, null);
  assert.equal(logged.length, 1, "the second priced run does not log again");
  const persisted = JSON.parse(fs.readFileSync(opencodeModelsPath(root), "utf8")) as { models: Record<string, { billedAt?: number }> };
  assert.equal(persisted.models["opencode/free-m"]?.billedAt, 42, "the demotion is written to the cache");
});

test("observeOpencodeRun leaves a $0 run free and logs nothing", () => {
  const root = tmpdir();
  writeOpencodeCache(root, { fetchedAt: 1, models: { "opencode/free-m": { free: true } } });
  const logged: HarnessEventInput[] = [];
  const result = observeOpencodeRun(
    root,
    { model: "opencode/free-m", costUsd: 0 },
    { source: "feature", log: (e) => logged.push(e) },
  );
  assert.equal(result, null);
  assert.equal(logged.length, 0, "a $0 run logs nothing");
  const persisted = JSON.parse(fs.readFileSync(opencodeModelsPath(root), "utf8")) as { models: Record<string, { free: boolean; billedAt?: number }> };
  assert.equal(persisted.models["opencode/free-m"]?.free, true);
  assert.equal(persisted.models["opencode/free-m"]?.billedAt, undefined, "a $0 run never demotes");
});

test("observeOpencodeRun ignores unknown and already-priced models", () => {
  const root = tmpdir();
  writeOpencodeCache(root, {
    fetchedAt: 1,
    models: { "opencode/priced": { free: false }, "opencode/free-billed": { free: true, billedAt: 7 } },
  });
  const logged: HarnessEventInput[] = [];
  assert.equal(observeOpencodeRun(root, { model: "opencode/unknown", costUsd: 1 }, { source: "feature", log: (e) => logged.push(e) }), null);
  assert.equal(observeOpencodeRun(root, { model: "opencode/priced", costUsd: 1 }, { source: "feature", log: (e) => logged.push(e) }), null);
  assert.equal(observeOpencodeRun(root, { model: "opencode/free-billed", costUsd: 1 }, { source: "feature", log: (e) => logged.push(e) }), null);
  assert.equal(logged.length, 0);
});

test("opencodeModelKey maps a bare gateway id and keeps a routed provider key", () => {
  assert.equal(opencodeModelKey("deepseek-v4.1-flash-free"), "opencode/deepseek-v4.1-flash-free");
  assert.equal(opencodeModelKey("opencode-go/deepseek-v4.1-flash"), "opencode-go/deepseek-v4.1-flash");
});

test("readOpencodeCache drops a foreign catalog entry and keeps the valid ones", () => {
  const root = tmpdir("opencode-foreign-");
  const ok = { free: true, context: 1000, efforts: ["high"], extra: 1 };
  fs.mkdirSync(path.dirname(opencodeModelsPath(root)), { recursive: true });
  fs.writeFileSync(
    opencodeModelsPath(root),
    JSON.stringify({
      fetchedAt: 1,
      models: {
        "opencode/ok": ok,
        "opencode/null": null,
        "opencode/num": 7,
        "opencode/yes": { free: "yes" },
        "opencode/nofree": { context: 1000 },
        "opencode/ctx": { free: true, context: "big" },
        "opencode/eff": { free: false, efforts: "high" },
        "opencode/eff2": { free: false, efforts: ["high", 3] },
        "opencode/billed": { free: true, billedAt: "soon" },
      },
    }),
  );
  const cache = readOpencodeCache(root);
  assert.deepEqual(cache.models, { "opencode/ok": ok });
  assert.equal(opencodeModelFree(cache, "opencode/null"), false);
  assert.equal(opencodeModelFree(cache, "opencode/yes"), false);
  assert.equal(
    observeOpencodeRun(root, { model: "opencode/null", costUsd: 1 }, { source: "feature", log: () => {} }),
    null,
  );
});

test("parseOpencodeCatalog skips a malformed provider or model instead of throwing", () => {
  const body = {
    opencode: {
      models: {
        a: { modalities: { input: 5 } },
        b: { reasoning_options: { type: "effort" } },
        c: { cost: { input: "0", output: 0 } },
        d: null,
        ok: { cost: { input: 0, output: 0 } },
      },
    },
    "opencode-go": { models: null },
  };
  assert.deepEqual(parseOpencodeCatalog(body, ["opencode-go"]), {
    "opencode/a": { free: false },
    "opencode/b": { free: false },
    "opencode/ok": { free: true, inputPerM: 0, outputPerM: 0 },
  });
});

test("a failed catalog write warns and still returns the fetched catalog", async () => {
  const root = tmpdir();
  fs.mkdirSync(opencodeModelsPath(root), { recursive: true });
  const warnings: string[] = [];
  const cache = await refreshOpencodeCatalog(root, {
    providers: [],
    fetch: fetchOf(catalogCapture()),
    cliVersion: "2.0.32",
    now: () => 1_000,
    warn: (m) => warnings.push(m),
  });
  assert.equal(cache.fetchedAt, 1_000);
  assert.equal(cache.models["opencode/deepseek-v4.1-flash-free"]?.free, true);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.startsWith("could not save the open code model catalog"));
});
