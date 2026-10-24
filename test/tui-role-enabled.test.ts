import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";

/** The tumwater.json `roles` slice this file reads back to assert on. */
interface CfgRoles { roles: Record<string, { enabled?: boolean }> }

// Ctrl+V enable/disable editor on the Health view (PLANS.md): the terminal twin of the
// dashboard Settings card's Enable and the role drawer's two-click Disable (and of `tumwater
// role <id> --enable|--disable`). A typed role id's base role's `roles.<base>.enabled` is
// toggled through the shared setConfigKey core: a config-disabled role is enabled at once, an
// enabled one is armed for a second Enter (the drawer's two-click confirm), an id changed
// between the two Enters re-arms rather than disabling, and the director cannot be disabled.
// Esc / Ctrl+V again / Ctrl+T exit by restoring the prompt draft, and Ctrl+V off the Health
// view keeps its other view meanings.

// makeTuiRepo's fresh repo has exactly one enabled role (clean); every other catalog role,
// including qa, is disabled in tumwater.json. The Health view is view roleIds.length + 7 = 8
// with one role, so 8 Ctrl+T presses reach it from the Activity start view.
test("Ctrl+V on Health enables a disabled role; Enter writes roles.qa.enabled=true and flashes qa: enabled", async () => {
  const repo = await makeTuiRepo();
  const cfgPath = path.join(repo, "tumwater.json");
  await withTui(repo, async (tui) => {
    for (const ch of "draft prompt") tui.key(ch, ch);
    for (let i = 0; i < 8; i++) tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /\[Health\]/);

    // Ctrl+V opens the editor and flashes its hint; the brand prefix names the mode and the
    // footer's hint branch names the mode's own save/cancel keys.
    tui.key(undefined, "v", { ctrl: true });
    assert.match(tui.lastFrame(), /enable or disable a role: type the role id, Enter to toggle, Esc to cancel/);
    assert.equal(tui.lines().at(-1), "role state ›");
    assert.match(tui.lastFrame(), /Enter enable\/disable role/);

    // Typing a config-disabled role id and Enter enables it at once and returns to prompt mode.
    for (const ch of "qa") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /qa: enabled/);
    assert.equal((readJson<CfgRoles>(cfgPath)).roles.qa?.enabled, true, "the disabled role is enabled");
    assert.equal(tui.lines().at(-1), "director › draft prompt"); // previous prompt restored
  });
});

// The enabled role's two-click confirm: the first Enter writes nothing and flashes the
// second-press hint, a second Enter on the same base writes roles.clean.enabled=false, and an
// id changed between the two Enters re-arms instead of disabling what the line no longer shows.
test("Ctrl+V disables an enabled role on a second Enter; an id change between the two re-arms", async () => {
  const repo = await makeTuiRepo();
  const cfgPath = path.join(repo, "tumwater.json");
  // Enable a second role so the re-arm test has a different enabled id to switch to. Two roles
  // make it the Health view 9.
  const cfg = loadConfig(repo);
  cfg.roles["bugfix"] = { enabled: true };
  saveConfig(repo, cfg);

  await withTui(repo, async (tui) => {
    for (let i = 0; i < 9; i++) tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /\[Health\]/);
    tui.key(undefined, "v", { ctrl: true });

    // First Enter on the enabled clean role arms the confirm and writes nothing.
    for (const ch of "clean") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /press Enter again to disable clean/);
    assert.equal((readJson<CfgRoles>(cfgPath)).roles.clean?.enabled, true, "the first Enter writes nothing");

    // Changing the id to another enabled role and Enter re-arms for it — clean is not disabled.
    for (let i = 0; i < 5; i++) tui.key(undefined, "backspace");
    for (const ch of "bugfix") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /press Enter again to disable bugfix/);
    assert.equal((readJson<CfgRoles>(cfgPath)).roles.clean?.enabled, true, "clean is not disabled by an id change");

    // The second Enter on the same base disables it.
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /bugfix: disabled/);
    assert.equal((readJson<CfgRoles>(cfgPath)).roles.bugfix?.enabled, false, "the second Enter disables bugfix");
    assert.equal(tui.lines().at(-1), "director ›");
  });
});

// Enabling stays allowed (the CLI/GUI contract): a config-disabled `director` id enables at once
// like any other role, writing roles.director.enabled=true and flashing `director: enabled`.
test("Ctrl+V enables a config-disabled director at once (enabling stays allowed)", async () => {
  const repo = await makeTuiRepo();
  const cfgPath = path.join(repo, "tumwater.json");
  await withTui(repo, async (tui) => {
    for (let i = 0; i < 8; i++) tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "v", { ctrl: true });
    for (const ch of "director") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /director: enabled/);
    assert.equal((readJson<CfgRoles>(cfgPath)).roles.director?.enabled, true, "a disabled director enables at once");
  });
});

// Only disabling is refused: an enabled `director` id flashes the refusal and leaves
// tumwater.json byte-identical; an empty line flashes the required-id wording and an unknown id
// flashes unknownRoleMessage, both staying in the editor.
test("Ctrl+V refuses disabling the director; empty and unknown ids write nothing", async () => {
  const repo = await makeTuiRepo();
  const cfgPath = path.join(repo, "tumwater.json");
  // Enable the director so a disable is actually being attempted (enabling stays allowed). The
  // extra enabled role makes the Health view roleIds.length + 7 = 9, so 9 Ctrl+T presses reach it.
  const cfg = loadConfig(repo);
  cfg.roles["director"] = { enabled: true };
  saveConfig(repo, cfg);
  await withTui(repo, async (tui) => {
    for (let i = 0; i < 9; i++) tui.key(undefined, "t", { ctrl: true });
    const before = fs.readFileSync(cfgPath, "utf8");
    tui.key(undefined, "v", { ctrl: true });
    for (const ch of "director") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /the director cannot be disabled/);
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "a director disable writes nothing");

    // An empty line flashes the required-id wording and stays open.
    for (let i = 0; i < 8; i++) tui.key(undefined, "backspace");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /a role id is required/);

    // An unknown id flashes unknownRoleMessage's wording.
    for (const ch of "nope") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /unknown role: nope \(valid ids:/);
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "an unknown id writes nothing");
  });
});

// Esc, Ctrl+V again, and Ctrl+T all exit the editor by restoring the draft prompt; while open
// the `role state ›` prefix names the mode.
test("Ctrl+V editor: Esc, Ctrl+V again, and Ctrl+T exit by restoring the draft", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (let i = 0; i < 8; i++) tui.key(undefined, "t", { ctrl: true });
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Esc cancels, restoring the draft byte-for-byte.
    tui.key(undefined, "v", { ctrl: true });
    assert.equal(tui.lines().at(-1), "role state ›");
    for (const ch of "qa") tui.key(ch, ch);
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › draft prompt", "Esc restores the draft");

    // Ctrl+V again while open exits, restoring the draft.
    tui.key(undefined, "v", { ctrl: true });
    for (const ch of "qa") tui.key(ch, ch);
    tui.key(undefined, "v", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft prompt", "Ctrl+V again restores the draft");

    // Ctrl+T exits the editor and cycles away from the view.
    tui.key(undefined, "v", { ctrl: true });
    for (const ch of "qa") tui.key(ch, ch);
    tui.key(undefined, "t", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft prompt", "Ctrl+T restores the draft");
    assert.match(tui.lastFrame(), /\[Brief\]/, "the view cycled away");
  });
});

// Ctrl+V off the Health view keeps its own meanings — the Activity view's image attach still
// opens, because the role-enabled editor is guarded to the Health view index.
test("Ctrl+V on Activity keeps its image-attach meaning, not the Health editor", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    // The start view is Activity.
    tui.key(undefined, "v", { ctrl: true });
    assert.match(tui.lastFrame(), /attach an image path — Enter to attach, Esc to cancel/);
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director ›");
  });
});

// A bare instance id writes its base role's key: with `feature` enabled at two instances,
// `feature-2` toggles `roles.feature.enabled`, not `roles.feature-2.enabled`. Two roles make
// the Health view 9.
test("Ctrl+V on Health maps a bare instance id to its base role's enabled key", async () => {
  const repo = await makeTuiRepo();
  const cfgPath = path.join(repo, "tumwater.json");
  const cfg = loadConfig(repo);
  for (const rc of Object.values(cfg.roles)) rc.enabled = false;
  cfg.roles["feature"] = { enabled: true, instances: 2 };
  saveConfig(repo, cfg);

  await withTui(repo, async (tui) => {
    for (let i = 0; i < 9; i++) tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /\[Health\]/);
    tui.key(undefined, "v", { ctrl: true });

    // feature is enabled: first Enter arms, second writes roles.feature.enabled = false.
    for (const ch of "feature-2") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /press Enter again to disable feature/);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /feature: disabled/);
    assert.equal((readJson<CfgRoles>(cfgPath)).roles.feature?.enabled, false, "feature-2 writes roles.feature.enabled");
  });
});
