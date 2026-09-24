/** The GUI dashboard's report tab, browser-side: the pure SVG chart builders, the shared
 * role-stack renderer, the hover-tip chip, the stat-block row, and the fetchReport call
 * that renders them into #report. Inlined into gui-client.ts's GUI_CLIENT_JS by string
 * interpolation, so the served script stays byte-identical to the pre-split single blob
 * and the marked regions (report-chart, report-tip) that test/gui-report.test.ts extracts
 * keep matching. It runs as part of the page's only <script> and cannot import the harness
 * modules — it reaches gui-client.ts's core helpers (esc, getJson, fmtTokens) through that
 * concatenation. Edit here when the report tab's client behavior changes. */
export const GUI_CLIENT_REPORT_JS = `// report-chart:start
  const REPORT_PALETTE = ["#7ec8ff", "#7fd88f", "#ffb454", "#c792ea", "#ff9a8a", "#56b6c2", "#e0d37a", "#d19bf6"];

  // Window totals per role, in the same order renderReportMarkdown's "Ticks by role" line
  // uses — count desc, then name asc — so legend and stack order match the Markdown report.
  // The fold covers costByRole too (it rides the same tick_end events, so its roles are a
  // subset in practice) so the single shared order can never drop a spend-bearing role from
  // the cost chart.
  function reportRoleOrder(data) {
    const byRole = {};
    for (const d of data.series) {
      for (const [role, n] of Object.entries(d.ticksByRole)) byRole[role] = (byRole[role] || 0) + n;
      for (const role of Object.keys(d.costByRole || {})) if (!(role in byRole)) byRole[role] = 0;
    }
    return Object.entries(byRole).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  // X-axis labels: MM-DD like the Markdown table's day column, thinned to at most seven —
  // label index i when i % ceil(n/7) === 0 (n=14 → every other day; n≤7 → all days).
  function reportDayLabels(series) {
    const step = Math.ceil(series.length / 7);
    return series.map((d, i) => (i % step === 0 ? d.date.slice(5) : ""));
  }

  // Shared bar geometry: fixed plot box, one slot per day so zero days keep their space and
  // all four charts' x-axes line up. segmentsOf(day) → [{ value, color, title }] stacked
  // bottom-up; each positive segment becomes a <rect> whose <title> carries the same
  // abbreviated value the stat blocks show — the text the report-tip hover chip displays
  // (zero values leave an empty slot — no rect to hover).
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
    return reportSvg(data.series, (d) => [{ value: d.tokensOut, color: "#7ec8ff", title: d.date + ": " + fmtTokens(d.tokensOut) }]);
  }

  function chartCommits(data) {
    return reportSvg(data.series, (d) => [{ value: d.commits, color: "#7fd88f", title: d.date + ": " + fmtTokens(d.commits) }]);
  }

  // Stacked bars, one color per role from the fixed palette — colors wrap modulo so a fleet
  // with more roles than palette entries still renders. The first (highest-count) role sits
  // at the bottom; the legend under the chart lists roles in that same stack order. Role
  // names are dynamic strings (custom loops): escaped like every other dynamic value.
  // The ticks and cost charts are the same shape over different fields, so one builder takes
  // the field name and the tooltip formatter — the two charts share reportRoleOrder's order,
  // the palette, and the legend byte-for-byte.
  const fmtUsd = (n) => "$" + n.toFixed(2); // the stat block's cost rule (gui report 2/3)
  function roleStackChart(data, field, fmt) {
    const roles = reportRoleOrder(data);
    const colorOf = (i) => REPORT_PALETTE[i % REPORT_PALETTE.length];
    const svg = reportSvg(
      data.series,
      (d) => roles.map(([role], i) => ({ value: d[field][role] || 0, color: colorOf(i), title: d.date + " " + role + ": " + fmt(d[field][role] || 0) })),
    );
    const legend = roles.length
      ? "<div class='legend'>" + roles.map(([role], i) => "<span><span class='swatch' style='background:" + colorOf(i) + "'></span>" + esc(role) + "</span>").join("") + "</div>"
      : "";
    return svg + legend;
  }

  function chartTicksByRole(data) {
    return roleStackChart(data, "ticksByRole", fmtTokens);
  }

  function chartCostByRole(data) {
    return roleStackChart(data, "costByRole", fmtUsd);
  }
  // report-chart:end

  // report-tip:start
  // Hover label for the report charts: one shared, cursor-following chip that shows each
  // bar segment's value immediately. Each segment's existing <title> is the label text —
  // the same abbreviated value the chart builders produce and escape — so the tooltip
  // cannot drift from them; no rect (gaps, axis, legend, stats row) or an empty title
  // hides the chip. The native <title> tooltip may still appear after the browser's
  // delay; the styled chip is the immediate affordance.
  function reportTipElement() {
    // Idempotent: created once, on first use. It lives on document.body, outside #report,
    // because fetchReport replaces #report's innerHTML on every tab activation — a tip
    // inside it would be destroyed and re-created per fetch.
    let tip = document.getElementById("report-tip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "report-tip";
      document.body.appendChild(tip);
    }
    return tip;
  }
  function hideReportTip() {
    const tip = document.getElementById("report-tip");
    if (tip) tip.style.display = "none";
  }
  function attachReportTip() {
    const panel = document.getElementById("report");
    // Delegation on the container itself — never replaced, only re-rendered by innerHTML —
    // survives every re-render, so the listeners attach exactly once at init. pointermove
    // positions the chip in viewport coordinates (matching position:fixed) and measures it
    // AFTER showing it, so the flip to the cursor's other side is exact within 12 px of the
    // viewport's right/bottom edge; pointerleave hides it when the pointer leaves the panel
    // (switching tabs fires it, since the nav-link click moves the pointer out first).
    panel.addEventListener("pointermove", (ev) => {
      const target = ev.target instanceof Element ? ev.target.closest("rect") : null;
      const title = target ? target.querySelector("title")?.textContent : "";
      if (!title) { hideReportTip(); return; }
      const tip = reportTipElement();
      tip.textContent = title;
      tip.style.display = "block";
      let left = ev.clientX + 12;
      let top = ev.clientY + 12;
      const box = tip.getBoundingClientRect();
      if (left + box.width > window.innerWidth) left = ev.clientX - box.width - 12;
      if (top + box.height > window.innerHeight) top = ev.clientY - box.height - 12;
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    });
    panel.addEventListener("pointerleave", () => hideReportTip());
  }
  // report-tip:end

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

  // Fetch the report on tab activation and render summary + four charts into #report.
  async function fetchReport() {
    const panel = document.getElementById("report");
    try {
      const d = await getJson("/api/report?days=14");
      const block = (title, svg) => "<div class='chartblock'><div class='charttitle'>" + title + "</div>" + svg + "</div>";
      panel.innerHTML = "<div class='stats'>" + reportSummary(d) + "</div>" +
        block("Output tokens per day", chartTokens(d)) +
        block("Ticks per day by role", chartTicksByRole(d)) +
        block("Commits per day", chartCommits(d)) +
        block("Cost per day by role", chartCostByRole(d));
    } catch (e) {
      // A failed poll is no longer a bare "unavailable": the apiError message names the
      // endpoint, status, and the server's error (a network failure says Failed to fetch).
      panel.innerHTML = "<span class='muted'>report unavailable" + (e && e.message ? " — " + esc(e.message) : "") + "</span>";
    }
  }
`;
