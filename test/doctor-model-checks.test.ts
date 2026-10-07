import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkFallbackModel, checkTierModels, piProviderAuth } from "../src/doctor/doctor-model-checks.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { tmpdir, writeConfig } from "./repo-fixtures.js";
import { readyRepo } from "./doctor-fixtures.js";
import { writeScript } from "./fake-commands.js";

// Unit coverage for the doctor's model-readiness checks (src/doctor/doctor-model-checks.ts):
// the cap fallback's price check, the declared-tier resolution check, and the agent binary's
// credential probe. Every branch is exercised with an injected `modelsPath`/`auth` stub, and
// the probe with a fake pi on PATH — never a real model or network call. The environment and
// repo checks' own coverage lives in test/doctor-checks.test.ts; the fixtures both files share
// live in test/doctor-fixtures.ts and test/repo-fixtures.ts.

/** A models.json with one unpriced (free) model and one paid model, for the fallback check. */
function writeModels(): string {
  const dir = tmpdir("doctor-models-");
  const file = path.join(dir, "models.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      providers: {
        local: { models: [{ id: "free-model" }] },
        paid: { models: [{ id: "gpt-x", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.4 } }] },
      },
    }),
  );
  return file;
}

test("checkFallbackModel reports the cap behavior and verifies a free fallback pair", () => {
  const models = writeModels();

  // No fallbackModel: informational — the fleet pauses at the cap by design. The definitions
  // file is not even consulted, so an absent path is still ok.
  const none = readyRepo();
  assert.deepEqual(checkFallbackModel(none, path.join(tmpdir(), "absent.json")), {
    level: "ok",
    detail: "none configured — role loops pause at the cap",
  });

  // A free local pair is the case the fallback exists for — but a price is not readiness: a
  // backend that rejects every prompt is priced at zero too (BUGS.md 2026-09-20), so the line
  // must not claim more than it checked.
  const free = readyRepo();
  writeConfig(free, { fallbackModel: { provider: "local", model: "free-model" } });
  assert.deepEqual(checkFallbackModel(free, models), {
    level: "ok",
    detail: "local/free-model — priced at zero (cost n/a), serving not verified",
  });
  // The running fleet's breaker demoted it (runDoctor passes orchestrator.json's
  // fallbackDemoted only while that orchestrator is alive): warn with the evidence and the retry.
  const probeAt = new Date(2026, 8, 19, 23, 10, 56).getTime();
  const demoted = checkFallbackModel(free, models, { pair: "local/free-model", failures: 3, probeAt });
  assert.equal(demoted.level, "warn");
  assert.match(demoted.detail, /^local\/free-model is priced at zero but not serving/);
  assert.match(demoted.detail, /demoted it after 3 consecutive failed ticks, so role loops pause at the cap/);
  assert.match(demoted.detail, /one probe tick retries it from 23:10:56$/);

  // A pair naming only one half falls through to pi's own default and can never be free —
  // the warning names the half-resolved pair instead of rendering a bare "?/model".
  const half = readyRepo();
  writeConfig(half, { fallbackModel: { model: "solo-model" } });
  const halfWarn = checkFallbackModel(half, models);
  assert.equal(halfWarn.level, "warn");
  assert.match(halfWarn.detail, /^a half-resolved pair is not priced at zero/);
  assert.match(halfWarn.detail, /role loops pause instead of switching/);

  // A priced or unknown id would be refused by the gate, so role loops would pause at the cap
  // instead of switching — warn before the day's budget is spent on discovering it.
  const paid = readyRepo();
  writeConfig(paid, { fallbackModel: { provider: "paid", model: "gpt-x" } });
  const warned = checkFallbackModel(paid, models);
  assert.equal(warned.level, "warn");
  assert.match(warned.detail, /paid\/gpt-x is not priced at zero/);
  assert.match(warned.detail, /role loops pause instead of switching/);
});

test("checkFallbackModel cannot run on an invalid config and says so without failing", () => {
  const root = readyRepo();
  writeConfig(root, { bogusKey: 1 });
  const outcome = checkFallbackModel(root, path.join(tmpdir(), "absent.json"));
  assert.equal(outcome.level, "warn");
  assert.match(outcome.detail, /cannot check — invalid tumwater\.json/);
});

// --- checkTierModels (plans/model-tiers.md "Doctor", part 7c/8) ---

// Every pair the config can put on a seam is checked once: the `auth` stub records which
// providers were probed so a config naming the same provider through several surfaces
// (top-level tiers, a role override, the reviewer) probes it a single time.
test("checkTierModels verifies declared tier models and probes each provider once", async () => {
  const models = writeModels();
  const probed: string[] = [];
  const root = readyRepo();
  writeConfig(root, {
    model: { small: "local/free-model", default: "paid/gpt-x" },
    review: { enabled: true },
  });
  const outcome = await checkTierModels(root, models, async (p) => {
    probed.push(p);
    return "ready";
  });
  assert.equal(outcome.level, "ok");
  assert.match(outcome.detail, /2 declared models resolve/);
  assert.match(outcome.detail, /all providers local, paid report ready/);
  assert.deepEqual(probed.sort(), ["local", "paid"]);

  // A tier with no entry of its own resolves to default's model, and the reviewer with no
  // override runs there too — the same pair, checked once.

  // With no top-level model the seams all use pi's own default: nothing to check.
  const none = readyRepo();
  assert.deepEqual(await checkTierModels(none, models, async () => "ready"), {
    level: "ok",
    detail: "no models declared — every seam uses pi's own default",
  });
});

test("checkTierModels fails a pair pi cannot resolve and warns on an unready provider", async () => {
  const models = writeModels();

  // A typo'd model id fails: a strong tier pi cannot resolve would fail every review.
  const typoRoot = readyRepo();
  writeConfig(typoRoot, { model: "paid/no-such-model" });
  const typo = await checkTierModels(typoRoot, models, async () => "ready");
  assert.equal(typo.level, "fail");
  assert.match(typo.detail, /paid\/no-such-model does not resolve/);

  // A provider pi has never heard of fails too.
  const unknownRoot = readyRepo();
  writeConfig(unknownRoot, { model: "nowhere/mystery" });
  const unknownProvider = await checkTierModels(unknownRoot, models, async () => "ready");
  assert.equal(unknownProvider.level, "fail");
  assert.match(unknownProvider.detail, /provider nowhere is not in pi's definitions/);

  // Credentials are a separate question from resolution: a resolvable model on a provider
  // without credentials warns, so a config edit and a re-login are distinguishable.
  const authRoot = readyRepo();
  writeConfig(authRoot, { model: "paid/gpt-x" });
  const notReady = await checkTierModels(authRoot, models, async () => "not-ready");
  assert.equal(notReady.level, "warn");
  assert.match(notReady.detail, /provider paid reports not ready — check its credentials/);

  // A probe that could not run is unknown, never conflated with not-ready.
  const unknownAuth = await checkTierModels(authRoot, models, async () => "unknown");
  assert.equal(unknownAuth.level, "warn");
  assert.match(unknownAuth.detail, /could not verify provider paid/);

  // A role override naming a selector is one of the declared pairs.
  const roleRoot = readyRepo();
  writeConfig(roleRoot, { roles: { qa: { model: "paid/no-such-qa-model" } } });
  const roleModel = await checkTierModels(roleRoot, models, async () => "ready");
  assert.equal(roleModel.level, "fail");
  assert.match(roleModel.detail, /paid\/no-such-qa-model does not resolve/);
});

test("checkTierModels warns when a priced model's cache reads are declared free", async () => {
  const dir = tmpdir("doctor-models-");
  const file = path.join(dir, "models.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      providers: {
        local: { models: [{ id: "free-model" }] },
        paid: {
          models: [
            { id: "zero-cache", cost: { input: 0.15, output: 0.5, cacheRead: 0 } },
            { id: "missing-cache", cost: { input: 0.15, output: 0.5 } },
            { id: "priced-cache", cost: { input: 0.15, output: 0.5, cacheRead: 0.03 } },
          ],
        },
      },
    }),
  );

  // `cacheRead: 0` on a priced model means "billed free", not "unpriced": the daily budget
  // undercounts every cached prompt token (BUGS.md 2026-10-06), so the check warns.
  const zero = readyRepo();
  writeConfig(zero, { model: "paid/zero-cache" });
  const zeroOutcome = await checkTierModels(zero, file, async () => "ready");
  assert.equal(zeroOutcome.level, "warn");
  assert.match(zeroOutcome.detail, /paid\/zero-cache prices cache reads at \$0/);

  // An absent cacheRead field is the same hazard.
  const missing = readyRepo();
  writeConfig(missing, { model: "paid/missing-cache" });
  const missingOutcome = await checkTierModels(missing, file, async () => "ready");
  assert.equal(missingOutcome.level, "warn");
  assert.match(missingOutcome.detail, /paid\/missing-cache prices cache reads at \$0/);

  // A model that declares a cache price stays silent.
  const priced = readyRepo();
  writeConfig(priced, { model: "paid/priced-cache" });
  assert.equal((await checkTierModels(priced, file, async () => "ready")).level, "ok");

  // An unpriced model's real spend is zero, so its zero cache price undercounts nothing.
  const free = readyRepo();
  writeConfig(free, { model: "local/free-model" });
  assert.equal((await checkTierModels(free, file, async () => "ready")).level, "ok");
});

test("checkTierModels degrades to a warning when the definitions file is unreadable", async () => {
  const root = readyRepo();
  writeConfig(root, { model: "paid/gpt-x" });
  const outcome = await checkTierModels(root, path.join(tmpdir(), "absent-models.json"), async () => "ready");
  assert.equal(outcome.level, "warn");
  assert.match(outcome.detail, /cannot check — could not read pi's model definitions/);
});

test("checkTierModels reports set PI_*_MODEL variables and points at the tier keys", async () => {
  const models = writeModels();
  const root = readyRepo();

  // Set: the note appends and the level warns (a warn never touches the exit code).
  const withVar = await checkTierModels(root, models, async () => "ready", { PI_SMOL_MODEL: "x" });
  assert.equal(withVar.level, "warn");
  assert.match(withVar.detail, /PI_SMOL_MODEL is set: tumwater does not read it/);
  assert.match(withVar.detail, /model\.small \/ model\.strong/);

  // Several at once are listed together.
  const withBoth = await checkTierModels(root, models, async () => "ready", {
    PI_SLOW_MODEL: "x",
    PI_PLAN_MODEL: "y",
  });
  assert.equal(withBoth.level, "warn");
  assert.match(withBoth.detail, /PI_SLOW_MODEL and PI_PLAN_MODEL are set: tumwater does not read them/);

  // Unset: no note anywhere.
  const without = await checkTierModels(root, models, async () => "ready", {});
  assert.equal(without.level, "ok");
  assert.ok(!without.detail.includes("PI_"), `no PI note when unset: ${without.detail}`);

  // A fail outranks the note's warn; the note still travels with the detail.
  writeConfig(root, { model: "paid/missing" });
  const failWithNote = await checkTierModels(root, models, async () => "ready", { PI_SMOL_MODEL: "x" });
  assert.equal(failWithNote.level, "fail");
  assert.match(failWithNote.detail, /does not resolve .*PI_SMOL_MODEL is set/);

  // The empty-string form counts as unset: an exported-but-empty variable is no signal.
  writeConfig(root, {}); // back to the clean config: no declared pairs, nothing to fail on
  const emptyVar = await checkTierModels(root, models, async () => "ready", { PI_SMOL_MODEL: "" });
  assert.equal(emptyVar.level, "ok");
});

test("checkTierModels cannot run on an invalid config and says so without failing", async () => {
  const root = readyRepo();
  writeConfig(root, { bogusKey: 1 });
  const outcome = await checkTierModels(root, path.join(tmpdir(), "absent.json"), async () => "ready");
  assert.equal(outcome.level, "warn");
  assert.match(outcome.detail, /cannot check — invalid tumwater\.json/);
});

// The default probe runs the resolved agent binary's own auth check; pinned against a fake
// pi on PATH (never a real model) for each verdict shape.
test("piProviderAuth reads ready out of the agent binary's auth check and never throws", async () => {
  const binDir = tmpdir("doctor-auth-bins-");
  writeScript(path.join(binDir, "pi"), 'echo \'{"ready":true}\'');
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir), "ready");

  writeScript(path.join(binDir, "pi"), 'echo \'{"ready":false}\'');
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir), "not-ready");

  writeScript(path.join(binDir, "pi"), "echo not-json");
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir), "unknown");

  writeScript(path.join(binDir, "pi"), "exit 3");
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir), "unknown");

  // A binary that does not exist is unknown, not a thrown error.
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", tmpdir("doctor-empty-bins-")), "unknown");
});
