/** The dashboard's History view, browser-side: every completed tick, newest first, as
 * /api/history serves them (the rows `tumwater history` prints). A toolbar narrows it to one
 * loop (server-side, so a quiet loop still gets its full count), to an outcome class
 * (changes, no change, problems — client-side over the fetched rows), and picks how many ticks
 * to fetch. It refetches when the view opens and, while it stays open, whenever the status
 * poll sees new events — never on a timer of its own. A row opens that loop's drawer. Spliced
 * into gui-client.ts's script, reaching its helpers (esc, getJson, resultInfo, the formatters)
 * through that concatenation. */
export const GUI_CLIENT_HISTORY_JS = String.raw`  let histRole = recall("hist-role") || "";
  let histCount = Number(recall("hist-n")) || 50;
  let histFilter = "all";
  let histRows = null;
  let histFetchedAt = 0;
  let histRoleKey = "";
  const HIST_FILTERS = [["all", "All"], ["changes", "Changes"], ["none", "No change"], ["problems", "Problems"]];
  function buildHistoryView() {
    const panel = $("history");
    if (panel.dataset.built) return;
    panel.dataset.built = "1";
    panel.innerHTML = "<div class='view-head'><div><h1>History</h1><p>Every completed tick, newest first.</p></div>" +
      "<div class='toolbar'>" +
      "<label><span class='sr-only'>Loop</span><select class='field' id='histrole'><option value=''>All loops</option></select></label>" +
      "<div class='seg' id='histfilter'>" + HIST_FILTERS.map((f) => "<button type='button' data-hist='" + f[0] + "'>" + f[1] + "</button>").join("") + "</div>" +
      "<label><span class='sr-only'>Ticks to show</span><select class='field' id='histcount'>" +
      [20, 50, 100, 200].map((n) => "<option value='" + n + "'>Last " + n + "</option>").join("") + "</select></label>" +
      "<button type='button' class='btn btn-sm' id='histrefresh'>" + icon("refresh") + "Refresh</button>" +
      "</div></div><div class='card' id='histbody'><div class='empty'>Loading…</div></div>";
    $("histcount").value = String(histCount);
    $("histrole").addEventListener("change", (ev) => {
      histRole = ev.target.value;
      store("hist-role", histRole);
      fetchHistory();
    });
    $("histcount").addEventListener("change", (ev) => {
      histCount = Number(ev.target.value) || 50;
      store("hist-n", String(histCount));
      fetchHistory();
    });
    $("histfilter").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-hist]");
      if (!b) return;
      histFilter = b.dataset.hist;
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
    if (!state || state === "loading") return "<div class='empty'>Loading tick detail…</div>";
    if (state === "error") return "<div class='empty'><strong>" + esc(entry.message || "Tick detail unavailable") + "</strong></div>";
    const lines = String(entry.text || "").split("\n");
    const head = lines.shift() || "";
    const trail = lines.join("\n");
    return "<div class='hist-detail'><div class='hist-detail-head mono'>" + esc(head) + "</div>" +
      (trail ? "<pre class='mono'>" + esc(trail) + "</pre>" : "<div class='empty'>No events in this tick's block.</div>") +
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
      const d = await getJson("/api/tick?role=" + encodeURIComponent(role) + "&tick=" + encodeURIComponent(String(tick)));
      if (!d || typeof d.text !== "string") throw new Error("malformed tick detail");
      histDetails.set(key, { state: "ok", text: d.text });
    } catch (e) {
      histDetails.set(key, { state: "error", message: e && e.message ? e.message : "Tick detail unavailable" });
    }
    renderHistory();
  }
  // history-detail:end
  // The loop picker's options follow the fleet's role list (custom loops included).
  function syncHistoryRoles(d) {
    const select = $("histrole");
    if (!select || !d) return;
    const roles = (d.loops || []).map((l) => l.role);
    const key = roles.join(",");
    if (key === histRoleKey) return;
    histRoleKey = key;
    select.innerHTML = "<option value=''>All loops</option>" + roles.map((r) => "<option value='" + esc(r) + "'>" + esc(r) + "</option>").join("");
    select.value = roles.includes(histRole) ? histRole : "";
  }
  async function fetchHistory(throttled) {
    if (throttled && Date.now() - histFetchedAt < 4000) return;
    histFetchedAt = Date.now();
    buildHistoryView();
    syncHistoryRoles(lastStatus);
    try {
      const d = await getJson("/api/history?n=" + histCount + (histRole ? "&role=" + encodeURIComponent(histRole) : ""));
      histRows = d && Array.isArray(d.rows) ? d.rows : [];
      // A refetch invalidates the drill-down cache: cached trails could disagree with the new
      // rows, and an open card's tick may no longer be among them — close it; the next expand
      // refetches.
      histDetails.clear();
      histDetailOpen = "";
    } catch (e) {
      $("histbody").innerHTML = errorPanel("History unavailable", e);
      return;
    }
    renderHistory();
  }
  // history-table:start
  // Which outcome class a tick result falls in — the History filter's buckets.
  function historyClass(result) {
    if (result === "changed" || result === "queued") return "changes";
    if (result === "no_change" || result === "skipped" || result === "user_aborted") return "none";
    return "problems";
  }
  // The History table for rows (/api/history's, newest first) under an outcome filter; known is
  // the set of the fleet's loop ids, whose rows open that loop's drawer. Pure — the view's
  // render paints what this returns.
  function historyTableHtml(rows, filter, known) {
    const shown = (rows || []).filter((r) => filter === "all" || historyClass(r.result) === filter);
    if (!shown.length) {
      return "<div class='empty'><strong>" + (rows && rows.length ? "No ticks match this filter" : "No ticks yet") + "</strong>" +
        (rows && rows.length ? "Try another outcome or loop." : "Completed ticks show up here as the loops work.") + "</div>";
    }
    return "<div class='table-wrap'><table class='table history'><thead><tr><th class='c-x'></th><th>When</th><th>Loop</th><th class='c-tick num'>Tick</th>" +
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
            "' data-tick='" + esc(r.tick) + "' aria-expanded='" + open + "' title='" + (open ? "Hide tick detail" : "Show tick detail") + "'>" + icon("chev") + "</button>"
          : "";
        const row = "<tr" + (known.has(r.loop) ? " class='clickable' data-open='" + esc(r.loop) + "'" : "") + ">" +
          "<td class='c-x'>" + toggle + "</td>" +
          "<td title='" + esc(r.time) + "'><span class='clamp1'>" + esc(fmtAgo(r.ts)) + "</span></td>" +
          "<td class='mono'>" + esc(r.loop) + "</td>" +
          "<td class='c-tick num muted'>#" + esc(r.tick) + "</td>" +
          "<td><span class='res t-" + res.tone + "'>" + esc(res.label) + "</span></td>" +
          "<td class='c-detail'><span class='clamp2' title='" + esc(r.detail) + "'>" + (r.detail ? esc(r.detail) : "<span class='muted'>—</span>") + "</span></td>" +
          "<td class='num c-dur'>" + (r.durationMs === null || r.durationMs === undefined ? "—" : esc(fmtSpan(Number(r.durationMs)))) + "</td>" +
          "<td class='num c-usage muted'>" + esc(r.usage || "—") + "</td></tr>";
        // The expanded card rides directly beneath its row, full width.
        return open ? row + "<tr class='detail-row'><td colspan='8'>" + histDetailCardHtml(histDetails.get(key)) + "</td></tr>" : row;
      }).join("") + "</tbody></table></div>";
  }
  // history-table:end
  function renderHistory() {
    const body = $("histbody");
    if (!body) return;
    markActive($("histfilter"), "hist", histFilter);
    body.innerHTML = historyTableHtml(histRows, histFilter, new Set(((lastStatus && lastStatus.loops) || []).map((l) => l.role)));
  }
`;
