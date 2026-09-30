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
  }
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
    return "<div class='table-wrap'><table class='table history'><thead><tr><th>When</th><th>Loop</th><th class='c-tick num'>Tick</th>" +
      "<th>Result</th><th class='c-detail'>Detail</th><th class='num c-dur'>Took</th><th class='num c-usage'>Usage</th></tr></thead><tbody>" +
      shown.map((r) => {
        const res = resultInfo(r.result);
        return "<tr" + (known.has(r.loop) ? " class='clickable' data-open='" + esc(r.loop) + "'" : "") + ">" +
          "<td title='" + esc(r.time) + "'><span class='clamp1'>" + esc(fmtAgo(r.ts)) + "</span></td>" +
          "<td class='mono'>" + esc(r.loop) + "</td>" +
          "<td class='c-tick num muted'>#" + esc(r.tick) + "</td>" +
          "<td><span class='res t-" + res.tone + "'>" + esc(res.label) + "</span></td>" +
          "<td class='c-detail'><span class='clamp2' title='" + esc(r.detail) + "'>" + (r.detail ? esc(r.detail) : "<span class='muted'>—</span>") + "</span></td>" +
          "<td class='num c-dur'>" + (r.durationMs === null || r.durationMs === undefined ? "—" : esc(fmtSpan(Number(r.durationMs)))) + "</td>" +
          "<td class='num c-usage muted'>" + esc(r.usage || "—") + "</td></tr>";
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
