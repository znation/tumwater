/** The dashboard page served at `/` by `tumwater gui`: a zero-dependency single-file app
 * that polls /api/status every second, renders the loop table and event feed, and posts
 * prompts to /api/prompt. Kept in its own module so gui.ts stays focused on serving logic
 * and the API payload; edit this template when the dashboard's UI changes. */
export const GUI_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>tumwater</title>
<style>
  :root { color-scheme: dark; }
  body { background:#101418; color:#d6dde4; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
         max-width:1100px; margin:2rem auto; padding:0 1rem; }
  h1 { font-size:16px; font-weight:600; } h1 .muted, .muted { color:#7a8794; font-weight:400; }
  table { border-collapse:collapse; width:100%; margin:1rem 0; font-size:12px; }
  th,td { text-align:left; padding:4px 10px 4px 0; border-bottom:1px solid #1e2831; white-space:nowrap; }
  td.wide { white-space:normal; }
  th { color:#7a8794; font-weight:500; }
  .working { color:#7ec8ff; } .changed { color:#7fd88f; } .error, .merge_conflict { color:#ff9a8a; }
  #feed { background:#0b0e12; border:1px solid #1e2831; border-radius:6px; padding:10px 14px;
          height:16em; overflow-y:auto; font-size:13px; color:#9fb0bf; }
  #transcript { background:#0b0e12; border:1px solid #1e2831; border-radius:6px; padding:10px 14px;
          max-height:16em; overflow-y:auto; font-size:13px; color:#9fb0bf; white-space:pre-wrap;
          margin-bottom:1rem; }
  #backlog { background:#0b0e12; border:1px solid #1e2831; border-radius:6px; padding:10px 14px;
          max-height:16em; overflow-y:auto; font-size:13px; color:#9fb0bf; white-space:pre-wrap;
          margin-bottom:1rem; }
  a { color:#7ec8ff; text-decoration:none; cursor:pointer; } a.active { color:#d6dde4; font-weight:600; }
  form { display:flex; gap:8px; margin:1rem 0; }
  input { flex:1; background:#0b0e12; color:#d6dde4; border:1px solid #2a3642; border-radius:6px;
          padding:8px 10px; font:inherit; }
  button { background:#20303e; color:#d6dde4; border:1px solid #2a3642; border-radius:6px;
           padding:8px 16px; font:inherit; cursor:pointer; }
  #flash { color:#7fd88f; margin-left:8px; }
  #viewnav { margin:0.5rem 0; }
  .stats { display:flex; gap:12px; flex-wrap:wrap; margin:1rem 0; }
  .stat { background:#0b0e12; border:1px solid #1e2831; border-radius:6px; padding:8px 14px; min-width:9em; }
  .stat b { display:block; font-size:15px; margin-top:2px; }
  .chartblock { margin:1rem 0; }
  .charttitle { color:#7a8794; font-weight:500; margin-bottom:6px; }
  #report svg text { fill:#7a8794; font-size:10px; }
  .legend { display:flex; gap:12px; flex-wrap:wrap; margin-top:6px; color:#9fb0bf; font-size:12px; }
  .swatch { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; }
</style>
<h1>tumwater <span class="muted" id="header">connecting…</span></h1>
<nav id="viewnav"><a href="#" id="tab-fleet" class="active">fleet</a><span class="muted"> | </span><a href="#" id="tab-report">report</a></nav>
<form id="promptform">
  <input id="prompt" placeholder="type a prompt for the project — it runs immediately via the director loop" autocomplete="off">
  <button>send</button><span id="flash"></span>
</form>
<div id="fleet-view">
<table>
  <thead><tr><th>loop</th><th>state</th><th>current</th><th>ticks</th><th>commits</th><th>gen</th><th>peak ctx</th><th>cost</th><th>today</th><th>last tick</th><th>last result</th></tr></thead>
  <tbody id="loops"></tbody>
</table>
<div id="transcript" hidden></div>
<div id="backlog"></div>
<div id="feed"></div>
</div>
<div id="report" hidden></div>
<script>
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  const fmtTokens = (n) => (n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n || 0));
  // Absolute local time of the last tick end, same format rules as the TUI's last-tick
  // cell: zero-padded HH:MM:SS, prefixed MM-DD once older than a day; "-" when never ticked.
  const fmtLastTick = (ts) => {
    if (!ts) return "-";
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    let s = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    if (Date.now() - ts > 86400000) s = p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + s;
    return s;
  };
  // loop-sort:start
  // Loop-table row order: active loops (working/reviewing — the two in-flight phases, same
  // prefix convention as the row coloring below, extended with reviewing) before inactive
  // ones; within each category by last tick most-recent-first. Null (never completed a tick)
  // sorts last in its category; ties break on role name so an identical payload always renders
  // in the same order. Client-side only — /api/status, status --json, and the TUI keep
  // payload order.
  function sortLoops(loops) {
    const cat = (l) => ((l.phase.startsWith("working") || l.phase.startsWith("reviewing")) ? 0 : 1);
    return loops.slice().sort((a, b) => {
      if (cat(a) !== cat(b)) return cat(a) - cat(b);
      const ta = a.lastTickEndedAt ?? 0;
      const tb = b.lastTickEndedAt ?? 0;
      if (ta !== tb) return tb - ta;
      return a.role.localeCompare(b.role);
    });
  }
  // loop-sort:end
  // ---- report tab: the usage dashboard ------------------------------------------
  // Top-level views inside one page: "fleet" (today's dashboard, default) and "report"
  // (usage charts). The director prompt form sits outside both — an operator control,
  // visible on every tab. The 1s status poll keeps running on both tabs; the report data
  // itself is fetched only on tab activation (usage moves at tick granularity, not per second).
  let activeView = "fleet";
  function switchView(v) {
    if (v !== "fleet" && v !== "report") return;
    activeView = v;
    document.getElementById("fleet-view").hidden = v !== "fleet";
    document.getElementById("report").hidden = v !== "report";
    document.getElementById("tab-fleet").classList.toggle("active", v === "fleet");
    document.getElementById("tab-report").classList.toggle("active", v === "report");
    if (v === "report") fetchReport(); // on every activation — re-clicking refetches
  }

  // report-chart:start
  const REPORT_PALETTE = ["#7ec8ff", "#7fd88f", "#ffb454", "#c792ea", "#ff9a8a", "#56b6c2", "#e0d37a", "#d19bf6"];

  // Window totals per role, in the same order renderReportMarkdown's "Ticks by role" line
  // uses — count desc, then name asc — so legend and stack order match the Markdown report.
  function reportRoleOrder(data) {
    const byRole = {};
    for (const d of data.series)
      for (const [role, n] of Object.entries(d.ticksByRole)) byRole[role] = (byRole[role] || 0) + n;
    return Object.entries(byRole).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  // X-axis labels: MM-DD like the Markdown table's day column, thinned to at most seven —
  // label index i when i % ceil(n/7) === 0 (n=14 → every other day; n≤7 → all days).
  function reportDayLabels(series) {
    const step = Math.ceil(series.length / 7);
    return series.map((d, i) => (i % step === 0 ? d.date.slice(5) : ""));
  }

  // Shared bar geometry: fixed plot box, one slot per day so zero days keep their space and
  // all three charts' x-axes line up. segmentsOf(day) → [{ value, color, title }] stacked
  // bottom-up; each positive segment becomes a <rect> whose <title> carries the exact raw
  // value (zero values leave an empty slot — no rect to hover).
  const REPORT_W = 560;
  const REPORT_H = 170;
  const REPORT_PAD_T = 8;
  const REPORT_PAD_B = 24;

  function reportSvg(series, segmentsOf) {
    const n = series.length;
    const plotH = REPORT_H - REPORT_PAD_T - REPORT_PAD_B;
    const slotW = REPORT_W / n;
    const barW = Math.max(4, slotW * 0.6);
    const max = Math.max(0, ...series.map((d) => segmentsOf(d).reduce((a, s) => a + s.value, 0)));
    const labels = reportDayLabels(series);
    let out = "<svg viewBox='0 0 " + REPORT_W + " " + REPORT_H + "' width='" + REPORT_W + "' height='" + REPORT_H + "' role='img'>";
    out += "<line x1='0' y1='" + (REPORT_PAD_T + plotH) + "' x2='" + REPORT_W + "' y2='" + (REPORT_PAD_T + plotH) + "' stroke='#1e2831'/>";
    series.forEach((d, i) => {
      const x = i * slotW + (slotW - barW) / 2;
      let y = REPORT_PAD_T + plotH; // stack from the baseline up
      for (const s of segmentsOf(d)) {
        if (s.value <= 0 || max === 0) continue;
        const h = Math.max(1, (s.value / max) * plotH);
        y -= h;
        out += "<rect x='" + x.toFixed(2) + "' y='" + y.toFixed(2) + "' width='" + barW.toFixed(2) + "' height='" + h.toFixed(2) + "' fill='" + s.color + "'><title>" + esc(s.title) + "</title></rect>";
      }
      if (labels[i]) out += "<text x='" + (i * slotW + slotW / 2).toFixed(2) + "' y='" + (REPORT_H - 8) + "' text-anchor='middle'>" + labels[i] + "</text>";
    });
    return out + "</svg>";
  }

  function chartTokens(data) {
    return reportSvg(data.series, (d) => [{ value: d.tokensOut, color: "#7ec8ff", title: d.date + ": " + d.tokensOut }]);
  }

  function chartCommits(data) {
    return reportSvg(data.series, (d) => [{ value: d.commits, color: "#7fd88f", title: d.date + ": " + d.commits }]);
  }

  // Stacked bars, one color per role from the fixed palette — colors wrap modulo so a fleet
  // with more roles than palette entries still renders. The first (highest-count) role sits
  // at the bottom; the legend under the chart lists roles in that same stack order. Role
  // names are dynamic strings (custom loops): escaped like every other dynamic value.
  function chartTicksByRole(data) {
    const roles = reportRoleOrder(data);
    const colorOf = (i) => REPORT_PALETTE[i % REPORT_PALETTE.length];
    const svg = reportSvg(
      data.series,
      (d) => roles.map(([role], i) => ({ value: d.ticksByRole[role] || 0, color: colorOf(i), title: d.date + " " + role + ": " + (d.ticksByRole[role] || 0) })),
    );
    const legend = roles.length
      ? "<div class='legend'>" + roles.map(([role], i) => "<span><span class='swatch' style='background:" + colorOf(i) + "'></span>" + esc(role) + "</span>").join("") + "</div>"
      : "";
    return svg + legend;
  }
  // report-chart:end

  // The six stat blocks above the charts, from data.totals — tokens through fmtTokens and
  // cost as $ + toFixed(2), the same two rules the Markdown Totals line uses.
  function reportSummary(data) {
    const t = data.totals;
    const block = (label, value) => "<div class='stat'><span class='muted'>" + esc(label) + "</span><b>" + value + "</b></div>";
    return [
      block("output tokens", fmtTokens(t.tokensOut)),
      block("ticks", String(t.ticks)),
      block("commits", String(t.commits)),
      block("cost", "$" + t.costUsd.toFixed(2)),
      block("features done", String(t.featuresDone)),
      block("bugs fixed", String(t.bugsFixed)),
    ].join("");
  }

  // Fetch the report on tab activation and render summary + three charts into #report.
  async function fetchReport() {
    const panel = document.getElementById("report");
    try {
      const r = await fetch("/api/report?days=14");
      if (!r.ok) throw new Error("bad response");
      const d = await r.json();
      const block = (title, svg) => "<div class='chartblock'><div class='charttitle'>" + title + "</div>" + svg + "</div>";
      panel.innerHTML = "<div class='stats'>" + reportSummary(d) + "</div>" +
        block("Output tokens per day", chartTokens(d)) +
        block("Ticks per day by role", chartTicksByRole(d)) +
        block("Commits per day", chartCommits(d));
    } catch {
      panel.innerHTML = "<span class='muted'>report unavailable</span>";
    }
  }

  let transcriptRole = null; // loop whose transcript panel is open (null = closed)
  let backlogKey = null; // "file:index" of the open backlog entry (null = closed) — mutually
                         // exclusive with transcriptRole: both render into #transcript, so only
                         // one can be open at a time.
  async function refreshTranscript() {
    const panel = document.getElementById("transcript");
    if (!transcriptRole && !backlogKey) { panel.hidden = true; panel.innerHTML = ""; return; }
    try {
      if (transcriptRole) {
        const r = await fetch("/api/transcript?role=" + encodeURIComponent(transcriptRole) + "&n=50");
        const d = await r.json();
        const lines = Array.isArray(d.lines) ? d.lines : [];
        panel.hidden = false;
        panel.innerHTML = "<span class='muted'>transcript: " + esc(transcriptRole) +
          " — click the loop name again to close</span>\\n" +
          (lines.length ? lines.map(esc).join("\\n") : "(no transcript yet for this loop)");
      } else {
        // A backlog entry's full text, fetched on demand (bodies can be multi-KB) and re-fetched
        // on the same 1s poll while open — the panel's pre-wrap preserves its newlines. The body
        // is model-written markdown: escape it before innerHTML like every other dynamic value,
        // or HTML in a plan/bug entry would execute in the dashboard (XSS).
        const [file, index] = backlogKey.split(":");
        const r = await fetch("/api/backlog?file=" + encodeURIComponent(file) + "&index=" + encodeURIComponent(index));
        if (!r.ok) throw new Error("bad response");
        const d = await r.json();
        panel.hidden = false;
        panel.innerHTML = "<span class='muted'>" + esc(d.title) +
          " — click the entry again to close</span>\\n" + (esc(d.body) || "(no details for this entry)");
      }
    } catch { /* keep the previous panel content on a failed poll */ }
  }
  async function refresh() {
    try {
      const r = await fetch("/api/status");
      const d = await r.json();
      const qn = (d.questions || []).length;
      // The build badge arrives pre-formatted from the payload — status-render's buildBadge,
      // the same string the TUI/status header renders, so the two surfaces cannot drift.
      document.getElementById("header").textContent =
        (d.running ? "running (pid " + d.pid + (d.buildBadge || "") + ")" : "orchestrator not running") +
        (d.inbox ? " · inbox: " + d.inbox : "") +
        (qn ? " · questions: " + qn : "") +
        // The daily cost budget badge arrives preformatted from the payload — status-render's
        // budgetBadge, the same string the TUI/status header renders (n/a for an all-free
        // fleet; empty when disabled), so the two surfaces cannot drift.
        (d.budgetBadge || "");
      document.getElementById("loops").innerHTML = sortLoops(d.loops).map((l) => {
        const cls = l.phase.startsWith("working") ? "working" : (l.lastResult || "");
        const last = l.lastResult ? l.lastResult + (l.lastSummary ? " — " + l.lastSummary : "") : "-";
        return "<tr><td><a href='#' class='looplink" + (transcriptRole === l.role ? " active" : "") +
          "' data-role='" + esc(l.role) + "'>" + esc(l.role) + "</a></td>"
          + "<td class='wide " + cls + "'>" + esc(l.phase)
          + "</td><td class='wide'>" + esc(l.currentWork ?? "-") + "</td><td>" + l.ticks + "</td><td>" + l.commits + "</td><td>" + fmtTokens(l.generated) +
          "</td><td>" + fmtTokens(l.peakCtx) +
          // today: the loop's spend for the local day (0 while its stamp is stale), same
          // two-decimal rule as cost — formatted client-side from the payload, like cost.
          "</td><td>$" + l.costUsd.toFixed(2) + "</td><td>$" + l.todayUsd.toFixed(2) + "</td><td>" + fmtLastTick(l.lastTickEndedAt) +
          "</td><td class='wide'>" + esc(last) + "</td></tr>";
      }).join("");
      // Project status: planned features, open bugs, and open questions — fresh from
      // /api/status each poll. Each entry line is a link into the detail panel (its full text,
      // fetched on demand from /api/backlog); queued prompts stay plain — they have no body.
      const backlogLink = (file, items) => items.map((t, i) =>
        "<a class='backloglink" + (backlogKey === file + ":" + i ? " active" : "") + "' data-file='" + file +
        "' data-index='" + i + "'>" + esc(t) + "</a>").join("\\n");
      const backlogList = (title, items, file) => "<span class='muted'>" + esc(title + " (" + items.length + ")") + "</span>\\n" +
        (items.length ? (file ? backlogLink(file, items) : items.map(esc).join("\\n")) : "(none)");
      document.getElementById("backlog").innerHTML =
        backlogList("planned features", d.plans || [], "plans") + "\\n\\n" + backlogList("open bugs", d.bugs || [], "bugs") +
        "\\n\\n" + backlogList("open questions", d.questions || [], "questions") +
        // Queued director prompts in execution order (previews, truncated server-side);
        // (none) while the inbox is empty, like the other sections.
        "\\n\\n" + backlogList("queued prompts", d.inboxPrompts || []);
      const feed = document.getElementById("feed");
      const stick = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 4;
      feed.innerHTML = d.events.map(esc).join("<br>");
      if (stick) feed.scrollTop = feed.scrollHeight;
    } catch {
      document.getElementById("header").textContent = "connection lost";
    }
    await refreshTranscript(); // panel re-fetches on the same 1s poll while open
  }
  document.getElementById("loops").addEventListener("click", (ev) => {
    const a = ev.target.closest("a.looplink");
    if (!a) return;
    ev.preventDefault();
    backlogKey = null; // opening/switching a transcript closes any open backlog entry
    transcriptRole = transcriptRole === a.dataset.role ? null : a.dataset.role; // toggle / switch
    refresh();
  });
  document.getElementById("backlog").addEventListener("click", (ev) => {
    const a = ev.target.closest("a.backloglink");
    if (!a) return;
    ev.preventDefault();
    transcriptRole = null; // opening/switching an entry closes any open transcript
    const key = a.dataset.file + ":" + a.dataset.index;
    backlogKey = backlogKey === key ? null : key; // toggle / switch, same rule as loop links
    refresh();
  });
  document.getElementById("viewnav").addEventListener("click", (ev) => {
    const a = ev.target.closest("a");
    if (!a || !a.id.startsWith("tab-")) return;
    ev.preventDefault();
    switchView(a.id.slice(4)); // "fleet" | "report" — re-clicking the active tab refetches
  });
  document.getElementById("promptform").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const input = document.getElementById("prompt");
    const text = input.value.trim();
    if (!text) return;
    await fetch("/api/prompt", { method: "POST", headers: { "content-type": "application/json" },
                                 body: JSON.stringify({ text }) });
    input.value = "";
    const flash = document.getElementById("flash");
    flash.textContent = "queued";
    setTimeout(() => (flash.textContent = ""), 3000);
    refresh();
  });
  refresh();
  setInterval(refresh, 1000);
</script>
`;
