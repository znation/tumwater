import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_JS } from "../src/ui/gui/gui-client.js";
import { GUI_CLIENT_BOOT_JS } from "../src/ui/gui/gui-client-boot.js";
import { EDITABLE_CONFIG_KEYS } from "../src/config/config-editable-keys.js";
import { clientScope, clientRegion, ESC_LINE } from "./helpers/gui-client-scope.js";

// The dashboard's Settings panel, browser-side (src/ui/gui/gui-client-settings.ts): the curated
// keys rendered as one row per key with the current value in an inline field, and the Save
// wiring that posts the row's key to /api/config-set and flashes the outcome. The pattern
// gui-client-composer.test.ts uses: the script's own esc() and the settings blob, run in one
// function scope with stand-ins for the DOM and the server.

type SettingsFns = {
  SETTINGS_KEYS: ReadonlyArray<readonly [string, string]>;
  renderSettings(d: unknown): string;
  fetchSettings(): Promise<void>;
  renderSettingsPanel(d: unknown): void;
  saveSetting(form: { dataset: Record<string, string>; querySelector(sel: string): { value: string } }): Promise<void>;
};

function settingsScope(inject: Record<string, unknown> = {}): SettingsFns {
  return clientScope<SettingsFns>(
    ["settings-view"],
    ["SETTINGS_KEYS", "renderSettings", "fetchSettings", "renderSettingsPanel", "saveSetting"],
    inject,
  );
}

test("renderSettings renders one row per curated key, esc'd, with the key's config name shown", () => {
  const { renderSettings, SETTINGS_KEYS } = settingsScope();
  const html = renderSettings({ provider: "a&b", model: "gpt-5", fallback: "omlx/free", maxDailyCostUsd: 30, quietHours: null, notify: undefined, agents: { pi: { bin: "pi" } } });
  // The browser list is a hand copy of the server constant; pin key and order to it so the
  // two cannot drift — an added editable key must appear here too.
  assert.deepEqual(SETTINGS_KEYS.map(([key]) => key), [...EDITABLE_CONFIG_KEYS]);
  // Each curated key has its row, field, and Save button.
  for (const key of EDITABLE_CONFIG_KEYS) {
    assert.match(html, new RegExp(`data-key='${key}'`));
    assert.match(html, new RegExp(`id='set-${key}'`));
  }
  assert.equal((html.match(/<form class='settings-row'/g) || []).length, EDITABLE_CONFIG_KEYS.length);
  assert.equal((html.match(/type='submit'/g) || []).length, EDITABLE_CONFIG_KEYS.length);
  // Values are escaped; null and undefined render as an empty field.
  assert.match(html, /value='a&amp;b'/);
  assert.match(html, /id='set-model' value='gpt-5'/);
  assert.match(html, /id='set-maxDailyCostUsd' value='30'/);
  assert.match(html, /id='set-quietHours' value=''/);
  assert.match(html, /id='set-notify' value=''/);
  // An object value renders as compact JSON (esc'd), so it can round-trip through the field.
  assert.match(html, /id='set-agents' value='\{&quot;pi&quot;:\{&quot;bin&quot;:&quot;pi&quot;\}\}'/);
});

test("fetchSettings builds the panel and fills it from GET /api/config; a failure renders the error panel", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {
    "settings-view": { innerHTML: "", dataset: {} },
    settingscard: { innerHTML: "", dataset: {} },
  };
  const { fetchSettings } = settingsScope({
    errorPanel: (title: string, err: { message: string }) => "<div>" + title + " " + err.message + "</div>",
    $: (id: string) => els[id],
    getJson: async () => ({ model: "gpt-5", provider: null, maxDailyCostUsd: 25, quietHours: null, notify: null }),
  });
  await fetchSettings();
  assert.match(els["settings-view"]!.innerHTML, /<h1>Settings<\/h1>/);
  assert.match(els["settings-view"]!.innerHTML, /id='settingscard'/);
  assert.match(els.settingscard!.innerHTML, /id='set-model' value='gpt-5'/);
  // A failed GET: the standard error panel, not a silent blank card.
  const { fetchSettings: fetchFail } = settingsScope({
    errorPanel: (title: string, err: { message: string }) => "<div>" + title + " " + err.message + "</div>",
    $: (id: string) => els[id],
    getJson: async () => {
      throw new Error("/api/config failed: HTTP 500 — broken file");
    },
  });
  els["settings-view"]!.dataset.built = "1";
  await fetchFail();
  assert.match(els.settingscard!.innerHTML, /Settings could not load/);
  assert.match(els.settingscard!.innerHTML, /broken file/);
});

test("saveSetting posts the row's key and value and flashes the outcome", async () => {
  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const { saveSetting } = settingsScope({
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { ok: true, key: "model", value: "gpt-5", oldValue: null };
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  const form = { dataset: { key: "model" }, querySelector: () => ({ value: "gpt-5" }) };
  await saveSetting(form);
  assert.deepEqual(posts, [{ path: "/api/config-set", body: { key: "model", value: "gpt-5" } }]);
  assert.deepEqual(flashes, ["Saved model (was unset)"]);
  // A JSON object field (agents) posts the parsed object, not its text.
  let agentBody: unknown;
  const { saveSetting: saveAgents } = settingsScope({
    postJson: async (_path: string, body: unknown) => {
      agentBody = body;
      return { ok: true, key: "agents", value: "ok", oldValue: null };
    },
    showFlash: () => {},
  });
  await saveAgents({ dataset: { key: "agents" }, querySelector: () => ({ value: '{"pi":{"bin":"pi"}}' }) });
  assert.deepEqual(agentBody, { key: "agents", value: { pi: { bin: "pi" } } });
  // A server-side refusal: the flash is the error pattern, with the server's message.
  const { saveSetting: saveFail } = settingsScope({
    postJson: async () => {
      throw new Error("/api/config-set failed: HTTP 400 — quietHours: invalid quiet hours window");
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await saveFail({ dataset: { key: "quietHours" }, querySelector: () => ({ value: "25:00-07:00" }) });
  assert.match(flashes[flashes.length - 1]!, /^error: .*quietHours/);
});

test("the settings region is spliced into the served script, and the boot routes #settings to it", () => {
  // The GUI page inlines GUI_CLIENT_JS, which must carry the settings blob...
  assert.equal(GUI_CLIENT_JS.includes(clientRegion("settings-view")), true);
  // ...and the boot's view table and switchView must fetch it.
  assert.match(GUI_CLIENT_BOOT_JS, /settings: "settings-view"/);
  assert.match(GUI_CLIENT_BOOT_JS, /if \(v === "settings"\) fetchSettings\(\);/);
  assert.match(ESC_LINE, /const esc = /);
});
