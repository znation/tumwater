// Unit coverage for src/roles/role-view.ts (the collector behind `tumwater role <id>`) and
// src/roles/role-render.ts (its Markdown renderer). The collector reads only persisted state —
// tumwater.json, the loop's state file, the queue directories, the pause marker — so every
// test runs against a bare fixture dir with no fleet, which is also the degradation claim
// under test: a missing read yields its empty answer, never a throw.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rolePayload } from "../src/roles/role-view.js";
import { renderRoleMarkdown } from "../src/roles/role-render.js";
import { enqueuePrompt, enqueueRolePrompt } from "../src/inbox/inbox.js";
import { pausedRolesPath, roleNotesPath } from "../src/paths.js";
import { freshLoopState, saveLoopState } from "../src/loop/loop-state.js";
import { readmeTemplate } from "../src/brief.js";
import { writeConfig, tmpdir } from "./fixtures/repo-fixtures.js";

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
  assert.match(p.nextPrompt ?? "", /You are the "feature" loop \(feature implementer\)/);
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
  assert.equal(p.minTickIntervalSeconds, 300);
  // A role without overrides resolves to the top-level pair and the global interval
  // (bugfix carries no clock override of its own in the defaults).
  const bugfix = rolePayload(dir, "bugfix", NO_MODELS);
  assert.equal(bugfix.provider, "prov-a");
  assert.equal(bugfix.model, "model-a");
  assert.equal(bugfix.instructions, null);
  assert.equal(bugfix.minTickIntervalSeconds, 20); // defaultConfig's global value
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

test("a custom loop's task is its find text, and it reads as enabled and custom", () => {
  const dir = root();
  writeConfig(dir, { customLoops: [{ name: "greeter", task: "Say hello to the project." }] });
  const p = rolePayload(dir, "greeter", NO_MODELS);
  assert.equal(p.custom, true);
  assert.equal(p.title, "user-defined loop");
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
  assert.match(busy.nextPrompt ?? "", /"director" loop/);
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
  pauseRoles(dir, ["telemetry"]);
  assert.equal(rolePayload(dir, "telemetry", NO_MODELS).paused, true);
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
  assert.match(md, /- Loop: "feature" \(feature implementer\)$/m);
  assert.match(md, /- State: enabled, not paused/);
  assert.match(md, /- Scheduling tier: 0 \(work\)/);
  assert.match(md, /- Model: prov-a\/model-a \(default tier\)/m);
  assert.match(md, /- Budget fallback: fp\/fm \(priced\)/); // no definitions file in the fixture
  assert.match(md, /- Min tick interval: 20s/);
  assert.match(md, /- Queued prompts: 1/);
  assert.match(md, /## Instructions override\n\n```\nBe terse\.\nThen terser\.\n```/); // verbatim, fenced
  assert.match(md, /## Find text/);
  assert.match(md, /check the scheduler first/); // the queued prompt rides in the preview
  assert.match(md, /## Next tick prompt/);
});

test("with several prompts queued, the next-tick block discloses that only the oldest rides", () => {
  const dir = root();
  enqueueRolePrompt(dir, "feature", "cover the empty-input case");
  enqueueRolePrompt(dir, "feature", "also test the NaN path");
  const md = renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS));
  assert.match(md, /- Queued prompts: 2/);
  assert.match(
    md,
    /_\(the Next tick prompt embeds the oldest queued prompt — one is consumed per tick; 1 more waits?\)_/,
  ); // tick-prompt dequeues exactly one per tick — the block says so rather than reading as a contradiction
});

test("unset things render as explicit placeholder lines, not omissions", () => {
  const dir = root();
  const md = renderRoleMarkdown(rolePayload(dir, "director", NO_MODELS));
  assert.match(md, /- Model: pi default \(default tier\)/m);
  assert.ok(!md.includes("Budget fallback")); // no fallback configured: no line at all
  assert.match(md, /## Instructions override\n\n_\(none\)_/);
  assert.match(md, /_\(none — the director is driven by its queued prompts, not a find text\)_/);
  assert.match(md, /## Notebook\n\n_\(none yet/); // the director has no notebook
  assert.match(md, /## Next tick prompt\n\n_\(nothing to run this tick\)_/);
});

test("a role's notebook renders verbatim, or reads as none yet", () => {
  const dir = root();
  const notes = roleNotesPath(dir, "feature");
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.writeFileSync(notes, "the scheduler lives in fleet.ts\n");
  const md = renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS));
  assert.match(md, /## Notebook\n\n```\nthe scheduler lives in fleet\.ts\n```/);
  assert.equal(rolePayload(dir, "feature", NO_MODELS).note, "the scheduler lives in fleet.ts\n");

  // Empty or missing degrades to the placeholder, never a throw or a blank section.
  fs.writeFileSync(notes, "");
  const blank = renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS));
  assert.equal(rolePayload(dir, "feature", NO_MODELS).note, null);
  assert.match(blank, /## Notebook\n\n_\(none yet/);
});

test("the State line distinguishes disabled from paused, alone and together", () => {
  const dir = root();
  writeConfig(dir, { roles: { qa: { enabled: false } } });
  assert.match(renderRoleMarkdown(rolePayload(dir, "qa", NO_MODELS)), /- State: disabled, not paused/);
  pauseRoles(dir, ["qa"]);
  assert.match(renderRoleMarkdown(rolePayload(dir, "qa", NO_MODELS)), /- State: disabled, paused/);
});

test("a custom loop renders as user-defined, on the maintenance tier", () => {
  const dir = root();
  writeConfig(dir, { customLoops: [{ name: "greeter", task: "Say hello to the project." }] });
  const md = renderRoleMarkdown(rolePayload(dir, "greeter", NO_MODELS));
  assert.match(md, /- Loop: "greeter" \(user-defined loop\) — user-defined loop/);
  assert.match(md, /- Scheduling tier: 1 \(maintenance\/observer\)/);
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
  assert.match(md, /- Budget fallback: fp-only \(priced\)/);
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
  assert.match(md, /- Budget fallback: lm-studio\/qwen3\.8-27b \(free\)/);
});

test("a fenced block grows past any backtick run in the verbatim text", () => {
  const dir = root();
  writeConfig(dir, { roles: { feature: { instructions: "use ```md fences\nin docs" } } });
  const md = renderRoleMarkdown(rolePayload(dir, "feature", NO_MODELS));
  assert.match(md, /````\nuse ```md fences\nin docs\n````/); // four backticks close the block
});

test("modelTier resolves the seam tier: the catalog's assignment, then a tier-name override", () => {
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
