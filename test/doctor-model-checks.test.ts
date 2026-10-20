import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  checkAnthroApiKey,
  checkClaudeAuth,
  checkClaudeVersion,
  checkFallbackChain,
  checkFallbackModel,
  checkImageInput,
  checkOpencode,
  checkTierModels,
  parsePiModelList,
  piListedModels,
  piProviderAuth,
} from "../src/doctor/doctor-model-checks.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { readyRepo } from "./fixtures/doctor-fixtures.js";
import { writeScript } from "./fakes/fake-commands.js";
import { writeOpencodeCache } from "../src/agent/opencode/opencode-catalog.js";
import { writeClaudeAccount } from "../src/agent/claude/claude-account.js";
import { registerAgentBackend } from "../src/agent/agent-backend.js";
import { piBackend } from "../src/pi/pi-backend.js";
import { claudeBackend } from "../src/agent/claude/claude-backend.js";
import { todayStamp } from "../src/budget/budget.js";
import { saveRunnerState, loadRunnerState } from "../src/runner/runner-state.js";
import { allRoleIds } from "../src/roles/roles.js";
import type { ImageProbeResult } from "../src/doctor/image-probe.js";
import { envPath } from "../src/files/files.js";
import { imageProbesPath, piListedModelsPath } from "../src/paths.js";
import { readPiListedModels } from "../src/pi/pi-listed-models.js";

// Unit coverage for the doctor's model-readiness checks (src/doctor/doctor-model-checks.ts):
// the cap fallback's price check, the declared-tier resolution check, and the agent binary's
// credential probe. Every branch is exercised with an injected `modelsPath`/`auth` stub, and
// the probe with a fake pi on PATH — never a real model or network call. The environment and
// repo checks' own coverage lives in test/doctor-checks.test.ts; the fixtures both files share
// live in test/fixtures/doctor-fixtures.ts and test/fixtures/repo-fixtures.ts.

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

  // No fallbackModel: informational — the team pauses at the cap by design. The definitions
  // file is not even consulted, so an absent path is still ok.
  const none = readyRepo();
  assert.deepEqual(checkFallbackModel(none, path.join(tmpdir(), "absent.json")), {
    level: "ok",
    detail: "none configured — roles pause at the cap",
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
  // The running team's breaker demoted it (runDoctor passes orchestrator.json's
  // fallbackDemoted only while that orchestrator is alive): warn with the evidence and the retry.
  const probeAt = new Date(2026, 8, 19, 23, 10, 56).getTime();
  const demoted = checkFallbackModel(free, models, { pair: "local/free-model", failures: 3, probeAt });
  assert.equal(demoted.level, "warn");
  assert.match(demoted.detail, /^local\/free-model is priced at zero but not serving/);
  assert.match(demoted.detail, /demoted it after 3 consecutive failed runs, so roles pause at the cap/);
  assert.match(demoted.detail, /one probe run retries it from 23:10:56$/);

  // A pair naming only one half falls through to pi's own default and can never be free —
  // the warning names the half-resolved pair instead of rendering a bare "?/model".
  const half = readyRepo();
  writeConfig(half, { fallbackModel: { model: "solo-model" } });
  const halfWarn = checkFallbackModel(half, models);
  assert.equal(halfWarn.level, "warn");
  assert.match(halfWarn.detail, /^a half-resolved pair is not priced at zero/);
  assert.match(halfWarn.detail, /roles pause instead of switching/);

  // A priced or unknown id would be refused by the gate, so roles would pause at the cap
  // instead of switching — warn before the day's budget is spent on discovering it.
  const paid = readyRepo();
  writeConfig(paid, { fallbackModel: { provider: "paid", model: "gpt-x" } });
  const warned = checkFallbackModel(paid, models);
  assert.equal(warned.level, "warn");
  assert.match(warned.detail, /paid\/gpt-x is not priced at zero/);
  assert.match(warned.detail, /roles pause instead of switching/);

  // A subscription claude fallback is free by the account's billing answer, not by
  // models.json: the check reads the same account the budget gate does.
  const claudeSub = readyRepo();
  writeConfig(claudeSub, { fallbackModel: { provider: "claude", model: "claude-sonnet-5-5" } });
  writeClaudeAccount(claudeSub, { billing: "subscription", observedAt: Date.now(), windows: {} });
  const accepted = checkFallbackModel(claudeSub, path.join(tmpdir(), "absent.json"));
  assert.equal(accepted.level, "ok");
  assert.match(accepted.detail, /^claude\/claude-sonnet-5-5 — priced at zero/);
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
    detail: "no models declared — every model job uses pi's own default",
  });
});

test("checkTierModels fails a pair pi cannot resolve and warns on an unready provider", async () => {
  const models = writeModels();

  // A typo'd model id fails: a strong tier pi cannot resolve would fail every review.
  const typoRoot = readyRepo();
  writeConfig(typoRoot, { model: "paid/no-such-model" });
  const typo = await checkTierModels(typoRoot, models, async () => "ready", process.env, async () => null);
  assert.equal(typo.level, "fail");
  assert.match(typo.detail, /paid\/no-such-model does not resolve/);

  // A provider pi has never heard of fails too.
  const unknownRoot = readyRepo();
  writeConfig(unknownRoot, { model: "nowhere/mystery" });
  const unknownProvider = await checkTierModels(unknownRoot, models, async () => "ready", process.env, async () => null);
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
  const roleModel = await checkTierModels(roleRoot, models, async () => "ready", process.env, async () => null);
  assert.equal(roleModel.level, "fail");
  assert.match(roleModel.detail, /paid\/no-such-qa-model does not resolve/);
});

test("checkTierModels warns on a declared selector that names no provider", async () => {
  const models = writeModels();
  const root = readyRepo();
  // A slash-less selector is a bare pattern with no provider (model-selector.ts): pi
  // resolves it against its own default, so tumwater cannot verify it — warn rather than
  // look it up as the empty-string provider and fail. The auth stub must never be called.
  writeConfig(root, { model: "bare-model" });
  let probed = 0;
  const outcome = await checkTierModels(root, models, async () => {
    probed++;
    return "ready";
  });
  assert.equal(outcome.level, "warn");
  assert.match(outcome.detail, /bare-model names no provider/);
  assert.equal(probed, 0, "a providerless pair is not probed");
});

test("checkTierModels notes per-token billing for a Claude model routed to pi; a bare claude id stays silent", async () => {
  const root = readyRepo();
  const file = path.join(tmpdir("doctor-pi-claude-"), "models.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      providers: {
        anthropic: { models: [{ id: "claude-opus-5-5", cost: { input: 15, output: 75 } }] },
      },
    }),
  );
  // `anthropic/claude-opus-5-5` keeps pi (a named provider beats rule 3a) and is billed per
  // token even under a Claude subscription login, so doctor names the seam.
  writeConfig(root, { model: "anthropic/claude-opus-5-5" });
  const pinned = await checkTierModels(root, file, async () => "ready");
  assert.equal(pinned.level, "warn");
  assert.match(pinned.detail, /anthropic\/claude-opus-5-5 runs on pi and is billed per token/);
  // A bare `claude-opus-5-5` routes to the claude CLI (rule 3a), so it is not a pi pair: the
  // pi sweep must not name it score-wise nor probe pi's auth.
  writeConfig(root, { model: "claude-opus-5-5" });
  let probed = 0;
  const bare = await checkTierModels(root, file, async () => {
    probed++;
    return "ready";
  });
  assert.equal(bare.level, "ok");
  assert.match(bare.detail, /claude-routed .*resolved by the claude backend/);
  assert.ok(!bare.detail.includes("billed per token"), `a bare claude id must not draw the pi-billing note: ${bare.detail}`);
  assert.equal(probed, 0, "a claude-routed pair never probes pi's auth");
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
  const outcome = await checkTierModels(root, path.join(tmpdir(), "absent-models.json"), async () => "ready", process.env, async () => null);
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
  const failWithNote = await checkTierModels(root, models, async () => "ready", { PI_SMOL_MODEL: "x" }, async () => null);
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

// --- claude routing (plans/agent-backends.md "Every seam, checked", part 4e/7) ---

// A claude-routed config has no pi pair to resolve, so the sweep must not consult (or require)
// pi's models.json for it — and must not probe pi's auth check.
test("checkTierModels skips pi's definitions for claude-routed models", async () => {
  const root = readyRepo();
  writeConfig(root, { agent: "claude" });
  let probed = 0;
  const outcome = await checkTierModels(root, path.join(tmpdir(), "absent-models.json"), async () => {
    probed++;
    return "ready";
  });
  assert.equal(outcome.level, "ok");
  assert.match(outcome.detail, /claude-routed .* resolved by the claude backend, not pi's definitions/);
  assert.equal(probed, 0, "a claude-routed config probes no pi provider");
});

// An agent id is reserved: a pi models.json provider of the same name can never be reached
// through routing, so doctor warns rather than silently ignoring the definitions.
test("checkTierModels warns when pi's definitions name a reserved agent id", async () => {
  const dir = tmpdir("doctor-reserved-");
  const file = path.join(dir, "models.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ providers: { claude: { models: [{ id: "claude-x", cost: { input: 0, output: 0 } }] } } }),
  );
  const root = readyRepo();
  writeConfig(root, { agent: "claude" });
  const outcome = await checkTierModels(root, file, async () => "ready");
  assert.equal(outcome.level, "warn");
  assert.match(outcome.detail, /declare provider "claude" — the name is reserved for an agent backend/);
});

// opencode (part 2/7): a model routed to opencode is not a pi pair and must not consult (or
// require) pi's definitions nor probe pi's auth; the routing note names OpenCode's CLI and the
// design §2 caveat that a bare `opencode/…` id always means the OpenCode CLI, never pi's
// built-in `opencode` gateway.
test("checkTierModels notes opencode-routed models and the built-in opencode caveat", async () => {
  const root = readyRepo();
  writeConfig(root, { backend: "opencode", model: "deepseek-v4.1-flash-free" });
  let probed = 0;
  const outcome = await checkTierModels(root, path.join(tmpdir(), "absent-models.json"), async () => {
    probed++;
    return "ready";
  });
  assert.equal(outcome.level, "ok");
  assert.match(outcome.detail, /opencode-routed .* ids run on the OpenCode CLI/);
  assert.match(
    outcome.detail,
    /pi's built-in `opencode` provider is not reachable from tumwater/,
  );
  assert.equal(probed, 0, "an opencode-routed config probes no pi provider");
});

test("checkTierModels warns when pi's definitions name the reserved opencode provider", async () => {
  const dir = tmpdir("doctor-reserved-");
  const file = path.join(dir, "models.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ providers: { opencode: { models: [{ id: "deepseek-x" }] } } }),
  );
  const root = readyRepo();
  // opencode declares no tier defaults, so name an explicit model to get past the
  // "no models declared" early return and reach the reserved-provider warning.
  writeConfig(root, { backend: "opencode", model: "deepseek-v4.1-flash-free" });
  const outcome = await checkTierModels(root, file, async () => "ready");
  assert.equal(outcome.level, "warn");
  assert.match(outcome.detail, /declare provider "opencode" — the name is reserved for an agent backend/);
});

// The subscription-vs-API billing trap (plans/provider-concurrency.md §9 gap 6): with
// ANTHROPIC_API_KEY exported (for pi's anthropic provider) a claude seam prefers the key over a
// claude.ai login, silently moving every claude run to API billing. Doctor warns only when the
// key is set, a claude seam is in use, and claude reports a claude.ai login to lose; a pi-only
// team, an unset key, an API-key login, or an unreadable probe all hold the warning.
test("checkAnthroApiKey warns on API key + claude.ai login with a claude seam in use", async () => {
  const root = readyRepo();
  writeConfig(root, { agent: "claude" });
  const bin = tmpdir("doctor-claude-key-");
  writeScript(path.join(bin, "claude"), 'echo \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team"}\'');
  const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
  const warn = await checkAnthroApiKey(root, env, bin);
  assert.equal(warn.level, "warn");
  assert.match(warn.detail, /ANTHROPIC_API_KEY is set while claude reports a claude\.ai login/);
  assert.match(warn.detail, /bill the API key, not the subscription/);

  // Unset key: no trap, silent.
  assert.deepEqual(await checkAnthroApiKey(root, {}, bin), { level: "ok", detail: "no ANTHROPIC_API_KEY set" });
  // An API-key login means there is no subscription to lose: silent.
  writeScript(path.join(bin, "claude"), 'echo \'{"loggedIn":true,"authMethod":"ANTHROPIC_API_KEY"}\'');
  const apiLogin = await checkAnthroApiKey(root, env, bin);
  assert.equal(apiLogin.level, "ok");
  assert.match(apiLogin.detail, /no claude\.ai login/);
});

// No claude seam, no trap (gap 6's silence rule): a pi-only team never spawns claude, so the
// key, however exported, cannot move a claude run off the subscription.
test("checkAnthroApiKey stays silent without a claude seam", async () => {
  const root = readyRepo();
  writeConfig(root, { model: "local/free-model" });
  const empty = tmpdir("doctor-claude-key-empty-");
  assert.deepEqual(await checkAnthroApiKey(root, { ANTHROPIC_API_KEY: "sk-ant-test" }, empty), {
    level: "ok",
    detail: "no model jobs run on claude",
  });
});

// The auth probe is pinned against a fake claude on PATH (never a real model) for each verdict.
test("checkClaudeAuth fails a logged-out claude and names the billing it implies", async () => {
  const root = readyRepo();
  writeConfig(root, { agent: "claude" });
  const bin = tmpdir("doctor-claude-auth-");
  writeScript(path.join(bin, "claude"), 'echo \'{"loggedIn":false}\'');
  const out = await checkClaudeAuth(root, bin);
  assert.equal(out.level, "fail");
  assert.match(out.detail, /logged in: false — run `claude auth login`/);

  writeScript(path.join(bin, "claude"), 'echo \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team"}\'');
  const subscription = await checkClaudeAuth(root, bin);
  assert.equal(subscription.level, "ok");
  assert.match(subscription.detail, /logged in — billing: subscription \(team\)/);

  writeScript(path.join(bin, "claude"), 'echo \'{"loggedIn":true,"authMethod":"ANTHROPIC_API_KEY"}\'');
  const api = await checkClaudeAuth(root, bin);
  assert.equal(api.level, "ok");
  assert.match(api.detail, /logged in — billing: API key/);

  writeScript(path.join(bin, "claude"), "echo not-json");
  const unreadable = await checkClaudeAuth(root, bin);
  assert.equal(unreadable.level, "warn");
  assert.match(unreadable.detail, /could not check/);
});

// The auth probe must run under the configured team config dir, or it would check claude's
// default dir while a run with backends.claude.configDir writes and auths elsewhere — the very
// mismatch doctor exists to surface. The fake claude records the CLAUDE_CONFIG_DIR it saw.
test("checkClaudeAuth probes under the configured team config dir", async () => {
  const root = readyRepo();
  const seen = path.join(tmpdir("doctor-claude-auth-cfg-"), "seen");
  writeConfig(root, { agent: "claude", backends: { claude: { configDir: "/team/claude" } } });
  const bin = tmpdir("doctor-claude-auth-cfg-bin-");
  writeScript(
    path.join(bin, "claude"),
    `echo "$CLAUDE_CONFIG_DIR" > "${seen}"; echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team"}'`,
  );
  const out = await checkClaudeAuth(root, bin);
  assert.equal(out.level, "ok");
  assert.equal(fs.readFileSync(seen, "utf8").trim(), "/team/claude");
});

// A pi-only config stands the claude checks down, so a team that never runs claude spawns no
// claude and reads no claude state.
test("checkClaudeAuth and checkClaudeVersion stand down without a claude seam", async () => {
  const root = readyRepo();
  writeConfig(root, { model: "local/free-model" });
  const empty = tmpdir("doctor-claude-empty-");
  assert.deepEqual(await checkClaudeAuth(root, empty), { level: "ok", detail: "no model jobs run on claude" });
  assert.deepEqual(await checkClaudeVersion(root, empty), { level: "ok", detail: "no model jobs run on claude" });
});

// The version gate: a CLI below a configured model's floor fails and names the model, a newer
// one passes and prints the version against the floor.
// A config whose claude seam is only a fallback must still route the claude checks on (gap 1
// of plans/provider-concurrency.md §9): before `seamsInUse`, seamPairs missed the fallback pair,
// so these stood down and the fallback's binary/auth/version were never verified.
test("claude checks run when claude appears only as a fallback", async () => {
  const root = readyRepo();
  writeConfig(root, { model: "local/free-model", fallback: [{ backend: "claude", model: "claude-sonnet-5-5" }] });
  const bin = tmpdir("doctor-claude-fallback-");
  writeScript(path.join(bin, "claude"), 'echo \'{"loggedIn":true,"subscriptionType":"team"}\'');
  const auth = await checkClaudeAuth(root, bin);
  assert.equal(auth.level, "ok");
  assert.match(auth.detail, /logged in — billing: subscription \(team\)/);
  writeScript(path.join(bin, "claude"), 'echo "2.1.295 (Claude Code)"');
  const version = await checkClaudeVersion(root, bin);
  assert.equal(version.level, "ok");
  assert.match(version.detail, /claude 2\.1\.295 \(>= 2\.1\.280 for claude-/);
});

// A fallback's pi provider is swept like any primary's: gap 1 makes seamPairs include the
// fallback, so checkTierModels probes its provider and prices it.
test("checkTierModels checks a pi fallback's provider", async () => {
  const models = writeModels();
  const probed: string[] = [];
  const root = readyRepo();
  writeConfig(root, { model: "paid/gpt-x", fallback: "local/free-model" });
  const outcome = await checkTierModels(root, models, async (p) => {
    probed.push(p);
    return "ready";
  });
  assert.equal(outcome.level, "ok");
  assert.ok(probed.includes("local"), `the fallback's pi provider is probed (${probed})`);
  assert.ok(probed.includes("paid"), `the primary's provider is probed (${probed})`);
});

// The claude checks' stand-down (without a claude seam) and the binary check's agent list
// (agentsInUse) both derive from the one seamsInUse list, so a fallback-only claude can never
// disagree: covered above for the checks, and by the startup-gate fallback test for the seed.
test("a claude-only fallback is reported by the doctor's binary/credential/version checks together", async () => {
  const root = readyRepo();
  writeConfig(root, { model: "local/free-model", fallback: [{ backend: "claude", model: "claude-sonnet-5-5" }] });
  const bin = tmpdir("doctor-claude-fallback-2-");
  writeScript(path.join(bin, "claude"), 'echo \'{"loggedIn":true,"subscriptionType":"team"}\'');
  // Both surfaces see claude — the auth check runs (not "no model jobs run on claude") proving
  // claudeSeamsInUse is true, which is exactly what the binary check's agentsInUse reports too.
  const auth = await checkClaudeAuth(root, bin);
  assert.ok(!auth.detail.includes("no model jobs run on claude"), `a fallback claude is in use: ${auth.detail}`);
});

test("checkClaudeVersion fails a CLI below a configured model's floor", async () => {
  const root = readyRepo();
  writeConfig(root, { agent: "claude" });
  const bin = tmpdir("doctor-claude-version-");
  writeScript(path.join(bin, "claude"), 'echo "2.1.216 (Claude Code)"');
  const old = await checkClaudeVersion(root, bin);
  assert.equal(old.level, "fail");
  assert.match(old.detail, /claude 2\.1\.216 is older than 2\.1\.280 required by claude-/);

  writeScript(path.join(bin, "claude"), 'echo "2.1.295 (Claude Code)"');
  const fresh = await checkClaudeVersion(root, bin);
  assert.equal(fresh.level, "ok");
  assert.match(fresh.detail, /claude 2\.1\.295 \(>= 2\.1\.280 for claude-/);

  // `off`/`minimal` thinking has no claude setting below `low`, and the check notes the clamp.
  writeConfig(root, { agent: "claude", thinking: "minimal" });
  const clamped = await checkClaudeVersion(root, bin);
  assert.equal(clamped.level, "ok");
  assert.match(clamped.detail, /`off`\/`minimal` thinking clamps to `--effort low`/);

  writeScript(path.join(bin, "claude"), "exit 3");
  const unreadable = await checkClaudeVersion(root, bin);
  assert.equal(unreadable.level, "warn");
  assert.match(unreadable.detail, /could not check/);
});

// The default probe runs the resolved agent binary's own auth check; pinned against a fake
// pi on PATH (never a real model) for each verdict shape.
test("piProviderAuth reads ready out of the agent binary's auth check and never throws", async () => {
  const binDir = tmpdir("doctor-auth-bins-");
  writeScript(path.join(binDir, "pi"), 'echo \'{"ready":true}\'');
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir), "ready");

  writeScript(path.join(binDir, "pi"), 'echo \'{"ready":false}\'');
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir), "not-ready");

  // A `ready` that is not the boolean false is not not-ready: valid JSON with a non-boolean
  // `ready` reads unknown, never not-ready (which would blame the credentials).
  writeScript(path.join(binDir, "pi"), 'echo \'{"ready":"yes"}\'');
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir), "unknown");

  // A valid `{"ready":false}` on a nonzero exit is unknown: the exit-code gate is first, so
  // a crashed check is never read as "credentials missing".
  writeScript(path.join(binDir, "pi"), 'echo \'{"ready":false}\'; exit 3');
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir), "unknown");

  writeScript(path.join(binDir, "pi"), "echo not-json");
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir), "unknown");

  writeScript(path.join(binDir, "pi"), "exit 3");
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir), "unknown");

  // A binary that does not exist is unknown, not a thrown error.
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", tmpdir("doctor-empty-bins-")), "unknown");

  // A spawn that throws before a child exists (a NUL byte in the resolved bin, which Node
  // rejects synchronously) is unknown too: a malformed agentBin must not reject the probe
  // and crash `tumwater doctor`.
  assert.equal(await piProviderAuth({ agentBin: "bad\0bin" } as TumwaterConfig, "local", binDir), "unknown");
});

// A probe whose child never delivers `'close'`, or floods its pipe, must settle at its own
// bound: `'close'` waits for the stdio pipes, so a grandchild holding them open would otherwise
// leave the promise pending past the deadline and hang doctor. The injected timeout keeps a
// regression failing in seconds instead of the production 15 s.
test("piProviderAuth settles at its deadline and caps runaway output", { timeout: 5000 }, async () => {
  const binDir = tmpdir("doctor-auth-bins-");
  // The probe runs with PATH set to binDir alone, so the body must hold stdout with shell
  // builtins only: the sunk subshell stays alive after the direct child exits, keeping the
  // pipe open so no `'close'` ever arrives. The deadline must settle the probe and reap the
  // group.
  writeScript(path.join(binDir, "pi"), "( while :; do :; done ) &");
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir, 200), "unknown");

  // Runaway output: once past the cap the probe stops capturing, kills the child, and reads
  // as unknown rather than growing the buffer for the whole deadline. Settling well before the
  // 4 s deadline is the red-proof for the cap: the producer never exits, so without the cap
  // branch the probe would still read "unknown" but only after the deadline, and this timing
  // would fail. Each iteration is a single `printf` shell builtin writing 100 KB (no external
  // binary, no PATH lookup), so the 1 MiB cap costs ~11 pipe reads instead of the old
  // `while true; do echo ...; done`'s ~65k shell iterations, which a busy machine could
  // stretch past the 3 s bound. A shell without `printf` emits nothing, so that loop runs to
  // the deadline and fails the timing bound rather than passing as a fast nonzero exit.
  writeScript(path.join(binDir, "pi"), "while :; do printf '%0100000d' 0; done");
  const startedAt = Date.now();
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir, 4000), "unknown");
  assert.ok(Date.now() - startedAt < 3000, "runaway output settles at the output cap, not the deadline");
});

// --- image input (plans/image-input.md "Doctor", part 1/5) ---

// A models.json with text-only and vision models for the image-input check. Unpriced, so the
// fallback pairs the check sweeps are free and resolved.
function writeImageModels(): string {
  const dir = tmpdir("doctor-image-input-");
  const file = path.join(dir, "models.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      providers: {
        local: {
          models: [
            { id: "text" },
            { id: "textlist", input: ["text"] },
            { id: "vision", input: ["text", "image"] },
          ],
        },
      },
    }),
  );
  return file;
}

// Register the real claude/pi adapters so a claude seam reads true through the backend hook.
registerAgentBackend(piBackend);
registerAgentBackend(claudeBackend);

/** A roles map enabling only `feature` (default tier), so the image-input check's loop sweep is
 * predictable: the director and every maintenance role are switched off. */
function onlyFeature(): Record<string, { enabled: boolean }> {
  const roles: Record<string, { enabled: boolean }> = {};
  for (const id of allRoleIds()) roles[id] = { enabled: false };
  roles.feature = { enabled: true };
  return roles;
}

test("checkImageInput is ok when every seam reads images (all-claude), naming them", async () => {
  const root = readyRepo();
  writeConfig(root, {
    agent: "claude",
    model: { default: "claude-sonnet-5-5", strong: "claude-opus-5-5" },
    roles: onlyFeature(),
  });
  const outcome = await checkImageInput(root, path.join(tmpdir(), "absent.json"));
  assert.deepEqual(outcome, {
    level: "ok",
    detail: "reads images: claude-opus-5-5, claude-sonnet-5-5",
  });
});

test("checkImageInput names the reroute for a text-only default with a vision strong (unverified by default)", async () => {
  const models = writeImageModels();
  const root = readyRepo();
  writeConfig(root, { model: { default: "local/text", strong: "local/vision" }, roles: onlyFeature() });
  const outcome = await checkImageInput(root, models);
  assert.equal(outcome.level, "ok");
  assert.match(outcome.detail, /^reads images: local\/vision \(not verified yet — run `tumwater doctor`\); /);
  assert.match(
    outcome.detail,
    /feature text-only \(local\/text\) — reroutes to strong \(local\/vision\)/,
  );
});

test("checkImageInput warns when no tier can read images and a text-only role has no target", async () => {
  const models = writeImageModels();
  const root = readyRepo();
  writeConfig(root, { model: { default: "local/text", strong: "local/textlist" }, roles: onlyFeature() });
  const outcome = await checkImageInput(root, models);
  assert.equal(outcome.level, "warn");
  assert.match(outcome.detail, /^feature text-only \(local\/text\) — no configured model reads images/);
  assert.match(outcome.detail, /declare image input on a vision model in pi's models\.json/);
});

test("checkImageInput warns when no seam reads images (models declared, all text-only)", async () => {
  const models = writeImageModels();
  const root = readyRepo();
  // All roles disabled, but a team with only a text-only model declared: nothing can read
  // images, even though there is nothing enabled to run — the gap is still worth surfacing.
  writeConfig(root, {
    model: { default: "local/text" },
    roles: Object.fromEntries(Object.entries(onlyFeature()).map(([id]) => [id, { enabled: false }])),
  });
  const outcome = await checkImageInput(root, models);
  assert.equal(outcome.level, "warn");
  assert.match(outcome.detail, /^no configured model reads images/);
});

test("checkImageInput is informational when no models are declared at all", async () => {
  const root = readyRepo();
  // No model map: capability is left to pi's own defaults, the same stance as tier models —
  // informational, so a default-configured team still reads doctor as ready.
  writeConfig(root, { roles: onlyFeature() });
  const outcome = await checkImageInput(root, writeImageModels());
  assert.equal(outcome.level, "ok");
  assert.match(outcome.detail, /^no models declared/);
});

test("checkImageInput cannot check when models.json is unreadable", async () => {
  const root = readyRepo();
  writeConfig(root, { model: { default: "local/text", strong: "local/vision" }, roles: onlyFeature() });
  const outcome = await checkImageInput(root, path.join(tmpdir(), "absent.json"));
  assert.equal(outcome.level, "warn");
  assert.match(outcome.detail, /^cannot check — could not read pi's model definitions/);
});

// ── The live image probe (part 2/5): probeImages + cache. The probe itself is injected so
// these tests need no real pi on PATH; checkImageInput's caller passes the resolved probe, and
// runImageProbe's own process handling is covered in test/image-probe.test.ts with a fake pi.

/** A ready repo with one claimed vision model (local/vision on the strong tier) and only the
 * feature role, the shape the probe tests drive. */
function probeConfig(): { root: string; models: string } {
  const root = readyRepo();
  const models = writeImageModels();
  writeConfig(root, { model: { default: "local/text", strong: "local/vision" }, roles: onlyFeature() });
  return { root, models };
}

test("checkImageInput with missing probes only uncached claimed models once, and caches the pass", async () => {
  const { root, models } = probeConfig();
  let calls = 0;
  const probe = async (): Promise<ImageProbeResult> => {
    calls += 1;
    return { verdict: "pass", detail: 'answered "1"' };
  };
  const base = envPath();
  const first = await checkImageInput(root, models, undefined, undefined, "missing", base, probe);
  assert.equal(calls, 1, "probes the one claimed model");
  assert.equal(first.level, "ok");
  assert.match(first.detail, /local\/vision \(verified \d{4}-\d{2}-\d{2}\)/);
  // A second doctor within 7 days reads the fresh cached pass and spawns no probe.
  const second = await checkImageInput(root, models, undefined, undefined, "missing", base, probe);
  assert.equal(calls, 1, "cached pass means no second probe");
  assert.equal(second.level, "ok");
});

test("checkImageInput fails a claimed model whose probe failed, naming it and the fix", async () => {
  const { root, models } = probeConfig();
  const probe = async (): Promise<ImageProbeResult> => ({ verdict: "fail", detail: 'answered "6319"' });
  const outcome = await checkImageInput(root, models, undefined, undefined, "missing", envPath(), probe);
  assert.equal(outcome.level, "fail");
  assert.match(outcome.detail, /local\/vision failed the image probe — answered "6319"/);
  assert.match(outcome.detail, /remove "image" from its input in pi's models\.json or fix the endpoint/);
  assert.match(outcome.detail, /tumwater doctor --reprobe/);
});

test("checkImageInput warns but does not cache a probe that could not verify", async () => {
  const { root, models } = probeConfig();
  let calls = 0;
  const probe = async (): Promise<ImageProbeResult> => {
    calls += 1;
    return { verdict: "could-not-verify", detail: "the provider backend failed (5xx or connection)" };
  };
  const base = envPath();
  const first = await checkImageInput(root, models, undefined, undefined, "missing", base, probe);
  assert.equal(first.level, "warn");
  assert.match(first.detail, /local\/vision could not be verified — the provider backend failed/);
  // could-not-verify is never cached: a second run probes again.
  await checkImageInput(root, models, undefined, undefined, "missing", base, probe);
  assert.equal(calls, 2, "uncached could-not-verify probes again");
});

test("checkImageInput with never probes nothing even when unverified", async () => {
  const { root, models } = probeConfig();
  let calls = 0;
  const probe = async (): Promise<ImageProbeResult> => {
    calls += 1;
    return { verdict: "pass", detail: 'answered "1"' };
  };
  const outcome = await checkImageInput(root, models, undefined, undefined, "never", envPath(), probe);
  assert.equal(calls, 0, "the TUI/GUI path never spawns a probe");
  assert.equal(outcome.level, "ok");
});

test("checkImageInput --reprobe re-probes a model that already has a fresh cached pass", async () => {
  const { root, models } = probeConfig();
  let calls = 0;
  const probe = async (): Promise<ImageProbeResult> => {
    calls += 1;
    return { verdict: "pass", detail: 'answered "1"' };
  };
  const base = envPath();
  await checkImageInput(root, models, undefined, undefined, "missing", base, probe);
  assert.equal(calls, 1, "first run cached a pass");
  await checkImageInput(root, models, undefined, undefined, "all", base, probe);
  assert.equal(calls, 2, "--reprobe bypasses the cache");
});

// The write-side fallback key (objection): a free fallback pair that fails its probe is cached
// under the same imageProbeKey("pi", …) the readers (seamImageInput/imageReroute) look up, and a
// second doctor run within the TTL reads that fresh fail without a double probe.
test("checkImageInput caches a failed free-fallback probe under the pi agent key and does not re-probe", async () => {
  const root = readyRepo();
  const modelsDir = tmpdir("doctor-image-probe-fallback-");
  const models = path.join(modelsDir, "models.json");
  fs.writeFileSync(
    models,
    JSON.stringify({
      providers: {
        local: {
          models: [
            { id: "text" },
            { id: "fb-vision", input: ["text", "image"] },
          ],
        },
      },
    }),
  );
  // Both primary tiers text-only; the only vision claim rides the strong tier's free fallback.
  writeConfig(root, {
    model: { default: "local/text", strong: "local/text" },
    fallback: { strong: "local/fb-vision" },
    roles: onlyFeature(),
  });
  let calls = 0;
  const probe = async (): Promise<ImageProbeResult> => {
    calls += 1;
    return { verdict: "fail", detail: 'answered "6319"' };
  };
  const base = envPath();
  const first = await checkImageInput(root, models, undefined, undefined, "missing", base, probe);
  assert.equal(calls, 1, "probes the one claimed fallback model");
  assert.equal(first.level, "fail");
  assert.match(first.detail, /local\/fb-vision failed the image probe/);
  // The cached key carries the pi agent segment — the segment the readers resolve and look up.
  const cache = JSON.parse(fs.readFileSync(imageProbesPath(root), "utf8"));
  const entry = cache["pi/local/fb-vision"];
  assert.ok(entry, `fallback fail cached under the pi agent key (keys: ${Object.keys(cache)})`);
  assert.equal(entry.verdict, "fail");
  // A second doctor within the TTL reads the fresh fail verdict and spawns no probe.
  const second = await checkImageInput(root, models, undefined, undefined, "missing", base, probe);
  assert.equal(calls, 1, "fresh cached fail means no double probe");
  assert.equal(second.level, "fail");
});

/** A models.json whose `local` provider points at `baseUrl`, plus a priced `paid` one. */
function writeChainModels(baseUrl: string): string {
  const file = path.join(tmpdir("doctor-chain-"), "models.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      providers: {
        local: { baseUrl, models: [{ id: "free-model" }] },
        paid: { baseUrl: "https://api.example.com/v1", models: [{ id: "gpt-x", cost: { input: 1, output: 2 } }] },
      },
    }),
  );
  return file;
}

test("checkFallbackChain reads ok 'none configured' without a fallback", async () => {
  const root = readyRepo();
  assert.deepEqual(await checkFallbackChain(root, path.join(tmpdir(), "absent.json")), {
    level: "ok",
    detail: "none configured",
  });
});

test("checkFallbackChain warns on a local server that does not answer and reads ok on one that does", async () => {
  // An injected probe stands in for the server: the gating tier binds no real listener.
  const models = writeChainModels("http://127.0.0.1:8090/v1");
  const root = readyRepo();
  writeConfig(root, { fallback: ["local/free-model"] });
  const urls: string[] = [];
  const up = await checkFallbackChain(root, models, async (u) => (urls.push(u), true));
  assert.equal(up.level, "ok");
  assert.match(up.detail, /default 1: local\/free-model — free · server up/);
  assert.deepEqual(urls, ["http://127.0.0.1:8090/v1/models"]);
  const down = await checkFallbackChain(root, models, async () => false);
  assert.equal(down.level, "warn");
  assert.match(down.detail, /not running \(GET http:\/\/127\.0\.0\.1:8090\/v1\/models failed\)/);
});

test("checkFallbackChain flags a spent step cap and never probes a non-local server", async () => {
  const root = readyRepo();
  writeConfig(root, { fallback: [{ model: "paid/gpt-x", maxDailyCostUsd: 5 }] });
  const models = writeChainModels("http://127.0.0.1:1/v1");
  const state = loadRunnerState(root, "feature");
  state.dayStamp = todayStamp();
  state.dayCostByPair = { "paid/gpt-x": 5 };
  saveRunnerState(root, state);
  let calls = 0;
  const spent = await checkFallbackChain(root, models, async () => (calls++, true));
  assert.match(spent.detail, /default 1: paid\/gpt-x — cap reached \(\$5\.00\/\$5\)/);

  const remote = readyRepo();
  writeConfig(remote, { fallback: ["paid/gpt-x"] });
  calls = 0;
  const priced = await checkFallbackChain(remote, models, async () => (calls++, true));
  assert.equal(calls, 0);
  assert.match(priced.detail, /priced, team cap only/);
});

// --- OpenCode readiness (part 7/7) ----------------------------------------------------------
// checkOpencode runs only when a seam routes to opencode: each opencode model must be in the
// catalog cache (failing an unknown one), a non-gateway provider needs a credential the fake
// `opencode auth list` lists, and the operator's global config must not leak into team runs.
test("checkOpencode stands down on a pi-only config and reads the free model as free", async () => {
  const root = readyRepo();
  writeConfig(root, { model: "local/free-model" });
  const empty = tmpdir("doctor-opencode-pi-");
  assert.deepEqual(await checkOpencode(root, empty, empty), { level: "ok", detail: "no model jobs run on opencode" });

  // A free opencode model in the catalog cache reads "free" at ok.
  writeConfig(root, { backend: "opencode", model: "deepseek-v4.1-flash-free" });
  writeOpencodeCache(root, {
    fetchedAt: Date.now(),
    models: { "opencode/deepseek-v4.1-flash-free": { free: true, context: 200_000 } },
  });
  const free = await checkOpencode(root, empty, empty);
  assert.equal(free.level, "ok");
  assert.match(free.detail, /deepseek-v4\.1-flash-free — free/);
  // The sizeNotes line routes through formatBytes, so the db/spill render is pinned here, and a
  // kb-sized db exercises the KB tier (one decimal) via the real checkOpencode path, not only
  // formatBytes's unit tests.
  assert.match(free.detail, /db 0 B, no spill dir/);
  const dbBytes = 1536;
  const dbPath = path.join(root, ".tumwater", "opencode", "opencode.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, "x".repeat(dbBytes));
  const withDb = await checkOpencode(root, empty, empty);
  assert.match(withDb.detail, /db 1\.5 KB, no spill dir/);
  assert.equal(withDb.level, "ok");
});

test("checkOpencode fails a model missing from the catalog cache", async () => {
  const root = readyRepo();
  writeConfig(root, { backend: "opencode", model: "not-in-catalog" });
  const out = await checkOpencode(root, tmpdir("doctor-opencode-bin-"), tmpdir("doctor-opencode-home-"));
  assert.equal(out.level, "fail");
  // The seam resolves the bare model (the routing strips the `opencode/` backend prefix); the
  // catalog key goes back through opencodeModelKey, and the failure names the model.
  assert.match(out.detail, /not-in-catalog is not in the opencode catalog cache/);
});

test("checkOpencode notes a thinking level the catalog has no effort for as dropped", async () => {
  const root = readyRepo();
  writeConfig(root, { backend: "opencode", model: "deepseek-v4.1-flash-free", thinking: "high" });
  // The catalog lists efforts but not `high`: the level is dropped.
  writeOpencodeCache(root, {
    fetchedAt: Date.now(),
    models: { "opencode/deepseek-v4.1-flash-free": { free: true, efforts: ["low", "medium"] } },
  });
  const hasList = await checkOpencode(root, tmpdir("doctor-opencode-bin-"), tmpdir("doctor-opencode-home-"));
  assert.equal(hasList.level, "warn");
  assert.match(hasList.detail, /deepseek-v4\.1-flash-free has no high effort — that thinking level is dropped/);

  // A model with no effort list at all supports no thinking level either, so it drops too.
  writeOpencodeCache(root, {
    fetchedAt: Date.now(),
    models: { "opencode/deepseek-v4.1-flash-free": { free: true } },
  });
  const noList = await checkOpencode(root, tmpdir("doctor-opencode-bin-"), tmpdir("doctor-opencode-home-"));
  assert.equal(noList.level, "warn");
  assert.match(noList.detail, /deepseek-v4\.1-flash-free has no high effort — that thinking level is dropped/);
});

test("checkOpencode warns a non-gateway provider opencode does not list a credential for", async () => {
  const root = readyRepo();
  writeConfig(root, { model: { default: { backend: "opencode", model: "anthropic/claude-sonnet" } } });
  // The seam resolves `anthropic/claude-sonnet`, and that is the catalog key too.
  writeOpencodeCache(root, {
    fetchedAt: Date.now(),
    models: { "anthropic/claude-sonnet": { free: false, inputPerM: 3, outputPerM: 15 } },
  });
  // Not listed: the fake auth list is empty.
  const bin = tmpdir("doctor-opencode-auth-");
  writeScript(path.join(bin, "opencode"), "echo '[]'");
  const notListed = await checkOpencode(root, bin, tmpdir("doctor-opencode-home-"));
  assert.equal(notListed.level, "warn");
  assert.match(notListed.detail, /anthropic\/claude-sonnet is a non-gateway provider opencode does not list a credential for/);

  // Listed: the fake auth list names the provider, so no warning.
  writeScript(path.join(bin, "opencode"), "echo '[\"anthropic\"]'");
  const listed = await checkOpencode(root, bin, tmpdir("doctor-opencode-home-"));
  assert.notEqual(listed.level, "warn");
  assert.ok(!listed.detail.includes("non-gateway provider"), listed.detail);

  // A credential is never vouched for by a raw substring: a listed `anthropic-foo` must not
  // stand in for the `anthropic` provider, so doctor still warns.
  writeScript(path.join(bin, "opencode"), "echo '[\"anthropic-foo\"]'");
  const substring = await checkOpencode(root, bin, tmpdir("doctor-opencode-home-"));
  assert.equal(substring.level, "warn");
  assert.match(substring.detail, /anthropic\/claude-sonnet is a non-gateway provider opencode does not list a credential for/);
});

test("checkOpencode warns about the operator's global config that leaks an MCP server and instructions", async () => {
  const root = readyRepo();
  writeConfig(root, { backend: "opencode", model: "deepseek-v4.1-flash-free" });
  writeOpencodeCache(root, {
    fetchedAt: Date.now(),
    models: { "opencode/deepseek-v4.1-flash-free": { free: true } },
  });
  const home = tmpdir("doctor-opencode-home-");
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".config", "opencode", "opencode.jsonc"),
    '{ "mcp": { "servers": { "srv": {} } }, "instructions": ["hi"] }',
  );
  // The config root is injected (XDG config home when set, else ~/.config) so the scan is
  // hermetic and matches the folder a run actually loads.
  const configHome = path.join(home, ".config");
  const out = await checkOpencode(root, tmpdir("doctor-opencode-bin-"), home, configHome);
  assert.equal(out.level, "warn");
  // Only the MCP server is disabled for team runs; the instructions entry still loads.
  assert.match(out.detail, /opencode\.jsonc carries an MCP server and a instructions entry — still loads into team runs/);

  // A config with only an MCP server is the one genuinely disabled for team runs.
  fs.writeFileSync(path.join(home, ".config", "opencode", "opencode.jsonc"), '{ "mcp": { "servers": { "srv": {} } } }');
  const mcpOnly = await checkOpencode(root, tmpdir("doctor-opencode-bin-"), home, configHome);
  assert.equal(mcpOnly.level, "warn");
  assert.match(mcpOnly.detail, /opencode\.jsonc carries an MCP server — disabled for team runs/);
});

test("checkOpencode scans the XDG config home, not ~/.config, when XDG_CONFIG_HOME is set", async () => {
  const root = readyRepo();
  writeConfig(root, { backend: "opencode", model: "deepseek-v4.1-flash-free" });
  writeOpencodeCache(root, {
    fetchedAt: Date.now(),
    models: { "opencode/deepseek-v4.1-flash-free": { free: true } },
  });
  // A same-shaped leak sits in ~/.config/opencode; the leak the run would actually load lives
  // in $XDG_CONFIG_HOME/opencode. With the XDG root injected, only the latter is scanned.
  const home = tmpdir("doctor-opencode-home-");
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "opencode", "opencode.jsonc"), '{ "mcp": { "servers": { "srv": {} } } }');
  const xdg = tmpdir("doctor-opencode-xdg-");
  fs.mkdirSync(path.join(xdg, "opencode"), { recursive: true });
  fs.writeFileSync(path.join(xdg, "opencode", "opencode.jsonc"), '{ "plugin": ["x"] }');
  const out = await checkOpencode(root, tmpdir("doctor-opencode-bin-"), home, xdg);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /opencode\.jsonc carries a plugin entry — still loads into team runs/);
  assert.ok(!out.detail.includes("disabled for team runs"), out.detail);
  // With the XDG root left unset, the ~/.config copy is the one scanned instead.
  const noXdg = await checkOpencode(root, tmpdir("doctor-opencode-bin-"), home, "");
  assert.equal(noXdg.level, "warn");
  assert.match(noXdg.detail, /carries an MCP server — disabled for team runs/);
});

test("parsePiModelList reads pi's list-models table and refuses anything else", () => {
  const header = "provider     model                      context  max-out  thinking  images";
  const table = `${header}\nhuggingface  deepseek-ai/DeepSeek-V3.1  131.1K  8.2K  yes  no\nanthropic    claude-x  200K  8K  yes  yes\n`;
  assert.deepEqual(parsePiModelList(table), new Set(["huggingface/deepseek-ai/DeepSeek-V3.1", "anthropic/claude-x"]));
  assert.deepEqual(parsePiModelList(`${header}\n`), new Set());
  assert.equal(parsePiModelList('No models matching "x"'), null);
  assert.equal(parsePiModelList(""), null);
  assert.equal(parsePiModelList("some arbitrary text\nmore"), null);
});

test("piListedModels saves the images column under the root it is given", async () => {
  const root = tmpdir("doctor-listed-root-");
  const binDir = tmpdir("doctor-listed-bins-");
  const table = [
    "provider     model                      context  max-out  thinking  images",
    "huggingface  deepseek-ai/DeepSeek-V3.1  131.1K  8.2K  yes  no",
    "anthropic    claude-x  200K  8K  yes  yes",
  ];
  writeScript(path.join(binDir, "pi"), table.map((row) => `printf '%s\\n' '${row}'`).join("\n"));
  const expected = new Set(["huggingface/deepseek-ai/DeepSeek-V3.1", "anthropic/claude-x"]);
  assert.deepEqual(await piListedModels({} as TumwaterConfig, binDir, 5000), expected);
  assert.equal(fs.existsSync(piListedModelsPath(root)), false);
  assert.deepEqual(await piListedModels({} as TumwaterConfig, binDir, 5000, root), expected);
  assert.equal(readPiListedModels(root)?.images["anthropic/claude-x"], true);
  assert.equal(readPiListedModels(root)?.images["huggingface/deepseek-ai/DeepSeek-V3.1"], false);

  const failRoot = tmpdir("doctor-listed-fail-");
  const failBin = tmpdir("doctor-listed-failbin-");
  writeScript(path.join(failBin, "pi"), "exit 1");
  assert.equal(await piListedModels({} as TumwaterConfig, failBin, 5000, failRoot), null);
  assert.equal(fs.existsSync(piListedModelsPath(failRoot)), false);
});

test("checkTierModels accepts a model pi lists but models.json does not declare", async () => {
  const models = writeModels();
  for (const pair of ["paid/built-in-x", "builtin/some-model"]) {
    const root = readyRepo();
    writeConfig(root, { model: pair });
    const probed: string[] = [];
    let listCalls = 0;
    const outcome = await checkTierModels(
      root,
      models,
      async (p) => {
        probed.push(p);
        return "ready";
      },
      process.env,
      async () => {
        listCalls++;
        return new Set([pair]);
      },
    );
    assert.equal(outcome.level, "ok", outcome.detail);
    assert.match(outcome.detail, /1 declared model resolve/);
    assert.deepEqual(probed, [pair.split("/")[0]]);
    assert.equal(listCalls, 1);
  }

  const allDeclared = readyRepo();
  writeConfig(allDeclared, { model: { small: "local/free-model", default: "paid/gpt-x" } });
  let calls = 0;
  const resolved = await checkTierModels(allDeclared, models, async () => "ready", process.env, async () => {
    calls++;
    return new Set();
  });
  assert.equal(resolved.level, "ok");
  assert.equal(calls, 0, "a pair models.json declares never asks pi");

  const empty = async () => new Set<string>();
  const typoRoot = readyRepo();
  writeConfig(typoRoot, { model: "paid/no-such-model" });
  const typo = await checkTierModels(typoRoot, models, async () => "ready", process.env, empty);
  assert.equal(typo.level, "fail");
  assert.match(typo.detail, /is neither in pi's definitions .* nor listed by `pi --list-models`/);
  const unknownRoot = readyRepo();
  writeConfig(unknownRoot, { model: "nowhere/mystery" });
  const unknown = await checkTierModels(unknownRoot, models, async () => "ready", process.env, empty);
  assert.equal(unknown.level, "fail");
  assert.match(unknown.detail, /lists none of its models/);
  const listedRoot = readyRepo();
  writeConfig(listedRoot, { model: "nowhere/typo-model" });
  const listedTypo = await checkTierModels(listedRoot, models, async () => "ready", process.env, async () => new Set(["nowhere/real-model"]));
  assert.equal(listedTypo.level, "fail");
  assert.match(listedTypo.detail, /nowhere\/typo-model is neither in pi's definitions .* nor listed by `pi --list-models`/);
  assert.doesNotMatch(listedTypo.detail, /lists none of its models/);

  const absent = path.join(tmpdir(), "absent-models.json");
  const unreadableRoot = readyRepo();
  writeConfig(unreadableRoot, { model: "paid/gpt-x" });
  const viaListing = await checkTierModels(unreadableRoot, absent, async () => "ready", process.env, async () => new Set(["paid/gpt-x"]));
  assert.equal(viaListing.level, "ok", viaListing.detail);
  const noListing = await checkTierModels(unreadableRoot, absent, async () => "ready", process.env, async () => null);
  assert.equal(noListing.level, "warn");
  assert.match(noListing.detail, /cannot check — could not read pi's model definitions/);
});
