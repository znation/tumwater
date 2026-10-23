// The Codex model catalog (plans/codex-backend.md design finding 14; part 8/9): parsed from
// `$CODEX_HOME/models_cache.json`, the file the CLI itself refreshes. The parse runs against
// the real 0.163.0 capture in test/fixtures/codex-captures/models-catalog-entries.json; the
// read's missing/malformed half is exercised with a hand-written empty and torn file so no
// codex binary is ever touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexHome, codexModelsPath, readCodexCatalog } from "../src/agent/codex/codex-catalog.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { readJson } from "./helpers/json-read.js";

/** The real 0.163.0 catalogue capture (finding 14). From the compiled module (dist/test) four
 * levels up to the repo root; from the source module (test/) two. */
function catalogCapture(): unknown {
  const fromDist = fileURLToPath(new URL("../../test/fixtures/codex-captures/models-catalog-entries.json", import.meta.url));
  const fromSrc = fileURLToPath(new URL("./fixtures/codex-captures/models-catalog-entries.json", import.meta.url));
  const file = fs.existsSync(fromDist) ? fromDist : fromSrc;
  return readJson(file) as unknown;
}

/** A home directory with `models_cache.json` holding the given JSON object. */
function homeWith(doc: unknown): string {
  const home = tmpdir("codex-catalog-");
  writeFileDeep(codexModelsPath(home), JSON.stringify(doc));
  return home;
}

test("readCodexCatalog parses the fixture's window, levels and image input per model", () => {
  const catalog = readCodexCatalog(homeWith(catalogCapture()));
  // gpt-6.1-sol: 500k × 95% = 475000 window, image input, low..ultra levels.
  const sol = catalog.get("gpt-6.1-sol");
  assert.ok(sol);
  assert.equal(sol.contextWindow, 475_000);
  assert.equal(sol.images, true);
  assert.deepEqual(sol.levels, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(sol.defaultLevel, "low");
  // gpt-6-luna: 272k × 95% = 258400, image input, low..max (no ultra).
  const luna = catalog.get("gpt-6-luna");
  assert.ok(luna);
  assert.equal(luna.contextWindow, 258_400);
  assert.equal(luna.images, true);
  assert.deepEqual(luna.levels, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(luna.defaultLevel, "medium");
  // A hidden model is still listed by the CLI's file and read like any other.
  assert.equal(catalog.get("gpt-reserve")?.contextWindow, 258_400);
});

test("readCodexCatalog: a missing or malformed file reads an empty catalog, never throws", () => {
  assert.equal(readCodexCatalog(tmpdir("codex-catalog-missing-")).size, 0, "no file");
  const torn = tmpdir("codex-catalog-torn-");
  fs.writeFileSync(codexModelsPath(torn), "{not json");
  assert.equal(readCodexCatalog(torn).size, 0, "malformed json");
  // A catalog whose `models` is not an array is empty too.
  assert.equal(readCodexCatalog(homeWith({ models: "nope" })).size, 0);
  assert.equal(readCodexCatalog(homeWith({})).size, 0);
});

test("readCodexCatalog drops a model whose window is unusable, keeping the rest", () => {
  const catalog = readCodexCatalog(
    homeWith({
      models: [
        { slug: "ok", context_window: 500000, effective_context_window_percent: 95, input_modalities: ["text"] },
        { slug: "nowindow" },
        { slug: 42, context_window: 500000, effective_context_window_percent: 95 },
      ],
    }),
  );
  assert.equal(catalog.size, 1);
  assert.equal(catalog.get("ok")?.contextWindow, 475_000);
  assert.equal(catalog.get("ok")?.images, false, "text-only reads no images");
  assert.equal(catalog.get("nowindow"), undefined, "no usable window: dropped");
  assert.equal(catalog.get("42"), undefined, "a non-string slug is dropped");
});

test("codexHome expands a leading tilde against the home dir and defaults to ~/.codex", () => {
  assert.equal(codexHome({}), path.join(os.homedir(), ".codex"));
  assert.equal(codexHome({ configDir: "/plain/path" }), "/plain/path");
  assert.equal(codexHome({ configDir: "~/team" }), path.join(os.homedir(), "team"));
});

test("readCodexCatalog deep-copies entries so callers own their result", () => {
  const home = homeWith({
    models: [
      {
        slug: "gpt-x",
        context_window: 100000,
        effective_context_window_percent: 50,
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        input_modalities: ["image"],
      },
    ],
  });
  const first = readCodexCatalog(home);
  const entry = first.get("gpt-x");
  assert.ok(entry);
  entry.levels.push("ultra");
  entry.contextWindow = 1;
  // A second read is not polluted by the first caller's mutation.
  const again = readCodexCatalog(home);
  assert.deepEqual(again.get("gpt-x")?.levels, ["low", "high"]);
  assert.equal(again.get("gpt-x")?.contextWindow, 50_000);
});
