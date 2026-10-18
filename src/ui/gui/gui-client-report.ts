// vocabulary: plain
/** The dashboard's Usage and Failures views, browser-side. Usage renders /api/report as six
 * totals (each with its per-day average) over five daily bar charts — merged commits, ticks by
 * loop, output tokens, spend by loop, rejections by loop — with gridlines, a scale, and one
 * shared color per loop; a window picker switches between 7, 14, 30, and 90 days and a
 * Loop picker scopes the report to one loop group (`?role=`, the browser twin of
 * `tumwater report --role`). Both pickers also
 * carry trailing-window buttons (1h/6h/1d, `?sinceMs=`, the browser twin of `tumwater report
 * --since`), so the day and sub-day shapes read through the same collectors and renders as the
 * CLI; the since shape draws the returned Markdown instead of the charts. Failures renders
 * the failure digest (/api/failures, the Markdown `tumwater report --failures` prints) through
 * the page's Markdown renderer, over the same kind of window and Loop pickers. Both fetch when
 * their view opens, on Refresh, and — Usage only, throttled — when new events arrive while it
 * is open. The chart builders are pure (report-chart region), the hover chip is one shared
 * element (report-tip region), and the Loop picker's options are pure (report-role region);
 * all are exercised in isolation by the tests. Spliced into gui-client.ts's script, reaching
 * its helpers (esc, getJson, icon, fmtTokens, fmtUsd, renderMarkdown) through that
 * concatenation. */
import { SPARSE_WINDOW_NOTE } from "../../events/event-window.js";

export const GUI_CLIENT_REPORT_JS = String.raw`// report-chart:start
  // One color per loop, assigned in the report's role order so a loop keeps its color across
  // both per-loop charts and the legend. Chosen to stay distinct on white and on gray-950.
  const REPORT_PALETTE = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#0ea5e9", "#a855f7", "#f97316", "#14b8a6",
    "#ec4899", "#84cc16", "#06b6d4", "#eab308", "#64748b", "#d946ef"];

  // One [key, total][] for a day series, ordered by total desc then name asc — the shared
  // shape of the role/provider/model orderings. sumFields are the fields that contribute a
  // running total (runsByRole, costByProvider, runsByModel); seedFields are fields whose
  // PRESENCE alone earns a category a 0 row (a loop that only merged or only spent, a
  // provider that only spent notionally) without adding to its total — the split that lets
  // the real-spend charts read 0 for a notional-only provider while still listing it. Every
  // field's keys also seed a 0 when absent, so a category some day carried keeps its row on
  // days (and in fields) that lack it. Keys are dynamic (roles, providers, models), so reads
  // and seeds use Object.hasOwn as each ordering did.
  function tallyAcross(series, sumFields, seedFields) {
    const by = {};
    for (const d of series) {
      for (const field of sumFields) {
        for (const [k, n] of Object.entries(d[field] || {})) by[k] = (Object.hasOwn(by, k) ? by[k] : 0) + n;
      }
      for (const field of [...sumFields, ...seedFields]) {
        for (const k of Object.keys(d[field] || {})) if (!Object.hasOwn(by, k)) by[k] = 0;
      }
    }
    return Object.entries(by).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  // Window totals per role — ticks desc, then name — so the legend and the stack order match
  // the Markdown report's "Ticks by role" line. Roles that only spent (no ticks) still count.
  // Reads and seeds use Object.hasOwn: the custom-loop name charset admits "constructor", an
  // Object.prototype key whose inherited value would otherwise seed the counter and satisfy
  // the membership test (the browser twin of addTo's fix; BUGS.md 2026-10-10).
  function reportRoleOrder(data) {
    return tallyAcross(data.series, ["runsByRole"], ["costByRole", "notionalByRole", "rejectionsByRole", "revisionsByRole", "fallbacksByRole", "imageReroutesByRole", "failedRunsByRole", "mergeFailedByRole", "commitsByRole", "mergedByRole"]);
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
    return reportSvg(data.series, (d) => [{ value: d.commits, color: "#10b981", title: d.date + ": " + plural(d.commits, "commit") + " merged" }],
      countAxis, true);
  }

  // The day's merged commits per base role, the per-role split of the Merged commits total
  // it sits beside (same roleStackChart shape, palette, legend order and integer count axis
  // as the other role charts). Counts merged events, one per change in a stacked fast-forward.
  function chartCommitsByRole(data) {
    return roleStackChart(data, "commitsByRole", (n) => plural(n, "commit"), countAxis, true);
  }

  // The day's work vs maintenance commits, from workCommits/maintenanceCommits (the same split
  // foldUsageEvent's totals carry): work (feature/bugfix/director) at the bottom, maintenance
  // (code-maintenance/readme) above. This shows only the tiered counts — plan, steward,
  // observer and custom/legacy roles are untiered and count toward the total commits chart
  // alone, so the two tiers need not sum to chartCommits. The Number(...) || 0 guard covers
  // older or hand-built report rows that omit the fields.
  function chartCommitTiers(data) {
    return reportSvg(data.series, (d) => [
      { value: Number(d.workCommits) || 0, color: "#10b981", title: d.date + ": " + plural(Number(d.workCommits) || 0, "work commit") },
      { value: Number(d.maintenanceCommits) || 0, color: "#94a3b8", title: d.date + ": " + plural(Number(d.maintenanceCommits) || 0, "maintenance commit") },
    ], countAxis, true);
  }

  // The lower median of the day's passing full-suite merge checks, from checkMedianMs; a day
  // without one keeps its empty slot.
  function chartCheckMedian(data) {
    return reportSvg(data.series, (d) => [{ value: Number(d.checkMedianMs) || 0, color: "#0ea5e9", title: d.date + ": " + fmtSpan(Number(d.checkMedianMs) || 0) + " median merge check" }],
      (v) => fmtSpan(v), false);
  }

  // The day's failed full-suite checks, from checkFailures; a day without one keeps its empty
  // slot, as chartCheckMedian does.
  function chartCheckFailures(data) {
    return reportSvg(data.series, (d) => [{ value: Number(d.checkFailures) || 0, color: "#ef4444", title: d.date + ": " + plural(Number(d.checkFailures) || 0, "red merge check") }],
      countAxis, true);
  }

  // The lower median of the day's merge waits, enqueue to merged on main, from mergeWaitMedianMs;
  // a day without one keeps its empty slot.
  function chartMergeWaitMedian(data) {
    return reportSvg(data.series, (d) => [{ value: Number(d.mergeWaitMedianMs) || 0, color: "#f59e0b", title: d.date + ": " + fmtSpan(Number(d.mergeWaitMedianMs) || 0) + " median merge wait" }],
      (v) => fmtSpan(v), false);
  }

  // The lower median of the day's provider-slot waits, from providerWaitMedianMs; a day
  // without one keeps its empty slot, as chartMergeWaitMedian does.
  function chartProviderWaitMedian(data) {
    return reportSvg(data.series, (d) => [{ value: Number(d.providerWaitMedianMs) || 0, color: "#a855f7", title: d.date + ": " + fmtSpan(Number(d.providerWaitMedianMs) || 0) + " median provider wait" }],
      (v) => fmtSpan(v), false);
  }

  // The lower median of the day's workspace-slot waits, from slotWaitMedianMs; a day
  // without one keeps its empty slot, as chartProviderWaitMedian does.
  function chartSlotWaitMedian(data) {
    return reportSvg(data.series, (d) => [{ value: Number(d.slotWaitMedianMs) || 0, color: "#22c55e", title: d.date + ": " + fmtSpan(Number(d.slotWaitMedianMs) || 0) + " median workspace wait" }],
      (v) => fmtSpan(v), false);
  }

  // Window totals per provider — spend desc, then name — so both provider charts share one
  // color and one legend position, the dashboard twin of the day report's "Cost by provider".
  // Provider keys are dynamic seams, so reads and seeds use Object.hasOwn as reportRoleOrder
  // does; a provider that only spent notionally still counts.
  function reportProviderOrder(data) {
    return tallyAcross(data.series, ["costByProvider"], ["notionalByProvider"]);
  }

  // Window tallies per model — run count desc, then name — so the "Runs by model" chart
  // matches the day report's line ordering. Model keys are dynamic selectors, so reads and
  // seeds use Object.hasOwn as reportProviderOrder does; a model a day series never started
  // on still gets a row only if some day carries it.
  function reportModelOrder(data) {
    return tallyAcross(data.series, ["runsByModel"], []);
  }

  // Window tallies per merge-failure reason code, count desc then code asc — the reason
  // twin of reportModelOrder, so the "Merge failures by reason" chart matches the day
  // report's line ordering. Reason keys are dynamic (result strings), so reads and seeds use
  // Object.hasOwn as reportModelOrder does; a code a day series never failed with still gets
  // a row only if some day carries it.
  function reportMergeFailureOrder(data) {
    const byReason = {};
    for (const d of data.series) {
      for (const [reason, n] of Object.entries(d.mergeFailedByReason || {})) byReason[reason] = (Object.hasOwn(byReason, reason) ? byReason[reason] : 0) + n;
      for (const reason of Object.keys(d.mergeFailedByReason || {})) if (!Object.hasOwn(byReason, reason)) byReason[reason] = 0;
    }
    return Object.entries(byReason).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  // Stacked bars, one color per entry in the caller's order (the first at the bottom), with a
  // legend in the same order. entries is the ordered [key, total][] list that drives the
  // colors, stack order, and legend; keys are dynamic (roles, providers): escaped everywhere.
  function stackChart(data, entries, field, fmt, fmtAxis, integer) {
    const colorOf = (i) => REPORT_PALETTE[i % REPORT_PALETTE.length];
    const svg = reportSvg(
      data.series,
      (d) => entries.map(([key], i) => {
        // hasOwn again: an absent key must read 0, not Object.prototype's inherited value.
        const m = d[field] || {};
        const value = Object.hasOwn(m, key) ? m[key] : 0;
        return { value, color: colorOf(i), title: d.date + " · " + key + ": " + fmt(value) };
      }),
      fmtAxis,
      integer,
    );
    const legend = entries.length
      ? "<div class='legend'>" + entries.map(([key], i) => "<span><span class='swatch' style='background:" + colorOf(i) + "'></span>" + esc(key) + "</span>").join("") + "</div>"
      : "";
    return svg + legend;
  }

  // Stacked bars, one color per role in reportRoleOrder's order (the first role at the
  // bottom), with a legend in the same order. Role names are dynamic (custom loops): escaped
  // everywhere. The role-keyed form of stackChart.
  function roleStackChart(data, field, fmt, fmtAxis, integer) {
    return stackChart(data, reportRoleOrder(data), field, fmt, fmtAxis, integer);
  }

  function chartTicksByRole(data) {
    return roleStackChart(data, "runsByRole", (n) => plural(n, "run"), countAxis, true);
  }

  function chartCostByRole(data) {
    return roleStackChart(data, "costByRole", fmtUsd, (v) => (v === 0 ? "$0" : fmtUsd(v)), false);
  }

  // The day's output tokens, per loop, the dashboard twin of the CLI "Tokens by role" line.
  function chartTokensByRole(data) {
    return roleStackChart(data, "tokensByRole", (n) => fmtTokens(Number(n) || 0) + " output tokens", (v) => fmtTokens(Math.round(v)), true);
  }

  // The API-equivalent (notional) spend of subscription runs, per loop, on the same axis as
  // the cap spend.
  function chartNotionalByRole(data) {
    return roleStackChart(data, "notionalByRole", fmtUsd, (v) => (v === 0 ? "$0" : fmtUsd(v)), false);
  }

  // The team's real spend, per day, stacked by provider: each segment one (day, provider), on
  // the same axis as the role spend. Both provider maps are sparse, so a day with none keeps
  // its empty slot, as the role charts do.
  function chartCostByProvider(data) {
    return stackChart(data, reportProviderOrder(data), "costByProvider", fmtUsd, (v) => (v === 0 ? "$0" : fmtUsd(v)), false);
  }

  // The team's run starts, per day, stacked by model: each segment one (day, model), the
  // dashboard twin of the day report's "Runs by model" line. Sparse like the provider charts.
  function chartRunsByModel(data) {
    return stackChart(data, reportModelOrder(data), "runsByModel", (n) => plural(n, "run"), countAxis, true);
  }

  // The API-equivalent (notional) spend of subscription runs, per provider, on the same axis
  // as the estimated role spend; the provider twin of chartNotionalByRole.
  function chartNotionalByProvider(data) {
    return stackChart(data, reportProviderOrder(data), "notionalByProvider", fmtUsd, (v) => (v === 0 ? "$0" : fmtUsd(v)), false);
  }

  // The team's review friction, per loop, on a tick-like count axis: one segment per
  // (day, loop) with a rejection, empty when the report has none.
  function chartRejectionsByRole(data) {
    return roleStackChart(data, "rejectionsByRole", (n) => plural(n, "rejection"), countAxis, true);
  }
  // Revisions (rework rounds after a rejection), per loop, drawn the same way.
  function chartRevisionsByRole(data) {
    return roleStackChart(data, "revisionsByRole", (n) => plural(n, "revision"), countAxis, true);
  }
  // The team's model-fallback episodes, per loop, on the same count axis: one segment per
  // (day, loop) with a fallback.
  function chartFallbacksByRole(data) {
    return roleStackChart(data, "fallbacksByRole", (n) => plural(n, "fallback"), countAxis, true);
  }
  // Image reroutes per loop, drawn the same way: one segment per (day, loop) with a reroute.
  function chartImageReroutesByRole(data) {
    return roleStackChart(data, "imageReroutesByRole", (n) => plural(n, "image reroute"), countAxis, true);
  }
  // Runs that ended in an error, per loop, drawn the same way.
  function chartFailedRunsByRole(data) {
    return roleStackChart(data, "failedRunsByRole", (n) => plural(n, "failed run"), countAxis, true);
  }
  // Merges that were blocked or conflicted, per loop, drawn the same way.
  function chartMergeFailuresByRole(data) {
    return roleStackChart(data, "mergeFailedByRole", (n) => plural(n, "merge failure"), countAxis, true);
  }
  // WHY merges failed, per reason code (each merge_failed's result), drawn the same way as
  // the by-role chart so the two read as a pair; the reason codes' own ordering comes from
  // reportMergeFailureOrder.
  function chartMergeFailuresByReason(data) {
    return stackChart(data, reportMergeFailureOrder(data), "mergeFailedByReason", (n) => plural(n, "merge failure"), countAxis, true);
  }
  // The day's merged outcomes per loop, the success sibling of chartMergeFailuresByRole,
  // drawn exactly like it (same roleStackChart shape, palette, legend order and integer count
  // axis) so the two read as one pair.
  function chartMergedByRole(data) {
    return roleStackChart(data, "mergedByRole", (n) => plural(n, "merge"), countAxis, true);
  }
  // The day's backlog items: features done stacked at the bottom and bugs fixed above them,
  // from featuresDone/bugsFixed (day-granular backlog-file done dates, so a role scope zeroes
  // them); a day with neither keeps its empty slot.
  function chartBacklogItems(data) {
    return reportSvg(data.series, (d) => [
      { value: Number(d.featuresDone) || 0, color: "#6366f1", title: d.date + ": " + plural(Number(d.featuresDone) || 0, "feature") + " done" },
      { value: Number(d.bugsFixed) || 0, color: "#ef4444", title: d.date + ": " + plural(Number(d.bugsFixed) || 0, "bug") + " fixed" },
    ], countAxis, true);
  }
  // True when some day carries a map under field with an own value above zero; both counts
  // are rare, so their elements render only then.
  function seriesHasAny(data, field) {
    return data.series.some((d) => Object.values(d[field] || {}).some((n) => n > 0));
  }
  // The per-day filing-stamp twin of chartBacklogItems: plans added and bugs filed, the same
  // two colors as the done chart so the opened and done charts read as a pair. A day with
  // neither carries an empty slot, and zero segments draw no rect.
  function chartBacklogItemsOpened(data) {
    return reportSvg(data.series, (d) => [
      { value: Number(d.plansAdded) || 0, color: "#6366f1", title: d.date + ": " + plural(Number(d.plansAdded) || 0, "plan") + " added" },
      { value: Number(d.bugsFiled) || 0, color: "#ef4444", title: d.date + ": " + plural(Number(d.bugsFiled) || 0, "bug") + " filed" },
    ], countAxis, true);
  }
  // True when some day carries a feature or bug count; the gate for the backlog chart, whose
  // tally a role-scoped report zeroes, so the element stays out exactly where the two tiles are.
  function seriesHasBacklogItems(data) {
    return data.series.some((d) => Number(d.featuresDone) > 0 || Number(d.bugsFixed) > 0);
  }
  // True when some day carries a filing count; the gate for the opened chart, the sibling of
  // seriesHasBacklogItems, hidden the same way on a role-scoped series.
  function seriesHasBacklogAdded(data) {
    return data.series.some((d) => Number(d.plansAdded) > 0 || Number(d.bugsFiled) > 0);
  }
  // True when some day carries a passing-check median; the element renders only then.
  function seriesHasCheckMedian(data) {
    return data.series.some((d) => Number(d.checkMedianMs) > 0);
  }
  // True when some day carries a count of failed full-suite checks; the red sibling of
  // seriesHasCheckMedian, the element renders only then.
  function seriesHasCheckFailures(data) {
    return data.series.some((d) => Number(d.checkFailures) > 0);
  }
  // True when some day carries a merge-wait median; the element renders only then.
  function seriesHasMergeWaitMedian(data) {
    return data.series.some((d) => Number(d.mergeWaitMedianMs) > 0);
  }
  // True when some day carries a provider-wait median; the element renders only then.
  function seriesHasProviderWaitMedian(data) {
    return data.series.some((d) => Number(d.providerWaitMedianMs) > 0);
  }
  // True when some day carries a workspace-wait median; the element renders only then.
  function seriesHasSlotWaitMedian(data) {
    return data.series.some((d) => Number(d.slotWaitMedianMs) > 0);
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
    // The per-day average every tile's sub-line carries: the shared "≈ " prefix and division by
    // the window's day count, with the tile's own formatter for the quotient (counts keep one
    // decimal, ticks and tokens round, money reuses fmtUsd). One home for the prefix and the
    // divisor, so the six tiles cannot drift on how an average is stated.
    const perDay = (value, fmt) => "≈ " + fmt(value / days);
    const tile = (label, ic, value, avg, extra) => "<div class='stat'><span class='stat-label'>" + icon(ic) + esc(label) +
      "</span><span class='stat-value'>" + esc(value) + "</span><span class='stat-sub'>" + esc(avg + " a day" + (extra || "")) + "</span></div>";
    return [
      tile("Commits merged", "merge", String(t.commits), perDay(t.commits, (v) => v.toFixed(1)),
        " · " + workSplit(t)),
      // A role scope has no backlog tallies: features/bugs come from day-granular backlog-file
      // dates that carry no role, so the scoped collector zeroes them and the tiles stay out —
      // the Usage render's scope line states the omission instead.
      ...(data.role ? [] : [
        tile("Features done", "plan", String(t.featuresDone), perDay(t.featuresDone, (v) => v.toFixed(1))),
        tile("Bugs fixed", "bug", String(t.bugsFixed), perDay(t.bugsFixed, (v) => v.toFixed(1))),
      ]),
      tile("Runs", "refresh", String(t.runs), perDay(t.runs, Math.round)),
      tile("Output tokens", "bars", fmtTokens(t.tokensOut), perDay(t.tokensOut, (v) => fmtTokens(Math.round(v)))),
      tile("Spent", "dollar", fmtUsd(t.costUsd), perDay(t.costUsd, fmtUsd),
        t.notionalCostUsd > 0 ? " · " + fmtUsd(t.notionalCostUsd) + " estimated" : undefined),
    ].join("");
  }

  // report-role:start
  // The Loop picker's options: the team-wide "All loops" empty option plus one option per
  // role, in the team's own order. syncRolePicker escapes every role through it, so the three
  // Loop pickers (the report views', History's, and the Activity feed's) render role names the
  // same way — role names are dynamic (custom loops) and the custom-loop charset admits HTML
  // metacharacters. Pure, so a test can drive it without a DOM.
  function rolePickerOptions(roles) {
    return "<option value=''>All roles</option>" +
      (roles || []).map((r) => "<option value='" + esc(r) + "'>" + esc(r) + "</option>").join("");
  }
  // Repaint one Loop picker from the team's role list, returning the scope to keep filtering
  // with. Every picker (the report views' syncRoles, History's syncHistoryRoles, the Activity
  // feed's syncFeedRoles) does the same thing: rebuild only when the roster changes, keep the
  // persisted choice while the team still lists it, and fall back to All loops — persisting
  // that fallback — when it does not, so a dimmed picker never scopes the request to a ghost
  // loop. The last-painted roster is tracked per select id, so the pickers never share a key.
  const rolePickerKeys = {};
  function syncRolePicker(selectId, roles, current, storeKey) {
    const select = $(selectId);
    if (!select) return current;
    const key = roles.join(",");
    if (key === rolePickerKeys[selectId]) return current;
    rolePickerKeys[selectId] = key;
    select.innerHTML = rolePickerOptions(roles);
    select.value = roles.includes(current) ? current : "";
    if (select.value !== current) {
      store(storeKey, select.value);
      return select.value;
    }
    return current;
  }
  // The report views' Loop picker offers base roles only: the scoped collectors
  // (collectReport/collectFailureReport) fold an instance id (feature-2) into its base role, so
  // an instance option would collect the base role's whole body under the instance's name — the
  // GUI twin of the TUI's Ctrl+G scope cycle (src/ui/tui/tui-keys.ts scopeCycle). The status
  // payload already carries the base role as instanceOf on an instance row (src/status/
  // status-data.ts), so this borrows the server's own fold rather than re-deriving it. History's
  // picker (gui-client-history.ts) filters by exact loop id and keeps the raw team list. Pure,
  // so a test can drive it without a DOM.
  function reportBaseRoles(loops) {
    const bases = [];
    for (const l of loops || []) {
      const base = l.instanceOf || l.role;
      if (!bases.includes(base)) bases.push(base);
    }
    return bases;
  }
  // Repaint both report views' Loop pickers from a status payload: each view's persisted
  // choice is kept while the team still lists it and falls back to All loops otherwise. The
  // views are defined below; the boot poll and each fetch call this once they exist.
  function syncReportRoles(d) {
    for (const view of [usage, failures]) view.syncRoles(d);
  }
  // report-role:end

  // view-scaffold:start
  // The window pickers' choices and the views' shared head (title, blurb, picker, Refresh).
  function viewHead(title, blurb, pickerId, choices, current, refreshId, rolePickerId, sinceChoices) {
    // A dropped blurb renders as no subtitle at all, never the string "undefined". The Loop
    // picker rides the toolbar when the view has one (the shared Usage/Failures shape); the
    // options are filled by syncRoles from the team's role list. The trailing-window buttons
    // (a view that configured sinceChoices) sit in the same segmented control after the day
    // buttons; each carries its length as data-since so windowView can mark exactly one active.
    const rolePicker = rolePickerId
      ? "<label><span class='sr-only'>Role</span><select class='field' id='" + rolePickerId + "' data-role='1'><option value=''>All roles</option></select></label>"
      : "";
    const sinceButtons = (sinceChoices || []).map(([ms, label]) =>
      "<button type='button' data-since='" + ms + "'>" + esc(String(label)) + "</button>").join("");
    return "<div class='view-head'><div><h1>" + esc(title) + "</h1>" +
      (blurb ? "<p>" + esc(blurb) + "</p>" : "") + "</div><div class='toolbar'>" + rolePicker +
      "<div class='seg' id='" + pickerId + "'>" + choices.map((n) => "<button type='button' data-days='" + n + "' class='" +
        (n === current ? "active" : "") + "'>" + n + " days</button>").join("") + sinceButtons + "</div>" +
      "<button type='button' class='btn btn-sm' id='" + refreshId + "'>" + icon("refresh") + "Refresh</button></div></div>";
  }
  // The window-view scaffold Usage and Failures share: a lazily built panel (shared head
  // with a window picker and Refresh, body holding a Loading… placeholder until the first
  // render), the picker's active choice re-marked on every fetch, a GET of the view's endpoint
  // (o.endpoint selects the day or since shape) rendered into the body — with an error panel
  // naming the view on failure — optional 60-second throttling (Usage's event-driven refetch),
  // and click wiring for the picker's data-days and data-since buttons (persisted through
  // recall/store, each clearing the other so exactly one window shape is live) and the Refresh
  // button. Usage and Failures are two configurations of this one scaffold.
  function windowView(o) {
    // The persisted day window, normalized to one of the picker's choices at read. A stored value
    // outside the menu (a stale or hand-edited localStorage entry) would leave no button marked
    // while the fetch still asked for it, and the mismatch never healed; the view's default stands
    // in, so the request and the marked button always agree.
    const dayChoice = Number(recall(o.key));
    let days = o.choices.includes(dayChoice) ? dayChoice : o.defaultDays;
    // The persisted trailing window (only a view that configured sinceChoices reads it): one of
    // the offered lengths, otherwise null so the day window is live and days is used on the fetch.
    // Normalized the same way, so an off-menu stored value cannot mark no since button while the
    // fetch still uses it.
    const sinceChoice = o.sinceChoices ? Number(recall(o.sinceKey)) : NaN;
    let sinceMs = (o.sinceChoices || []).some(([ms]) => ms === sinceChoice) ? sinceChoice : null;
    // The persisted Loop scope for this view: "" is the team-wide report. Only a view that
    // configured a rolePickerId reads it, so a view without a picker never touches storage.
    let role = o.roleKey ? recall(o.roleKey) || "" : "";
    let fetchedAt = 0;
    // Keep this view's Loop picker in step with the team's role list (custom loops included).
    function syncRoles(d) {
      if (!o.rolePickerId || !d) return;
      role = syncRolePicker(o.rolePickerId, reportBaseRoles(d.roles), role, o.roleKey);
    }
    async function fetchView(throttled) {
      if (throttled && Date.now() - fetchedAt < 60000) return;
      fetchedAt = Date.now();
      buildOnce(o.panelId, viewHead(o.title, o.blurb, o.pickerId, o.choices, days, o.refreshId, o.rolePickerId, o.sinceChoices) +
        "<div id='" + o.bodyId + "'><div class='empty'>Loading…</div></div>");
      // Exactly one of the two controls is active: a live since window clears the day buttons
      // (days → -1) and marks its own; otherwise the day window is the marked one.
      markActive($(o.pickerId), "days", sinceMs ? -1 : days);
      if (o.sinceChoices) markActive($(o.pickerId), "since", sinceMs || -1);
      syncRoles(lastStatus);
      try {
        $(o.bodyId).innerHTML = o.render(await getJson(o.endpoint(days, role, sinceMs)));
      } catch (err) {
        // Name the view, status, and server error rather than a bare "unavailable".
        $(o.bodyId).innerHTML = errorPanel(o.errorTitle, err, "card empty");
      }
    }
    function wireClicks(container) {
      if (o.rolePickerId) container.addEventListener("change", (ev) => {
        const select = clickClosest(ev, "select[data-role]");
        if (!select) return;
        role = select.value;
        store(o.roleKey, role);
        fetchView();
      });
      container.addEventListener("click", (ev) => {
        const s = clickClosest(ev, "[data-since]");
        if (s) {
          sinceMs = Number(s.dataset.since);
          store(o.sinceKey, String(sinceMs));
          fetchView();
          return;
        }
        const b = clickClosest(ev, "[data-days]");
        if (b) {
          // A day-window click clears a live trailing window, so the two cannot disagree
          // about which is in force; the empty string is the stored "no since" sentinel.
          sinceMs = null;
          store(o.sinceKey, "");
          days = Number(b.dataset.days);
          store(o.key, String(days));
          fetchView();
          return;
        }
        if (clickClosest(ev, "#" + o.refreshId)) fetchView();
      });
    }
    return { fetch: fetchView, wireClicks, syncRoles };
  }

  // The trailing-window lengths both report views offer, as [milliseconds, short label]. Usage
  // and Failures share one set, so their segmented controls always offer the same windows.
  const REPORT_SINCE_CHOICES = [[3_600_000, "1h"], [21_600_000, "6h"], [86_400_000, "1d"]];

  const usage = windowView({
    panelId: "report", title: "Usage", bodyId: "usagebody",
    blurb: "What the team produced and what it cost, per day and per role.",
    pickerId: "usagewindow", choices: [7, 14, 30, 90], refreshId: "usagerefresh",
    key: "usage-days", defaultDays: 14, roleKey: "usage-role", rolePickerId: "usagerole",
    sinceKey: "usage-since", sinceChoices: REPORT_SINCE_CHOICES,
    errorTitle: "Usage report unavailable",
    endpoint: (days, role, sinceMs) => (sinceMs ? "/api/report?sinceMs=" + sinceMs : "/api/report?days=" + days) +
      (role ? "&role=" + encodeURIComponent(role) : ""),
    render: (d) => {
      // The since shape is a Markdown totals report (the CLI's report --since render), not a
      // series: draw it through the page's Markdown renderer as the Failures tab does, dropping
      // the render's own "# …" heading since the view head already titles the page.
      if (d.markdown) {
        const md = String(d.markdown).replace(/^# .*\n+/, "");
        return "<article class='card md'>" + renderMarkdown(md, true) + "</article>";
      }
      const block = (title, svg, sub) => "<section class='card chart-card'><header class='card-head'><h2>" + esc(title) +
        "</h2><span class='muted'>" + esc(sub || "per day") + "</span></header><div class='chart'>" + svg + "</div></section>";
      // A scoped report drops to the four scoped tiles and says what it left out, mirroring the
      // CLI's --role report. The team-wide render is unchanged.
      return "<div class='stats" + (d.role ? "" : " six") + "'>" + reportSummary(d) + "</div><div class='grid-2 even'>" +
        block("Work vs maintenance commits", chartCommitTiers(d), "per day · work + maintenance") + block("Merged commits", chartCommits(d)) + block("Commits by role", chartCommitsByRole(d)) + (seriesHasBacklogAdded(d) ? block("Backlog items opened", chartBacklogItemsOpened(d), "per day · plans added + bugs filed") : "") + (seriesHasBacklogItems(d) ? block("Backlog items done", chartBacklogItems(d), "per day · features done + bugs fixed") : "") + block("Runs by role", chartTicksByRole(d)) +
        block("Output tokens", chartTokens(d)) + block("Tokens by role", chartTokensByRole(d)) + block("Spend by role", chartCostByRole(d)) +
        (!d.role && seriesHasAny(d, "costByProvider") ? block("Spend by provider", chartCostByProvider(d)) : "") +
        block("Rejections by role", chartRejectionsByRole(d)) +
        (seriesHasAny(d, "revisionsByRole") ? block("Revisions by role", chartRevisionsByRole(d)) : "") +
        (seriesHasAny(d, "fallbacksByRole") ? block("Fallbacks by role", chartFallbacksByRole(d)) : "") +
        (seriesHasAny(d, "imageReroutesByRole") ? block("Image reroutes by role", chartImageReroutesByRole(d)) : "") +
        (seriesHasAny(d, "failedRunsByRole") ? block("Failed runs by role", chartFailedRunsByRole(d)) : "") +
        (seriesHasAny(d, "mergedByRole") ? block("Merged by role", chartMergedByRole(d)) : "") +
        (!d.role && seriesHasAny(d, "runsByModel") ? block("Runs by model", chartRunsByModel(d)) : "") +
        (seriesHasAny(d, "mergeFailedByRole") ? block("Merge failures by role", chartMergeFailuresByRole(d)) : "") +
        (seriesHasAny(d, "mergeFailedByReason") ? block("Merge failures by reason", chartMergeFailuresByReason(d)) : "") +
        (seriesHasCheckMedian(d) ? block("Merge check median", chartCheckMedian(d), "per day · passing full-suite checks") : "") +
        (seriesHasCheckFailures(d) ? block("Red merge checks", chartCheckFailures(d), "per day · failed full-suite checks") : "") +
        (seriesHasMergeWaitMedian(d) ? block("Merge wait median", chartMergeWaitMedian(d), "per day · enqueue to merged on main") : "") +
        (seriesHasProviderWaitMedian(d) ? block("Provider wait median", chartProviderWaitMedian(d), "per day · waits of 30s or more for a provider slot") : "") +
        (seriesHasSlotWaitMedian(d) ? block("Workspace wait median", chartSlotWaitMedian(d), "per day · waits of 30s or more for a workspace") : "") +
        (d.totals.notionalCostUsd > 0
          ? block("Estimated spend by role", chartNotionalByRole(d), "per day · API-equivalent, not in the cap") : "") +
        (!d.role && seriesHasAny(d, "notionalByProvider") ? block("Estimated spend by provider", chartNotionalByProvider(d), "per day · API-equivalent, not in the cap") : "") + "</div>" +
        (d.role ? "<p class='muted scope-note'>Role scope: " + esc(d.role) +
          " · merge runs and backlog tallies (features done / bugs fixed / plans added / bugs filed) are team-wide and omitted.</p>" : "") +
        (d.from ? "<p class='muted window-note'>" + esc(d.from + " → " + d.to) +
          (!d.coversFullWindow ? " · " + ${JSON.stringify(SPARSE_WINDOW_NOTE)} : "") + "</p>" : "");
    },
  });

  const failures = windowView({
    panelId: "failures", title: "Failures", bodyId: "failbody",
    blurb: "What went wrong, where, and how often — the digest the selfcheck role reads.",
    pickerId: "failwindow", choices: [7, 14, 30], refreshId: "failrefresh",
    key: "fail-days", defaultDays: 14, roleKey: "fail-role", rolePickerId: "failrole",
    sinceKey: "fail-since", sinceChoices: REPORT_SINCE_CHOICES,
    errorTitle: "Failure digest unavailable",
    endpoint: (days, role, sinceMs) => (sinceMs ? "/api/failures?sinceMs=" + sinceMs : "/api/failures?days=" + days) +
      (role ? "&role=" + encodeURIComponent(role) : ""),
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
