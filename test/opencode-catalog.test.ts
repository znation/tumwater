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
import { fileURLToPath } from "node:url";
import {
  opencodeModelFree,
  parseOpencodeCatalog,
  refreshOpencodeCatalog,
  writeOpencodeCache,
  type OpencodeCatalogCache,
  type CatalogFetch,
} from "../src/agent/opencode/opencode-catalog.js";
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
