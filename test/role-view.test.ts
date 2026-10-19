// Unit coverage for src/roles/role-view.ts (the collector behind `tumwater role <id>`) and
// src/roles/role-render.ts (its Markdown renderer). The collector reads only persisted state —
// tumwater.json, the loop's state file, the queue directories, the pause marker — so every
// test runs against a bare fixture dir with no team, which is also the degradation claim
// under test: a missing read yields its empty answer, never a throw.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dayKey } from "../src/text/datetime.js";
import { rolePayload } from "../src/roles/role-view.js";
import { inspectMarkdownLines, renderRoleMarkdown } from "../src/roles/role-render.js";
import { enqueuePrompt, enqueueRolePrompt } from "../src/inbox/inbox.js";
import { contextBudgetRule } from "../src/prompt/prompt.js";
import { PI_DIALECT } from "../src/prompt/dialect.js";
import { pausedRolesPath, roleNotesPath } from "../src/paths.js";
import { freshLoopState, saveLoopState } from "../src/runner/runner-state.js";
import { readmeTemplate } from "../src/brief/brief.js";
import { writeConfig, tmpdir } from "./fixtures/repo-fixtures.js";
import { writeModelsFile, writeOpencodeCache } from "./fixtures/models-fixtures.js";
import { writeClaudeAccount } from "../src/agent/claude/claude-account.js";
import { writeEvents, writeOrchestratorMarker } from "./fixtures/log-fixtures.js";

const NO_MODELS = "/nonexistent/tumwater-test-models.json"; // readPiProviders degrades to []

function root(): string {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "README.md"), readmeTemplate("proj", "Build a tiny thing.\n"));
  return dir;
}

function pauseRoles(dir: string, roles: string[]): void {
  fs.mkdirSync(path.dirname(pausedRolesPath(dir)), { recursive: true });
  fs.writeFileSync(pausedRolesPath(dir), JSON.stringify({ roles, at: Date.now() }));
}

test("a built-in role's payload resolves identity, tier, defaults, and its find text", () => {
  const dir = root();
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(p.id, "feature");
  assert.equal(p.title, "feature implementer");
  assert.equal(p.custom, false);
  assert.equal(p.enabled, true); // no config file: the defaults enable every built-in
  assert.equal(p.paused, false);
  assert.equal(p.tier, 0); // a work role
  assert.equal(p.instructions, null); // no override configured
  assert.match(p.find ?? "", /Implement the SINGLE most valuable planned feature in PLANS\.md/); // the find text, verbatim
  assert.equal(p.inboxCount, 0);
  assert.match(p.nextPrompt ?? "", /You are the "feature" role \(feature implementer\)/);
  assert.match(p.nextPrompt ?? "", /Implement the SINGLE most valuable planned feature in PLANS\.md/); // the find text rides in the preview
});

test("the config file's role overrides resolve: instructions, model pair, interval, disabled", () => {
  const dir = root();
  writeConfig(dir, {
    provider: "prov-a",
    model: "model-a",
    roles: {
      feature: {
        enabled: false,
        instructions: "Be terse.",
        provider: "prov-b",
        model: "model-b",
        thinking: "high",
        minTickIntervalSeconds: 300,
      },
    },
  });
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(p.enabled, false);
  assert.equal(p.instructions, "Be terse.");
  assert.equal(p.provider, "prov-b"); // the role override, not the top-level value
  assert.equal(p.model, "model-b");
  assert.equal(p.thinking, "high");
  assert.equal(p.minRunIntervalSeconds, 300);
  // The override rides along: the drawer can say the shown value is the role's own, not the
  // team default (the legacy alias minTickIntervalSeconds resolved to the canonical key).
  assert.equal(p.minRunIntervalOverride, 300);
  // A role without overrides resolves to the top-level pair and the global interval
  // (bugfix carries no clock override of its own in the defaults) and carries no
  // minRunIntervalOverride — a payload without one stays byte-identical to before.
  const bugfix = rolePayload(dir, "bugfix", NO_MODELS);
  assert.equal(bugfix.provider, "prov-a");
  assert.equal(bugfix.model, "model-a");
  assert.equal(bugfix.instructions, null);
  assert.equal(bugfix.minRunIntervalSeconds, 20); // defaultConfig's global value
  assert.equal("minRunIntervalOverride" in bugfix, false);
});

test("a seeded built-in role with no file override reports no min-run-interval override", () => {
  // qa is a built-in whose catalog entry seeds minRunIntervalSeconds (7200 in config.ts's
  // defaults) even when the file never sets it. Presence must be judged against the FILE, not
  // the merged config — or every built-in role would look overridden (steward/qa/selfcheck/
  // readme/plan/organize) and the drawer's clear would be a no-op success that keeps the
  // seeded value. The payload carries the override only once the file sets the key.
  const dir = root();
  writeConfig(dir, {});
  const seeded = rolePayload(dir, "qa", NO_MODELS);
  assert.equal(seeded.minRunIntervalSeconds, 7200); // the catalog seed, not an override
  assert.equal("minRunIntervalOverride" in seeded, false);
  writeConfig(dir, { roles: { qa: { minRunIntervalSeconds: 300 } } });
  const set = rolePayload(dir, "qa", NO_MODELS);
  assert.equal(set.minRunIntervalSeconds, 300);
  assert.equal("minRunIntervalOverride" in set, true);
  assert.equal(set.minRunIntervalOverride, 300);
});

test("the role view reports the configured instance count only when set", () => {
  const dir = root();
  writeConfig(dir, { roles: { feature: { instances: 3 } } });
  const set = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(set.instances, 3);
  // An instance id resolves through its base role, like instructions and the min-run
  // override.
  const inst = rolePayload(dir, "feature-2", NO_MODELS);
  assert.equal(inst.instances, 3);
  // A role with no count configured carries no instances field — the payload stays
  // byte-identical to before.
  const unset = rolePayload(dir, "bugfix", NO_MODELS);
  assert.equal("instances" in unset, false);
});

test("renderRoleMarkdown prints the Instances line only when a count is configured", () => {
  const dir = root();
  writeConfig(dir, { roles: { feature: { instances: 3 } } });
  assert.match(renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS)), /- Instances: 3/);
  assert.doesNotMatch(renderRoleMarkdown(rolePayload(dir, "bugfix", NO_MODELS)), /- Instances:/);
});

test("the payload carries the raw model-triple overrides only when the file sets them", () => {
  const dir = root();
  // A config that sets provider/model/thinking only through roles feature: the resolved
  // provider/model/thinking come from the top level, and the raw overrides ride along.
  writeConfig(dir, { model: "model-a", roles: { feature: { provider: "prov-b", model: "model-b", thinking: "high" } } });
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(p.providerOverride, "prov-b");
  assert.equal(p.modelOverride, "model-b");
  assert.equal(p.thinkingOverride, "high");
  // An instance id resolves the overrides through its base role, like instructions and the
  // min-run override.
  const inst = rolePayload(dir, "feature-2", NO_MODELS);
  assert.equal(inst.modelOverride, "model-b");
  // A role the file gives no overrides carries none — the payload stays byte-identical.
  const none = rolePayload(dir, "bugfix", NO_MODELS);
  assert.equal("providerOverride" in none, false);
  assert.equal("modelOverride" in none, false);
  assert.equal("thinkingOverride" in none, false);
  // A partial triple carries only the fields the file sets.
  writeConfig(dir, { roles: { feature: { model: "m" } } });
  const partial = rolePayload(dir, "feature", NO_MODELS);
  assert.equal("providerOverride" in partial, false);
  assert.equal(partial.modelOverride, "m");
  assert.equal("thinkingOverride" in partial, false);
});

test("an instance id resolves the instructions override through its base role", () => {
  const dir = root();
  writeConfig(dir, { roles: { feature: { instructions: "Stay small.", instances: 2 } } });
  // An instance id reads roles.feature.instructions (the key tick-prompt reads), so the
  // drawer and `tumwater role feature-2` show — and can edit — the override its runs carry.
  const inst = rolePayload(dir, "feature-2", NO_MODELS);
  assert.equal(inst.instructions, "Stay small.");
  // The base role's own case is unchanged.
  const base = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(base.instructions, "Stay small.");
});

test("a configured fallback pair is reported, with its freeness verdict from pi's definitions", () => {
  const dir = root();
  writeConfig(dir, { fallbackModel: { provider: "free-prov", model: "free-model" } });
  const p = rolePayload(dir, "bugfix", NO_MODELS);
  assert.deepEqual(p.fallback, { provider: "free-prov", model: "free-model" });
  assert.equal(p.fallbackFree, false); // no definitions file: not provably free
  // No fallback configured: null pair, and the definitions file is never consulted.
  const bare = rolePayload(root(), "bugfix", NO_MODELS);
  assert.equal(bare.fallback, null);
  assert.equal(bare.fallbackFree, false);
});

test("an opencode fallback pair reads free in the role view only when the cached catalog prices it free", () => {
  // Part 6b/7: the fallback free-ness verdict reads the opencode catalog exactly as the budget
  // gate does, so `tumwater role` cannot disagree with the gate about a fallback it would
  // engage. A missing cache (no catalog read) leaves the pair NOT free — the safe direction.
  const dir = root();
  writeConfig(dir, { fallbackModel: { provider: "opencode", model: "deepseek-v4.1-flash-free" } });
  const noCache = rolePayload(dir, "bugfix", NO_MODELS);
  assert.equal(noCache.fallbackFree, false, "no cached catalog: an opencode fallback is not provably free");
  writeOpencodeCache(dir); // the fixture prices the gateway free model free
  const withCache = rolePayload(dir, "bugfix", NO_MODELS);
  assert.equal(withCache.fallbackFree, true, "a catalog-free opencode fallback reads free to the view");
  assert.deepEqual(withCache.fallback, { provider: "opencode", model: "deepseek-v4.1-flash-free" });
});

test("a subscription claude fallback reads free in the role view", () => {
  const dir = root();
  writeConfig(dir, { fallbackModel: { provider: "claude", model: "claude-sonnet-5-5" } });
  writeClaudeAccount(dir, { billing: "subscription", observedAt: Date.now(), windows: {} });
  const p = rolePayload(dir, "bugfix", NO_MODELS);
  assert.deepEqual(p.fallback, { provider: "claude", model: "claude-sonnet-5-5" });
  assert.equal(p.fallbackFree, true); // the account's subscription makes the claude pair free
});

test("a custom role's task is its find text, and it reads as enabled and custom", () => {
  const dir = root();
  writeConfig(dir, { customRoles: [{ name: "greeter", task: "Say hello to the project." }] });
  const p = rolePayload(dir, "greeter", NO_MODELS);
  assert.equal(p.custom, true);
  assert.equal(p.title, "custom role");
  assert.equal(p.find, "Say hello to the project.");
  assert.equal(p.enabled, true); // a custom absent from `roles` stays enabled
  assert.equal(p.tier, 1); // customs are not catalog work roles
});

test("the director is special-cased: no find text, and its inbox is its queue", () => {
  const dir = root();
  const idle = rolePayload(dir, "director", NO_MODELS);
  assert.equal(idle.find, null);
  assert.equal(idle.inboxCount, 0);
  assert.equal(idle.nextPrompt, null); // empty inbox: nothing to run, like the tick itself
  enqueuePrompt(dir, "add a changelog");
  const busy = rolePayload(dir, "director", NO_MODELS);
  assert.equal(busy.inboxCount, 1);
  assert.match(busy.nextPrompt ?? "", /"director" role/);
  assert.match(busy.nextPrompt ?? "", /add a changelog/);
});

test("a queued per-role prompt appears in the preview and stays queued", () => {
  const dir = root();
  enqueueRolePrompt(dir, "qa", "exercise the gui composer");
  const p = rolePayload(dir, "qa", NO_MODELS);
  assert.equal(p.inboxCount, 1);
  assert.match(p.nextPrompt ?? "", /<user-request>\nexercise the gui composer\n<\/user-request>/);
  // The peek never consumed: a second collection reads the same queue.
  assert.equal(rolePayload(dir, "qa", NO_MODELS).inboxCount, 1);
});

test("a paused role reads as paused; the pause marker is read, not required", () => {
  const dir = root();
  pauseRoles(dir, ["selfcheck"]);
  assert.equal(rolePayload(dir, "selfcheck", NO_MODELS).paused, true);
  assert.equal(rolePayload(dir, "qa", NO_MODELS).paused, false);
});

test("an unknown role throws the shared unknownRoleMessage wording", () => {
  assert.throws(() => rolePayload(root(), "bogus", NO_MODELS), /unknown role: bogus \(valid ids: /);
});

// --- the renderer ---

test("renderRoleMarkdown renders the payload's sections, with verbatim text fenced", () => {
  const dir = root();
  writeConfig(dir, {
    provider: "prov-a",
    model: "model-a",
    fallbackModel: { provider: "fp", model: "fm" },
    roles: { feature: { instructions: "Be terse.\nThen terser." } },
  });
  enqueueRolePrompt(dir, "feature", "check the scheduler first");
  const md = renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS));
  assert.match(md, /^# tumwater role: feature$/m);
  assert.match(md, /- Role: "feature" \(feature implementer\)$/m);
  assert.match(md, /- State: enabled, not paused/);
  assert.match(md, /- Priority: work/);
  assert.match(md, /- Model: prov-a\/model-a \(default tier\)/m);
  assert.match(md, /- Over-cap model: fp\/fm \(priced\)/); // no definitions file in the fixture
  assert.match(md, /- Min run interval: 20s/);
  assert.match(md, /- Inbox: 1/);
  assert.match(md, /## Instructions override\n\n```\nBe terse\.\nThen terser\.\n```/); // verbatim, fenced
  assert.match(md, /## Find text/);
  assert.match(md, /check the scheduler first/); // the queued prompt rides in the preview
  assert.match(md, /## Next run's prompt/);
});

test("the role view names the per-provider concurrency key and its cap when a cap map sets one", () => {
  const dir = root();
  writeConfig(dir, {
    provider: "prov-a",
    model: "model-a",
    maxConcurrentPerProvider: { "prov-a": 3 },
  });
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(p.providerKey, "prov-a");
  assert.equal(p.providerCap, 3);
  assert.match(renderRoleMarkdown(p), /- Provider: prov-a \(cap 3\)/m);
});

test("a cap-less team's role view renders no Provider line, byte-identical to before", () => {
  const dir = root();
  writeConfig(dir, { provider: "prov-a", model: "model-a" });
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(p.providerKey, "prov-a"); // the key resolves...
  assert.equal(p.providerCap, undefined); // ...but no map sets a cap entry for it
  assert.doesNotMatch(renderRoleMarkdown(p), /- Provider:/m);
});

test("with several prompts queued, the next-run block discloses that only the oldest rides", () => {
  const dir = root();
  enqueueRolePrompt(dir, "feature", "cover the empty-input case");
  enqueueRolePrompt(dir, "feature", "also test the NaN path");
  const md = renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS));
  assert.match(md, /- Inbox: 2/);
  assert.match(
    md,
    /_\(the next run's prompt embeds the oldest inbox message — one is taken per run; 1 more waits?\)_/,
  ); // tick-prompt dequeues exactly one per tick — the block says so rather than reading as a contradiction
});

test("inspectMarkdownLines carries the notes and next-run blocks renderRoleMarkdown splices in place", () => {
  const dir = root();
  const notes = roleNotesPath(dir, "feature");
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.writeFileSync(notes, "the scheduler lives in team.ts\n");
  enqueueRolePrompt(dir, "feature", "cover the empty-input case");
  enqueueRolePrompt(dir, "feature", "also test the NaN path");
  const p = rolePayload(dir, "feature", NO_MODELS);
  const lines = inspectMarkdownLines(p);
  // The Notebook block is verbatim and fenced, then the Next tick prompt block, then the
  // "more waits" disclosure when several prompts are queued.
  assert.deepEqual(lines.slice(0, 5), ["## Notes", "", "```", "the scheduler lives in team.ts", "```"]);
  assert.ok(lines.includes("## Next run's prompt"));
  assert.match(
    lines.join("\n"),
    /_\(the next run's prompt embeds the oldest inbox message — one is taken per run; 1 more waits?\)_/,
  );
  // The extraction is in place: the full document still shows Find text before Notebook
  // before Next tick prompt, with the same fenced notebook body.
  const md = renderRoleMarkdown(p);
  const findAt = md.indexOf("## Find text");
  const notebookAt = md.indexOf("## Notes");
  const nextAt = md.indexOf("## Next run's prompt");
  assert.ok(findAt >= 0 && notebookAt > findAt && nextAt > notebookAt);
  assert.match(md, /## Notes\n\n```\nthe scheduler lives in team\.ts\n```/);
});

test("unset things render as explicit placeholder lines, not omissions", () => {
  const dir = root();
  const md = renderRoleMarkdown(rolePayload(dir, "director", NO_MODELS));
  assert.match(md, /- Model: pi default \(strong tier\)/m);
  assert.ok(!md.includes("Over-cap model")); // no fallback configured: no line at all
  assert.match(md, /## Instructions override\n\n_\(none\)_/);
  assert.match(md, /_\(none — the director is driven by its inbox, not by instructions\)_/);
  assert.match(md, /## Notes\n\n_\(none yet/); // the director has no notebook
  assert.match(md, /## Next run's prompt\n\n_\(nothing to do this run\)_/);
});

test("a role's notes renders verbatim, or reads as none yet", () => {
  const dir = root();
  const notes = roleNotesPath(dir, "feature");
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.writeFileSync(notes, "the scheduler lives in team.ts\n");
  const md = renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS));
  assert.match(md, /## Notes\n\n```\nthe scheduler lives in team\.ts\n```/);
  assert.equal(rolePayload(dir, "feature", NO_MODELS).notes, "the scheduler lives in team.ts\n");

  // Empty or missing degrades to the placeholder, never a throw or a blank section.
  fs.writeFileSync(notes, "");
  const blank = renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS));
  assert.equal(rolePayload(dir, "feature", NO_MODELS).notes, null);
  assert.match(blank, /## Notes\n\n_\(none yet/);
});

test("the State line distinguishes disabled from paused, alone and together", () => {
  const dir = root();
  writeConfig(dir, { roles: { qa: { enabled: false } } });
  assert.match(renderRoleMarkdown(rolePayload(dir, "qa", NO_MODELS)), /- State: disabled, not paused/);
  pauseRoles(dir, ["qa"]);
  assert.match(renderRoleMarkdown(rolePayload(dir, "qa", NO_MODELS)), /- State: disabled, paused/);
});

test("a custom role renders as user-defined, on the maintenance tier", () => {
  const dir = root();
  writeConfig(dir, { customRoles: [{ name: "greeter", task: "Say hello to the project." }] });
  const md = renderRoleMarkdown(rolePayload(dir, "greeter", NO_MODELS));
  assert.match(md, /- Custom role: "greeter" \(custom role\)/);
  assert.match(md, /- Priority: maintenance or observer/);
});

test("the Model line shows a thinking level and drops a missing pair half", () => {
  const dir = root();
  writeConfig(dir, { thinking: "high", roles: { qa: { model: "m-only" } } });
  const md = renderRoleMarkdown(rolePayload(dir, "qa", NO_MODELS));
  assert.match(md, /- Model: m-only \(thinking: high\)/);
});

test("a one-sided fallback pair renders with its missing half dropped", () => {
  const dir = root();
  writeConfig(dir, { fallbackModel: { provider: "fp-only" } });
  const md = renderRoleMarkdown(rolePayload(dir, "qa", NO_MODELS));
  assert.match(md, /- Over-cap model: fp-only \(priced\)/);
});

test("a fallback pair priced free in pi's definitions renders as free", () => {
  const dir = root();
  writeConfig(dir, { fallbackModel: { provider: "lm-studio", model: "qwen3.8-27b" } });
  const file = path.join(dir, "models.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ providers: { "lm-studio": { models: [{ id: "qwen3.8-27b" }] } } }),
  ); // no cost field: free
  const md = renderRoleMarkdown(rolePayload(dir, "qa", file));
  assert.match(md, /- Over-cap model: lm-studio\/qwen3\.8-27b \(free\)/);
});

test("a fenced block grows past any backtick run in the verbatim text", () => {
  const dir = root();
  writeConfig(dir, { roles: { feature: { instructions: "use ```md fences\nin docs" } } });
  const md = renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS));
  assert.match(md, /````\nuse ```md fences\nin docs\n````/); // four backticks close the block
});

test("modelTier resolves the model job tier: the catalog's assignment, then a tier-name override", () => {
  const dir = root();
  const p = rolePayload(dir, "plan", NO_MODELS);
  assert.equal(p.modelTier, "strong"); // the model catalog assigns plan the strong tier
  assert.match(renderRoleMarkdown(p), /- Model: .* \(strong tier\)/); // the renderer names it

  writeConfig(dir, { model: { default: "prov-a/model-a", strong: "prov-s/model-s:high" } });
  const mapped = rolePayload(dir, "plan", NO_MODELS);
  assert.equal(mapped.modelTier, "strong");
  assert.equal(mapped.model, "model-s"); // the strong tier's own map entry resolves
  assert.equal(mapped.provider, "prov-s");
  assert.equal(mapped.thinking, "high");

  // A tier-name roles.<id>.model names the tier directly; an undeclared tier inherits
  // the map's default entry (config-views' topTierSelector rule).
  writeConfig(dir, {
    model: { default: "prov-a/model-a", strong: "prov-s/model-s:high" },
    roles: { plan: { model: "small" } },
  });
  const overridden = rolePayload(dir, "plan", NO_MODELS);
  assert.equal(overridden.modelTier, "small");
  assert.equal(overridden.model, "model-a");
  assert.equal(overridden.provider, "prov-a");
});

test("the plan payload resolves the stop target without leaking a template", () => {
  const dir = root();
  const p = rolePayload(dir, "plan", NO_MODELS);
  assert.ok(p.find);
  assert.ok(!p.find.includes("{{"), "the find text carries no unresolved placeholder");
  assert.match(p.nextPrompt ?? "", /2 or more eligible plans/);
});

// Model failure fallback, part 2/2: the inspector names the off-model pair, the episode's
// start, and the failure that tripped it, and says nothing while the role runs its primary.
test("an active model-fallback episode is reported with its pair and reason", () => {
  const dir = root();
  writeConfig(dir, { model: "prov-a/model-a", fallbackModel: { provider: "fp", model: "fm" } });
  const state = freshLoopState("feature");
  const since = Date.now() - 120_000;
  state.modelFallback = {
    failures: 0,
    since,
    probeAt: Date.now() + 600_000,
    cooldownMs: 300_000,
    reason: "Request timed out.",
  };
  saveLoopState(dir, state);
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.deepEqual(p.modelFallback, { provider: "fp", model: "fm", since, reason: "Request timed out." });
  assert.match(
    renderRoleMarkdown(p),
    /- Model fallback: fp\/fm — on fallback since .* \(primary failing: Request timed out\.\)/,
  );

  // A probe is due: the next tick runs the primary, so the episode line is gone.
  state.modelFallback.probeAt = Date.now() - 1;
  saveLoopState(dir, state);
  assert.equal(rolePayload(dir, "feature", NO_MODELS).modelFallback, null);
  assert.doesNotMatch(renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS)), /Model fallback:/);
});

// A claude model-fallback episode (PLANS.md "Mixed claude + pi fleets, part 3/4" gap 7) renders
// agent-qualified in `tumwater role` and carries the backend on the payload.
test("a claude model-fallback episode renders as claude/model", () => {
  const dir = root();
  writeConfig(dir, { agent: "claude", fallbackModel: { model: "claude-haiku-5-5" } });
  const state = freshLoopState("feature");
  const since = Date.now() - 60_000;
  state.modelFallback = {
    failures: 0,
    since,
    probeAt: Date.now() + 600_000,
    cooldownMs: 300_000,
    reason: "Request timed out.",
  };
  saveLoopState(dir, state);
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(p.modelFallback?.backend, "claude");
  assert.equal(p.modelFallback?.model, "claude-haiku-5-5");
  assert.match(
    renderRoleMarkdown(p),
    /- Model fallback: claude\/claude-haiku-5-5 — on fallback since .* \(primary failing: Request timed out\.\)/,
  );
});

test("agent labels: a claude model job names the backend, pi stays byte-identical", () => {
  // Part 4f/7: with agent claude and no model, configForRole fills the tier default and the
  // renderer names it agent-qualified; a seam with no model at all falls back to `<agent>
  // default` rather than pi's label.
  const dir = root();
  writeConfig(dir, { agent: "claude" });
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(p.backend, "claude");
  assert.equal(p.model, "claude-sonnet-5-5", "routeModel fills the default tier's model");
  assert.match(renderRoleMarkdown(p), /- Model: claude\/claude-sonnet-5-5 \(default tier\)/m);
  assert.match(
    renderRoleMarkdown({ ...p, provider: undefined, model: undefined }),
    /- Model: claude default \(default tier\)/m,
  );

  // The pi default stays byte-identical to before routing.
  assert.match(renderRoleMarkdown(rolePayload(root(), "feature", NO_MODELS)), /- Model: pi default \(default tier\)/m);
});

// The claude seam's billing (plans/agent-backends.md §7/§8, PLANS.md part 6d/7): the role view
// names subscription (with its primary window) or API; a pi seam carries no billing line.
test("a claude model job's role view names its billing and subscription window", () => {
  const dir = root();
  writeConfig(dir, { agent: "claude" });
  writeClaudeAccount(dir, {
    billing: "subscription",
    observedAt: Date.now(),
    windows: { five_hour: { status: "allowed", utilization: 0.64, observedAt: Date.now() } },
  });
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(p.billing, "subscription");
  assert.equal(p.billingWindow, "five_hour");
  assert.match(renderRoleMarkdown(p), /- Billing: subscription \(5h window\)/m);

  writeClaudeAccount(dir, { billing: "api", observedAt: Date.now(), windows: {} });
  const api = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(api.billing, "api");
  assert.equal(api.billingWindow, undefined);
  assert.match(renderRoleMarkdown(api), /- Billing: API/m);

  // A pi seam carries no billing line at all, whatever the account file says.
  writeConfig(dir, {});
  assert.doesNotMatch(renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS)), /Billing:/m);
});

// Context-window visibility: the role view names the resolved primary seam's declared window,
// which sizes the bundled extensions' read caps. The run prompt is the same whatever the window,
// and the `nextPrompt` preview shows it.
test("the role view names the resolved seam's context window and previews the same prompt on any window", () => {
  const dir = root();
  const modelsPath = writeModelsFile(
    dir,
    JSON.stringify({
      providers: {
        local: {
          models: [
            { id: "tiny", contextWindow: 65536 },
            { id: "big", contextWindow: 262144 },
          ],
        },
      },
    }),
  );

  writeConfig(dir, { provider: "local", model: "tiny" });
  const small = rolePayload(dir, "feature", modelsPath);
  assert.equal(small.contextWindow, 65536);
  assert.match(renderRoleMarkdown(small), /^- Context window: 65\.5k tokens$/m);
  assert.equal(small.nextPrompt?.includes(contextBudgetRule(PI_DIALECT)), true);

  writeConfig(dir, { provider: "local", model: "big" });
  const big = rolePayload(dir, "feature", modelsPath);
  assert.equal(big.contextWindow, 262144);
  assert.match(renderRoleMarkdown(big), /^- Context window: 262\.1k tokens$/m);
  assert.equal(big.nextPrompt?.includes(contextBudgetRule(PI_DIALECT)), true);

  // An unresolvable seam (NO_MODELS): the window is unknown; the prompt is the same one.
  const unk = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(unk.contextWindow, null);
  assert.match(renderRoleMarkdown(unk), /^- Context window: unknown$/m);
  assert.equal(unk.nextPrompt?.includes(contextBudgetRule(PI_DIALECT)), true);
});

test("the role view names the fallback step a live orchestrator moved the role's tier to", () => {
  const dir = root();
  writeConfig(dir, { agent: "claude" });
  writeClaudeAccount(dir, {
    billing: "subscription",
    observedAt: Date.now(),
    windows: { five_hour: { status: "rejected", resetsAt: Date.now() + 3600_000, observedAt: Date.now() } },
  });
  assert.doesNotMatch(renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS)), /Running on fallback/);
  const returnsAt = new Date(2026, 9, 16, 17, 40).getTime();
  writeOrchestratorMarker(dir, [], {
    chain: { default: { pair: "p/m", step: 2, of: 3, reason: "window", returnsAt } },
  });
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(p.chainStep?.step, 2);
  assert.match(renderRoleMarkdown(p), /- Running on fallback 2 of 3 \(5h window used up, resets 17:40\)/);
  assert.match(inspectMarkdownLines(p)[0] ?? "", /^- Running on fallback 2 of 3/);
});

// A pi author with a claude reviewer (PLANS.md "Mixed claude + pi fleets, part 3/4" gap 7):
// the role's changes are reviewed on claude, so the role view names that billing too, not
// just the role's own seam.
test("a pi role with a claude reviewer shows claude billing; a pi reviewer does not", () => {
  const dir = root();
  writeConfig(dir, { review: { enabled: true, model: "claude/claude-sonnet-5-5" } });
  writeClaudeAccount(dir, {
    billing: "subscription",
    observedAt: Date.now(),
    windows: { five_hour: { status: "allowed", utilization: 0.5, observedAt: Date.now() } },
  });
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(p.backend, "pi", "the role's own model job is pi");
  assert.equal(p.billing, "subscription", "the claude reviewer's billing is shown");
  assert.match(renderRoleMarkdown(p), /- Billing: subscription \(5h window\)/m);

  // A pi reviewer leaves the role view without a billing line.
  writeConfig(dir, { review: { enabled: true, model: "pi-prov/m" } });
  assert.doesNotMatch(renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS)), /Billing:/m);
});

// Part 2/2: a pi seam that resolves no model names pi's own saved default from its
// settings.json beside the models catalog (readPiDefaultModel), the same rule status-data's
// snapshot applies. The formatted selector carries the effective thinking, so no separate
// ` (thinking: …)` suffix is added.
test("a pi model job naming no model shows pi's own saved default", () => {
  const dir = root();
  const modelsDir = path.join(dir, "pi-agent");
  fs.mkdirSync(modelsDir, { recursive: true });
  const modelsPath = path.join(modelsDir, "models.json");
  fs.writeFileSync(
    path.join(modelsDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "prov",
      defaultModel: "org/m",
      modelThinkingLevels: { "prov/org/m": "low" },
    }),
  );
  const p = rolePayload(dir, "feature", modelsPath);
  assert.equal(p.piDefault, "prov/org/m:low");
  assert.match(renderRoleMarkdown(p), /- Model: pi default \(prov\/org\/m:low\) \(default tier\)/m);

  // The configured thinking wins over the default's: a role that names only a thinking level
  // still resolves no provider/model, so it rides pi's default at the configured level.
  writeConfig(dir, { provider: undefined, model: undefined, thinking: "high" });
  const p2 = rolePayload(dir, "feature", modelsPath);
  assert.equal(p2.piDefault, "prov/org/m:high");
  assert.match(renderRoleMarkdown(p2), /- Model: pi default \(prov\/org\/m:high\) \(default tier\)/m);

  // No settings.json beside the models catalog: nothing to name, so the seam reads `pi
  // default` with no selector and the payload carries no `piDefault` (the JSON is unchanged
  // for every other seam). Reset the config's thinking so the line is the bare default.
  writeConfig(dir, {});
  const bare = rolePayload(dir, "feature", path.join(dir, "empty", "models.json"));
  assert.equal(bare.piDefault, undefined);
  assert.match(renderRoleMarkdown(bare), /- Model: pi default \(default tier\)/m);
});

// Image input, part 5/5 (plans/image-input.md "Surfaces"): the role page carries an `Images:`
// line — the loop's own capability and, when it cannot read images, where a blind read
// reroutes. The text-only default-tier loop names its vision strong target; a vision loop says
// yes; an unknown seam (no models file) says unknown rather than guessing.
test("role payload reports image input and the renderer's Images line", () => {
  const dir = root();
  const dirModels = tmpdir("role-image-");
  const models = writeModelsFile(
    dirModels,
    JSON.stringify({
      providers: {
        local: {
          models: [
            { id: "text" },
            { id: "vision", input: ["text", "image"] },
          ],
        },
      },
    }),
  );
  writeConfig(dir, { model: { default: "local/text", strong: "local/vision" } });
  const feature = rolePayload(dir, "feature", models); // rides default → text-only
  assert.equal(feature.imageInput, false);
  assert.equal(feature.imageReroute, "strong (local/vision)");
  const md = renderRoleMarkdown(feature);
  assert.match(md, /- Images: no — reruns on strong \(local\/vision\)/);

  const plan = rolePayload(dir, "plan", models); // rides strong → reads images
  assert.equal(plan.imageInput, true);
  assert.equal(plan.imageReroute, null);
  assert.match(renderRoleMarkdown(plan), /- Images: yes/);

  // An unknown seam (no models) reads unknown — never assumed capable.
  const unknown = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(unknown.imageInput, null);
  assert.match(renderRoleMarkdown(unknown), /- Images: unknown/);
});

// Recent runs (the `tumwater role <id>` section): the loop's last few run_end
// results, read from the event log so the command answers with the team stopped. Newest
// first, at most 8, each with its time, result, duration, and summary.
test("role payload surfaces the newest run_end outcomes ordered newest-first", () => {
  const dir = root();
  const now = Date.now();
  // Seed 10 run_end events (oldest first in file order); only the newest 8 should surface.
  writeEvents(
    dir,
    Array.from({ length: 10 }, (_, i) => ({
      ts: now - (10 - i) * 60_000, // i=0 oldest (10m ago) … i=9 newest (1m ago)
      loop: "feature",
      type: "run_end",
      run: i + 1,
      result: i % 2 === 0 ? "changed" : "no_change",
      durationMs: 30_000,
      summary: "run " + (i + 1),
    })),
  );
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(p.recentOutcomes!.length, 8); // capped at 8, not all 10
  assert.equal(p.recentOutcomes![0]!.ts, now - 60_000); // newest first
  assert.equal(p.recentOutcomes![0]!.result, "no_change"); // i=9 (odd)
  assert.equal(p.recentOutcomes![0]!.summary, "run 10");
  assert.equal(p.recentOutcomes![0]!.durationMs, 30_000); // durations ride along
  assert.equal(p.recentOutcomes![7]!.ts, now - 8 * 60_000); // the 8th newest is i=2
  assert.equal(p.recentOutcomes![7]!.result, "changed");
  // Only this role's events count: another role with no events carries no recentOutcomes.
  assert.equal(rolePayload(dir, "bugfix", NO_MODELS).recentOutcomes, undefined);
});

test("a torn run_end line (no usable ts/result/duration) contributes no recent outcome", () => {
  const dir = root();
  const now = Date.now();
  // The event log is read without a shape filter, so a torn or hand-edited line can carry a
  // non-numeric ts/durationMs or an empty result — the same foreign-shape every other
  // consumer guards with finiteNumber. A line missing a usable ts or result is as unusable
  // as an absent one and must not surface (no "Invalid Date", no literal "undefined").
  writeEvents(dir, [
    { ts: now - 120_000, loop: "feature", type: "run_end", run: 1, result: "changed" },
    { ts: "not-a-number", loop: "feature", type: "run_end", run: 2, result: "changed" }, // torn ts
    { ts: now - 60_000, loop: "feature", type: "run_end", run: 3, result: "", durationMs: "not-a-number" }, // empty result + torn duration
    { ts: now - 30_000, loop: "feature", type: "run_end", run: 4, result: "no_change", durationMs: 10_000 },
  ]);
  const o = rolePayload(dir, "feature", NO_MODELS).recentOutcomes!;
  assert.equal(o.length, 2); // only the two with a usable ts + result survive
  assert.ok(o.every((x) => Number.isFinite(x.ts) && typeof x.result === "string" && x.result.length > 0));
  const newest = o[0]!;
  assert.equal(newest.result, "no_change"); // newest valid survivor = tick 4
  assert.equal(newest.ts, now - 30_000);
  assert.equal(newest.durationMs, 10_000); // a valid duration rides along
});

test("a role with no run_end events carries no recentOutcomes", () => {
  const dir = root();
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(p.recentOutcomes, undefined);
  assert.ok(!renderRoleMarkdown(p).includes("Recent runs"));
});

// The loop's own spend (PLANS.md): rolePayload sums this role's run_end usage over the same
// retained event window recentOutcomes reads, through the shared eventUsage finiteness guard,
// and the renderer names it as a Spend line (a notional suffix only when non-zero).
test("role payload sums the role's usage and renders a Spend line", () => {
  const dir = root();
  const now = Date.now();
  writeEvents(dir, [
    { ts: now - 180_000, loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 6000, costUsd: 0.02 },
    { ts: now - 120_000, loop: "feature", type: "run_end", run: 2, result: "no_change", tokens: 6500, costUsd: 0.03, notionalCostUsd: 0.05 },
    // Another role's spend is not folded into this loop's sum.
    { ts: now - 60_000, loop: "other", type: "run_end", run: 1, result: "changed", tokens: 99999, costUsd: 9.99 },
  ]);
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.deepEqual(p.usage, { tokens: 12500, costUsd: 0.05, notionalCostUsd: 0.05 });
  const md = renderRoleMarkdown(p);
  assert.match(md, /- Spend: \$0\.05 · 12\.5k tokens · \$0\.05 notional/);
  // The line sits after Inbox and before the schedule lines.
  assert.ok(md.indexOf("- Inbox: 0") < md.indexOf("- Spend:"));
  assert.ok(md.indexOf("- Spend:") < md.indexOf("- Next run:"));

  // A zero notional omits the notional suffix.
  writeEvents(dir, [
    { ts: now - 60_000, loop: "feature", type: "run_end", run: 3, result: "changed", tokens: 1200, costUsd: 0.01 },
  ]);
  assert.match(renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS)), /- Spend: \$0\.01 · 1200 tokens$/m);
});

test("a never-costly or never-ticked role carries no usage field or Spend line", () => {
  const dir = root();
  // Never ticked: no usage at all, and the render stays byte-identical (no Spend line).
  const neverTicked = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(neverTicked.usage, undefined);
  assert.doesNotMatch(renderRoleMarkdown(neverTicked), /- Spend:/);
  // Ticked but with all-zero usage: the zero-means-absent convention drops the field.
  writeEvents(dir, [
    { ts: Date.now() - 60_000, loop: "feature", type: "run_end", run: 1, result: "changed" },
  ]);
  const zero = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(zero.usage, undefined);
  assert.doesNotMatch(renderRoleMarkdown(zero), /- Spend:/);
});

test("a torn run_end line contributes nothing to the usage sum", () => {
  const dir = root();
  const now = Date.now();
  writeEvents(dir, [
    { ts: now - 120_000, loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 500, costUsd: 0.01 },
    // A non-numeric cost reads as 0 via eventUsage's finiteness guard; its tokens still count.
    { ts: now - 60_000, loop: "feature", type: "run_end", run: 2, result: "changed", tokens: 200, costUsd: "not-a-number" },
    // A torn ts (no usable timestamp) is as unusable as an absent tick and spends nothing.
    { ts: "not-a-number", loop: "feature", type: "run_end", run: 3, result: "changed", tokens: 999, costUsd: 0.5 },
  ]);
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.deepEqual(p.usage, { tokens: 700, costUsd: 0.01, notionalCostUsd: 0 });
});

test("role markdown renders the Recent runs section before the instructions", () => {
  const dir = root();
  const now = Date.now();
  writeEvents(dir, [
    { ts: now - 120_000, loop: "feature", type: "run_end", run: 1, result: "changed", durationMs: 30_000, summary: "added a thing" },
    { ts: now - 60_000, loop: "feature", type: "run_end", run: 2, result: "no_change", summary: "nothing to do" },
  ]);
  const md = renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS));
  assert.match(md, /## Recent runs/);
  assert.match(md, /- .* · changed · 30s — added a thing/);
  // A durationless outcome omits the span, keeping the summary after the result.
  assert.match(md, /- .* · no_change — nothing to do/);
  assert.ok(md.indexOf("## Recent runs") < md.indexOf("## Instructions override"));
});

// The loop's schedule (PLANS.md): the role view says when the loop next runs and when it
// last ticked, derived from the persisted nextRunAt/backoffSeconds/lastRunEndedAt and in
// the same words and wording family as the status `next run`/`last tick` cells. The clock is
// injected so every line is pinned by a fixed now (the renderer stays a pure function).
test("role payload and render surface the role's schedule from persisted state", () => {
  const dir = root();
  const now = 1_700_000_000_000;
  // A scheduled loop in backoff with a last tick: a future nextRunAt with backoffSeconds > 0.
  const state = freshLoopState("feature");
  state.nextRunAt = now + 300_000; // 5m away
  state.backoffSeconds = 120;
  state.lastRunEndedAt = now - 180_000; // 3m ago
  saveLoopState(dir, state);
  const p = rolePayload(dir, "feature", NO_MODELS);
  assert.equal(p.nextRunAt, now + 300_000);
  assert.equal(p.backoffSeconds, 120);
  assert.equal(p.lastRunEndedAt, now - 180_000);
  const md = renderRoleMarkdown(p, now);
  assert.match(md, /- Next run: sleeping in 5m/); // sleeping prefix while backing off
  // Last tick: the absolute local stamp reusing formatTimestamp, plus the humanSeconds age.
  assert.match(md, /- Last run: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(3m ago\)/);

  // A due loop (nextRunAt at/past now) reads `due now`.
  state.nextRunAt = now;
  saveLoopState(dir, state);
  assert.match(renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS), now), /- Next run: due now/);

  // A scheduled loop out of backoff reads plain `in <Ns>` with no backoff prefix.
  state.nextRunAt = now + 60_000;
  state.backoffSeconds = 0;
  saveLoopState(dir, state);
  const plain = renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS), now);
  assert.match(plain, /- Next run: in 1m/);
  assert.doesNotMatch(plain, /backoff/);

  // A never-ticked, never-scheduled default reads `not scheduled yet`/`never`, and the JSON
  // payload omits lastRunEndedAt (and reads nextRunAt 0) until the loop has been scheduled.
  const freshDir = root();
  const fresh = rolePayload(freshDir, "feature", NO_MODELS);
  assert.equal(fresh.nextRunAt, 0);
  assert.equal(fresh.backoffSeconds, 0);
  assert.equal(fresh.lastRunEndedAt, undefined);
  const freshMd = renderRoleMarkdown(fresh, now);
  assert.match(freshMd, /- Next run: not scheduled yet/);
  assert.match(freshMd, /- Last run: never/);
});

// The role view's Schedule must not understate a quiet yield-scaled loop's effective gap: a
// scalable role (bugfix here) whose recent-yield ring holds a run of empties earns a ×N
// multiplier (yieldMultiplier 2 at 10 empties) that stretches its min-tick gap beyond what
// nextRunAt's countdown shows, so the `Next tick` line rides the same `×N` suffix the status
// `next run` cell and the GUI twin carry (nextRunCell/fmtNextRun). Work roles (feature, plan,
// director) are not scalable and never show the suffix.
test("role schedule surfaces the yield multiplier a quiet scalable role is serving", () => {
  const dir = root();
  const now = 1_700_000_000_000;
  // A bugfix loop 5m from its nextRunAt, out of backoff, with ten empties in its yield ring.
  const state = freshLoopState("bugfix");
  state.nextRunAt = now + 300_000;
  state.backoffSeconds = 0;
  state.recentOutcomes = "n".repeat(10); // 10 empties => yieldMultiplier 2
  saveLoopState(dir, state);
  const p = rolePayload(dir, "bugfix", NO_MODELS);
  assert.equal(p.yieldMultiplier, 2);
  const md = renderRoleMarkdown(p, now);
  assert.match(md, /- Next run: in 5m ×2/); // the stretched-gap suffix rides the line
  // A due quiet loop reads `due now ×2`, matching nextRunCell's `now ×N`.
  state.nextRunAt = now;
  saveLoopState(dir, state);
  assert.match(renderRoleMarkdown(rolePayload(dir, "bugfix", NO_MODELS), now), /- Next run: due now ×2/);
  // A merge inside the recent window resets the multiplier to 1, so no suffix rides.
  state.nextRunAt = now - 60_000;
  state.recentOutcomes = "L".repeat(2) + "n".repeat(8);
  saveLoopState(dir, state);
  assert.equal(rolePayload(dir, "bugfix", NO_MODELS).yieldMultiplier, 1);
  const settled = renderRoleMarkdown(rolePayload(dir, "bugfix", NO_MODELS), now);
  assert.match(settled, /- Next run: due now$/m);
  assert.doesNotMatch(settled, /×/);
});

test("the role view names the quiet-hours windows governing the role and whether one holds now", () => {
  const dir = root();
  writeConfig(dir, { quietHours: "12:00-13:00", quietHoursPerRole: { qa: "23:00-07:00" } });
  const at = new Date(2026, 9, 16, 23, 30);
  const p = rolePayload(dir, "qa", NO_MODELS, at);
  assert.deepEqual(p.quietHours, [
    { scope: "role", window: "23:00-07:00", inWindow: true },
    { scope: "fleet", window: "12:00-13:00", inWindow: false },
  ]);
  const md = renderRoleMarkdown(p);
  assert.match(md, /- Last run: .*\n- Quiet hours: 23:00-07:00 \(own window; holding now — quiet until 07:00\)\n- Quiet hours: 12:00-13:00 \(team window; not holding now\)/);
  // The director is exempt from both gates.
  assert.equal("quietHours" in rolePayload(dir, "director", NO_MODELS, at), false);
});

test("a malformed per-role window yields no role entry", () => {
  const dir = root();
  writeConfig(dir, { quietHoursPerRole: { feature: "25:00-07:00" } });
  assert.equal("quietHours" in rolePayload(dir, "feature", NO_MODELS, new Date(2026, 9, 16, 12, 0)), false);
});

test("an instance id reads its base role's quiet-hours window; no window leaves no key", () => {
  const dir = root();
  writeConfig(dir, { quietHoursPerRole: { feature: "23:00-07:00" } });
  const at = new Date(2026, 9, 16, 12, 0);
  const p = rolePayload(dir, "feature-2", NO_MODELS, at);
  assert.deepEqual(p.quietHours, [{ scope: "role", window: "23:00-07:00", inWindow: false }]);
  const bare = root();
  assert.equal("quietHours" in rolePayload(bare, "feature", NO_MODELS, at), false);
  assert.doesNotMatch(renderRoleMarkdown(rolePayload(bare, "feature", NO_MODELS, at)), /Quiet hours/);
});

// The per-role daily cap (PLANS.md): rolePayload reads roleCapVerdicts, the verdict the
// scheduler's gate shares, and the renderer names today's spend against the cap.
test("role payload carries the daily cap verdict and renders a Daily cap line", () => {
  const dir = root();
  const now = new Date(2026, 9, 16, 12, 0, 0);
  const today = dayKey(now.getTime());
  writeConfig(dir, { maxDailyCostUsdPerRole: { coverage: 1 } });
  saveLoopState(dir, { ...freshLoopState("coverage"), dayStamp: today, dayCostUsd: 1.2 });
  const p = rolePayload(dir, "coverage", NO_MODELS, now);
  assert.deepEqual(p.dailyCap, { capUsd: 1, spentUsd: 1.2, over: true, roleIds: ["coverage"] });
  assert.match(
    renderRoleMarkdown(p),
    /^- Daily cap: \$1\.20 of \$1\.00 spent today \(holding now — no new runs until local midnight\)$/m,
  );

  // A spend stamped on an earlier day counts 0.
  saveLoopState(dir, { ...freshLoopState("coverage"), dayStamp: "2020-01-01", dayCostUsd: 5 });
  const old = rolePayload(dir, "coverage", NO_MODELS, now);
  assert.equal(old.dailyCap?.over, false);
  assert.equal(old.dailyCap?.spentUsd, 0);
  assert.match(renderRoleMarkdown(old), /\(not holding\)$/m);
});

test("daily cap sums instances, and is absent for cap 0, the director, or no cap", () => {
  const dir = root();
  const now = new Date(2026, 9, 16, 12, 0, 0);
  const today = dayKey(now.getTime());
  writeConfig(dir, {
    roles: { feature: { enabled: true, instances: 2 } },
    maxDailyCostUsdPerRole: { feature: 1, coverage: 0 },
  });
  for (const id of ["feature", "feature-2"]) {
    saveLoopState(dir, { ...freshLoopState(id), dayStamp: today, dayCostUsd: 0.6 });
  }
  const p = rolePayload(dir, "feature-2", NO_MODELS, now);
  assert.equal(p.dailyCap?.over, true);
  assert.equal(p.dailyCap?.spentUsd, 1.2);
  assert.deepEqual(p.dailyCap?.roleIds, ["feature", "feature-2", "feature-3", "feature-4"]);
  assert.match(renderRoleMarkdown(p), /· shared by feature, feature-2, feature-3, feature-4$/m);
  assert.equal("dailyCap" in rolePayload(dir, "coverage", NO_MODELS, now), false);
  assert.equal("dailyCap" in rolePayload(dir, "director", NO_MODELS, now), false);

  const bare = root();
  const np = rolePayload(bare, "feature", NO_MODELS, now);
  assert.equal("dailyCap" in np, false);
  assert.doesNotMatch(renderRoleMarkdown(np), /Daily cap/);
});

test("feature reads as paused when the marker holds its instance-1 key", () => {
  const dir = root();
  writeConfig(dir, { roles: { feature: { enabled: true, instances: 2 } } });
  pauseRoles(dir, ["feature-1"]);
  assert.equal(rolePayload(dir, "feature", NO_MODELS).paused, true);
});
