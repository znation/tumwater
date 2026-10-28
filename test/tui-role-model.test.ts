import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";
import {
  formatRoleModelLine,
  parseRoleModelLine,
  type RoleModelFields,
} from "../src/ui/tui/tui-editor-role-model.js";

// Ctrl+X role-model editor on a role's Transcript view (PLANS.md): the terminal twin of the
// dashboard role drawer's Model overrides row and `tumwater role <id> --model`/`--provider`/
// `--thinking`. Pre-filled with the viewed role's own triple read from the FILE, Enter parses
// the one line and writes all three through the shared setRoleModelFields; a field the line
// leaves out is cleared, an empty line clears all three, and Esc and Ctrl+T cancel by restoring
// the prompt draft. The unit-level scope on tui-keys.test.ts pins the instance→base mapping;
// this file drives the full TUI.
test("Ctrl+X pre-fills the whole override triple and Enter writes provider, model and thinking in one write", async () => {
  const repo = await makeTuiRepo(); // one enabled role: clean, no overrides yet
  const cfgPath = path.join(repo, "tumwater.json");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → clean's transcript
    assert.match(tui.lastFrame(), /Transcript: clean \(1\/1\)/);

    // Ctrl+X opens pre-filled empty (no overrides set yet) and flashes the hint; the footer's
    // hint branch names the mode's own save/cancel keys, and the prompt line labels the mode.
    tui.key(undefined, "x", { ctrl: true });
    assert.match(tui.lastFrame(), /edit clean's model overrides/);
    assert.equal(tui.lines().at(-1), "model overrides ›");
    assert.match(tui.lastFrame(), /Enter save model overrides/);

    // Typing the whole triple and entering writes provider, model and thinking through one
    // setRoleModelFields call, persisting each to tumwater.json.
    for (const ch of "strong provider=huggingface thinking=high") tui.key(ch, ch);
    assert.equal(tui.lines().at(-1), "model overrides › strong provider=huggingface thinking=high");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: model overrides set to model strong, provider huggingface, thinking high/);
    const cfg = readJson(cfgPath) as { roles?: Record<string, { model?: string; provider?: string; thinking?: string }> };
    assert.equal(cfg.roles?.clean?.model, "strong");
    assert.equal(cfg.roles?.clean?.provider, "huggingface");
    assert.equal(cfg.roles?.clean?.thinking, "high");

    // Re-opening pre-fills the whole triple the file just wrote, the model first as a bare
    // token, then provider= and thinking=.
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(tui.lines().at(-1), "model overrides › strong provider=huggingface thinking=high");
  });
});

test("a field left off the Ctrl+X line clears that override, and an empty line clears all three", async () => {
  const repo = await makeTuiRepo(); // one enabled role: clean
  const cfgPath = path.join(repo, "tumwater.json");
  // A backend is set too: it must survive every edit untouched — the line never carries it.
  const cfg = loadConfig(repo) as any; // makeTuiRepo already built a valid, clean-only-enabled config
  cfg.roles.clean.model = "strong";
  cfg.roles.clean.provider = "openai";
  cfg.roles.clean.thinking = "medium";
  cfg.roles.clean.backend = "claude";
  saveConfig(repo, cfg);
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(tui.lines().at(-1), "model overrides › strong provider=openai thinking=medium");

    // Leave only the model on the line: provider and thinking (left off) are cleared, the
    // model stays, and the backend is untouched.
    for (let i = 0; i < "strong provider=openai thinking=medium".length; i++) tui.key(undefined, "backspace");
    for (const ch of "strong") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: model overrides set to model strong; the rest cleared/);
    let cfgR = readJson(cfgPath) as { roles?: Record<string, { model?: string; provider?: string; thinking?: string; backend?: string }> };
    assert.equal(cfgR.roles?.clean?.model, "strong");
    assert.equal(cfgR.roles?.clean?.provider, undefined, "a field left off the line is cleared");
    assert.equal(cfgR.roles?.clean?.thinking, undefined, "a field left off the line is cleared");
    assert.equal(cfgR.roles?.clean?.backend, "claude", "a backend set for the role is never touched");

    // An empty line clears all three, still leaving the backend alone.
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(tui.lines().at(-1), "model overrides › strong");
    for (let i = 0; i < "strong".length; i++) tui.key(undefined, "backspace");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: all model overrides cleared/);
    cfgR = readJson(cfgPath) as { roles?: Record<string, { model?: string; provider?: string; thinking?: string; backend?: string }> };
    assert.equal(cfgR.roles?.clean?.model, undefined);
    assert.equal(cfgR.roles?.clean?.provider, undefined);
    assert.equal(cfgR.roles?.clean?.thinking, undefined);
    assert.equal(cfgR.roles?.clean?.backend, "claude", "a backend set for the role is never touched");
  });
});

test("a bad thinking level, an unknown key or a second bare token stays in edit mode and writes nothing", async () => {
  const repo = await makeTuiRepo(); // one enabled role: clean, no overrides
  const cfgPath = path.join(repo, "tumwater.json");
  const before = fs.readFileSync(cfgPath, "utf8");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });

    // A bad thinking level is rejected by validateConfig: flashes, stays in edit mode with the
    // line intact, and writes nothing.
    tui.key(undefined, "x", { ctrl: true });
    for (const ch of "thinking=boosted") tui.key(ch, ch);
    assert.equal(tui.lines().at(-1), "model overrides › thinking=boosted");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /thinking must be one of/);
    assert.equal(tui.lines().at(-1), "model overrides › thinking=boosted", "a bad level stays in edit mode with the line intact");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "a bad thinking level writes nothing");
    tui.key(undefined, "escape");

    // An unknown key is an input error naming the three accepted keys.
    tui.key(undefined, "x", { ctrl: true });
    for (const ch of "provider=openai batches=3") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /unknown key batches: only provider, model and thinking are accepted/);
    assert.equal(tui.lines().at(-1), "model overrides › provider=openai batches=3");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "an unknown key writes nothing");
    tui.key(undefined, "escape");

    // A second bare token is an input error too (the model may be given only once).
    tui.key(undefined, "x", { ctrl: true });
    for (const ch of "gpt-5 strong") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /the model may be given only once/);
    assert.equal(tui.lines().at(-1), "model overrides › gpt-5 strong");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "a second bare token writes nothing");
  });
});

// The pure parser/format pair: formatRoleModelLine must be the exact inverse of
// parseRoleModelLine, and the parser's error cases must stay enumerated.
test("parseRoleModelLine reads back the pre-fill it formats", () => {
  const cases: RoleModelFields[] = [
    { provider: "", model: "", thinking: "" },
    { provider: "", model: "strong", thinking: "" },
    { provider: "huggingface", model: "strong", thinking: "high" },
    { provider: "", model: "anthropic/claude-3-7-sonnet", thinking: "off" },
  ];
  for (const fields of cases) {
    const parsed = parseRoleModelLine(formatRoleModelLine(fields));
    assert.deepEqual(parsed, { ok: true, fields }, `round-trip of ${JSON.stringify(fields)}`);
  }
  // Explicit spellings and clear-vs-set round-trips stay well-formed.
  assert.deepEqual(parseRoleModelLine("gpt-5 model=gpt-5"), {
    ok: false,
    error: "the model may be given only once (a bare token or model=, not both or twice)",
  });
  assert.deepEqual(parseRoleModelLine("model=strong"), {
    ok: true,
    fields: { provider: "", model: "strong", thinking: "" },
  });
  assert.deepEqual(parseRoleModelLine("provider="), { ok: false, error: "provider= needs a value" });
  assert.deepEqual(parseRoleModelLine("thinking=high thinking=low"), {
    ok: false,
    error: "repeated thinking=",
  });
  assert.deepEqual(parseRoleModelLine("model=strong strong"), {
    ok: false,
    error: "the model may be given only once (a bare token or model=, not both or twice)",
  });
});

// The prompt-line editors share one line, so the role-model editor must not enter while another
// holds it (and vice versa); each flashes the way out.
test("Ctrl+X is mutually exclusive with the other prompt-line editors", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → clean's transcript
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+B (budget) holds the line first; Ctrl+X must flash the way out, not open.
    tui.key(undefined, "b", { ctrl: true });
    tui.key(undefined, "x", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the budget edit first/);
    assert.equal(tui.lines().at(-1), "daily cap $", "still in budget mode");
    tui.key(undefined, "escape"); // out of budget mode

    // Role-model mode open; Ctrl+B must flash the way out and leave role-model mode alone.
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(tui.lines().at(-1), "model overrides ›");
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the role model edit first/);
    assert.equal(tui.lines().at(-1), "model overrides ›", "the role-model editor keeps the line");
    tui.key(undefined, "escape");
  });
});

// The per-role controls and pane arms must stay inert while the role-model editor holds the
// prompt line, exactly like the sibling interval editor: Ctrl+P/W would otherwise open a second
// pause/wake prompt-line editor and Ctrl+A/V write run state, and Ctrl+G/E scope/window and
// Ctrl+N sub-view cycle would act while the editor owns the line.
test("Ctrl+X holds the line against the per-role controls and the transcript pane arms", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → clean's transcript
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(tui.lines().at(-1), "model overrides ›");
    for (const ch of "sonnet") tui.key(ch, ch);
    assert.equal(tui.lines().at(-1), "model overrides › sonnet");

    // Per-role controls (Ctrl+P pause, Ctrl+W wake, Ctrl+A abort, Ctrl+V counters) are
    // excluded while the editor holds the line: none opens a pause/wake editor or writes run
    // state, and the pending model text survives untouched.
    for (const name of ["p", "w", "a", "v"]) {
      tui.key(undefined, name, { ctrl: true });
      assert.equal(
        tui.lines().at(-1),
        "model overrides › sonnet",
        `Ctrl+${name.toUpperCase()} must not disturb the role-model editor`,
      );
    }

    // Pane arms are excluded too: Ctrl+N stays on the transcript sub-view (it does not cycle
    // to the notes), and Ctrl+G/E scope/window do not act — the role-model line still owns
    // the prompt line.
    for (const name of ["n", "g", "e"]) {
      tui.key(undefined, name, { ctrl: true });
      assert.equal(
        tui.lines().at(-1),
        "model overrides › sonnet",
        `Ctrl+${name.toUpperCase()} must not act while the role-model editor holds the line`,
      );
    }

    // Enter still commits the held model value, proving the editor survived every stray key.
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: model overrides set to model sonnet; the rest cleared/);
  });
});
