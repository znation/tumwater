// The model/seam facet of the status-data suite: snapshot()'s per-row resolved selector and
// seam tier, the active model-fallback episode, and the claude subscription window. Split by
// facet from one status-data test file; the core contract and poll cache live in
// status-data.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "../src/status/status-data.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { MODELS_JSON, writeModelsFile } from "./fixtures/models-fixtures.js";
import { freshLoopState, saveLoopState } from "../src/loop/loop-state.js";
import { writeClaudeAccount } from "../src/agent/claude/claude-account.js";

test("snapshot loop rows carry the resolved selector always and the seam tier only under a tier map", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");

  // A single string model: every row carries the resolved selector; the tier tag stays absent.
  writeConfig(repo, { model: "prov-a/model-a" });
  const plain = snapshot(repo);
  assert.equal(plain.loops[0]?.modelTier, undefined);
  assert.equal(plain.loops[0]?.model, "prov-a/model-a");

  // The payload ships the same field per row — the GUI renders it beside the loop name.
  const plainPayload = statusPayload(repo) as { loops: Array<{ role: string; modelTier?: string; model?: string }> };
  assert.equal(plainPayload.loops[0]?.model, "prov-a/model-a");
  assert.equal(plainPayload.loops[0]?.modelTier, undefined);

  // A tier map: each row carries its role's seam tier and that tier's resolved selector.
  writeConfig(repo, { model: { default: "prov-a/model-a", strong: "prov-s/model-s:high" } });
  const mapped = snapshot(repo);
  const plan = mapped.loops.find((l) => l.role === "plan");
  assert.equal(plan?.modelTier, "strong"); // the catalog assigns plan the strong tier
  assert.equal(plan?.model, "prov-s/model-s:high");
  const readme = mapped.loops.find((l) => l.role === "readme");
  assert.equal(readme?.modelTier, "small");
  assert.equal(readme?.model, "prov-a/model-a"); // an undeclared tier inherits default

  // The payload ships the same fields per row — the GUI renders them beside the loop name.
  const payload = statusPayload(repo) as { loops: Array<{ role: string; modelTier?: string; model?: string }> };
  const planRow = payload.loops.find((l) => l.role === "plan");
  assert.equal(planRow?.modelTier, "strong");
  assert.equal(planRow?.model, "prov-s/model-s:high");
});

// Model failure fallback, part 2/2: the snapshot's loop row carries the resolved fallback
// pair, the episode's start, and the tripping reason only while the episode is active (its
// ticks run off-model); a due probe runs the primary, so the field is absent then.
test("snapshot rows carry the active model-fallback episode", async () => {
  const repo = makeRepo();
  await initProject(repo, "model fallback rows");
  writeConfig(repo, { model: "prov-a/model-a", fallbackModel: { provider: "prov-fb", model: "model-fb" } });
  const now = Date.now();
  const state = freshLoopState("feature");
  state.modelFallback = {
    failures: 0,
    since: now - 60_000,
    probeAt: now + 300_000,
    cooldownMs: 300_000,
    reason: "Request timed out.",
  };
  saveLoopState(repo, state);
  const active = snapshot(repo, undefined, now).loops.find((l) => l.role === "feature");
  assert.deepEqual(active?.fallback, {
    provider: "prov-fb",
    model: "model-fb",
    since: now - 60_000,
    reason: "Request timed out.",
  });
  // The payload ships the same field for the dashboard row tag.
  const payload = statusPayload(repo, now) as { loops: Array<{ role: string; fallback?: unknown }> };
  assert.deepEqual(payload.loops.find((l) => l.role === "feature")?.fallback, active?.fallback);

  // Probe due: this tick runs the primary, so the row stops naming the fallback.
  state.modelFallback.probeAt = now - 1;
  saveLoopState(repo, state);
  assert.equal(snapshot(repo, undefined, now).loops.find((l) => l.role === "feature")?.fallback, undefined);

  // No fallback configured: an active episode cannot advertise a pair.
  writeConfig(repo, { model: "prov-a/model-a" });
  state.modelFallback.probeAt = now + 300_000;
  saveLoopState(repo, state);
  assert.equal(snapshot(repo, undefined, now).loops.find((l) => l.role === "feature")?.fallback, undefined);
});

// The subscription usage-window block (plans/agent-backends.md §8, PLANS.md part 6d/7): the
// snapshot classifies the fleet's paying seams so the display can replace or join the daily
// spend.
test("snapshot carries the claude subscription window and classifies paying seams", async () => {
  const repo = makeRepo();
  await initProject(repo, "claude window status test");
  const modelsFile = writeModelsFile(tmpdir("status-claude-"), MODELS_JSON);
  const cfg = loadConfig(repo);

  // A pi-only fleet with no account reading: absent, so the surfaces render as before.
  assert.equal(snapshot(repo, modelsFile).claudeWindow, undefined);

  // Every seam claude on subscription billing: the window block is present and `only`.
  cfg.agent = "claude";
  saveConfig(repo, cfg);
  const resetsAt = Date.now() + 3_600_000;
  writeClaudeAccount(repo, {
    billing: "subscription",
    observedAt: Date.now(),
    windows: { five_hour: { status: "allowed_warning", resetsAt, utilization: 0.64, observedAt: Date.now() } },
  });
  let snap = snapshot(repo, modelsFile);
  assert.ok(snap.claudeWindow, "the window block is present");
  assert.equal(snap.claudeWindow!.only, true, "every paying seam is subscription claude");
  assert.equal(snap.claudeWindow!.primary.type, "five_hour");
  assert.equal(snap.claudeWindow!.primary.utilization, 0.64);
  assert.equal(snap.claudeWindow!.heldUntil, null);
  // The payload carries the raw block and the preformatted badge folds the window in.
  const payload = statusPayload(repo) as { claudeWindow?: unknown; budgetBadge: string };
  assert.ok(payload.claudeWindow, "the payload carries the raw block for the GUI");
  assert.match(payload.budgetBadge, /Claude 5h · 64% · resets /);

  // A rejected window reports the future hold.
  writeClaudeAccount(repo, {
    billing: "subscription",
    observedAt: Date.now(),
    windows: { five_hour: { status: "rejected", resetsAt, utilization: 1, observedAt: Date.now() } },
  });
  snap = snapshot(repo, modelsFile);
  assert.equal(snap.claudeWindow!.heldUntil, resetsAt);

  // Mixed: the fleet on claude with one role on a priced pi model — the daily spend and the
  // window both stand. The top-level legacy provider is cleared so the claude default is not
  // read as a bare id under a pi provider.
  cfg.agent = "claude";
  delete (cfg as { provider?: unknown }).provider;
  delete (cfg as { model?: unknown }).model;
  cfg.roles.clean!.provider = "paid";
  cfg.roles.clean!.model = "gpt-x";
  saveConfig(repo, cfg);
  snap = snapshot(repo, modelsFile);
  assert.ok(snap.claudeWindow, "the mixed fleet still shows the window");
  assert.equal(snap.claudeWindow!.only, false, "priced pi seams keep the daily spend");
  const mixed = statusPayload(repo) as { budgetBadge: string };
  assert.match(mixed.budgetBadge, /budget: /, "the daily-spend line stands");
  assert.match(mixed.budgetBadge, /Claude 5h/, "beside the window line");
});
