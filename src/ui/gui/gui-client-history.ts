/** The dashboard's History view, browser-side: every completed run, newest first, as
 * /api/history serves them (the rows `tumwater history` prints). A toolbar narrows it to one
 * role (server-side, so a quiet role still gets its full count), searches the rendered row text
 * (server-side, through the same haystack rule `tumwater history --grep` uses), to an outcome
 * class (changes, no change, problems — client-side over the fetched rows), and picks how many
 * runs to fetch or a trailing window matching `tumwater history --since`; ◀ Earlier / Later ▶
 * step that window back by its own length (`--since --until`). It refetches when the
 * view opens and, while it stays open, whenever the status poll sees new events — never on a
 * timer of its own. A row opens that role's drawer. Spliced into gui-client.ts's script,
 * reaching its helpers (esc, getJson, resultInfo, the formatters) through that concatenation. */
export const GUI_CLIENT_HISTORY_JS = String.raw`  // The counts the "Runs to show" picker offers; the recalled count is normalized to one of
  // them at read, so the picker can always represent (and the request always matches) the scope.
  const HIST_COUNTS = [20, 50, 100, 200];
  let histRole = recall("hist-role") || "";
  let histCount = HIST_COUNTS.includes(Number(recall("hist-n"))) ? Number(recall("hist-n")) : 50;
  let histGrep = recall("hist-grep") || "";
  let histSinceKey = recall("hist-since") || "";
  let histModel = ""; // view state, not persisted: set by clicking a By model row
  let histStep = 0; // view state, not persisted: how many window lengths back the window ends
  let histNote = "";
  let histFilter = "all";
  const m = recall("hist-mode");
  let histMode = m === "summary" || m === "models" ? m : "table";
  let histRows = null;
  let histSummary = null;
  let histModelSummary = null;
  let histFetchedAt = 0;
  const HIST_FILTERS = [["all", "All"], ["changes", "Changes"], ["none", "No change"], ["refused", "Refused"], ["problems", "Problems"]];
  const HIST_MODES = [["table", "Table"], ["summary", "Summary"], ["models", "By model"]];
  function buildHistoryView() {
    if (!buildOnce("history", "<div class='view-head'><div><h1>History</h1><p>Every completed run, newest first.</p></div>" +
      "<div class='toolbar'>" +
      "<label><span class='sr-only'>Role</span><select class='field' id='histrole'><option value=''>All roles</option></select></label>" +
      "<button type='button' class='btn btn-sm' id='histmodel' style='display:none'></button>" +      "<div class='seg' id='histfilter'>" + HIST_FILTERS.map((f) => "<button type='button' data-hist='" + f[0] + "'>" + f[1] + "</button>").join("") + "</div>" +
      "<div class='seg' id='histsum'>" + HIST_MODES.map((m) => "<button type='button' data-histsum='" + m[0] + "'>" + m[1] + "</button>").join("") + "</div>" +
      "<label><span class='sr-only'>Search</span><input class='field' id='histgrep' type='search' placeholder='Search runs…' autocomplete='off'></label>" +
      "<label><span class='sr-only'>Runs to show</span><select class='field' id='histcount'>" +
      HIST_COUNTS.map((n) => "<option value='" + n + "'>Last " + n + "</option>").join("") +
      histWindowOptions() + "</select></label>" +
      "<span id='histstep' style='display:none'><button type='button' class='btn btn-sm' id='histearlier'>◀ Earlier</button><button type='button' class='btn btn-sm' id='histlater'>Later ▶</button></span>" +
      "<button type='button' class='btn btn-sm' id='histnewest'>Newest failure</button>" +
      "<button type='button' class='btn btn-sm' id='histrefresh'>" + icon("refresh") + "Refresh</button>" +
      "</div></div><div class='card' id='histbody'><div class='empty'>Loading…</div></div>")) return;
    $("histcount").value = HIST_WINDOWS[histSinceKey] ? histSinceKey : String(histCount);
    $("histgrep").value = histGrep;
    $("histrole").addEventListener("change", (ev) => {
      histRole = ev.target.value;
      store("hist-role", histRole);
      fetchHistory();
    });
    $("histmodel").addEventListener("click", () => {
      histModel = "";
      fetchHistory();
    });
    $("histgrep").addEventListener("change", (ev) => {
      histGrep = ev.target.value.trim();
      store("hist-grep", histGrep);
      fetchHistory();
    });
    $("histcount").addEventListener("change", (ev) => {
      const v = ev.target.value;
      if (HIST_WINDOWS[v]) {
        histSinceKey = v;
      } else {
        histSinceKey = "";
        histCount = Number(v) || 50;
        store("hist-n", String(histCount));
      }
      store("hist-since", histSinceKey);
      histStep = 0;
      fetchHistory();
    });
    $("histfilter").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-hist]");
      if (!b) return;
      histFilter = b.dataset.hist;
      renderHistory();
    });
    $("histsum").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-histsum]");
      if (!b) return;
      histMode = b.dataset.histsum;
      store("hist-mode", histMode);
      renderHistory();
    });
    $("histearlier").addEventListener("click", () => {
      histStep += 1;
      fetchHistory();
    });
    $("histlater").addEventListener("click", () => {
      histStep = Math.max(0, histStep - 1);
      fetchHistory();
    });
    $("histrefresh").addEventListener("click", () => fetchHistory());
    $("histnewest").addEventListener("click", () => openHistNewest());
    // The drill-down's details toggle: the button alone expands or collapses (the row's own
    // click still opens the drawer — gui-client-boot's data-open handler skips clicks on a
    // data-rundetail button).
    // A By model row's label drills into that model's runs: the table, filtered to the selector.
    $("histbody").addEventListener("click", (ev) => {
      const b = ev.target instanceof Element ? ev.target.closest("button[data-histmodel]") : null;
      if (!b) return;
      histModel = b.dataset.histmodel;
      histMode = "table";
      store("hist-mode", "table");
      fetchHistory();
    });
    $("histbody").addEventListener("click", (ev) => {
      const b = ev.target instanceof Element ? ev.target.closest("button[data-rundetail]") : null;
      if (!b) return;
      toggleHistDetail(b.dataset.role, b.dataset.run);
    });
    // The drill-down's revert buttons: the first click previews, the preview's own button commits.
    $("histbody").addEventListener("click", (ev) => {
      const b = ev.target instanceof Element ? ev.target.closest("button[data-hist-revert], button[data-hist-revert-go]") : null;
      if (!b) return;
      if (b.dataset.histRevertGo !== undefined) runHistRevert(b.dataset.histRevertGo);
      else previewHistRevert(b.dataset.histRevert);
    });
    // The drill-down's "Show patch" / "Hide patch" button.
    $("histbody").addEventListener("click", (ev) => {
      const b = ev.target instanceof Element ? ev.target.closest("button[data-hist-patch]") : null;
      if (!b) return;
      toggleHistPatch(b.dataset.histPatch);
    });
    // The drill-down's "Show transcript" / "Hide transcript" button.
    $("histbody").addEventListener("click", (ev) => {
      const b = ev.target instanceof Element ? ev.target.closest("button[data-hist-transcript]") : null;
      if (!b) return;
      toggleHistTranscript(b.dataset.histTranscript);
    });
    // The open transcript's "Show prompts" / "Hide prompts" button.
    $("histbody").addEventListener("click", (ev) => {
      const b = ev.target instanceof Element ? ev.target.closest("button[data-hist-transcript-prompts]") : null;
      if (!b) return;
      toggleHistTranscriptPrompts(b.dataset.histTranscriptPrompts);
    });
    // The open transcript's search box (applied on Enter or blur: the card re-renders each change).
    $("histbody").addEventListener("change", (ev) => {
      const el = ev.target instanceof Element ? ev.target.closest("input[data-hist-transcript-grep]") : null;
      if (el) searchHistTranscript(el.dataset.histTranscriptGrep, el.value);
    });
    // The pinned newest-failure card's × closes it.
    $("histbody").addEventListener("click", (ev) => {
      const b = ev.target instanceof Element ? ev.target.closest("button[data-hist-newest-close]") : null;
      if (!b) return;
      closeHistNewest();
    });
  }
  // history-detail:start
  // Run drill-down state: one open card at a time, keyed "role#run", with each key's cache
  // entry — { state: "loading" } while its fetch is in flight, { state: "error", message }
  // when one failed, { state: "ok", text, stat, revertSha, hasCommit, patch?, transcript?,
  // revert? } once /api/run answered — hasCommit is whether the run pinned a commit (the Show
  // patch button's gate), patch the button's sub-state
  // { state: loading | ok | error, text?, message?, open? }, transcript the Show transcript
  // button's sub-state, shaped like patch's (shown on every ok card, commit or not), with
  // optional { prompts?, promptText?, promptsLoading?, promptsError? } for the Show prompts
  // button (the transcript reloaded with each run's prompt) and { grep?, grepText?, grepLoading?,
  // grepError? } for the search box (the server-filtered text while set, cleared by the prompts
  // toggle), revertSha
  // is the full sha of the change on main (null when none), revert the revert button's
  // sub-state { state: previewing | preview | reverting | done | error, preview?, message? }.
  // Cached until the view refetches (fetchHistory clears the map), so collapsing and
  // re-expanding reuses the card.
  const histDetails = new Map();
  let histDetailOpen = "";
  function histDetailKey(role, run) {
    return role + "#" + run;
  }
  // The pinned newest-failure card: the Newest failure toolbar button opens the team's newest
  // failing run (GET /api/run?last=1&result=problems, no role — the role-less last endpoint)
  // as a card above the table, regardless of the current role, window or count, and its ×
  // closes it. histNewest is { state: loading | ok | error, key?, message? }; the ok entry's
  // key is the run's real "role#run", whose card lives in histDetails like any row's so its
  // patch/transcript/revert buttons work, and a refresh or role/window/count change drops it
  // together with the drill-down cache (fetchHistory resets it).
  let histNewest = null;
  async function openHistNewest() {
    histNewest = { state: "loading" };
    renderHistory();
    try {
      const d = await getJson("/api/run?last=1&result=problems");
      // Name the endpoint and the run it answered for: a 200 without a text or role field is a
      // server too old (or too new) for this dashboard's client, not a lost run.
      if (!d || typeof d.text !== "string" || typeof d.role !== "string")
        throw new Error(
          "/api/run answered the newest failing run without a text field — the running tumwater may not match this dashboard",
        );
      const key = histDetailKey(d.role, d.run);
      histDetails.set(key, { state: "ok", text: d.text, stat: typeof d.stat === "string" ? d.stat : "", revertSha: typeof d.revertSha === "string" ? d.revertSha : null, hasCommit: d.hasCommit === true });
      histNewest = { state: "ok", key };
    } catch (err) {
      histNewest = { state: "error", message: err && err.message ? err.message : "Newest failure unavailable" };
    }
    renderHistory();
  }
  function closeHistNewest() {
    histNewest = null;
    renderHistory();
  }
  // The pinned card's markup; empty when no newest card is open. The ok card reuses the shared
  // histDetailCardHtml, so its patch/transcript/revert buttons and their sub-states behave as
  // they do for a row card.
  function histNewestHtml() {
    if (!histNewest) return "";
    if (histNewest.state === "loading") return "<div class='empty'>Loading newest failure…</div>";
    if (histNewest.state === "error") return "<div class='empty'><strong>Newest failure unavailable</strong>" + esc(histNewest.message) + "</div>";
    return "<div class='hist-newest'><div class='hist-detail-head mono'>Newest failure of any role <button type='button' class='btn btn-sm' data-hist-newest-close='1' title='Close'>×</button></div>" +
      histDetailCardHtml(histDetails.get(histNewest.key), histNewest.key) + "</div>";
  }
  // The expanded card's markup from its cache entry. The state is checked explicitly, in
  // loading → error → ok order, so a placeholder can never fall into the fetched path and
  // render as an empty trail: an absent or loading entry shows the Loading… placeholder, an
  // errored fetch shows the server's message, and a fetched one shows the summary header plus
  // the run's events exactly as the server pre-rendered them (renderRunDetail's output —
  // the tumwater history <role> <n> rendering).
  // The revert control under a card whose run's change is on main: the button, then the sub-state
  // — a preview (subject, paths, and a Revert button only when it applies on a clean checkout),
  // the server's message once done, or its error.
  function histRevertHtml(entry, key) {
    const r = entry.revert || {};
    const s = r.state;
    let out = "<button type='button' class='btn btn-sm' data-hist-revert='" + esc(key) + "'>Revert this change…</button>";
    if (s === "previewing") out += " <span class='muted'>Checking…</span>";
    else if (s === "reverting") out += " <span class='muted'>Reverting…</span>";
    else if (s === "done" || s === "error") out += "<div class='" + (s === "error" ? "err" : "muted") + "'>" + esc(r.message || "") + "</div>";
    else if (s === "preview" && r.preview) {
      const p = r.preview;
      const on = "on " + p.primary + " (HEAD " + shortSha(p.head) + "); nothing was written";
      out += "<div class='hist-revert-preview'><div class='mono'>would revert " + esc(shortSha(p.sha)) + " " + esc(p.subject) + "</div><ul>" +
        (p.paths || []).map((x) => "<li class='mono'>" + esc(x) + "</li>").join("") + "</ul>";
      if (!p.applies) out += "<div>would conflict " + esc(on) + "</div>";
      else if (p.dirty) out += "<div>the checkout has staged or unstaged changes, so tumwater revert would refuse until they are committed or stashed; nothing was written</div>";
      else out += "<div>applies cleanly " + esc(on) + "</div><button type='button' class='btn btn-sm btn-danger' data-hist-revert-go='" + esc(key) + "'>Revert</button>";
      out += "</div>";
    }
    return out;
  }
  // Run one revert step for the card at key ("role#run"): set the sub-state, repaint, post, and
  // store the outcome. A reply with an error (a 4xx body) or no JSON becomes the error state.
  async function histRevertStep(key, dryRun) {
    const entry = histDetails.get(key);
    if (!entry || entry.state !== "ok" || !entry.revertSha) return;
    entry.revert = { state: dryRun ? "previewing" : "reverting" };
    renderHistory();
    try {
      const d = await postJson("/api/revert", dryRun ? { sha: entry.revertSha, dryRun: true } : { sha: entry.revertSha });
      if (!d || d.error || !d.ok) entry.revert = { state: "error", message: (d && d.error) || "the revert did not answer" };
      else if (dryRun) entry.revert = { state: "preview", preview: d.preview };
      else entry.revert = { state: "done", message: d.message || "reverted" };
    } catch (err) {
      entry.revert = { state: "error", message: err && err.message ? err.message : "the revert failed" };
    }
    renderHistory();
  }
  function previewHistRevert(key) {
    return histRevertStep(key, true);
  }
  function runHistRevert(key) {
    return histRevertStep(key, false);
  }
  // The Show/Hide patch button under a card whose run pinned a commit, then the sub-state: the
  // loading note, the error message, or the patch itself while open.
  // The shared header of a card add-on (patch or transcript): the Show/Hide button, the
  // Loading span and the error div, all driven by the field's three-state record. Returns
  // the built prefix plus whether the field is showing, so the caller appends its own
  // detail body (the patch/transcript pre) only while the field is open — kind is the field
  // name, the data-hist-<kind> button hint and the user-facing label, so the two cards
  // cannot drift their header.
  function histFieldScaffoldHtml(kind, field, key) {
    const label = field.state === "ok" && field.open ? "Hide " + kind : "Show " + kind;
    let out = "<button type='button' class='btn btn-sm' data-hist-" + kind + "='" + esc(key) + "'>" + label + "</button>";
    if (field.state === "loading") out += " <span class='muted'>Loading " + kind + "…</span>";
    else if (field.state === "error") out += "<div class='err'>" + esc(field.message || "the " + kind + " failed to load") + "</div>";
    return { out, open: field.state === "ok" && field.open };
  }
  function histPatchHtml(entry, key) {
    const p = entry.patch || {};
    const base = histFieldScaffoldHtml("patch", p, key);
    if (base.open) base.out += "<pre class='mono hist-detail-patch'>" + esc(p.text) + "</pre>";
    return base.out;
  }
  // Fetch or toggle one card add-on field (the patch or the transcript) at key ("role#run").
  // kind is the field name, the "&kind=1" query the /api/run reply answers, and the field
  // read off it, so the patch and transcript cannot drift their fetch/toggle shape: flip a
  // loaded one, else fetch it once (an errored one refetches) and repaint around the request.
  async function toggleHistDetailField(key, kind) {
    const entry = histDetails.get(key);
    if (!entry || entry.state !== "ok") return;
    const field = entry[kind];
    if (field && field.state === "ok") {
      field.open = !field.open;
      renderHistory();
      return;
    }
    if (field && field.state === "loading") return;
    const at = key.lastIndexOf("#");
    entry[kind] = { state: "loading" };
    renderHistory();
    try {
      const d = await getJson(
        "/api/run?role=" + encodeURIComponent(key.slice(0, at)) + "&run=" + encodeURIComponent(key.slice(at + 1)) + "&" + kind + "=1",
      );
      if (!d || typeof d[kind] !== "string") throw new Error("/api/run answered without a " + kind + " field");
      entry[kind] = { state: "ok", text: d[kind], open: true };
    } catch (err) {
      entry[kind] = { state: "error", message: err && err.message ? err.message : "the " + kind + " failed to load" };
    }
    renderHistory();
  }
  // Toggle the patch for the card at key ("role#run") through the shared field fetcher.
  function toggleHistPatch(key) {
    return toggleHistDetailField(key, "patch");
  }
  // The Show/Hide transcript button, then its sub-state, through the shared scaffold.
  function histTranscriptHtml(entry, key) {
    const t = entry.transcript || {};
    const base = histFieldScaffoldHtml("transcript", t, key);
    if (base.open) {
      base.out += " <button type='button' class='btn btn-sm' data-hist-transcript-prompts='" + esc(key) + "'>" + (t.prompts ? "Hide prompts" : "Show prompts") + "</button>";
      if (t.promptsLoading) base.out += " <span class='muted'>Loading prompts…</span>";
      if (t.promptsError) base.out += "<div class='err'>" + esc(t.promptsError) + "</div>";
      base.out += " <input type='search' class='field' data-hist-transcript-grep='" + esc(key) + "' placeholder='Search transcript' aria-label='Search transcript' autocomplete='off' value='" + esc(t.grep || "") + "'>";
      if (t.grepLoading) base.out += " <span class='muted'>Searching transcript…</span>";
      if (t.grepError) base.out += "<div class='err'>" + esc(t.grepError) + "</div>";
      base.out += "<pre class='mono hist-detail-transcript'>" + esc(t.grep && typeof t.grepText === "string" ? t.grepText : t.prompts ? t.promptText : t.text) + "</pre>";
    }
    return base.out;
  }
  // Toggle the transcript for the card at key ("role#run"), the way toggleHistPatch does the
  // patch, through the shared toggleHistDetailField helper.
  function toggleHistTranscript(key) {
    return toggleHistDetailField(key, "transcript");
  }
  function clearHistTranscriptGrep(t) {
    delete t.grep;
    delete t.grepText;
    delete t.grepLoading;
    delete t.grepError;
  }
  // Narrow the open transcript to the entries containing value, server-side (&grep=); blank clears.
  async function searchHistTranscript(key, value) {
    const entry = histDetails.get(key);
    if (!entry || entry.state !== "ok") return;
    const t = entry.transcript;
    if (!t || t.state !== "ok" || !t.open) return;
    const grep = String(value ?? "").trim();
    if (grep === "") {
      clearHistTranscriptGrep(t);
      renderHistory();
      return;
    }
    t.grep = grep;
    t.grepLoading = true;
    delete t.grepText;
    delete t.grepError;
    renderHistory();
    const at = key.lastIndexOf("#");
    try {
      const d = await getJson(
        "/api/run?role=" + encodeURIComponent(key.slice(0, at)) + "&run=" + encodeURIComponent(key.slice(at + 1)) + "&transcript=1" + (t.prompts ? "&prompt=1" : "") + "&grep=" + encodeURIComponent(grep),
      );
      if (entry.transcript !== t || t.grep !== grep) return;
      if (!d || typeof d.transcript !== "string") throw new Error("/api/run answered without a transcript field");
      t.grepText = d.transcript;
    } catch (err) {
      if (entry.transcript !== t || t.grep !== grep) return;
      t.grepError = err && err.message ? err.message : "the search failed";
    }
    delete t.grepLoading;
    renderHistory();
  }
  // Toggle the open transcript between plain and with-prompts; the prompts text is fetched once.
  async function toggleHistTranscriptPrompts(key) {
    const entry = histDetails.get(key);
    if (!entry || entry.state !== "ok") return;
    const t = entry.transcript;
    if (!t || t.state !== "ok" || !t.open || t.promptsLoading) return;
    clearHistTranscriptGrep(t);
    if (typeof t.promptText === "string") {
      t.prompts = !t.prompts;
      renderHistory();
      return;
    }
    const at = key.lastIndexOf("#");
    t.promptsLoading = true;
    delete t.promptsError;
    renderHistory();
    try {
      const d = await getJson(
        "/api/run?role=" + encodeURIComponent(key.slice(0, at)) + "&run=" + encodeURIComponent(key.slice(at + 1)) + "&transcript=1&prompt=1",
      );
      if (!d || typeof d.transcript !== "string") throw new Error("/api/run answered without a transcript field");
      t.promptText = d.transcript;
      t.prompts = true;
    } catch (err) {
      t.promptsError = err && err.message ? err.message : "the prompts failed to load";
    }
    delete t.promptsLoading;
    renderHistory();
  }
  function histDetailCardHtml(entry, key) {
    const state = entry && entry.state;
    if (!state || state === "loading") return "<div class='empty'>Loading run detail…</div>";
    if (state === "error") return "<div class='empty'><strong>" + esc(entry.message || "Run detail unavailable") + "</strong></div>";
    const lines = String(entry.text || "").split("\n");
    const head = lines.shift() || "";
    const trail = lines.join("\n");
    return "<div class='hist-detail'><div class='hist-detail-head mono'>" + esc(head) + "</div>" +
      (trail ? "<pre class='mono'>" + esc(trail) + "</pre>" : "<div class='empty'>No events in this run's block.</div>") +
      (entry.stat ? "<pre class='mono hist-detail-stat'>" + esc(entry.stat) + "</pre>" : "") +
      (entry.hasCommit === true ? histPatchHtml(entry, key) : "") +
      histTranscriptHtml(entry, key) +
      (entry.revertSha ? histRevertHtml(entry, key) : "") +
      "</div>";
  }
  // Expand or collapse one row's card. Opening fetches the trail on first expand only — an
  // already-cached entry (ok or error) is reused, and a re-expand while the fetch is in flight
  // leaves that fetch to finish. The loading entry is installed and painted synchronously
  // (renderHistory below), so the placeholder shows while the request runs.
  function toggleHistDetail(role, run) {
    const key = histDetailKey(role, run);
    histDetailOpen = histDetailOpen === key ? "" : key;
    if (histDetailOpen) fetchHistDetail(role, run);
    renderHistory();
  }
  async function fetchHistDetail(role, run) {
    const key = histDetailKey(role, run);
    const prev = histDetails.get(key);
    if (prev && prev.state !== "loading") return; // cached until the view refetches
    // The loading entry is the synchronous prefix: it is set before toggleHistDetail's
    // renderHistory paints, so the card shows the Loading… placeholder while the request runs
    // (and a re-expand during flight sees it and lets the first fetch finish).
    histDetails.set(key, { state: "loading" });
    try {
      const d = await getJson("/api/run?role=" + encodeURIComponent(role) + "&run=" + encodeURIComponent(String(run)));
      // Name the endpoint, the run it answered for, and the likely cause: a 200 without
      // text is a server too old (or too new) for this dashboard's client, not a lost run —
      // a 404 already answers that shape with the CLI's own not-found wording.
      if (!d || typeof d.text !== "string")
        throw new Error(
          "/api/run answered " + role + " run " + run + " without a text field — the running tumwater may not match this dashboard",
        );
      histDetails.set(key, { state: "ok", text: d.text, stat: typeof d.stat === "string" ? d.stat : "", revertSha: typeof d.revertSha === "string" ? d.revertSha : null, hasCommit: d.hasCommit === true });
    } catch (err) {
      histDetails.set(key, { state: "error", message: err && err.message ? err.message : "Run detail unavailable" });
    }
    renderHistory();
  }
  // history-detail:end
  // The role picker's options follow the team's role list (custom roles included), keyed so a
  // poll with no roster change repaints nothing. A role the team dropped falls back to All
  // roles and persists, exactly as syncRolePicker does for the report and Activity pickers.
  function syncHistoryRoles(d) {
    if (!d) return;
    histRole = syncRolePicker("histrole", (d.roles || []).map((l) => l.role), histRole, "hist-role");
  }
  async function fetchHistory(throttled) {
    if (throttled && Date.now() - histFetchedAt < 4000) return;
    histFetchedAt = Date.now();
    buildHistoryView();
    syncHistoryRoles(lastStatus);
    try {
      const d = await getJson(historyQuery(histCount, histRole, histSinceKey, histGrep, histModel, histStep));
      histRows = d && Array.isArray(d.rows) ? d.rows : [];
      // The summary rides the same fetch (the endpoint folds the exact rows it served into
      // its additive summary), so toggling to Summary never refetches; a server too old to
      // include it leaves histSummary null and the toggle falls back to the table.
      histSummary = d && d.summary && Array.isArray(d.summary.roles) ? d.summary : null;
      histModelSummary = d && d.modelSummary && Array.isArray(d.modelSummary.models) ? d.modelSummary : null;
      // The trailing-window shape carries the server's coverage; the count shape has no note.
      histNote = d && typeof d.note === "string" ? d.note : "";
      // A refetch invalidates the drill-down cache: cached trails could disagree with the new
      // rows, and an open card's run may no longer be among them — close it; the next expand
      // refetches.
      histDetails.clear();
      histDetailOpen = "";
      histNewest = null;
    } catch (err) {
      $("histbody").innerHTML = errorPanel("History unavailable", err);
      return;
    }
    renderHistory();
  }
  // history-table:start
  // The trailing-window choices the toolbar's #histcount select grows after the run counts:
  // key → [milliseconds, phrase]. historyQuery turns a key into the endpoint URL, so the
  // browser and the CLI's history --since ask for the same window by construction. The phrase
  // names the window in the empty state.
  const HIST_WINDOWS = { "1h": [3_600_000, "the last hour"], "6h": [21_600_000, "the last 6 hours"], "1d": [86_400_000, "the last day"], "7d": [604_800_000, "the last 7 days"] };
  // The /api/history URL for the current toolbar: the trailing-window shape when a window key
  // is set, the count shape otherwise, role and grep appended only when chosen. summary=1 rides
  // every ask — the endpoint's additive summary folds the exact served rows, so the Summary
  // mode renders from already-fetched data and the toggle swaps only the body.
  function historyQuery(count, role, sinceKey, grep, model, step) {
    const w = HIST_WINDOWS[sinceKey];
    const win = w && step > 0 ? "/api/history?sinceMs=" + (step + 1) * w[0] + "&untilMs=" + step * w[0] : w ? "/api/history?sinceMs=" + w[0] : null;
    return (win || "/api/history?n=" + count) + (role ? "&role=" + encodeURIComponent(role) : "") + (grep ? "&grep=" + encodeURIComponent(grep) : "") + (model ? "&model=" + encodeURIComponent(model) : "") + "&summary=1";
  }
  // The server's LOGS_SINCE_MAX_MS (src/events/event-window.ts), the cap /api/history's sinceMs
  // rides; the two must agree (a test pins it).
  const HIST_MAX_MS = 604_800_000;
  // A whole-hour length as "1 day"/"N days" when it is a whole number of days, else hours.
  function histSpan(ms) {
    const d = ms % 86_400_000 === 0;
    const n = d ? ms / 86_400_000 : ms / 3_600_000;
    return n + (d ? " day" : " hour") + (n === 1 ? "" : "s");
  }
  // Whether the window can step one more length back: the next earlier window's sinceMs must
  // stay under the server's cap.
  function histCanStepEarlier(sinceKey, step) {
    const w = HIST_WINDOWS[sinceKey];
    return Boolean(w) && (step + 2) * w[0] <= HIST_MAX_MS;
  }
  // The window in words: the trailing phrase at step 0, else the bounds in cmdLogs' wording.
  function histWindowPhrase(sinceKey, step) {
    const w = HIST_WINDOWS[sinceKey];
    if (!w) return "";
    return step ? "between " + histSpan((step + 1) * w[0]) + " and " + histSpan(step * w[0]) + " ago" : w[1];
  }
  // The note above a stepped window's table; empty at step 0 or for an unknown key.
  function historyStepHtml(sinceKey, step) {
    return step && HIST_WINDOWS[sinceKey] ? "<p class='muted window-note'>Showing runs " + histWindowPhrase(sinceKey, step) + ".</p>" : "";
  }
  // The window options, the phrase capitalized for the select ("The last day").
  function histWindowOptions() {
    return Object.keys(HIST_WINDOWS).map((k) => {
      const label = HIST_WINDOWS[k][1];
      return "<option value='" + k + "'>" + label.charAt(0).toUpperCase() + label.slice(1) + "</option>";
    }).join("");
  }
  // The server's sparse-window note above the table; empty for no note.
  function historyNoteHtml(note) {
    return note ? "<p class='muted window-note'>" + esc(note) + "</p>" : "";
  }
  // Which outcome class a run result falls in — the History filter's buckets.
  function historyClass(result) {
    if (result === "changed" || result === "queued") return "changes";
    if (result === "no_change" || result === "skipped" || result === "user_aborted") return "none";
    if (result === "refused") return "refused";
    return "problems";
  }
  // The History table for rows (/api/history's, newest first) under a grep (already applied
  // server-side) and an outcome filter; known is
  // the set of the team's role ids, whose rows open that role's drawer. Pure — the view's
  // render paints what this returns.
  function historyTableHtml(rows, filter, known, grep, sinceKey, model, step) {
    const shown = (rows || []).filter((r) => filter === "all" || historyClass(r.result) === filter);
    if (!shown.length) {
      const hasRows = Boolean(rows && rows.length);
      if (hasRows)
        return "<div class='empty'><strong>No runs match this filter</strong>Try another outcome or role.</div>";
      if (model)
        return "<div class='empty'><strong>No runs on this model</strong>Clear the model chip to see every run.</div>";
      if (grep)
        return "<div class='empty'><strong>No runs match this search</strong>Try another search.</div>";
      const w = HIST_WINDOWS[sinceKey];
      return w
        ? "<div class='empty'><strong>No runs " + (step ? histWindowPhrase(sinceKey, step) : "in " + w[1]) + "</strong>The window may have had nothing to do, or its older events may have rotated out.</div>"
        : "<div class='empty'><strong>No runs yet</strong>Completed runs show up here as the roles work.</div>";
    }
    return "<div class='table-wrap'><table class='table history'><thead><tr><th class='c-x'></th><th>When</th><th>Role</th><th class='c-run num'>Run</th>" +
      "<th>Result</th><th class='c-model'>Model</th><th class='c-detail'>Detail</th><th class='num c-dur'>Took</th><th class='num c-usage'>Usage</th></tr></thead><tbody>" +
      shown.map((r) => {
        const res = resultInfo(r.result);
        // The drill-down toggle rides the drawer's button style and lives in its own leading
        // cell; only a team role's row carries one, the same rows that open the drawer (the
        // /api/run endpoint validates the role, so an id the config no longer knows would
        // only ever answer 400).
        const key = histDetailKey(r.role, r.run);
        const open = histDetailOpen === key;
        const toggle = known.has(r.role)
          ? "<button type='button' class='btn btn-sm hist-x' data-rundetail='1' data-role='" + esc(r.role) +
            "' data-run='" + esc(r.run) + "' aria-expanded='" + open + "' title='" + (open ? "Hide run detail" : "Show run detail") + "'>" + icon("chev") + "</button>"
          : "";
        const row = "<tr" + (known.has(r.role) ? " class='clickable' data-open='" + esc(r.role) + "'" : "") + ">" +
          "<td class='c-x'>" + toggle + "</td>" +
          "<td title='" + esc(r.time) + "'><span class='clamp1'>" + esc(fmtAgo(r.ts)) + "</span></td>" +
          "<td class='mono'>" + esc(roleLabel(r.role)) + "</td>" +
          "<td class='c-run num muted'>#" + esc(r.run) + "</td>" +
          "<td><span class='res t-" + res.tone + "'>" + esc(res.label) + "</span></td>" +
          "<td class='c-model'><span class='clamp1' title='" + esc(r.model || "") + "'>" + (r.model ? esc(r.model) : "<span class='muted'>—</span>") + "</span></td>" +
          "<td class='c-detail'><span class='clamp2' title='" + esc(r.detail) + "'>" + (r.detail ? esc(r.detail) : "<span class='muted'>—</span>") + "</span></td>" +
          "<td class='num c-dur'>" + durCell(r.durationMs) + "</td>" +
          "<td class='num c-usage muted'>" + esc(r.usage || "—") + "</td></tr>";
        // The expanded card rides directly beneath its row, full width.
        return open ? row + "<tr class='detail-row'><td colspan='9'>" + histDetailCardHtml(histDetails.get(key), key) + "</td></tr>" : row;
      }).join("") + "</tbody></table></div>";
  }
  // history-table:end
  // history-summary:start
  // The Summary table: one row per role plus the total, in the same column set the CLI's
  // history --summary prints (runs, changes, none, refused, problems, tokens, cost, time,
  // last change), so the dashboard and the CLI cannot drift column for column. Every number
  // comes from the
  // server's summary (built on the shared summarizeRunRows) — nothing here re-derives a
  // tally — and the cost/token cells reuse the page's report formatters. The time cell is the
  // sum of the role's run spans via fmtSpan, a dash when none of its rows carried a span. The
  // last-change cell is the newest changes-class run's age via fmtAgo, a dash when the role had
  // none. Pure — the view's render paints what this returns.
  function summaryTableHtml(header, entries) {
    const cell = (r, key, fmt) => "<td class='num'>" + esc(fmt ? fmt(r[key]) : r[key]) + "</td>";
    const rowsHtml = entries.map((e) => { const r = e.row; return (
      "<tr" + (e.total ? " class='hist-total'" : "") + ">" +
      "<td class='mono'>" + (e.labelHtml || esc(e.label)) + "</td>" +
      cell(r, "runs") + cell(r, "changes") + cell(r, "none") + cell(r, "refused") + cell(r, "problems") +
      cell(r, "tokens", (n) => fmtTokens(Number(n))) + cell(r, "costUsd", (n) => fmtUsd(Number(n))) +
      "<td class='num'>" + durCell(r.durationMs) + "</td>" +
      "<td>" + esc(r.lastChangeTs === null || r.lastChangeTs === undefined ? "—" : fmtAgo(Number(r.lastChangeTs))) + "</td></tr>"); }).join("");
    return "<div class='table-wrap'><table class='table history'><thead><tr><th>" + esc(header) + "</th><th class='num'>Runs</th><th class='num'>Merged</th><th class='num'>None</th><th class='num'>Refused</th><th class='num'>Problems</th><th class='num'>Tokens</th><th class='num'>Cost</th><th class='num'>Time</th><th>Last change</th></tr></thead><tbody>" +
      rowsHtml + "</tbody></table></div>";
  }
  function histSummaryHtml(summary) {
    const entries = summary.roles.map((r) => ({ label: roleLabel(r.role), row: r }));
    if (summary.total) entries.push({ label: "total", row: summary.total, total: true });
    return summaryTableHtml("Role", entries);
  }
  // The By model table: one row per model (the null bucket reads "(unknown)"), then the total.
  function histModelSummaryHtml(summary) {
    const entries = summary.models.map((r) => ({
      label: r.model === null ? "(unknown)" : r.model,
      row: r,
      labelHtml: r.model === null ? "" : "<button type='button' class='linkish mono' data-histmodel='" + esc(r.model) + "'>" + esc(r.model) + "</button>",
    }));
    if (summary.total) entries.push({ label: "total", row: summary.total, total: true });
    return summaryTableHtml("Model", entries);
  }
  // history-summary:end
  function renderHistory() {
    const body = $("histbody");
    if (!body) return;
    markActive($("histfilter"), "hist", histFilter);
    const chip = $("histmodel");
    if (chip) {
      chip.style.display = histModel ? "" : "none";
      chip.textContent = "Model: " + histModel + " ×";
    }
    const sum = $("histsum");
    if (sum) sum.style.display = "";
    markActive(sum, "histsum", histMode);
    // The outcome filter is meaningless in Summary mode (the summary already folds every class),
    // so it is hidden there; only the body changes, keeping the same fetch path.
    const filterEl = $("histfilter");
    if (filterEl) filterEl.style.display = histMode !== "table" ? "none" : "";
    // Summary mode shows the per-role table and By model mode the per-model one when the fetch
    // carried that summary over actual rows; otherwise (no rows, or a too-old server that answered
    // without it) it falls back to the same empty state the table shows.
    const hasRows = histRows && histRows.length > 0;
    const bodyHtml = histMode === "summary" && histSummary && hasRows
      ? histSummaryHtml(histSummary)
      : histMode === "models" && histModelSummary && hasRows
      ? histModelSummaryHtml(histModelSummary)
      : historyTableHtml(histRows, histFilter, new Set(((lastStatus && lastStatus.roles) || []).map((l) => l.role)), histGrep, histSinceKey, histModel, histStep);
    body.innerHTML = historyNoteHtml(histNote) + historyStepHtml(histSinceKey, histStep) + histNewestHtml() + bodyHtml;
    const stepEl = $("histstep");
    if (stepEl) {
      stepEl.style.display = HIST_WINDOWS[histSinceKey] ? "" : "none";
      $("histearlier").disabled = !histCanStepEarlier(histSinceKey, histStep);
      $("histlater").disabled = histStep === 0;
    }
  }
`;
