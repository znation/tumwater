// vocabulary: plain
/** The dashboard's Settings view, browser-side: the curated top-level config keys
 * (EDITABLE_CONFIG_KEYS's set, mirrored here for the labels) as label + current value +
 * inline field + Save + Clear, one row per key (the Notify row also has Send test, which
 * posts to POST /api/notify-test). Values load once through GET /api/config when
 * the view is first opened — no polling loop of its own; a re-click of the tab refetches, like
 * the other views' refresh-on-open. Save posts {key, value} to POST /api/config-set — the
 * same setConfigKey write path `tumwater config set` uses — and Clear posts {key} to
 * POST /api/config-unset — the same unsetConfigKey write path `tumwater config unset` uses —
 * so the two retract/set halves cannot drift from the CLI. Both flash the same
 * success/error toast pattern the composer's send uses (showFlash). Spliced into
 * gui-client.ts's script, reaching its helpers (esc, $, getJson, postJson, showFlash) through
 * that concatenation. A second card, "Health check", runs the same checks as `tumwater doctor`
 * through GET /api/doctor on each open (and on its Re-run button) and paints the report; a
 * third, "Disabled roles", lists retirable leftovers (GET /api/retire) with a two-click Retire
 * button (POST /api/retire). */
export const GUI_CLIENT_SETTINGS_JS = String.raw`  // settings-view:start
  // One home for turning a thrown value into the message a flash shows: the fetch/parse/post
  // helpers throw the server's JSON-decoded value, which for the server's own errors is an
  // {error} object (its message on the .message field) — the three Save/Clear/Brief catch
  // blocks that flash the outcome share this coercion so the wording cannot drift.
  function clientErrorMessage(err) {
    return err && err.message ? err.message : String(err);
  }
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
    ["backends", "Agent backends (JSON)"],
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
      (k[0] === "notify" ? "<button type='button' class='btn btn-sm rowaction' data-action='notify-test' title='Runs the saved hook once with a synthetic merge_failed event'>Send test</button>" : "") +
      "</form>").join("");
  }
  // The view's one panel: built once, values fetched on each open of the tab (the boot's
  // switchView calls fetchSettings) — no polling loop of its own.
  function buildSettingsView() {
    buildOnce("settings-view", "<div class='view-head'><div><h1>Settings</h1>" +
      "<p>The team-wide settings you edit from here; everything else lives in tumwater.json or the CLI.</p></div></div>" +
      "<div class='card' id='settingscard'><div class='empty'>Loading…</div></div>" +
      "<div class='card' id='doctorcard'><div class='settings-row'><strong>Health</strong>" +
      "<span>The same checks as <code>tumwater doctor</code>.</span>" +
      "<button type='button' class='btn btn-sm' data-action='doctor-rerun'>Re-run</button></div>" +
      "<div id='doctorbody'><div class='empty'>Checking…</div></div></div>" +
      "<div class='card' id='retirecard'><div class='empty'>Loading…</div></div>" +
      "<div class='card' id='briefcard'><div class='empty'>Loading…</div></div>");
  }
  // The Health check card's body: header, one row per check (level badge, name, detail), the
  // verdict — everything esc'd. The pill is built inline (gui-client.ts's pill sits outside
  // this region). A missing checks array renders no rows.
  function renderDoctorReport(d) {
    const tones = { ok: "green", warn: "amber", fail: "red" };
    const rows = (Array.isArray(d.checks) ? d.checks : []).map((c) =>
      "<div class='settings-row'><span class='pill t-" + (tones[c.level] || "amber") + "'>" + esc(c.level) + "</span>" +
      "<strong>" + esc(c.name) + "</strong><span>" + esc(c.detail) + "</span></div>").join("");
    return "<p>" + esc(d.header) + "</p>" + rows + "<p>" + esc(d.verdict) + "</p>";
  }
  async function fetchDoctor() {
    buildSettingsView();
    const body = $("doctorbody");
    body.innerHTML = "<div class='empty'>Checking…</div>";
    try {
      body.innerHTML = renderDoctorReport(await getJson("/api/doctor"));
    } catch (err) {
      body.innerHTML = errorPanel("Health checks could not run", err, "empty");
    }
  }
  // The Disabled roles card: roles set to enabled: false that still keep a worktree, branch,
  // merge ref, or paused marker (GET /api/retire), each with a two-click Retire button — the
  // same removal as tumwater retire --role <id>. A role the safety rails object to shows the
  // objections and the CLI's --force command instead: the dashboard never forces.
  let lastRetirable = null;
  const retireSlot = confirmSlot(paintRetirable);
  function renderRetirable(d, armed) {
    const rows = (d.roles || []).map((r) => {
      const head = "<strong>" + esc(r.role) + "</strong><span>would remove " + r.phrases.map(esc).join(", ") + "</span>";
      if (r.objections.length > 0) {
        return "<div class='settings-row'>" + head + r.objections.map((o) => "<span>" + esc(o) + "</span>").join("") +
          "<code>tumwater retire --role " + esc(r.role) + " --force</code></div>";
      }
      return "<div class='settings-row'>" + head + "<button type='button' class='btn btn-sm' data-action='retire' data-role='" + esc(r.role) + "'>" +
        (armed(r.role) ? "Confirm retire" : "Retire") + "</button></div>";
    }).join("");
    return "<div class='settings-row'><strong>Disabled roles</strong><span>Leftovers of roles set to enabled: false — the same removal as " +
      "<code>tumwater retire --role &lt;id&gt;</code>.</span></div>" +
      (rows || "<div class='empty'>No disabled role has anything left to remove.</div>");
  }
  function paintRetirable() {
    if (lastRetirable) $("retirecard").innerHTML = renderRetirable(lastRetirable, retireSlot.armed);
  }
  async function fetchRetirable() {
    buildSettingsView();
    try {
      lastRetirable = await getJson("/api/retire");
      paintRetirable();
    } catch (err) {
      $("retirecard").innerHTML = errorPanel("Disabled roles could not load", err, "empty");
    }
  }
  // First click arms the role's button; a second within the confirm window posts the retire.
  async function confirmRetire(role) {
    if (!retireSlot.armed(role)) {
      retireSlot.arm(role);
      return;
    }
    retireSlot.disarm();
    try {
      const d = await postJson("/api/retire", { role: role });
      showFlash(d.message);
    } catch (err) {
      showFlash("error: " + clientErrorMessage(err));
    }
    await fetchRetirable();
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
      showFlash("error: " + clientErrorMessage(err));
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
      showFlash("error: " + clientErrorMessage(err));
    }
  }
  // The Notify row's Send test button: POST /api/notify-test runs the saved hook once, the same
  // test that "tumwater notify --test" runs. The hook can take up to 10 s, so say so first.
  async function testNotify() {
    showFlash("Sending a test notification…");
    try {
      const d = await postJson("/api/notify-test", {});
      showFlash((d.passed ? "" : "error: ") + d.message);
    } catch (err) {
      showFlash("error: " + clientErrorMessage(err));
    }
  }
  // The Brief card: the brief file's name and the prompt in a textarea, filled from
  // GET /api/brief on each open. The form is deliberately not a settings-row, so the boot's
  // delegated settings submit listener never routes it to saveSetting.
  async function fetchBrief() {
    buildSettingsView();
    const card = $("briefcard");
    try {
      const d = await getJson("/api/brief");
      card.innerHTML = "<form class='brief-form'><strong>Brief</strong> <span class='settings-key'>" + esc(d.file) + "</span>" +
        "<textarea class='field' id='brief-text' rows='12'>" + esc(d.prompt) + "</textarea>" +
        "<button type='submit' class='btn btn-sm'>Save</button></form>";
    } catch (err) {
      card.innerHTML = errorPanel("Brief could not load", err, "empty");
    }
  }
  // Save posts the textarea's text to POST /api/brief — the same checks and commit as
  // tumwater brief --file — and flashes the outcome.
  async function saveBrief(form) {
    try {
      const d = await postJson("/api/brief", { prompt: form.querySelector("textarea").value });
      showFlash(!d.changed ? "Brief unchanged" : d.committed ? "Brief saved (committed to main)" : "Brief saved");
    } catch (err) {
      showFlash("error: " + clientErrorMessage(err));
    }
  }
  // settings-view:end
`;
