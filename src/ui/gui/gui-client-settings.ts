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
 * third, "Salvaged patches", lists every workspace patch kept for the operator under
 * `.tumwater/salvage/` (GET /api/salvage, the same collectSalvagePatches the CLI's list prints),
 * each with a View (GET /api/salvage-show, the same read as `tumwater salvage --show <n>`), a
 * two-click Apply (POST /api/salvage-apply, the same operation as
 * `tumwater salvage --apply <n>`) and Drop (POST /api/salvage-drop, the same operation as
 * `tumwater salvage --drop <n>`); a
 * fourth, "Disabled roles", lists every disabled role (GET /api/retire), each with an Enable
 * button (POST /api/role-enable) and — for a role that still keeps worktree/branch leftovers — a
 * two-click Retire button (POST /api/retire); a fifth, "GitHub issues", lists the GitHub-issues
 * mirror (GET /api/issues, the same read `tumwater issues` prints) — never a `gh` call, only the
 * ledger the hourly scan wrote — with the mirror's counts, each issue's trust and mirror state and
 * its age, and no action. */
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
    // The two instance roles' counts (roles.feature/bugfix.instances, 1–8): how many
    // feature/bugfix runs may run at once — the role drawer and config-set edit the same fields.
    ["roles.feature.instances", "Feature role instances"],
    ["roles.bugfix.instances", "Bugfix role instances"],
    ["maxConcurrentChecks", "Max concurrent checks"],
    ["worktreeSlots", "Worktree slots"],
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
      "<div class='card' id='salvagecard'><div class='empty'>Loading…</div></div>" +
      "<div class='card' id='retirecard'><div class='empty'>Loading…</div></div>" +
      "<div class='card' id='briefcard'><div class='empty'>Loading…</div></div>" +
      "<div class='card' id='issuescard'><div class='empty'>Loading…</div></div>");
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
  // The Salvaged patches card: every workspace patch kept for the operator under
  // .tumwater/salvage/ (GET /api/salvage, the same collectSalvagePatches the CLI list prints)
  // as a settings-row each with a View (GET /api/salvage-show, the same read as
  // tumwater salvage --show <n>) and a two-click Apply (POST /api/salvage-apply) and Drop (POST
  // /api/salvage-drop) — the same operations as tumwater salvage --show <n> / --apply <n> /
  // --drop <n>, so an operator watching the dashboard can read and act on a patch without a
  // shell. The single slot is keyed "apply:<n>"/"drop:<n>" per row, so one row's arm never
  // fires another row's button. A read opens in place: salvageOpen holds the one open row's
  // position and its already-built body, and renderSalvage splices that body into the row whose
  // position and file still match it, so the paint stays a pure function of the fetched list
  // plus that one slot.
  let lastSalvage = null;
  let salvageOpen = null;
  const salvageSlot = confirmSlot(paintSalvage);
  function renderSalvage(d, armed, open) {
    const rows = (d.patches || []).map((p) => {
      const applyArmed = armed("apply:" + p.position);
      const dropArmed = armed("drop:" + p.position);
      const isOpen = open !== null && open !== undefined && open.position === p.position &&
        (open.file === null || open.file === p.file);
      return "<div class='settings-row'>" +
        "<strong>" + p.position + ". " + esc(p.file) + "</strong>" +
        "<span>saved " + fmtAgo(p.savedAt) + ", " + esc(p.size) + "</span>" +
        "<button type='button' class='btn btn-sm' data-action='salvage-view' data-position='" + p.position + "'>" +
        (isOpen ? "Hide" : "View") + "</button>" +
        "<button type='button' class='btn btn-sm' data-action='salvage-apply' data-position='" + p.position + "'>" +
        (applyArmed ? "Confirm apply" : "Apply") + "</button>" +
        "<button type='button' class='btn btn-sm' data-action='salvage-drop' data-position='" + p.position + "'>" +
        (dropArmed ? "Confirm drop" : "Drop") + "</button>" +
        (isOpen ? salvageViewHtml(open.body) : "") + "</div>";
    }).join("");
    return "<div class='settings-row'><strong>Salvaged patches</strong><span>Workspace patches kept for you under <code>.tumwater/salvage/</code> — view, apply or drop the same way <code>tumwater salvage</code> does; applying never commits and never deletes the patch.</span></div>" +
      (rows || "<div class='empty'>no salvaged workspace patches are kept for you</div>");
  }
  function paintSalvage() {
    if (lastSalvage) $("salvagecard").innerHTML = renderSalvage(lastSalvage, salvageSlot.armed, salvageOpen);
  }
  async function fetchSalvage() {
    buildSettingsView();
    try {
      lastSalvage = await getJson("/api/salvage");
      paintSalvage();
    } catch (err) {
      $("salvagecard").innerHTML = errorPanel("Salvaged patches could not load", err, "empty");
    }
  }
  // The row's two-click salvage button: the first click arms the row's slot (the card repaints
  // the button as "Confirm apply"/"Confirm drop") and nothing posts; a second click within the
  // confirm window disarms, posts { position } to /api/salvage-<action>, flashes the server's
  // message, and refetches the card. Apply and Drop are one shape differing only by the action
  // token, which drives both the arm key ("<action>:" + position, the same key renderSalvage
  // arms) and the endpoint — so the two arms cannot drift apart on their key or path.
  async function salvageClick(action, position) {
    const key = action + ":" + position;
    if (!salvageSlot.armed(key)) {
      salvageSlot.arm(key);
      return;
    }
    salvageSlot.disarm();
    await postSetting("/api/salvage-" + action, { position: Number(position) }, fetchSalvage, (d) => d.message);
  }
  // The row's Apply button: POST /api/salvage-apply.
  async function salvageApplyClick(position) {
    return salvageClick("apply", position);
  }
  // The row's Drop button: POST /api/salvage-drop.
  async function salvageDropClick(position) {
    return salvageClick("drop", position);
  }
  // The open row's body, built once when the read comes back and spliced in by renderSalvage:
  // the row's own header line ("<n>. <file>", "saved <ago>, <size>") in the card's existing
  // fmtAgo/size wording, the git apply --stat block only when the patch is a real diff, and
  // the patch text itself in the shared <pre class='mono diff'> the log drawer already uses for
  // a body — everything esc'd, so a patch containing markup reaches the DOM as text. A read the
  // server refused (off-list position, vanished file) is the server's own sentence in an empty
  // panel, not a half-built header.
  function salvageViewHtml(body) {
    if (body.error) return "<div class='empty'>" + esc(body.error) + "</div>";
    return "<div class='sub'>" + body.position + ". " + esc(body.file) + " — saved " +
      fmtAgo(body.savedAt) + ", " + esc(body.size) + "</div>" +
      (body.stat ? "<pre class='mono'>" + esc(body.stat) + "</pre>" : "") +
      "<pre class='mono diff'>" + esc(body.patch) + "</pre>";
  }
  // The row's View button: the browser twin of tumwater salvage --show <n> — a read-only GET
  // /api/salvage-show?position=<n> whose reply fills that row's slot. One row is open at a time
  // (opening another closes the open one, and a second click on the open row collapses it
  // without refetching), and the fetched body is kept, so a repaint of the card (an arm, a
  // refetch after an action) does not refetch the patch. A failed read keeps the row open with
  // the server's message, and the row's Apply and Drop buttons are untouched — reading a patch
  // never arms or posts an action.
  async function salvageViewClick(position) {
    const n = Number(position);
    if (salvageOpen !== null && salvageOpen.position === n) {
      salvageOpen = null;
      paintSalvage();
      return;
    }
    try {
      const d = await getJson("/api/salvage-show?position=" + encodeURIComponent(String(n)));
      // A read the endpoint refused (an off-list position, a vanished file) answers 200
      // { ok: false, message } — the same shape apply and drop answer for that case — so its
      // sentence reaches the slot as the error line; a transport failure lands in the catch.
      // The endpoint answers an off-list position or a vanished file 200 { ok: false, message },
      // the shape apply and drop answer for the same case, so that sentence goes in the slot;
      // clientErrorMessage is the one read every message gets here, so the wording cannot drift.
      // The file name travels with the body so a refetch that renumbers the rows (a drop) can
      // never slide one patch's body under another patch's row.
      salvageOpen = d && d.ok === false
        ? { position: n, file: null, body: { error: clientErrorMessage(d) } }
        : { position: n, file: d.file, body: d };
    } catch (err) {
      salvageOpen = { position: n, file: null, body: { error: clientErrorMessage(err) } };
    }
    paintSalvage();
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
    await postSetting("/api/role-enable", { role: role }, fetchRetirable, (d) => d.message);
  }
  // First click arms the role's button; a second within the confirm window posts the retire.
  async function confirmRetire(role) {
    if (!retireSlot.armed(role)) {
      retireSlot.arm(role);
      return;
    }
    retireSlot.disarm();
    await postSetting("/api/retire", { role: role }, fetchRetirable, (d) => d.message);
  }
  // POST one Settings action and flash its outcome, then refetch the card it changed — the
  // try/catch tail every Enable/Retire/Health-button handler shares, so the thrown-error
  // coercion and the success/error wording live in one place. news derives the success line
  // from the endpoint's answer: the default is the team-wide "ok: / error: " prefix, Enable
  // and Retire pass the server's message through verbatim, and Retire-leftovers overrides the
  // none-left fallback. Deliberately not named postAction (gui-client.ts's core helper, which
  // closes menus, refreshes the standing poll, and does not refetch on failure — this one
  // refetches the card its action changed even when the post failed).
  async function postSetting(path, body, refetch, news) {
    try {
      const d = await postJson(path, body);
      showFlash(news ? news(d) : (d.ok ? "" : "error: ") + d.message);
    } catch (err) {
      showFlash("error: " + clientErrorMessage(err));
    }
    await refetch();
  }
  // POST one two-click Health-card action after its slot was armed by a prior click: the first
  // click only arms the slot (the handler's button repaints to "Confirm …") and returns; a
  // second click within the confirm window disarms, repaints, flashes the action line, posts,
  // and re-runs the card's checks. The Health card's four repair buttons (Kill orphans, Drop
  // broken pins, Retire leftovers, Archive backlog) share this one confirm shape: only the slot
  // key, the paint fn, the flash line, the endpoint, and an optional news override (passed
  // through to postSetting, e.g. Retire-leftovers' outcome-line override) differ, so they fold
  // into this one helper instead of four copies of the arm/disarm/paint/flash/postSetting tail.
  async function postConfirmedHealthAction(slot, key, paint, flash, path, news) {
    if (!slot.armed(key)) {
      slot.arm(key);
      return;
    }
    slot.disarm();
    paint();
    showFlash(flash);
    await postSetting(path, {}, fetchDoctor, news);
  }
  // The Health card's Kill orphans button: a two-click confirm, then POST /api/kill-orphans runs
  // the same kill as "tumwater doctor --kill-orphans" and the card re-runs its checks.
  function paintKillButton() {
    const btn = document.querySelector("button[data-action='doctor-kill-orphans']");
    if (btn) btn.textContent = killSlot.armed("orphans") ? "Confirm kill" : "Kill orphans";
  }
  const killSlot = confirmSlot(paintKillButton);
  async function killOrphansClick() {
    await postConfirmedHealthAction(killSlot, "orphans", paintKillButton, "Killing orphaned processes…", "/api/kill-orphans");
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
    await postConfirmedHealthAction(dropSlot, "broken-pins", paintDropButton, "Dropping broken pins…", "/api/doctor-drop-broken-pins");
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
    // The news override's none-left fallback matches the none-left sentence the Health action
    // flashes when nothing is retirable: the shared leftoverRetireLines join is empty when
    // nothing is retirable, so the button falls back to that same sentence.
    await postConfirmedHealthAction(retireLeftoversSlot, "retire-leftovers", paintRetireLeftoversButton, "Retiring every disabled role's leftovers…", "/api/doctor-retire-leftovers",
      (d) => (d.ok ? "" : "error: ") + (d.message || "no leftover roles to retire"));
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
    await postConfirmedHealthAction(archiveBacklogSlot, "archive-backlog", paintArchiveBacklogButton, "Archiving the finished backlog entries…", "/api/doctor-archive-backlog");
  }
  // The Health card's Commit backlog button: a single click, because the commit is the doctor's
  // own recommended repair and is reversible (unlike the two-click Kill orphans arm), POSTing
  // /api/doctor-commit-backlog — the same commitUncommittedBacklog "tumwater doctor
  // --commit-backlog" runs — flashing the shared lines (nothing-to-commit when the checkout is
  // clean), then re-running the checks so the uncommitted-backlog row repaints.
  async function commitBacklogClick() {
    showFlash("Committing the uncommitted backlog/brief files…");
    await postSetting("/api/doctor-commit-backlog", {}, fetchDoctor);
  }
  // The Health card's Re-sync install button: a single click, because the re-sync is the doctor's
  // own recommended repair and is a no-op when the install already matches the lockfile, POSTing
  // /api/doctor-resync-install — the same resyncRootInstall "tumwater doctor --resync-install"
  // runs — flashing the shared line (nothing to re-sync when the tree matches), then re-running
  // the checks so the root-install row and the install amber alert clear once the drift is gone.
  async function resyncInstallClick() {
    showFlash("Re-syncing the root install…");
    await postSetting("/api/doctor-resync-install", {}, fetchDoctor);
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
  // The plain-numeric team rows: for these the browser's JSON.parse below would read an
  // exponent spelling ("2e0" → 2, "1e2" → 100) past the key's numeric check before it ever
  // leaves the browser — the same silent misread the config-set CLI path and
  // the GUI drawers refuse — so refuse it here, naming the row and leaving the field as
  // typed. A non-exponent invalid still goes to the server, whose validateConfig names the
  // key. (The server's own exponent guard cannot see the misread on these rows: by the time
  // the value re-enters setConfigKey it has already been re-encoded from the parsed number.)
  const PLAIN_INTEGER_KEYS = ["maxConcurrent", "roles.feature.instances", "roles.bugfix.instances", "maxConcurrentChecks", "worktreeSlots"];
  // The daily spend cap row: its misread is the dollar-typed one ("1e2" → 100 — a cap no one
  // means), refused with the wording setConfigKey's dollar arm and the cap drawer's
  // parseBudgetField use.
  const PLAIN_DOLLAR_KEYS = ["maxDailyCostUsd"];
  // The one delegated submit listener for the panel: save the row's key with the field's
  // current text, and flash the outcome — "Saved <key>" on 200 (with the old value when the
  // key was unset before), the server's message otherwise. No polling, no repaint: the
  // response's value is already what the field holds.
  async function saveSetting(form) {
    const key = form.dataset.key;
    const input = form.querySelector("input");
    const typed = input.value.trim();
    // The one exponent-shape test the integer and dollar rows share — the browser's mirror of
    // isExponentSpelling (text.ts), which it cannot import.
    const isExponent =
      typed !== "" &&
      !/^\d*\.?\d+$/.test(typed) &&
      /^\d+(\.\d+)?[eE][+-]?\d+$/.test(typed);
    if (isExponent && PLAIN_INTEGER_KEYS.includes(key)) {
      showFlash("error: " + key + " must be a plain integer — no exponent notation (got \"" + typed + "\")");
      return;
    }
    if (isExponent && PLAIN_DOLLAR_KEYS.includes(key)) {
      showFlash("error: " + key + " must be a plain dollar amount like 25, 12.50, or .5 — no +/-, exponent, or hex notation (got \"" + typed + "\")");
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
  // The GitHub issues card: the mirror ledger the hourly scan wrote, through GET /api/issues —
  // the browser twin of tumwater issues, and read-only: it calls no gh (plans/github-issues.md
  // invariant 2 keeps gh inside the scan and the doctor's check) and posts nothing. The header
  // span states the mirror's counts in tumwater issues' own words (plural, "closed by tumwater",
  // "closed upstream") over the whole mirror, never over the rows the endpoint happened to keep —
  // the rule INV-DE3 pins — and each issue is one settings-row: its whole-list position and number,
  // its title linked to GitHub, its trust, its mirror state, and its age in the CLI's three
  // spellings (closed <ago> for a row tumwater closed, last seen open <ago> for one GitHub lost
  // upstream, updated <ago> for a live one). A gh that is not ok gets its own gate line, the same
  // reading the CLI prints. No clock of its own: checkedAt and each row's updatedAt are the only
  // times, and the ages ride the client's fmtAgo like the salvage card's "saved <ago>".
  let lastIssues = null;
  function issuesHeaderSpan(d) {
    if (!d.read) return "";
    const closed = d.closedCount || 0;
    const upstream = d.upstreamClosedCount || 0;
    return esc(d.repo) + (d.branch ? " (" + esc(d.branch) + ")" : "") + ": " +
      plural(d.openCount || 0, "open", "open") +
      (closed > 0 ? ", " + plural(closed, "closed by tumwater", "closed by tumwater") : "") +
      (upstream > 0 ? ", " + plural(upstream, "closed upstream", "closed upstream") : "") +
      ", checked " + fmtAgo(d.checkedAt);
  }
  function issueAgeSpan(r) {
    // The CLI's issueAge spellings, one for each list a row can come from, so the card's age
    // segment reads like the terminal row's. A ledger row whose timestamp GitHub did not supply
    // (or a hand-edited one that is not a date) has no age to name and says so.
    const at = Date.parse(r.updatedAt);
    if (Number.isNaN(at)) {
      if (r.upstreamClosed === true) return "last seen unknown";
      return r.wasClosed === true ? "closed unknown" : "updated unknown";
    }
    if (r.upstreamClosed === true) return "last seen open " + fmtAgo(at);
    if (r.wasClosed === true) return "closed " + fmtAgo(at);
    return "updated " + fmtAgo(at);
  }
  function renderIssues(d) {
    const rows = (d.issues || []).map((r) =>
      "<div class='settings-row'><strong>" + r.position + ". #" + r.number + " " +
      (r.url ? "<a rel='noopener' target='_blank' href='" + esc(r.url) + "'>" + esc(r.title) + "</a>"
        : esc(r.title)) + "</strong>" +
      "<span>" + (r.mirrored ? "mirrored" : "not mirrored") + "</span>" +
      (r.trusted ? "<span>trusted</span>" : "<span class='pill t-amber'>untrusted</span>") +
      "<span>" + issueAgeSpan(r) + "</span></div>").join("");
    // The gh gate line, in the CLI's reading of the stored state: "gh <state>" plus the ledger's
    // reason when it carries one. The card keeps this copy because renderIssues writes terminal
    // text and ghUnreadableSentence (src/github/gh.ts) is not reachable from the bundle.
    const gate = d.read && d.gh && d.gh !== "ok"
      ? "<p class='empty'>gh " + esc(d.gh) + (d.reason ? ": " + esc(d.reason) : "") + "</p>" : "";
    let body;
    if (d.empty) body = "<div class='empty'>the GitHub issues mirror has not been read yet</div>";
    else body = rows || "<div class='empty'>no issues to show</div>";
    return "<div class='settings-row'><strong>GitHub issues</strong><span>" + issuesHeaderSpan(d) +
      "</span></div>" + gate + body;
  }
  function paintIssues() {
    if (lastIssues) $("issuescard").innerHTML = renderIssues(lastIssues);
  }
  async function fetchIssues() {
    buildSettingsView();
    try {
      lastIssues = await getJson("/api/issues");
      paintIssues();
    } catch (err) {
      $("issuescard").innerHTML = errorPanel("GitHub issues could not load", err, "empty");
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
