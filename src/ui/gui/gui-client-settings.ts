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
 * through GET /api/doctor on each open (and on its Re-run button) and paints the report (its
 * Commit backlog button POSTs /api/doctor-commit-backlog instead, the same commitUncommittedBacklog
 * `tumwater doctor --commit-backlog` runs; its Archive backlog button POSTs
 * /api/doctor-archive-backlog instead, the same archiveFinishedOnMain `tumwater archive` runs); a
 * third, "Disabled roles", lists every disabled role (GET /api/retire), each with an Enable
 * button (POST /api/role-enable) and — for a role that still keeps worktree/branch leftovers — a
 * two-click Retire button (POST /api/retire). */
export const GUI_CLIENT_SETTINGS_JS = String.raw`  // settings-view:start
  // One home for turning a thrown value into the message a flash shows: the fetch/parse/post
  // helpers throw the server's JSON-decoded value, which for the server's own errors is an
  // {error} object (its message on the .message field) — the three Save/Clear/Brief catch
  // blocks that flash the outcome share this coercion so the wording cannot drift.
  function clientErrorMessage(err) {
    return errMessage(err, String(err));
  }
  // The curated keys, in display order: [key, label]. Mirrors the server's
  // EDITABLE_CONFIG_KEYS (src/config/config-editable-keys.ts) by hand — the settings test pins
  // this list's keys and order to that constant.
  const SETTINGS_KEYS = [
    ["provider", "Provider"],
    ["model", "Model"],
    ["fallback", "Fallback (free at the spend cap)"],
    ["maxDailyCostUsd", "Daily spend cap (USD)"],
    ["maxConcurrent", "Max concurrent runs"],
    ["maxConcurrentChecks", "Max concurrent checks"],
    ["worktreeSlots", "Worktree slots"],
    ["claudeWindowReserve", "Claude window reserve (backends.claude.windowReserve)"],
    ["quietHours", "Quiet hours"],
    ["notify", "Notify hook"],
    ["backends", "Agent backends (JSON)"],
    // The no-check alert's surfaced remedy: set check.command here and the alert clears.
    ["check", "Declared check (JSON)"],
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
      "<label><input type='checkbox' data-action='doctor-problems'> Problems only</label>" +
      "<button type='button' class='btn btn-sm' data-action='doctor-rerun'>Re-run</button>" +
      "<button type='button' class='btn btn-sm' data-action='doctor-kill-orphans'>Kill orphans</button>" +
      "<button type='button' class='btn btn-sm' data-action='doctor-drop-broken-pins' title=\"Drops each refs/tumwater/ pin whose commit is gone - the manual git update-ref -d the tumwater pins row names, like tumwater doctor --drop-broken-pins\">Drop broken pins</button>" +
      "<button type='button' class='btn btn-sm' data-action='doctor-commit-backlog' title='Commit each uncommitted tracked backlog or brief file on main, like tumwater doctor --commit-backlog'>Commit backlog</button>" +
      "<button type='button' class='btn btn-sm' data-action='doctor-resync-install' title=\"Re-sync the root checkout's install after a failed post-merge re-sync, like tumwater doctor --resync-install\">Re-sync install</button>" +
      "<button type='button' class='btn btn-sm' data-action='doctor-retire-leftovers' title=\"Retire every disabled role's leftover worktree, branch and merge ref in one pass, like tumwater doctor --retire-leftovers (or tumwater retire --role <id> per role)\">Retire leftovers</button>" +
      "<button type='button' class='btn btn-sm' data-action='doctor-archive-backlog' title=\"Move the finished entries under PLANS.md ## Done and BUGS.md ## Fixed into the archive files and commit them on main, like tumwater archive\">Archive backlog</button></div>" +
      "<div id='doctorbody'><div class='empty'>Checking…</div></div></div>" +
      "<div class='card' id='retirecard'><div class='empty'>Loading…</div></div>" +
      "<div class='card' id='briefcard'><div class='empty'>Loading…</div></div>");
  }
  // The Health check card's body: header, one row per check (level badge, name, detail), the
  // verdict — everything esc'd. The pill is built inline (gui-client.ts's pill sits outside
  // this region). A missing checks array renders no rows. With problems (the Problems only
  // checkbox), only the warn and fail rows render and a hidden-count line names how many ok
  // rows were cut, mirroring tumwater doctor --problems's problemsOnly/renderDoctorProblems.
  function renderDoctorReport(d, problems) {
    const tones = { ok: "green", warn: "amber", fail: "red" };
    const all = Array.isArray(d.checks) ? d.checks : [];
    const checks = problems ? all.filter((c) => c.level !== "ok") : all;
    const hidden = all.length - checks.length;
    const rows = checks.map((c) =>
      "<div class='settings-row'><span class='pill t-" + (tones[c.level] || "amber") + "'>" + esc(c.level) + "</span>" +
      "<strong>" + esc(c.name) + "</strong><span>" + esc(c.detail) + "</span></div>").join("");
    return "<p>" + esc(d.header) + "</p>" + rows +
      (problems && hidden > 0 ? "<p class='empty'>" + plural(hidden, "ok check") + " hidden</p>" : "") +
      "<p>" + esc(d.verdict) + "</p>";
  }
  // The last resolved doctor report and whether the card paints only its problems; the
  // Problems only checkbox toggles the latter and repaints the cached body without rerunning
  // the checks.
  let lastDoctor = null;
  let doctorProblems = false;
  async function fetchDoctor() {
    buildSettingsView();
    const body = $("doctorbody");
    body.innerHTML = "<div class='empty'>Checking…</div>";
    try {
      const report = await getJson("/api/doctor");
      lastDoctor = report;
      body.innerHTML = renderDoctorReport(report, doctorProblems);
    } catch (err) {
      body.innerHTML = errorPanel("Health checks could not run", err, "empty");
    }
  }
  function toggleDoctorProblems(checked) {
    doctorProblems = checked;
    const body = $("doctorbody");
    if (lastDoctor !== null) body.innerHTML = renderDoctorReport(lastDoctor, doctorProblems);
  }
  // The Disabled roles card: every role set to enabled: false (GET /api/retire), each with an
  // Enable button (POST /api/role-enable) and — for a role that still keeps a worktree, branch,
  // merge ref, or paused marker — a two-click Retire button (POST /api/retire), the same removal
  // as tumwater retire --role <id>. A role the safety rails object to shows the objections and
  // the CLI's --force command instead: the dashboard never forces.
  let lastRetirable = null;
  const retireSlot = confirmSlot(paintRetirable);
  function renderRetirable(d, armed) {
    const rows = (d.roles || []).map((r) => {
      const hasLeftovers = (r.wouldRemove || []).length > 0;
      const head = "<strong>" + esc(r.role) + "</strong>" +
        (hasLeftovers ? "<span>would remove " + r.phrases.map(esc).join(", ") + "</span>" : "<span>no leftovers to remove</span>") +
        "<button type='button' class='btn btn-sm' data-action='enable' data-role='" + esc(r.role) + "'>Enable</button>";
      if (r.objections.length > 0) {
        return "<div class='settings-row'>" + head + r.objections.map((o) => "<span>" + esc(o) + "</span>").join("") +
          "<code>tumwater retire --role " + esc(r.role) + " --force</code></div>";
      }
      const retireBtn = hasLeftovers ? "<button type='button' class='btn btn-sm' data-action='retire' data-role='" + esc(r.role) + "'>" +
        (armed(r.role) ? "Confirm retire" : "Retire") + "</button>" : "";
      return "<div class='settings-row'>" + head + retireBtn + "</div>";
    }).join("");
    return "<div class='settings-row'><strong>Disabled roles</strong><span>Roles set to enabled: false — re-enable one, or remove the leftovers " +
      "the same way <code>tumwater retire --role &lt;id&gt;</code> does.</span></div>" +
      (rows || "<div class='empty'>No role is disabled.</div>");
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
  // The row's Enable button: re-enable the role through POST /api/role-enable (writing
  // roles.<base>.enabled), flash the server's message, and refetch so the card drops the row.
  async function enableRole(role) {
    try {
      const d = await postJson("/api/role-enable", { role: role });
      showFlash(d.message);
    } catch (err) {
      showFlash("error: " + clientErrorMessage(err));
    }
    await fetchRetirable();
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
  // The Health card's Kill orphans button: a two-click confirm, then POST /api/kill-orphans runs
  // the same kill as "tumwater doctor --kill-orphans" and the card re-runs its checks.
  function paintKillButton() {
    const btn = document.querySelector("button[data-action='doctor-kill-orphans']");
    if (btn) btn.textContent = killSlot.armed("orphans") ? "Confirm kill" : "Kill orphans";
  }
  const killSlot = confirmSlot(paintKillButton);
  async function killOrphansClick() {
    if (!killSlot.armed("orphans")) {
      killSlot.arm("orphans");
      return;
    }
    killSlot.disarm();
    paintKillButton();
    showFlash("Killing orphaned processes…");
    try {
      const d = await postJson("/api/kill-orphans", {});
      showFlash((d.ok ? "" : "error: ") + d.message);
    } catch (err) {
      showFlash("error: " + clientErrorMessage(err));
    }
    await fetchDoctor();
  }
  // The Health card's Drop broken pins button: a two-click confirm, then POST
  // /api/doctor-drop-broken-pins runs the same drop as "tumwater doctor --drop-broken-pins" and
  // the card re-runs its checks so the tumwater pins row repaints.
  function paintDropButton() {
    const btn = document.querySelector("button[data-action='doctor-drop-broken-pins']");
    if (btn) btn.textContent = dropSlot.armed("broken-pins") ? "Confirm drop" : "Drop broken pins";
  }
  const dropSlot = confirmSlot(paintDropButton);
  async function dropBrokenPinsClick() {
    if (!dropSlot.armed("broken-pins")) {
      dropSlot.arm("broken-pins");
      return;
    }
    dropSlot.disarm();
    paintDropButton();
    showFlash("Dropping broken pins…");
    try {
      const d = await postJson("/api/doctor-drop-broken-pins", {});
      showFlash((d.ok ? "" : "error: ") + d.message);
    } catch (err) {
      showFlash("error: " + clientErrorMessage(err));
    }
    await fetchDoctor();
  }
  // The Health card's Retire leftovers button: a two-click confirm, then POST
  // /api/doctor-retire-leftovers runs the same reap as "tumwater doctor --retire-leftovers" and
  // the card re-runs its checks so the leftover-role-branches row repaints. ok is false when a
  // role's retire was refused, and its lines still flash so the operator sees who was left.
  function paintRetireLeftoversButton() {
    const btn = document.querySelector("button[data-action='doctor-retire-leftovers']");
    if (btn) btn.textContent = retireLeftoversSlot.armed("retire-leftovers") ? "Confirm retire" : "Retire leftovers";
  }
  const retireLeftoversSlot = confirmSlot(paintRetireLeftoversButton);
  async function retireLeftoversClick() {
    if (!retireLeftoversSlot.armed("retire-leftovers")) {
      retireLeftoversSlot.arm("retire-leftovers");
      return;
    }
    retireLeftoversSlot.disarm();
    paintRetireLeftoversButton();
    showFlash("Retiring every disabled role's leftovers…");
    try {
      const d = await postJson("/api/doctor-retire-leftovers", {});
      // The shared leftoverRetireLines join is empty when nothing is retirable, so the
      // button falls back to the same none-left sentence the TUI Health key flashes.
      showFlash((d.ok ? "" : "error: ") + (d.message || "no leftover roles to retire"));
    } catch (err) {
      showFlash("error: " + clientErrorMessage(err));
    }
    await fetchDoctor();
  }
  // The Health card's Archive backlog button: a two-click confirm, then POST
  // /api/doctor-archive-backlog runs the same archive as "tumwater archive" (holding the merge
  // lock) and the card re-runs its checks so the backlog archive row repaints. ok is false
  // when the archive was skipped (an off-base checkout or uncommitted backlog/archive files),
  // and its reason still flashes so the operator sees why nothing moved.
  function paintArchiveBacklogButton() {
    const btn = document.querySelector("button[data-action='doctor-archive-backlog']");
    if (btn) btn.textContent = archiveBacklogSlot.armed("archive-backlog") ? "Confirm archive" : "Archive backlog";
  }
  const archiveBacklogSlot = confirmSlot(paintArchiveBacklogButton);
  async function archiveBacklogClick() {
    if (!archiveBacklogSlot.armed("archive-backlog")) {
      archiveBacklogSlot.arm("archive-backlog");
      return;
    }
    archiveBacklogSlot.disarm();
    paintArchiveBacklogButton();
    showFlash("Archiving the finished backlog entries…");
    try {
      const d = await postJson("/api/doctor-archive-backlog", {});
      showFlash((d.ok ? "" : "error: ") + d.message);
    } catch (err) {
      showFlash("error: " + clientErrorMessage(err));
    }
    await fetchDoctor();
  }
  // The Health card's Commit backlog button: a single click, because the commit is the doctor's
  // own recommended repair and is reversible (unlike the two-click Kill orphans arm), POSTing
  // /api/doctor-commit-backlog — the same commitUncommittedBacklog "tumwater doctor
  // --commit-backlog" runs — flashing the shared lines (nothing-to-commit when the checkout is
  // clean), then re-running the checks so the uncommitted-backlog row repaints.
  async function commitBacklogClick() {
    showFlash("Committing the uncommitted backlog/brief files…");
    try {
      const d = await postJson("/api/doctor-commit-backlog", {});
      showFlash((d.ok ? "" : "error: ") + d.message);
    } catch (err) {
      showFlash("error: " + clientErrorMessage(err));
    }
    await fetchDoctor();
  }
  // The Health card's Re-sync install button: a single click, because the re-sync is the doctor's
  // own recommended repair and is a no-op when the install already matches the lockfile, POSTing
  // /api/doctor-resync-install — the same resyncRootInstall "tumwater doctor --resync-install"
  // runs — flashing the shared line (nothing to re-sync when the tree matches), then re-running
  // the checks so the root-install row and the install amber alert clear once the drift is gone.
  async function resyncInstallClick() {
    showFlash("Re-syncing the root install…");
    try {
      const d = await postJson("/api/doctor-resync-install", {});
      showFlash((d.ok ? "" : "error: ") + d.message);
    } catch (err) {
      showFlash("error: " + clientErrorMessage(err));
    }
    await fetchDoctor();
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
  // The plain-integer team rows (the run-concurrency knobs): for these the browser's
  // JSON.parse below would read an exponent spelling ("2e0" → 2) past validateConfig's
  // integer check before it ever leaves the browser — the same silent misread that the
  // config-set CLI path and the TUI team-key editors refuse — so refuse it here, naming
  // the row and leaving the field as typed. A non-exponent invalid still goes to the
  // server, whose validateConfig names the key.
  const PLAIN_INTEGER_KEYS = ["maxConcurrent", "maxConcurrentChecks", "worktreeSlots"];
  // The one delegated submit listener for the panel: save the row's key with the field's
  // current text, and flash the outcome — "Saved <key>" on 200 (with the old value when the
  // key was unset before), the server's message otherwise. No polling, no repaint: the
  // response's value is already what the field holds.
  async function saveSetting(form) {
    const key = form.dataset.key;
    const input = form.querySelector("input");
    const typed = input.value.trim();
    if (
      PLAIN_INTEGER_KEYS.includes(key) &&
      typed !== "" &&
      !/^\d*\.?\d+$/.test(typed) &&
      /^\d+(\.\d+)?[eE][+-]?\d+$/.test(typed)
    ) {
      showFlash("error: " + key + " must be a plain integer — no exponent notation");
      return;
    }
    // JSON-or-literal, matching tumwater config set: a field holding 30 or an agents
    // object sends the parsed value; anything else (a model selector like gpt-5) sends the
    // literal string. Without the parse an object field would arrive as a quoted string.
    let value;
    try { value = JSON.parse(input.value); } catch { value = input.value; }
    try {
      const d = await postJson("/api/config-set", { key: key, value: value });
      if (d && d.unchanged) showFlash(key + " is already that value — nothing saved");
      else showFlash(d && d.oldValue === null ? "Saved " + key + " (was unset)" : "Saved " + key);
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
