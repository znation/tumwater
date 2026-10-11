/** The dashboard's Settings view, browser-side: the curated top-level config keys
 * (EDITABLE_CONFIG_KEYS's set, mirrored here for the labels) as label + current value +
 * inline field + Save + Clear, one row per key. Values load once through GET /api/config when
 * the view is first opened — no polling loop of its own; a re-click of the tab refetches, like
 * the other views' refresh-on-open. Save posts {key, value} to POST /api/config-set — the
 * same setConfigKey write path `tumwater config set` uses — and Clear posts {key} to
 * POST /api/config-unset — the same unsetConfigKey write path `tumwater config unset` uses —
 * so the two retract/set halves cannot drift from the CLI. Both flash the same
 * success/error toast pattern the composer's send uses (showFlash). Spliced into
 * gui-client.ts's script, reaching its helpers (esc, $, getJson, postJson, showFlash) through
 * that concatenation. */
export const GUI_CLIENT_SETTINGS_JS = String.raw`  // settings-view:start
  // The curated keys, in display order: [key, label]. Mirrors the server's
  // EDITABLE_CONFIG_KEYS (src/config/config-editable-keys.ts) by hand — the settings test pins
  // this list's keys and order to that constant.
  const SETTINGS_KEYS = [
    ["provider", "Provider"],
    ["model", "Model"],
    ["fallback", "Fallback (free at the spend cap)"],
    ["maxDailyCostUsd", "Daily spend cap (USD)"],
    ["quietHours", "Quiet hours"],
    ["notify", "Notify hook"],
    ["agents", "Agent backends (JSON)"],
  ];
  // One row per key: the current value into an inline field (esc'd, like every rendered
  // value on the page), Save submits the row's form. A null (unset) key renders empty —
  // saving empty then sets the literal empty string, which the per-key validators and
  // validateConfig judge like the CLI's own empty-string set. An object value (the agents
  // section) renders as compact JSON so it can round-trip through the field's text.
  function settingsFieldValue(v) {
    if (v === null || v === undefined) return "";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  function renderSettings(d) {
    return SETTINGS_KEYS.map((k) =>
      "<form class='settings-row' data-key='" + k[0] + "'>" +
      "<label for='set-" + k[0] + "'>" + esc(k[1]) + "<span class='settings-key'>" + k[0] + "</span></label>" +
      "<input class='field' id='set-" + k[0] + "' value='" + esc(settingsFieldValue(d[k[0]])) + "'>" +
      "<button type='submit' class='btn btn-sm'>Save</button>" +
      "<button type='button' class='btn btn-sm rowaction' data-action='unset'>Clear</button>" +
      "</form>").join("");
  }
  // The view's one panel: built once, values fetched on each open of the tab (the boot's
  // switchView calls fetchSettings) — no polling loop of its own.
  function buildSettingsView() {
    buildOnce("settings-view", "<div class='view-head'><div><h1>Settings</h1>" +
      "<p>The fleet-wide settings an operator edits from here; everything else lives in tumwater.json or the CLI.</p></div></div>" +
      "<div class='card' id='settingscard'><div class='empty'>Loading…</div></div>");
  }
  async function fetchSettings() {
    buildSettingsView();
    const card = $("settingscard");
    try {
      renderSettingsPanel(await getJson("/api/config"));
    } catch (err) {
      card.innerHTML = errorPanel("Settings could not load", err, "card empty");
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
    // JSON-or-literal, matching tumwater config set: a field holding 30 or an agents
    // object sends the parsed value; anything else (a model selector like gpt-5) sends the
    // literal string. Without the parse an object field would arrive as a quoted string.
    let value;
    try { value = JSON.parse(input.value); } catch { value = input.value; }
    try {
      const d = await postJson("/api/config-set", { key: key, value: value });
      showFlash(d && d.oldValue === null ? "Saved " + key + " (was unset)" : "Saved " + key);
    } catch (err) {
      showFlash("error: " + (err && err.message ? err.message : String(err)));
    }
  }
  // The row's Clear button: retract the key through /api/config-unset, then refetch so the
  // field repaints with the reverted resolved value (unsetting the daily spend cap restores
  // the default 50, not an empty field). The response's oldValue distinguishes a retraction
  // (present, a null included) from a no-op (absent — the file never held the key).
  async function clearSetting(form) {
    const key = form.dataset.key;
    try {
      const d = await postJson("/api/config-unset", { key: key });
      showFlash(d && d.oldValue !== undefined ? "Unset " + key + " (was " + JSON.stringify(d.oldValue) + ")" : "Nothing to unset for " + key + " — it was already the default");
      await fetchSettings();
    } catch (err) {
      showFlash("error: " + (err && err.message ? err.message : String(err)));
    }
  }
  // settings-view:end
`;
