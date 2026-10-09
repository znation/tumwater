/** The dashboard's Usage and Failures views, browser-side. Usage renders /api/report as six
 * totals (each with its per-day average) over four daily bar charts — landed commits, ticks by
 * loop, output tokens, spend by loop — with gridlines, a scale, and one shared color per loop;
 * a window picker switches between 7, 14, 30, and 90 days. Failures renders the failure digest
 * (/api/failures, the Markdown `tumwater report --failures` prints) through the page's
 * Markdown renderer, over the same kind of window picker. Both fetch when their view opens,
 * on Refresh, and — Usage only, throttled — when new events arrive while it is open. The chart
 * builders are pure (report-chart region) and the hover chip is one shared element
 * (report-tip region); both are exercised in isolation by the tests. Spliced into
 * gui-client.ts's script, reaching its helpers (esc, getJson, icon, fmtTokens, fmtUsd,
 * renderMarkdown) through that concatenation. */
import { SPARSE_WINDOW_NOTE } from "../../events/event-window.js";

export const GUI_CLIENT_REPORT_JS = String.raw`// report-chart:start
  // One color per loop, assigned in the report's role order so a loop keeps its color across
  // both per-loop charts and the legend. Chosen to stay distinct on white and on gray-950.
  const REPORT_PALETTE = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#0ea5e9", "#a855f7", "#f97316", "#14b8a6",
    "#ec4899", "#84cc16", "#06b6d4", "#eab308", "#64748b", "#d946ef"];

  // Window totals per role — ticks desc, then name — so the legend and the stack order match
  // the Markdown report's "Ticks by role" line. Roles that only spent (no ticks) still count.
  function reportRoleOrder(data) {
    const byRole = {};
    for (const d of data.series) {
      for (const [role, n] of Object.entries(d.ticksByRole)) byRole[role] = (byRole[role] || 0) + n;
      for (const role of Object.keys(d.costByRole || {})) if (!(role in byRole)) byRole[role] = 0;
    }
    return Object.entries(byRole).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  // X-axis labels: MM-DD, thinned to at most seven, counted back from the newest day so today
  // always carries its label.
  function reportDayLabels(series) {
    const step = Math.ceil(series.length / 7);
    const last = series.length - 1;
    return series.map((d, i) => ((last - i) % step === 0 ? d.date.slice(5) : ""));
  }

  // The scale's top: a round number at or above the tallest bar (1/2/5 × 10^k), even for small
  // counts so the midline stays a whole number.
  function niceMax(v, integer) {
    if (!(v > 0)) return integer ? 2 : 1;
    if (integer && v <= 10) return Math.max(2, Math.ceil(v / 2) * 2);
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }

  const REPORT_W = 600;
  const REPORT_H = 190;
  const REPORT_PAD_L = 46;
  const REPORT_PAD_R = 6;
  const REPORT_PAD_T = 10;
  const REPORT_PAD_B = 24;

  // Shared bar geometry: one slot per day (zero days keep their space, so every chart's x-axis
  // lines up), a scale with a midline, and segmentsOf(day) → [{ value, color, title }] stacked
  // bottom-up. Each positive segment is a <rect> whose <title> is the hover chip's text.
  function reportSvg(series, segmentsOf, fmtAxis, integer) {
    const n = Math.max(1, series.length);
    const plotW = REPORT_W - REPORT_PAD_L - REPORT_PAD_R;
    const plotH = REPORT_H - REPORT_PAD_T - REPORT_PAD_B;
    const slotW = plotW / n;
    const barW = Math.max(3, Math.min(30, slotW * 0.62));
    const tallest = Math.max(0, ...series.map((d) => segmentsOf(d).reduce((a, s) => a + s.value, 0)));
    const max = niceMax(tallest, integer);
    const y = (v) => REPORT_PAD_T + plotH - (v / max) * plotH;
    const labels = reportDayLabels(series);
    let out = "<svg viewBox='0 0 " + REPORT_W + " " + REPORT_H + "' role='img'>";
    for (const f of [0, 0.5, 1]) {
      const gy = y(max * f).toFixed(1);
      out += "<line class='" + (f === 0 ? "axis" : "grid") + "' x1='" + REPORT_PAD_L + "' x2='" + (REPORT_W - REPORT_PAD_R) + "' y1='" + gy + "' y2='" + gy + "'/>";
      if (f === 0 || tallest > 0) out += "<text x='" + (REPORT_PAD_L - 8) + "' y='" + (Number(gy) + 4).toFixed(1) + "' text-anchor='end'>" + esc(fmtAxis(max * f)) + "</text>";
    }
    series.forEach((d, i) => {
      const x = REPORT_PAD_L + i * slotW + (slotW - barW) / 2;
      let stacked = 0;
      for (const s of segmentsOf(d)) {
        if (s.value <= 0) continue;
        const top = y(stacked + s.value);
        const h = Math.max(1, y(stacked) - top);
        out += "<rect x='" + x.toFixed(2) + "' y='" + top.toFixed(2) + "' width='" + barW.toFixed(2) + "' height='" + h.toFixed(2) + "' rx='2' fill='" + s.color + "'><title>" + esc(s.title) + "</title></rect>";
        stacked += s.value;
      }
      if (labels[i]) out += "<text x='" + (REPORT_PAD_L + i * slotW + slotW / 2).toFixed(2) + "' y='" + (REPORT_H - 6) + "' text-anchor='middle'>" + labels[i] + "</text>";
    });
    return out + "</svg>";
  }

  const countAxis = (v) => String(Math.round(v));

  function chartTokens(data) {
    return reportSvg(data.series, (d) => [{ value: d.tokensOut, color: "#6366f1", title: d.date + ": " + fmtTokens(d.tokensOut) + " output tokens" }],
      (v) => fmtTokens(Math.round(v)), true);
  }

  function chartCommits(data) {
    return reportSvg(data.series, (d) => [{ value: d.commits, color: "#10b981", title: d.date + ": " + plural(d.commits, "commit") + " landed" }],
      countAxis, true);
  }

  // Stacked bars, one color per role in reportRoleOrder's order (the first role at the bottom),
  // with a legend in the same order. Role names are dynamic (custom loops): escaped everywhere.
  function roleStackChart(data, field, fmt, fmtAxis, integer) {
    const roles = reportRoleOrder(data);
    const colorOf = (i) => REPORT_PALETTE[i % REPORT_PALETTE.length];
    const svg = reportSvg(
      data.series,
      (d) => roles.map(([role], i) => ({ value: d[field][role] || 0, color: colorOf(i), title: d.date + " · " + role + ": " + fmt(d[field][role] || 0) })),
      fmtAxis,
      integer,
    );
    const legend = roles.length
      ? "<div class='legend'>" + roles.map(([role], i) => "<span><span class='swatch' style='background:" + colorOf(i) + "'></span>" + esc(role) + "</span>").join("") + "</div>"
      : "";
    return svg + legend;
  }

  function chartTicksByRole(data) {
    return roleStackChart(data, "ticksByRole", (n) => plural(n, "tick"), countAxis, true);
  }

  function chartCostByRole(data) {
    return roleStackChart(data, "costByRole", fmtUsd, (v) => (v === 0 ? "$0" : fmtUsd(v)), false);
  }
  // report-chart:end

  // report-tip:start
  // Hover label for the charts: one cursor-following chip showing the hovered segment's
  // <title> — the same text the builders escape — so the chip cannot drift from the chart. It
  // lives on document.body (the view re-renders its own content), is created on first use, and
  // hides over anything that is not a titled bar.
  function reportTipElement() {
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
    panel.addEventListener("pointermove", (ev) => {
      const target = clickClosest(ev, "rect");
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

  // The six totals above the charts, each with its average per day of the window.
  function reportSummary(data) {
    const t = data.totals;
    const days = Math.max(1, Number(data.days) || data.series.length || 1);
    const tile = (label, ic, value, perDay, extra) => "<div class='stat'><span class='stat-label'>" + icon(ic) + esc(label) +
      "</span><span class='stat-value'>" + esc(value) + "</span><span class='stat-sub'>" + esc(perDay + " a day" + (extra || "")) + "</span></div>";
    return [
      tile("Commits landed", "merge", String(t.commits), "≈ " + (t.commits / days).toFixed(1),
        " · " + (t.workCommits ?? 0) + " work / " + (t.maintenanceCommits ?? 0) + " maintenance"),
      tile("Features done", "plan", String(t.featuresDone), "≈ " + (t.featuresDone / days).toFixed(1)),
      tile("Bugs fixed", "bug", String(t.bugsFixed), "≈ " + (t.bugsFixed / days).toFixed(1)),
      tile("Ticks", "refresh", String(t.ticks), "≈ " + Math.round(t.ticks / days)),
      tile("Output tokens", "bars", fmtTokens(t.tokensOut), "≈ " + fmtTokens(Math.round(t.tokensOut / days))),
      tile("Spent", "dollar", fmtUsd(t.costUsd), "≈ " + fmtUsd(t.costUsd / days)),
    ].join("");
  }

  // view-scaffold:start
  // The window pickers' choices and the views' shared head (title, blurb, picker, Refresh).
  function viewHead(title, blurb, pickerId, choices, current, refreshId) {
    // A dropped blurb renders as no subtitle at all, never the string "undefined".
    return "<div class='view-head'><div><h1>" + esc(title) + "</h1>" +
      (blurb ? "<p>" + esc(blurb) + "</p>" : "") + "</div><div class='toolbar'>" +
      "<div class='seg' id='" + pickerId + "'>" + choices.map((n) => "<button type='button' data-days='" + n + "' class='" +
        (n === current ? "active" : "") + "'>" + n + " days</button>").join("") + "</div>" +
      "<button type='button' class='btn btn-sm' id='" + refreshId + "'>" + icon("refresh") + "Refresh</button></div></div>";
  }
  // One day-window view, the shape Usage and Failures share: a lazily built panel (shared head
  // with a window picker and Refresh, body holding a Loading… placeholder until the first
  // render), the picker's active choice re-marked on every fetch, a GET of the view's endpoint
  // at ?days=<days> rendered into the body — with an error panel naming the view on failure —
  // optional 60-second throttling (Usage's event-driven refetch), and click wiring for the
  // picker's data-days buttons (persisted through recall/store) and the Refresh button. The
  // views differ only in endpoint, body renderer, and titles.
  function windowView(o) {
    let days = Number(recall(o.key)) || o.defaultDays;
    let fetchedAt = 0;
    async function fetchView(throttled) {
      if (throttled && Date.now() - fetchedAt < 60000) return;
      fetchedAt = Date.now();
      const panel = $(o.panelId);
      if (!panel.dataset.built) {
        panel.dataset.built = "1";
        panel.innerHTML = viewHead(o.title, o.blurb, o.pickerId, o.choices, days, o.refreshId) +
          "<div id='" + o.bodyId + "'><div class='empty'>Loading…</div></div>";
      }
      markActive($(o.pickerId), "days", days);
      try {
        $(o.bodyId).innerHTML = o.render(await getJson(o.endpoint(days)));
      } catch (e) {
        // Name the view, status, and server error rather than a bare "unavailable".
        $(o.bodyId).innerHTML = errorPanel(o.errorTitle, e, "card empty");
      }
    }
    function wireClicks(container) {
      container.addEventListener("click", (ev) => {
        const b = clickClosest(ev, "[data-days]");
        if (b) {
          days = Number(b.dataset.days);
          store(o.key, String(days));
          fetchView();
          return;
        }
        if (clickClosest(ev, "#" + o.refreshId)) fetchView();
      });
    }
    return { fetch: fetchView, wireClicks };
  }

  const usage = windowView({
    panelId: "report", title: "Usage", bodyId: "usagebody",
    blurb: "What the fleet produced and what it cost, per day and per loop.",
    pickerId: "usagewindow", choices: [7, 14, 30, 90], refreshId: "usagerefresh",
    key: "usage-days", defaultDays: 14, errorTitle: "Usage report unavailable",
    endpoint: (days) => "/api/report?days=" + days,
    render: (d) => {
      const block = (title, svg) => "<section class='card chart-card'><header class='card-head'><h2>" + esc(title) +
        "</h2><span class='muted'>per day</span></header><div class='chart'>" + svg + "</div></section>";
      return "<div class='stats six'>" + reportSummary(d) + "</div><div class='grid-2 even'>" +
        block("Landed commits", chartCommits(d)) + block("Ticks by loop", chartTicksByRole(d)) +
        block("Output tokens", chartTokens(d)) + block("Spend by loop", chartCostByRole(d)) + "</div>" +
        // The truncation note rides the window caption, hedged the same way the CLI and TUI
        // renders phrase it: covered is false only when the oldest retained event lies inside
        // the window, so the sentence stays true whenever it prints. The sentence itself is
        // interpolated from SPARSE_WINDOW_NOTE (events/event-window.ts), the one home shared
        // with the CLI and TUI renders, so this copy cannot drift from theirs.
        (d.from ? "<p class='muted window-note'>" + esc(d.from + " → " + d.to) +
          (!d.coversFullWindow ? " · " + ${JSON.stringify(SPARSE_WINDOW_NOTE)} : "") + "</p>" : "");
    },
  });

  const failures = windowView({
    panelId: "failures", title: "Failures", bodyId: "failbody",
    blurb: "What went wrong, where, and how often — the digest the telemetry loop reads.",
    pickerId: "failwindow", choices: [7, 14, 30], refreshId: "failrefresh",
    key: "fail-days", defaultDays: 14, errorTitle: "Failure digest unavailable",
    endpoint: (days) => "/api/failures?days=" + days,
    render: (d) => {
      // The view head already titles the page, so the digest's own "# …" heading is dropped.
      const md = String(d.markdown || "").replace(/^# .*\n+/, "");
      return md.trim()
        ? "<article class='card md'>" + renderMarkdown(md, true) + "</article>"
        : "<div class='card empty'><strong>No failure digest</strong>Nothing has been recorded in this window.</div>";
    },
  });

  usage.wireClicks(document.getElementById("report"));
  failures.wireClicks(document.getElementById("failures"));

  // Named delegates gui-client-boot.ts's view routing calls — its tests inject stand-ins for
  // exactly these names, so the cross-chunk seam stays "these two functions exist".
  function fetchReport(throttled) { return usage.fetch(throttled); }
  function fetchFailures() { return failures.fetch(); }
  // view-scaffold:end
`;
