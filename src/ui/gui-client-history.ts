/** The GUI dashboard's history tab, browser-side: the fetchHistory call that renders the
 * per-tick rows /api/history serves into #history, as the same table `tumwater history`
 * prints. Inlined into gui-client.ts's GUI_CLIENT_JS by string interpolation (the same
 * byte-exact splice gui-client-report.ts and gui-client-operator.ts use), so it runs as
 * part of the page's only <script> and cannot import the harness modules — it reaches
 * gui-client.ts's core helpers (esc, getJson) through that concatenation. Edit here when
 * the history tab's client behavior changes. */
export const GUI_CLIENT_HISTORY_JS = `  // Fetch the tick history on tab activation and render the seven columns the CLI prints
  // (time, loop, tick, result, duration, usage, detail). The server sends the collector's
  // rows as-is, so the browser stays a thin viewer. Re-clicking the tab refetches, like the
  // report and failures tabs — history moves at tick granularity, not per second.
  async function fetchHistory() {
    const panel = document.getElementById("history");
    try {
      const d = await getJson("/api/history");
      const rows = d && Array.isArray(d.rows) ? d.rows : [];
      if (!rows.length) {
        panel.innerHTML = "<span class='muted'>no ticks yet — click the tab again to refresh</span>";
        return;
      }
      // The CLI's shortSpanPhrase (text.ts) as a client copy: seconds under two minutes,
      // whole minutes above — the page cannot import TS, per the fmtTokens precedent.
      const spanMs = (ms) => (ms < 120000 ? Math.round(ms / 1000) + "s" : Math.round(ms / 60000) + "m");
      panel.innerHTML = "<table><thead><tr><th>time</th><th>loop</th><th>tick</th><th>result</th><th>duration</th><th>usage</th><th>detail</th></tr></thead><tbody>" +
        rows.map((r) =>
          "<tr><td>" + esc(r.time) + "</td><td>" + esc(r.loop) + "</td><td>#" + esc(r.tick) + "</td><td>" +
          esc(r.result) + "</td><td>" + (r.durationMs === null ? "—" : spanMs(Number(r.durationMs))) + "</td><td>" +
          esc(r.usage) + "</td><td class='wide'>" + esc(r.detail) + "</td></tr>",
        ).join("") + "</tbody></table>";
    } catch (e) {
      // Same guard as fetchReport and fetchFailures: name the endpoint, status, server error.
      panelUnavailable(panel, "history", e);
    }
  }
`;
