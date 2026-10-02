/** The dashboard's Settings view, browser-side: the five curated top-level config keys
 * (EDITABLE_CONFIG_KEYS's set, mirrored here for the labels) as label + current value +
 * inline field + Save, one row per key. Values load once through GET /api/config when the
 * view is first opened — no polling loop of its own; a re-click of the tab refetches, like
 * the other views' refresh-on-open. Save posts {key, value} to POST /api/config-set — the
 * same setConfigKey write path `tumwater config set` uses — and flashes the same
 * success/error toast pattern the composer's send uses (showFlash). Spliced into
 * gui-client.ts's script, reaching its helpers (esc, $, getJson, postJson, showFlash) through
 * that concatenation. */
export const GUI_CLIENT_SETTINGS_JS = String.raw`  // settings-view:start
  // The curated keys, in display order: [key, label]. Mirrors the server's
  // EDITABLE_CONFIG_KEYS (src/ui/gui-endpoints.ts); the round-trip test pins the two together.
  const SETTINGS_KEYS = [
    ["provider", "Provider"],
    ["model", "Model"],
    ["maxDailyCostUsd", "Daily spend cap (USD)"],
    ["quietHours", "Quiet hours"],
    ["notify", "Notify hook"],
  ];
  // One row per key: the current value into an inline field (esc'd, like every rendered
  // value on the page), Save submits the row's form. A null (unset) key renders empty —
  // saving empty then sets the literal empty string, which the per-key validators and
  // validateConfig judge like the CLI's own empty-string set.
  function renderSettings(d) {
    return SETTINGS_KEYS.map((k) =>
      "<form class='settings-row' data-key='" + k[0] + "'>" +
      "<label for='set-" + k[0] + "'>" + esc(k[1]) + "<span class='settings-key'>" + k[0] + "</span></label>" +
      "<input class='field' id='set-" + k[0] + "' value='" + esc(d[k[0]] === null || d[k[0]] === undefined ? "" : String(d[k[0]])) + "'>" +
      "<button type='submit' class='btn btn-sm'>Save</button>" +
      "</form>").join("");
  }
  // The view's one panel: built once, values fetched on each open of the tab (the boot's
  // switchView calls fetchSettings) — no polling loop of its own.
  function buildSettingsView() {
    const panel = $("settings-view");
    if (panel.dataset.built) return;
    panel.dataset.built = "1";
    panel.innerHTML = "<div class='view-head'><div><h1>Settings</h1>" +
      "<p>The fleet-wide settings an operator edits from here; everything else lives in tumwater.json or the CLI.</p></div></div>" +
      "<div class='card' id='settingscard'><div class='empty'>Loading…</div></div>";
  }
  async function fetchSettings() {
    buildSettingsView();
    const card = $("settingscard");
    try {
      renderSettingsPanel(await getJson("/api/config"));
    } catch (e) {
      card.innerHTML = errorPanel("Settings could not load", e, "card empty");
    }
  }
  function renderSettingsPanel(d) {
    const card = $("settingscard");
    card.innerHTML = renderSettings(d);
  }
  // The one delegated submit listener for the panel: save the row's key with the field's
  // current text, and flash the outcome — "Saved <key>" on 200 (with the old value when the
  // key was unset before), the server's message otherwise. No polling, no repaint: the
  // response's value is already what the field holds.
  async function saveSetting(form) {
    const key = form.dataset.key;
    const input = form.querySelector("input");
    try {
      const d = await postJson("/api/config-set", { key: key, value: input.value });
      showFlash(d && d.oldValue === null ? "Saved " + key + " (was unset)" : "Saved " + key);
    } catch (e) {
      showFlash("error: " + (e && e.message ? e.message : String(e)));
    }
  }
  // settings-view:end
`;