import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config/config.js";
import { writeOpencodeCache, opencodeModelFree, type OpencodeCatalogCache } from "../src/agent/opencode/opencode-catalog.js";
import { opencodeModelsPath } from "../src/paths.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { withOpencodeReplay } from "./fakes/fake-opencode.js";
import { opencodeCaptures } from "./fixtures/opencode-events.js";
import { makeHost } from "./fixtures/runner-pi-fixtures.js";
import { readJson } from "./helpers/json-read.js";

// Part 6c/7's seam, wired at the runner's fold chokepoint (src/runner/runner-pi.ts
// observeFreeModelCost): a run on the opencode backend that reports a nonzero cost demotes the
// catalog-free model it ran on in the shared catalog cache, once — the next run on that model
// costs against the daily cap. Runs on the pi or claude backends have no opencode catalog
// entry and no-op. Played through RunnerPi against the PATH opencode fake (the same shape as
// runner-pi-claude.test.ts) with a canned export whose info.cost is nonzero.

const FREE_KEY = "opencode/deepseek-v4.1-flash-free";

/** edit-run's real export (cost 0) replayed with info.cost bumped to 0.05. */
function pricedExport(): string {
  const e = JSON.parse(opencodeCaptures.editRunExport) as { info: { cost: number }; tokens?: unknown };
  e.info.cost = 0.05;
  return JSON.stringify(e);
}

test("a priced opencode run demotes the cached free model once through the runner", async () => {
  const root = tmpdir();
  // Seed the catalog cache with the free model free, as part 6a's startup seed would.
  writeOpencodeCache(root, { fetchedAt: 1, cliVersion: "2.0.32", models: { [FREE_KEY]: { free: true } } });
  const config = defaultConfig();
  config.backend = "opencode";
  config.model = FREE_KEY.replace("opencode/", "");
  await withOpencodeReplay(opencodeCaptures.editRun, { cannedExport: pricedExport() }, async () => {
    const { runnerPi } = makeHost(root, config);
    const result = await runnerPi.runRolePi(root, "work", "tumwater-feature-1-author");
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.equal(result.costUsd, 0.05, "the canned export's nonzero cost is the run's authoritative cost");
    const cache = readJson(opencodeModelsPath(root)) as OpencodeCatalogCache;
    assert.equal(typeof cache.models[FREE_KEY]?.billedAt, "number", "the free model is demoted to priced");
    assert.equal(opencodeModelFree(cache, FREE_KEY), false, "the demotion reads back as priced");
  });
});

test("a $0 opencode run leaves the cached free model free through the runner", async () => {
  const root = tmpdir();
  writeOpencodeCache(root, { fetchedAt: 1, cliVersion: "2.0.32", models: { [FREE_KEY]: { free: true } } });
  const config = defaultConfig();
  config.backend = "opencode";
  config.model = FREE_KEY.replace("opencode/", "");
  // The unmodified export has info.cost 0.
  await withOpencodeReplay(opencodeCaptures.editRun, async () => {
    const { runnerPi } = makeHost(root, config);
    const result = await runnerPi.runRolePi(root, "work", "tumwater-feature-1-author");
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.equal(result.costUsd, 0);
    const cache = readJson(opencodeModelsPath(root)) as OpencodeCatalogCache;
    assert.equal(cache.models[FREE_KEY]?.billedAt, undefined, "a $0 run leaves the model free");
    assert.equal(opencodeModelFree(cache, FREE_KEY), true);
  });
});
