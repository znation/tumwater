/** The dashboard Usage view's chart builders, browser-side: the report-chart region. Pure
 * functions from /api/report's day series to SVG strings — the per-day bar and stacked charts,
 * their role/provider/model orderings, the shared role palette, the has-data predicates that
 * decide which charts draw, the merge-share line's wording, and the cost-per-commit /
 * estimated-per-commit lines (costPerCommitParts, costPerCommitText, estimatedPerCommitText) —
 * with no DOM access, so the tests exercise them in isolation.
 * Spliced into gui-client.ts's script ahead of gui-client-report.ts's hover chip, Role picker,
 * and view code, which call them through that concatenation. */
import { INSTANCE_ID_SOURCE } from "../../roles/runner-ids.js";
export const GUI_CLIENT_REPORT_CHART_JS = String.raw`
// report-chart:start
  // One color per role, assigned in the report's role order so a role keeps its color across
  // both per-role charts and the legend. Chosen to stay distinct on white and on gray-950.
  const REPORT_PALETTE = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#0ea5e9", "#a855f7", "#f97316", "#14b8a6",
    "#ec4899", "#84cc16", "#06b6d4", "#eab308", "#64748b", "#d946ef"];

  // A [key, number][] ordering by total desc then key asc — the shared shape of every
  // role/provider/model ordering (tallyAcross's role/provider/model rows and costPerCommitParts's
  // mergeDone and idle pairs each spelled the b[1]-a[1] || a[0].localeCompare(b[0]) comparator
  // inline), so none of them can drift on the count-then-name rule.
  const byTotalThenName = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);

  // One [key, total][] for a day series, ordered by total desc then name asc — the shared
  // shape of the role/provider/model orderings. sumFields are the fields that contribute a
  // running total (runsByRole, costByProvider, runsByModel); seedFields are fields whose
  // PRESENCE alone earns a category a 0 row (a role that only merged or only spent, a
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
    return Object.entries(by).sort(byTotalThenName);
  }

  // Window totals per role — runs desc, then name — so the legend and the stack order match
  // the Markdown report's "Runs by role" line. Roles that only spent (no runs) still count.
  // Reads and seeds use Object.hasOwn: the custom-role name charset admits "constructor", an
  // Object.prototype key whose inherited value would otherwise seed the counter and satisfy
  // the membership test (the browser twin of addTo's fix; BUGS.md 2026-10-10).
  function reportRoleOrder(data) {
    return tallyAcross(data.series, ["runsByRole"], ["costByRole", "notionalByRole", "rejectionsByRole", "revisionsByRole", "refusalsByRole", "fallbacksByRole", "imageReroutesByRole", "failedRunsByRole", "mergeFailedByRole", "commitsByRole", "mergedByRole"]);
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

  // The lower-median bar for a duration field (check/merge-wait/merge-slot/run/review/
  // provider-wait/slot-wait/check-wait): one bar per day from that day's median ms, its hover
  // chip in the bar's color. Shared by the duration-median charts so the field/color/label
  // triple cannot drift.
  function medianBarChart(data, field, color, label) {
    return reportSvg(data.series, (d) => [{ value: Number(d[field]) || 0, color, title: d.date + ": " + fmtSpan(Number(d[field]) || 0) + " median " + label }],
      (v) => fmtSpan(v), false);
  }

  // The lower median of the day's passing full-suite merge checks, from checkMedianMs.
  function chartCheckMedian(data) {
    return medianBarChart(data, "checkMedianMs", "#0ea5e9", "merge check");
  }

  // The day's failed full-suite checks, from checkFailures; a day without one keeps its empty
  // slot, as chartCheckMedian does.
  function chartCheckFailures(data) {
    return reportSvg(data.series, (d) => [{ value: Number(d.checkFailures) || 0, color: "#ef4444", title: d.date + ": " + plural(Number(d.checkFailures) || 0, "red merge check") }],
      countAxis, true);
  }
  // Main's red wall-clock per day, from mainRedMs (the same main_check/main_red_hold rule G1
  // uses): the span main had no passing full check; a day without one keeps its empty slot,
  // like the median charts; the red color reads beside the red-check-count chart it follows.
  function chartMainRedMs(data) {
    return reportSvg(data.series, (d) => [{ value: Number(d.mainRedMs) || 0, color: "#dc2626", title: d.date + ": " + fmtSpan(Number(d.mainRedMs) || 0) + " main red" }],
      (v) => fmtSpan(v), false);
  }

  // The lower median of the day's merge waits, enqueue to merged on main, from mergeWaitMedianMs.
  function chartMergeWaitMedian(data) {
    return medianBarChart(data, "mergeWaitMedianMs", "#f59e0b", "merge wait");
  }

  // The lower median of the day's merge_done.durationMs, verification start to outcome, from
  // mergeSlotMedianMs: how long the merge slot itself held each change it landed.
  function chartMergeSlotMedian(data) {
    return medianBarChart(data, "mergeSlotMedianMs", "#64748b", "merge slot");
  }

  // The lower median of the day's run durations, from runMedianMs.
  function chartRunMedian(data) {
    return medianBarChart(data, "runMedianMs", "#14b8a6", "run duration");
  }

  // The lower median of the day's reviewer-run durations, from reviewMedianMs.
  function chartReviewMedian(data) {
    return medianBarChart(data, "reviewMedianMs", "#f43f5e", "review");
  }

  // The lower median of the day's finished-entry filing-to-done lags, from
  // backlogLagMedianDays (whole days from each finished plan or bug's filing stamp to its
  // done/fixed stamp). Whole-day values, so a plain Nd label is exact.
  function chartBacklogLagMedian(data) {
    return reportSvg(data.series, (d) => [{ value: Number(d.backlogLagMedianDays) || 0, color: "#0891b2", title: d.date + ": " + (Number(d.backlogLagMedianDays) || 0) + "d median backlog lag" }],
      (v) => Math.round(v) + "d", false);
  }

  // The lower median of the day's provider-slot waits, from providerWaitMedianMs.
  function chartProviderWaitMedian(data) {
    return medianBarChart(data, "providerWaitMedianMs", "#a855f7", "provider wait");
  }

  // The lower median of the day's check-slot waits, from checkWaitMedianMs.
  function chartCheckWaitMedian(data) {
    return medianBarChart(data, "checkWaitMedianMs", "#f97316", "check wait");
  }
  // The lower median of the day's workspace-slot waits, from slotWaitMedianMs.
  function chartSlotWaitMedian(data) {
    return medianBarChart(data, "slotWaitMedianMs", "#22c55e", "workspace wait");
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
  // report's line ordering. Reason keys are dynamic (result strings), so reads and seeds go
  // through tallyAcross's Object.hasOwn checks as reportModelOrder does; a code a day series
  // never failed with still gets a row only if some day carries it.
  function reportMergeFailureOrder(data) {
    return tallyAcross(data.series, ["mergeFailedByReason"], []);
  }

  // Window tallies per deferred-reason code, count desc then code asc — the reason twin of
  // reportModelOrder and reportMergeFailureOrder, so the "Deferred runs by reason" chart
  // matches the day report's line ordering, reusing the shared tallyAcross these dynamic-
  // keyed orders are built from.
  function reportDeferredOrder(data) {
    return tallyAcross(data.series, ["deferredByReason"], []);
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
  // bottom), with a legend in the same order. Role names are dynamic (custom roles): escaped
  // everywhere. The role-keyed form of stackChart.
  function roleStackChart(data, field, fmt, fmtAxis, integer) {
    return stackChart(data, reportRoleOrder(data), field, fmt, fmtAxis, integer);
  }

  function chartRunsByRole(data) {
    return roleStackChart(data, "runsByRole", (n) => plural(n, "run"), countAxis, true);
  }

  function chartCostByRole(data) {
    return roleStackChart(data, "costByRole", fmtUsd, (v) => (v === 0 ? "$0" : fmtUsd(v)), false);
  }

  // The day's output tokens, per role, the dashboard twin of the CLI "Tokens by role" line.
  function chartTokensByRole(data) {
    return roleStackChart(data, "tokensByRole", (n) => fmtTokens(Number(n) || 0) + " output tokens", (v) => fmtTokens(Math.round(v)), true);
  }

  // The day's prompt tokens, per role, the browser twin of the report's "Prompt tokens by
  // role" line — same roleStackChart shape, palette, legend order and integer count axis as
  // chartTokensByRole, so a role keeps its palette color and legend order from
  // reportRoleOrder.
  function chartPromptTokensByRole(data) {
    return roleStackChart(data, "promptTokensByRole", (n) => fmtTokens(Number(n) || 0) + " prompt tokens", (v) => fmtTokens(Math.round(v)), true);
  }

  // The day's cache-read prompt tokens, per role, the browser twin of the report's "Prompt
  // tokens by role" line's cache-read share — the same shape over cacheReadTokensByRole with
  // the " cached prompt tokens" label, keeping the same palette order and count axis.
  function chartCacheReadTokensByRole(data) {
    return roleStackChart(data, "cacheReadTokensByRole", (n) => fmtTokens(Number(n) || 0) + " cached prompt tokens", (v) => fmtTokens(Math.round(v)), true);
  }

  // The API-equivalent (notional) spend of subscription runs, per role, on the same axis as
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

  // The team's deferred maintenance runs, per day, stacked by reason: each segment one
  // (day, reason code), the dashboard twin of the day report's "Deferred runs by reason"
  // line. Sparse like the model chart; the reason codes are the legend labels.
  function chartDeferredByReason(data) {
    return stackChart(data, reportDeferredOrder(data), "deferredByReason", (n) => plural(n, "deferral"), countAxis, true);
  }

  // The API-equivalent (notional) spend of subscription runs, per provider, on the same axis
  // as the estimated role spend; the provider twin of chartNotionalByRole.
  function chartNotionalByProvider(data) {
    return stackChart(data, reportProviderOrder(data), "notionalByProvider", fmtUsd, (v) => (v === 0 ? "$0" : fmtUsd(v)), false);
  }

  // Window tallies per subscription backend (claude/codex/opencode), name asc then count
  // desc — reading only notionalByBackend because a backend has no real-cost map (a
  // subscription run never fills run_end.providerCost) but a backend that only spent
  // notionally still counts, the dashboard twin of the day report's per-backend notional
  // line. Backend keys are dynamic seams, so reads and seeds go through tallyAcross's
  // Object.hasOwn as reportProviderOrder does.
  function reportBackendOrder(data) {
    return tallyAcross(data.series, [], ["notionalByBackend"]);
  }

  // The API-equivalent (notional) spend of subscription runs, per backend, on the same axis
  // as the estimated role spend; the backend twin of chartNotionalByProvider, which
  // notionalByProvider alone cannot serve because it folds only from run_end.providerCost.
  function chartNotionalByBackend(data) {
    return stackChart(data, reportBackendOrder(data), "notionalByBackend", fmtUsd, (v) => (v === 0 ? "$0" : fmtUsd(v)), false);
  }

  // The team's review friction, per role, on a run-like count axis: one segment per
  // (day, role) with a rejection, empty when the report has none.
  function chartRejectionsByRole(data) {
    return roleStackChart(data, "rejectionsByRole", (n) => plural(n, "rejection"), countAxis, true);
  }
  // Post-merge rejections (an already-landed commit the reviewer turned back, so it stays on
  // main with the reviewer's reasons), per role, drawn the same way. A subset of rejectionsByRole.
  function chartPostMergeRejectionsByRole(data) {
    return roleStackChart(data, "postMergeRejectionsByRole", (n) => plural(n, "post-merge rejection"), countAxis, true);
  }
  // Revisions (rework rounds after a rejection), per role, drawn the same way.
  function chartRevisionsByRole(data) {
    return roleStackChart(data, "revisionsByRole", (n) => plural(n, "revision"), countAxis, true);
  }
  // Runs that deliberately declined their entry (result "refused"), per role, drawn the same
  // way as its rejection/revision siblings.
  function chartRefusalsByRole(data) {
    return roleStackChart(data, "refusalsByRole", (n) => plural(n, "refusal"), countAxis, true);
  }
  // The team's model-fallback episodes, per role, on the same count axis: one segment per
  // (day, role) with a fallback.
  function chartFallbacksByRole(data) {
    return roleStackChart(data, "fallbacksByRole", (n) => plural(n, "fallback"), countAxis, true);
  }
  // Image reroutes per role, drawn the same way: one segment per (day, role) with a reroute.
  function chartImageReroutesByRole(data) {
    return roleStackChart(data, "imageReroutesByRole", (n) => plural(n, "image reroute"), countAxis, true);
  }
  // Runs that ended in an error, per role, drawn the same way.
  function chartFailedRunsByRole(data) {
    return roleStackChart(data, "failedRunsByRole", (n) => plural(n, "failed run"), countAxis, true);
  }
  // Merges that were blocked or conflicted, per role, drawn the same way.
  function chartMergeFailuresByRole(data) {
    return roleStackChart(data, "mergeFailedByRole", (n) => plural(n, "merge failure"), countAxis, true);
  }
  // WHY merges failed, per reason code (each merge_failed's result), drawn the same way as
  // the by-role chart so the two read as a pair; the reason codes' own ordering comes from
  // reportMergeFailureOrder.
  function chartMergeFailuresByReason(data) {
    return stackChart(data, reportMergeFailureOrder(data), "mergeFailedByReason", (n) => plural(n, "merge failure"), countAxis, true);
  }
  // Window tallies per fixed-bug Validation gap tag, count desc then tag asc — the tag twin
  // of reportMergeFailureOrder, so the "Validation gaps" chart matches the day report's
  // line ordering. Tag keys are dynamic, so reads and seeds go through tallyAcross's
  // Object.hasOwn checks as its siblings do; a tag no day recorded still gets a row only if
  // some day carries it.
  function reportValidationGapOrder(data) {
    return tallyAcross(data.series, ["validationGapsByTag"], []);
  }
  // The team's fixed-bug Validation gap tags, per day, stacked by tag: each segment one
  // (day, tag), the dashboard twin of the day report's "Validation gaps" line. Sparse like
  // the model chart; tag names are the legend labels.
  function chartValidationGaps(data) {
    return stackChart(data, reportValidationGapOrder(data), "validationGapsByTag", (n) => plural(n, "validation gap"), countAxis, true);
  }
  // Window tallies per main-red failing test, count desc then name asc — the browser twin of
  // the day report's "Main red by test" line. Test keys are dynamic, so reads and seeds go
  // through tallyAcross's Object.hasOwn checks as its siblings do; a test no day recorded
  // still gets a row only if some day carries it.
  function reportMainRedTestOrder(data) {
    return tallyAcross(data.series, ["mainRedByTest"], []);
  }
  // The team's main-red failing tests, per day, stacked by test: each segment one (day, test),
  // the dashboard twin of the day report's "Main red by test" line. Sparse like the model
  // chart; test names are the legend labels.
  function chartMainRedByTest(data) {
    return stackChart(data, reportMainRedTestOrder(data), "mainRedByTest", (n) => plural(n, "red check"), countAxis, true);
  }
  // Window tallies per main-red blamed merge (the report's "<role> <shortSha>" label), count
  // desc then name asc — the browser twin of the day report's "Main red by merge" line.
  // Culprit keys are dynamic, so reads and seeds go through tallyAcross's Object.hasOwn checks
  // as its siblings do; a culprit no day recorded still gets a row only if some day carries it.
  function reportMainRedCulpritOrder(data) {
    return tallyAcross(data.series, ["mainRedByCulprit"], []);
  }
  // The team's main-red blamed merges, per day, stacked by culprit: each segment one
  // (day, culprit), the dashboard twin of the day report's "Main red by merge" line. Sparse
  // like the model chart; the culprit labels are the legend labels.
  function chartMainRedByMerge(data) {
    return stackChart(data, reportMainRedCulpritOrder(data), "mainRedByCulprit", (n) => plural(n, "blame"), countAxis, true);
  }
  // The day's merged outcomes per role, the success sibling of chartMergeFailuresByRole,
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
  // The browser twin of report-render.ts's mergeShareLine: the "of which merge runs …" line
  // under the tiles, worded exactly as the CLI prints it (so the two cannot drift on what they
  // say) but built from the client's own number formatters, as the tiles already do. The caller
  // decides when it prints: zero-means-absent, so a role-scoped report (which zeroes the merge
  // counts) and a merge-free window render no such line. No backticks or template literals —
  // this region is one String.raw template. The count stays bare "N runs" (never pluralised), a
  // faithful twin of mergeShareLine's "N runs" even at one run, so the wording cannot drift.
  function mergeShareText(t) {
    return "of which merge runs: " + t.mergeRuns + " runs" + ((t.mergeFailed || 0) > 0 ? " (" + t.mergeFailed + " failed)" : "") + " · " + fmtTokens(t.mergeTokens || 0) + " tokens · " + fmtUsd(t.mergeCostUsd || 0) + " (reviewer + conflict resolution)";
  }

  // The instance-id matcher for the cost-per-commit lines below, the same pattern
  // gui-client-labels.ts uses, named distinctly from that region's INSTANCE_ID so the
  // concatenated script has no duplicate const. Interpolated from the server's
  // INSTANCE_ID_SOURCE so the base-role fold cannot drift from baseRoleOf.
  const COST_INSTANCE_ID = new RegExp(${JSON.stringify(INSTANCE_ID_SOURCE)});

  // Cost per merged commit by base role, the browser twin of report-render.ts's
  // costPerCommitPairs: spend folded to its base role (feature-2 joins feature), commits read
  // as-is (already base-keyed). mergeDone is [role, cost per commit, commits] for roles with
  // both, ranked by cost per commit desc then name asc; idle is [role, cost] for roles that
  // spent and merged nothing, ranked by spend. pick selects another per-role-id spend map
  // (e.g. notionalByRole); a role with commits but no spend in the picked map appears in
  // neither list.
  function costPerCommitParts(series, pick) {
    const cost = {};
    const commits = {};
    for (const d of series) {
      const pickSpend = pick || ((day) => day.costByRole);
      for (const [id, c] of Object.entries(pickSpend(d) || {})) {
        const m = COST_INSTANCE_ID.exec(id);
        const base = m ? m[1] : id;
        cost[base] = (Object.hasOwn(cost, base) ? cost[base] : 0) + c;
      }
      for (const [role, n] of Object.entries(d.commitsByRole || {})) {
        commits[role] = (Object.hasOwn(commits, role) ? commits[role] : 0) + n;
      }
    }
    const mergeDone = [];
    const idle = [];
    for (const [role, c] of Object.entries(cost)) {
      if (!(c > 0)) continue;
      const n = commits[role] || 0;
      if (n > 0) mergeDone.push([role, c / n, n]);
      else idle.push([role, c]);
    }
    mergeDone.sort(byTotalThenName);
    idle.sort(byTotalThenName);
    return { mergeDone, idle };
  }

  // One "label: role — cost (n) · role — cost, no commits" line from costPerCommitParts, the
  // browser twin of report-render.ts's costPerCommitLine; "-" when nothing to show.
  function costPerCommitText(label, series, pick) {
    const parts = costPerCommitParts(series, pick);
    const lines = [];
    for (const [r, per, n] of parts.mergeDone) lines.push(r + " — " + fmtUsd(per) + " (" + n + ")");
    for (const [r, c] of parts.idle) lines.push(r + " — " + fmtUsd(c) + ", no commits");
    return label + ": " + (lines.length === 0 ? "-" : lines.join(" · "));
  }

  // The Estimated per commit line, over notionalByRole, the browser twin of
  // renderReportMarkdown's notional-gated line; the caller decides when it prints.
  function estimatedPerCommitText(series) {
    return costPerCommitText("Estimated per commit", series, (d) => d.notionalByRole);
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
  // True when some day carries a positive value for the named scalar series field; the shared
  // guard behind the per-scalar seriesHas* helpers below, so each chart's element renders only
  // when its series has data. Backlog items/added take two fields and stay separate.
  function seriesHasScalar(data, field) {
    return data.series.some((d) => Number(d[field]) > 0);
  }
  // True when some day carries a passing-check median; the element renders only then.
  function seriesHasCheckMedian(data) {
    return seriesHasScalar(data, "checkMedianMs");
  }
  // True when some day carries a count of failed full-suite checks; the red sibling of
  // seriesHasCheckMedian, the element renders only then.
  function seriesHasCheckFailures(data) {
    return seriesHasScalar(data, "checkFailures");
  }
  // True when some day carries main-red wall-clock; the element renders only then.
  function seriesHasMainRedMs(data) {
    return seriesHasScalar(data, "mainRedMs");
  }
  // True when some day carries a merge-wait median; the element renders only then.
  function seriesHasMergeWaitMedian(data) {
    return seriesHasScalar(data, "mergeWaitMedianMs");
  }
  // True when some day carries a merge-slot median; the element renders only then.
  function seriesHasMergeSlotMedian(data) {
    return seriesHasScalar(data, "mergeSlotMedianMs");
  }
  // True when some day carries a run-duration median; the element renders only then.
  function seriesHasRunMedian(data) {
    return seriesHasScalar(data, "runMedianMs");
  }
  // True when some day carries a review-duration median; the element renders only then.
  function seriesHasReviewMedian(data) {
    return seriesHasScalar(data, "reviewMedianMs");
  }

  // True when some day carries a backlog-lag median (a field that can legitimately hold 0
  // for a same-day filing and completion), so unlike the millisecond scalars it reads for a
  // defined value, not a positive one; the element renders only then.
  function seriesHasBacklogLagMedian(data) {
    return data.series.some((d) => d.backlogLagMedianDays != null);
  }
  // True when some day carries a provider-wait median; the element renders only then.
  function seriesHasProviderWaitMedian(data) {
    return seriesHasScalar(data, "providerWaitMedianMs");
  }
  // True when some day carries a workspace-wait median; the element renders only then.
  function seriesHasSlotWaitMedian(data) {
    return seriesHasScalar(data, "slotWaitMedianMs");
  }
  // True when some day carries a check-wait median; the element renders only then.
  function seriesHasCheckWaitMedian(data) {
    return seriesHasScalar(data, "checkWaitMedianMs");
  }
  // report-chart:end
`;
