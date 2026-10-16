// vocabulary: plain
/** The dashboard's History view, browser-side: every completed tick, newest first, as
 * /api/history serves them (the rows `tumwater history` prints). A toolbar narrows it to one
 * loop (server-side, so a quiet loop still gets its full count), searches the rendered row text
 * (server-side, through the same haystack rule `tumwater history --grep` uses), to an outcome
 * class (changes, no change, problems — client-side over the fetched rows), and picks how many
 * ticks to fetch or a trailing window matching `tumwater history --since`. It refetches when the
 * view opens and, while it stays open, whenever the status poll sees new events — never on a
 * timer of its own. A row opens that loop's drawer. Spliced into gui-client.ts's script,
 * reaching its helpers (esc, getJson, resultInfo, the formatters) through that concatenation. */
export const GUI_CLIENT_HISTORY_JS = String.raw`  // The counts the "Ticks to show" picker offers; the recalled count is normalized to one of
  // them at read, so the picker can always represent (and the request always matches) the scope.
  const HIST_COUNTS = [20, 50, 100, 200];
  let histRole = recall("hist-role") || "";
  let histCount = HIST_COUNTS.includes(Number(recall("hist-n"))) ? Number(recall("hist-n")) : 50;
  let histGrep = recall("hist-grep") || "";
  let histSinceKey = recall("hist-since") || "";
  let histNote = "";
  let histFilter = "all";
  let histMode = recall("hist-mode") === "summary" ? "summary" : "table";
  let histRows = null;
  let histSummary = null;
  let histFetchedAt = 0;
  const HIST_FILTERS = [["all", "All"], ["changes", "Changes"], ["none", "No change"], ["problems", "Problems"]];
  const HIST_MODES = [["table", "Table"], ["summary", "Summary"]];
  function buildHistoryView() {
    if (!buildOnce("history", "<div class='view-head'><div><h1>History</h1><p>Every completed run, newest first.</p></div>" +
      "<div class='toolbar'>" +
      "<label><span class='sr-only'>Role</span><select class='field' id='histrole'><option value=''>All roles</option></select></label>" +
      "<div class='seg' id='histfilter'>" + HIST_FILTERS.map((f) => "<button type='button' data-hist='" + f[0] + "'>" + f[1] + "</button>").join("") + "</div>" +
      "<div class='seg' id='histsum'>" + HIST_MODES.map((m) => "<button type='button' data-histsum='" + m[0] + "'>" + m[1] + "</button>").join("") + "</div>" +
      "<label><span class='sr-only'>Search</span><input class='field' id='histgrep' type='search' placeholder='Search runs…' autocomplete='off'></label>" +
      "<label><span class='sr-only'>Runs to show</span><select class='field' id='histcount'>" +
      HIST_COUNTS.map((n) => "<option value='" + n + "'>Last " + n + "</option>").join("") +
      histWindowOptions() + "</select></label>" +
      "<button type='button' class='btn btn-sm' id='histrefresh'>" + icon("refresh") + "Refresh</button>" +
      "</div></div><div class='card' id='histbody'><div class='empty'>Loading…</div></div>")) return;
    $("histcount").value = HIST_WINDOWS[histSinceKey] ? histSinceKey : String(histCount);
    $("histgrep").value = histGrep;
    $("histrole").addEventListener("change", (ev) => {
      histRole = ev.target.value;
      store("hist-role", histRole);
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
    $("histrefresh").addEventListener("click", () => fetchHistory());
    // The drill-down's details toggle: the button alone expands or collapses (the row's own
    // click still opens the drawer — gui-client-boot's data-open handler skips clicks on a
    // data-tickdetail button).
    $("histbody").addEventListener("click", (ev) => {
      const b = ev.target instanceof Element ? ev.target.closest("button[data-tickdetail]") : null;
      if (!b) return;
      toggleHistDetail(b.dataset.role, b.dataset.tick);
    });
  }
  // history-detail:start
  // Tick drill-down state: one open card at a time, keyed "role#tick", with each key's cache
  // entry — { state: "loading" } while its fetch is in flight, { state: "error", message }
  // when one failed, { state: "ok", text } once /api/tick answered. Cached until the view
  // refetches (fetchHistory clears the map), so collapsing and re-expanding reuses the card.
  const histDetails = new Map();
  let histDetailOpen = "";
  function histDetailKey(role, tick) {
    return role + "#" + tick;
  }
  // The expanded card's markup from its cache entry. The state is checked explicitly, in
  // loading → error → ok order, so a placeholder can never fall into the fetched path and
  // render as an empty trail: an absent or loading entry shows the Loading… placeholder, an
  // errored fetch shows the server's message, and a fetched one shows the summary header plus
  // the tick's events exactly as the server pre-rendered them (renderTickDetail's output —
  // the tumwater tick rendering).
  function histDetailCardHtml(entry) {
    const state = entry && entry.state;
    if (!state || state === "loading") return "<div class='empty'>Loading run detail…</div>";
    if (state === "error") return "<div class='empty'><strong>" + esc(entry.message || "Run detail unavailable") + "</strong></div>";
    const lines = String(entry.text || "").split("\n");
    const head = lines.shift() || "";
    const trail = lines.join("\n");
    return "<div class='hist-detail'><div class='hist-detail-head mono'>" + esc(head) + "</div>" +
      (trail ? "<pre class='mono'>" + esc(trail) + "</pre>" : "<div class='empty'>No events in this run's block.</div>") +
      (entry.stat ? "<pre class='mono hist-detail-stat'>" + esc(entry.stat) + "</pre>" : "") +
      "</div>";
  }
  // Expand or collapse one row's card. Opening fetches the trail on first expand only — an
  // already-cached entry (ok or error) is reused, and a re-expand while the fetch is in flight
  // leaves that fetch to finish. The loading entry is installed and painted synchronously
  // (renderHistory below), so the placeholder shows while the request runs.
  function toggleHistDetail(role, tick) {
    const key = histDetailKey(role, tick);
    histDetailOpen = histDetailOpen === key ? "" : key;
    if (histDetailOpen) fetchHistDetail(role, tick);
    renderHistory();
  }
  async function fetchHistDetail(role, tick) {
    const key = histDetailKey(role, tick);
    const prev = histDetails.get(key);
    if (prev && prev.state !== "loading") return; // cached until the view refetches
    // The loading entry is the synchronous prefix: it is set before toggleHistDetail's
    // renderHistory paints, so the card shows the Loading… placeholder while the request runs
    // (and a re-expand during flight sees it and lets the first fetch finish).
    histDetails.set(key, { state: "loading" });
    try {
      const d = await getJson("/api/tick?role=" + encodeURIComponent(role) + "&tick=" + encodeURIComponent(String(tick))); // vocabulary-ok: the /api/tick route and tick= parameter stay
      // Name the endpoint, the tick it answered for, and the likely cause: a 200 without
      // text is a server too old (or too new) for this dashboard's client, not a lost tick —
      // a 404 already answers that shape with the CLI's own not-found wording.
      if (!d || typeof d.text !== "string")
        throw new Error(
          "/api/tick answered " + role + " run " + tick + " without a text field — the running tumwater may not match this dashboard", // vocabulary-ok: the /api/tick route stays
        );
      histDetails.set(key, { state: "ok", text: d.text, stat: typeof d.stat === "string" ? d.stat : "" });
    } catch (err) {
      histDetails.set(key, { state: "error", message: err && err.message ? err.message : "Run detail unavailable" });
    }
    renderHistory();
  }
  // history-detail:end
  // The loop picker's options follow the fleet's role list (custom loops included), keyed so a
  // poll with no roster change repaints nothing. A role the fleet dropped falls back to All
  // loops and persists, exactly as syncRolePicker does for the report and Activity pickers.
  function syncHistoryRoles(d) {
    if (!d) return;
    histRole = syncRolePicker("histrole", (d.loops || []).map((l) => l.role), histRole, "hist-role");
  }
  async function fetchHistory(throttled) {
    if (throttled && Date.now() - histFetchedAt < 4000) return;
    histFetchedAt = Date.now();
    buildHistoryView();
    syncHistoryRoles(lastStatus);
    try {
      const d = await getJson(historyQuery(histCount, histRole, histSinceKey, histGrep));
      histRows = d && Array.isArray(d.rows) ? d.rows : [];
      // The summary rides the same fetch (the endpoint folds the exact rows it served into
      // its additive summary), so toggling to Summary never refetches; a server too old to
      // include it leaves histSummary null and the toggle falls back to the table.
      histSummary = d && d.summary && Array.isArray(d.summary.loops) ? d.summary : null;
      // The trailing-window shape carries the server's coverage; the count shape has no note.
      histNote = d && typeof d.note === "string" ? d.note : "";
      // A refetch invalidates the drill-down cache: cached trails could disagree with the new
      // rows, and an open card's tick may no longer be among them — close it; the next expand
      // refetches.
      histDetails.clear();
      histDetailOpen = "";
    } catch (err) {
      $("histbody").innerHTML = errorPanel("History unavailable", err);
      return;
    }
    renderHistory();
  }
  // history-table:start
  // The trailing-window choices the toolbar's #histcount select grows after the tick counts:
  // key → [milliseconds, phrase]. historyQuery turns a key into the endpoint URL, so the
  // browser and the CLI's history --since ask for the same window by construction. The phrase
  // names the window in the empty state.
  const HIST_WINDOWS = { "1h": [3_600_000, "the last hour"], "6h": [21_600_000, "the last 6 hours"], "1d": [86_400_000, "the last day"], "7d": [604_800_000, "the last 7 days"] };
  // The /api/history URL for the current toolbar: the trailing-window shape when a window key
  // is set, the count shape otherwise, role and grep appended only when chosen. summary=1 rides
  // every ask — the endpoint's additive summary folds the exact served rows, so the Summary
  // mode renders from already-fetched data and the toggle swaps only the body.
  function historyQuery(count, role, sinceKey, grep) {
    const w = HIST_WINDOWS[sinceKey];
    return (w ? "/api/history?sinceMs=" + w[0] : "/api/history?n=" + count) + (role ? "&role=" + encodeURIComponent(role) : "") + (grep ? "&grep=" + encodeURIComponent(grep) : "") + "&summary=1";
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
  // Which outcome class a tick result falls in — the History filter's buckets.
  function historyClass(result) {
    if (result === "changed" || result === "queued") return "changes";
    if (result === "no_change" || result === "skipped" || result === "user_aborted") return "none";
    return "problems";
  }
  // The History table for rows (/api/history's, newest first) under a grep (already applied
  // server-side) and an outcome filter; known is
  // the set of the fleet's loop ids, whose rows open that loop's drawer. Pure — the view's
  // render paints what this returns.
  function historyTableHtml(rows, filter, known, grep, sinceKey) {
    const shown = (rows || []).filter((r) => filter === "all" || historyClass(r.result) === filter);
    if (!shown.length) {
      const hasRows = Boolean(rows && rows.length);
      if (hasRows)
        return "<div class='empty'><strong>No runs match this filter</strong>Try another outcome or role.</div>";
      if (grep)
        return "<div class='empty'><strong>No runs match this search</strong>Try another search.</div>";
      const w = HIST_WINDOWS[sinceKey];
      return w
        ? "<div class='empty'><strong>No runs in " + w[1] + "</strong>The window may have had nothing to do, or its older events may have rotated out.</div>"
        : "<div class='empty'><strong>No runs yet</strong>Completed runs show up here as the roles work.</div>";
    }
    return "<div class='table-wrap'><table class='table history'><thead><tr><th class='c-x'></th><th>When</th><th>Role</th><th class='c-tick num'>Run</th>" + // vocabulary-ok: the c-tick class stays
      "<th>Result</th><th class='c-detail'>Detail</th><th class='num c-dur'>Took</th><th class='num c-usage'>Usage</th></tr></thead><tbody>" +
      shown.map((r) => {
        const res = resultInfo(r.result);
        // The drill-down toggle rides the drawer's button style and lives in its own leading
        // cell; only a fleet loop's row carries one, the same rows that open the drawer (the
        // /api/tick endpoint validates the role, so an id the config no longer knows would
        // only ever answer 400).
        const key = histDetailKey(r.loop, r.tick);
        const open = histDetailOpen === key;
        const toggle = known.has(r.loop)
          ? "<button type='button' class='btn btn-sm hist-x' data-tickdetail='1' data-role='" + esc(r.loop) +
            "' data-tick='" + esc(r.tick) + "' aria-expanded='" + open + "' title='" + (open ? "Hide run detail" : "Show run detail") + "'>" + icon("chev") + "</button>" // vocabulary-ok: the data-tick name stays
          : "";
        const row = "<tr" + (known.has(r.loop) ? " class='clickable' data-open='" + esc(r.loop) + "'" : "") + ">" +
          "<td class='c-x'>" + toggle + "</td>" +
          "<td title='" + esc(r.time) + "'><span class='clamp1'>" + esc(fmtAgo(r.ts)) + "</span></td>" +
          "<td class='mono'>" + esc(roleLabel(r.loop)) + "</td>" +
          "<td class='c-tick num muted'>#" + esc(r.tick) + "</td>" + // vocabulary-ok: the c-tick class stays
          "<td><span class='res t-" + res.tone + "'>" + esc(res.label) + "</span></td>" +
          "<td class='c-detail'><span class='clamp2' title='" + esc(r.detail) + "'>" + (r.detail ? esc(r.detail) : "<span class='muted'>—</span>") + "</span></td>" +
          "<td class='num c-dur'>" + (r.durationMs === null || r.durationMs === undefined ? "—" : esc(fmtSpan(Number(r.durationMs)))) + "</td>" +
          "<td class='num c-usage muted'>" + esc(r.usage || "—") + "</td></tr>";
        // The expanded card rides directly beneath its row, full width.
        return open ? row + "<tr class='detail-row'><td colspan='8'>" + histDetailCardHtml(histDetails.get(key)) + "</td></tr>" : row;
      }).join("") + "</tbody></table></div>";
  }
  // history-table:end
  // history-summary:start
  // The Summary table: one row per loop plus the total, in the same column set the CLI's
  // history --summary prints (ticks, changes, none, problems, tokens, cost, last change), so
  // the dashboard and the CLI cannot drift column for column. Every number comes from the
  // server's summary (built on the shared summarizeTickRows) — nothing here re-derives a
  // tally — and the cost/token cells reuse the page's report formatters. The last-change cell is
  // the newest changes-class tick's age via fmtAgo, a dash when the loop had none. Pure — the
  // view's render paints what this returns.
  function histSummaryHtml(summary) {
    const all = summary.loops.concat(summary.total ? [summary.total] : []);
    const cell = (r, key, fmt) => "<td class='num'>" + esc(fmt ? fmt(r[key]) : r[key]) + "</td>";
    const rowsHtml = all.map((r) =>
      "<tr" + (r.loop === "total" ? " class='hist-total'" : "") + ">" +
      "<td class='mono'>" + esc(r.loop === "total" ? r.loop : roleLabel(r.loop)) + "</td>" +
      cell(r, "ticks") + cell(r, "changes") + cell(r, "none") + cell(r, "problems") + // vocabulary-ok: the summary's ticks key stays
      cell(r, "tokens", (n) => fmtTokens(Number(n))) + cell(r, "costUsd", (n) => fmtUsd(Number(n))) +
      "<td>" + esc(r.lastChangeTs === null || r.lastChangeTs === undefined ? "—" : fmtAgo(Number(r.lastChangeTs))) + "</td></tr>").join("");
    return "<div class='table-wrap'><table class='table history'><thead><tr><th>Role</th><th class='num'>Runs</th><th class='num'>Merged</th><th class='num'>None</th><th class='num'>Problems</th><th class='num'>Tokens</th><th class='num'>Cost</th><th>Last change</th></tr></thead><tbody>" +
      rowsHtml + "</tbody></table></div>";
  }
  // history-summary:end
  function renderHistory() {
    const body = $("histbody");
    if (!body) return;
    markActive($("histfilter"), "hist", histFilter);
    const sum = $("histsum");
    if (sum) sum.style.display = "";
    markActive(sum, "histsum", histMode);
    // The outcome filter is meaningless in Summary mode (the summary already folds every class),
    // so it is hidden there; only the body changes, keeping the same fetch path.
    const filterEl = $("histfilter");
    if (filterEl) filterEl.style.display = histMode === "summary" ? "none" : "";
    // Summary mode shows the per-loop table when the fetch carried a summary over actual rows;
    // otherwise (no rows, or a too-old server that answered without a summary) it falls back to
    // the same empty state the table shows.
    const showSummary = histMode === "summary" && histSummary && histRows && histRows.length > 0;
    const bodyHtml = showSummary
      ? histSummaryHtml(histSummary)
      : historyTableHtml(histRows, histFilter, new Set(((lastStatus && lastStatus.loops) || []).map((l) => l.role)), histGrep, histSinceKey);
    body.innerHTML = historyNoteHtml(histNote) + bodyHtml;
  }
`;
