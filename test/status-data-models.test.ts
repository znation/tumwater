// The model/seam facet of the status-data suite: snapshot()'s per-row resolved selector and
// seam tier, the active model-fallback episode, and the claude subscription window. Split by
// facet from one status-data test file; the core contract and poll cache live in
// status-data.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { snapshot } from "../src/status/status-data.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { MODELS_JSON, writeModelsFile } from "./fixtures/models-fixtures.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { setEnv } from "./helpers/env.js";
import { writeClaudeAccount } from "../src/agent/claude/claude-account.js";

test("snapshot role rows carry the resolved selector always and the seam tier only under a tier map", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");

  // A single string model: every row carries the resolved selector; the tier tag stays absent.
  writeConfig(repo, { model: "prov-a/model-a" });
  const plain = snapshot(repo);
  assert.equal(plain.roles[0]?.modelTier, undefined);
  assert.equal(plain.roles[0]?.model, "prov-a/model-a");

  // The payload ships the same field per row — the GUI renders it beside the role name.
  const plainPayload = statusPayload(repo) as { roles: Array<{ role: string; modelTier?: string; model?: string }> };
  assert.equal(plainPayload.roles[0]?.model, "prov-a/model-a");
  assert.equal(plainPayload.roles[0]?.modelTier, undefined);

  // A tier map: each row carries its role's seam tier and that tier's resolved selector.
  writeConfig(repo, { model: { default: "prov-a/model-a", strong: "prov-s/model-s:high" } });
  const mapped = snapshot(repo);
  const plan = mapped.roles.find((l) => l.role === "plan");
  assert.equal(plan?.modelTier, "strong"); // the catalog assigns plan the strong tier
  assert.equal(plan?.model, "prov-s/model-s:high");
  const readme = mapped.roles.find((l) => l.role === "readme");
  assert.equal(readme?.modelTier, "small");
  assert.equal(readme?.model, "prov-a/model-a"); // an undeclared tier inherits default

  // The payload ships the same fields per row — the GUI renders them beside the role name.
  const payload = statusPayload(repo) as { roles: Array<{ role: string; modelTier?: string; model?: string }> };
  const planRow = payload.roles.find((l) => l.role === "plan");
  assert.equal(planRow?.modelTier, "strong");
  assert.equal(planRow?.model, "prov-s/model-s:high");
});

// Model failure fallback, part 2/2: the snapshot's role row carries the resolved fallback
// pair, the episode's start, and the tripping reason only while the episode is active (its
// runs use another model); a due probe runs the primary, so the field is absent then.
test("snapshot rows carry the active model-fallback episode", async () => {
  const repo = makeRepo();
  await initProject(repo, "model fallback rows");
  writeConfig(repo, { model: "prov-a/model-a", fallbackModel: { provider: "prov-fb", model: "model-fb" } });
  const now = Date.now();
  const state = freshRunnerState("feature");
  state.modelFallback = {
    failures: 0,
    since: now - 60_000,
    probeAt: now + 300_000,
    cooldownMs: 300_000,
    reason: "Request timed out.",
  };
  saveRunnerState(repo, state);
  const active = snapshot(repo, undefined, now).roles.find((l) => l.role === "feature");
  assert.deepEqual(active?.fallback, {
    provider: "prov-fb",
    model: "model-fb",
    since: now - 60_000,
    reason: "Request timed out.",
  });
  // The payload ships the same field for the dashboard row tag.
  const payload = statusPayload(repo, now) as { roles: Array<{ role: string; fallback?: unknown }> };
  assert.deepEqual(payload.roles.find((l) => l.role === "feature")?.fallback, active?.fallback);

  // Probe due: this run uses the primary, so the row stops naming the fallback.
  state.modelFallback.probeAt = now - 1;
  saveRunnerState(repo, state);
  assert.equal(snapshot(repo, undefined, now).roles.find((l) => l.role === "feature")?.fallback, undefined);

  // No fallback configured: an active episode cannot advertise a pair.
  writeConfig(repo, { model: "prov-a/model-a" });
  state.modelFallback.probeAt = now + 300_000;
  saveRunnerState(repo, state);
  assert.equal(snapshot(repo, undefined, now).roles.find((l) => l.role === "feature")?.fallback, undefined);
});

// The subscription usage-window block (plans/agent-backends.md §8, PLANS.md part 6d/7): the
// snapshot classifies the team's paying seams so the display can replace or join the daily
// spend.
test("snapshot carries the claude subscription window and classifies paying seams", async () => {
  const repo = makeRepo();
  await initProject(repo, "claude window status test");
  const modelsFile = writeModelsFile(tmpdir("status-claude-"), MODELS_JSON);
  const cfg = loadConfig(repo);

  // A pi-only team with no account reading: absent, so the surfaces render as before.
  assert.equal(snapshot(repo, modelsFile).claudeWindow, undefined);

  // Every seam claude on subscription billing: the window block is present and `only`.
  cfg.backend = "claude";
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
  // Part 3a/9: the snapshot also carries the per-backend list, one claude block here, and the
  // claude spelling is derived from it (same windows/primary/heldUntil, `only` = subscriptionOnly).
  assert.deepEqual(snap.subscriptionWindows!.map((b) => b.backend), ["claude"], "one claude block");
  assert.equal(snap.subscriptionWindows![0]!.label, "Claude");
  assert.equal(snap.subscriptionOnly, true, "the team-global answer matches the claude-only `only`");
  // The payload carries the raw block and the preformatted badge folds the window in.
  const payload = statusPayload(repo) as {
    claudeWindow?: unknown;
    subscriptionWindows?: unknown;
    subscriptionOnly?: boolean;
    budgetBadge: string;
  };
  assert.ok(payload.claudeWindow, "the payload carries the raw block for the GUI");
  assert.ok(payload.subscriptionWindows, "the payload carries the per-backend list too");
  assert.equal(payload.subscriptionOnly, true);
  assert.match(payload.budgetBadge, /Claude 5h · 64% · resets /);

  // A rejected window reports the future hold.
  writeClaudeAccount(repo, {
    billing: "subscription",
    observedAt: Date.now(),
    windows: { five_hour: { status: "rejected", resetsAt, utilization: 1, observedAt: Date.now() } },
  });
  snap = snapshot(repo, modelsFile);
  assert.equal(snap.claudeWindow!.heldUntil, resetsAt);

  // Mixed: the team on claude with one role on a priced pi model — the daily spend and the
  // window both stand. The top-level legacy provider is cleared so the claude default is not
  // read as a bare id under a pi provider.
  cfg.backend = "claude";
  delete (cfg as { provider?: unknown }).provider;
  delete (cfg as { model?: unknown }).model;
  cfg.roles.clean!.backend = "pi";
  cfg.roles.clean!.model = "paid/gpt-x";
  saveConfig(repo, cfg);
  snap = snapshot(repo, modelsFile);
  assert.ok(snap.claudeWindow, "the mixed team still shows the window");
  assert.equal(snap.claudeWindow!.only, false, "priced pi seams keep the daily spend");
  const mixed = statusPayload(repo) as { budgetBadge: string };
  assert.match(mixed.budgetBadge, /budget: /, "the daily-spend line stands");
  assert.match(mixed.budgetBadge, /Claude 5h/, "beside the window line");
});

// The pi-default facet of the role row (docs/backends.md): when tumwater.json resolves no
// model and the seam routes to pi, the row names pi's own saved default from its settings.json
// (read beside the models catalog) and marks it modelFromPi.
test("snapshot rows name pi's own saved default when the config resolves no model", async () => {
  const repo = makeRepo();
  await initProject(repo, "pi default rows");
  const dir = tmpdir("status-pi-default-");
  writeModelsFile(dir, MODELS_JSON);
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: "prov", defaultModel: "org/m:route", defaultThinkingLevel: "low" }));
  const modelsPath = path.join(dir, "models.json");

  writeConfig(repo, {});
  const snap = snapshot(repo, modelsPath);
  const row = snap.roles.find((l) => l.role === "feature")!;
  assert.equal(row.model, "prov/org/m:route:low");
  assert.equal(row.modelFromPi, true);
  // No model anywhere in the config, so every row names the pi default.
  assert.ok(snap.roles.every((l) => l.modelFromPi === true));

  // The config's thinking wins over the default's (tumwater passes it as --thinking).
  writeConfig(repo, { thinking: "high" });
  const high = snapshot(repo, modelsPath).roles.find((l) => l.role === "feature")!;
  assert.equal(high.model, "prov/org/m:route:high");
  assert.equal(high.modelFromPi, true);
});

test("modelFromPi stays absent when a model, agent or provider resolves", async () => {
  const repo = makeRepo();
  await initProject(repo, "pi no-default rows");
  const dir = tmpdir("status-pi-no-");
  writeModelsFile(dir, MODELS_JSON);
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: "prov", defaultModel: "org/m:route" }));
  const modelsPath = path.join(dir, "models.json");

  // A configured model: the row keeps the configured selector.
  writeConfig(repo, { model: "prov-a/model-a" });
  const configured = snapshot(repo, modelsPath).roles.find((l) => l.role === "feature")!;
  assert.equal(configured.model, "prov-a/model-a");
  assert.equal(configured.modelFromPi, undefined);

  // agent claude: the row keeps the claude/… tier default.
  writeConfig(repo, { backend: "claude" });
  const claude = snapshot(repo, modelsPath).roles.find((l) => l.role === "feature")!;
  assert.equal(claude.modelFromPi, undefined);
  assert.match(claude.model ?? "", /^claude\//);

  // Config names only a provider: no model resolves, so the row has none and no flag.
  writeConfig(repo, { provider: "huggingface" });
  const provOnly = snapshot(repo, modelsPath).roles.find((l) => l.role === "feature")!;
  assert.equal(provOnly.modelFromPi, undefined);
  assert.equal(provOnly.model, undefined);
});

test("a role that resolves no provider or model names its backend default", async () => {
  const repo = makeRepo();
  await initProject(repo, "backend default rows");
  // A models dir with no settings.json, so pi's own default is unreadable.
  const dir = tmpdir("status-backend-default-");
  writeModelsFile(dir, MODELS_JSON);
  const modelsPath = path.join(dir, "models.json");

  // An opencode role with no model/provider fills no tier default, so the row names the
  // backend's own default label — the same string `tumwater role <id>`'s Model line prints
  // (docs/invariants.md "Cross-surface agreement").
  writeConfig(repo, { roles: { clean: { backend: "opencode" } } });
  const opencode = snapshot(repo, modelsPath).roles.find((l) => l.role === "clean")!;
  assert.equal(opencode.model, "opencode default");
  assert.equal(opencode.modelFromPi, undefined);

  // A pi seam with no readable pi default likewise names `pi default`, not a formatted
  // selector, and no modelFromPi marker.
  writeConfig(repo, {});
  const pi = snapshot(repo, modelsPath).roles.find((l) => l.role === "feature")!;
  assert.equal(pi.model, "pi default");
  assert.equal(pi.modelFromPi, undefined);
});

test("statusPayload ships modelFromPi beside the model it names", async () => {
  const repo = makeRepo();
  await initProject(repo, "pi default payload");
  const dir = tmpdir("status-pi-payload-");
  writeModelsFile(dir, MODELS_JSON);
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: "prov", defaultModel: "org/m:route", defaultThinkingLevel: "low" }));
  writeConfig(repo, {});
  // statusPayload reads the default models/settings path, so point it at the temp dir.
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", dir);
  try {
    const payload = statusPayload(repo) as { roles: Array<{ role: string; model?: string; modelFromPi?: boolean }> };
    const row = payload.roles.find((l) => l.role === "feature")!;
    assert.equal(row.model, "prov/org/m:route:low");
    assert.equal(row.modelFromPi, true);
  } finally {
    restoreAgentDir();
  }
});

// Image input, part 5/5 (plans/image-input.md "Surfaces"): every snapshot row carries the
// role's image-input capability and its reroute target as a display label, computed by the
// same resolver the role page and submit gate use — so `status --json` and the images alert
// answer without running doctor. A default-tier text-only role reroutes to the vision strong
// tier; a strong-tier role reads images itself.
test("snapshot rows carry the image-input surface from the models catalog", async () => {
  const repo = makeRepo();
  await initProject(repo, "image surface");
  const dir = tmpdir("status-image-");
  const models = writeModelsFile(
    dir,
    JSON.stringify({
      providers: {
        local: {
          models: [
            { id: "text" }, // no input → text-only
            { id: "vision", input: ["text", "image"] },
          ],
        },
      },
    }),
  );
  // plan rides the strong tier; feature rides default. Default is text-only, strong reads images,
  // but the peer-tier reroute was subtracted (part 5g/6), so no role names a reroute label.
  writeConfig(repo, { model: { default: "local/text", strong: "local/vision" } });
  const snap = snapshot(repo, models);
  const feature = snap.roles.find((l) => l.role === "feature")!;
  assert.equal(feature.imageInput, false);
  assert.equal(feature.imageRerouteLabel, null, "no peer-tier reroute label remains (part 5g/6)");
  const plan = snap.roles.find((l) => l.role === "plan")!;
  assert.equal(plan.imageInput, true);
  assert.equal(plan.imageRerouteLabel, null);
  // The payload ships the same surface for the dashboard's images alert and composer notice.
  // statusPayload reads the default models path, so point it at the temp dir the snapshot used.
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", dir);
  try {
    const payload = statusPayload(repo) as { roles: Array<{ role: string; imageInput?: boolean | null; imageReroute?: string | null }> };
    const featureRow = payload.roles.find((l) => l.role === "feature")!;
    assert.equal(featureRow.imageInput, false);
    assert.equal(featureRow.imageReroute, null);
  } finally {
    restoreAgentDir();
  }
});
