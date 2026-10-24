/** The dashboard's Usage and Failures views, browser-side. Usage renders /api/report as six
 * totals (each with its per-day average) over five daily bar charts — merged commits, runs by
 * role, output tokens, spend by role, rejections by role — with gridlines, a scale, and one
 * shared color per role; a window picker switches between 7, 14, 30, and 90 days and a
 * Role picker scopes the report to one role group (`?role=`, the browser twin of
 * `tumwater report --role`). Both pickers also
 * carry trailing-window buttons (1h/6h/1d, `?sinceMs=`, the browser twin of `tumwater report
 * --since`), so the day and sub-day shapes read through the same collectors and renders as the
 * CLI; the since shape draws the returned Markdown instead of the charts. Failures renders
 * the failure digest (/api/failures, the Markdown `tumwater report --failures` prints) through
 * the page's Markdown renderer, over the same kind of window and Role pickers. The Failures view
 * also paints the current flake quarantine below the digest, the read twin of the amber quarantine
 * alert. Both fetch when
 * their view opens, on Refresh, and — Usage only, throttled — when new events arrive while it
 * is open. On a trailing window, ◀ Earlier / Later ▶ step it back by its own length through
 * `?sinceMs=&untilMs=`, the twin of `report --since --until`. The chart builders are pure and
 * live in gui-client-report-chart.ts (report-chart region); the hover chip is one shared
 * element (report-tip region) and the Role picker's options are pure (report-role region); all
 * are exercised in isolation by the tests. Spliced into gui-client.ts's script after the chart
 * module, reaching its helpers (esc, getJson, icon, fmtTokens, fmtUsd, renderMarkdown) through
 * that concatenation. */
import { SPARSE_WINDOW_NOTE } from "../../events/event-window.js";

export const GUI_CLIENT_REPORT_JS = String.raw`// report-tip:start
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
    // decimal, runs and tokens round, money reuses fmtUsd). One home for the prefix and the
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
  // The Role picker's options: the team-wide "All roles" empty option plus one option per
  // role, in the team's own order. syncRolePicker escapes every role through it, so the three
  // Role pickers (the report views', History's, and the Activity feed's) render role names the
  // same way — role names are dynamic (custom roles) and the custom-role charset admits HTML
  // metacharacters. Pure, so a test can drive it without a DOM.
  function rolePickerOptions(roles) {
    return "<option value=''>All roles</option>" +
      (roles || []).map((r) => "<option value='" + esc(r) + "'>" + esc(r) + "</option>").join("");
  }
  // Repaint one Role picker from the team's role list, returning the scope to keep filtering
  // with. Every picker (the report views' syncRoles, History's syncHistoryRoles, the Activity
  // feed's syncFeedRoles) does the same thing: rebuild only when the roster changes, keep the
  // persisted choice while the team still lists it, and fall back to All roles — persisting
  // that fallback — when it does not, so a dimmed picker never scopes the request to a ghost
  // role. The last-painted roster is tracked per select id, so the pickers never share a key.
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
  // The report views' Role picker offers base roles only: the scoped collectors
  // (collectReport/collectFailureReport) fold an instance id (feature-2) into its base role, so
  // an instance option would collect the base role's whole body under the instance's name — the
  // GUI twin of the TUI's Ctrl+G scope cycle (src/ui/tui/tui-pane-session.ts scopeCycle).
  // The status payload already carries the base role as instanceOf on an instance row (src/status/
  // status-data.ts), so this borrows the server's own fold rather than re-deriving it. History's
  // picker (gui-client-history.ts) filters by exact role id and keeps the raw team list. Pure,
  // so a test can drive it without a DOM.
  function reportBaseRoles(roles) {
    const bases = [];
    for (const l of roles || []) {
      const base = l.instanceOf || l.role;
      if (!bases.includes(base)) bases.push(base);
    }
    return bases;
  }
  // Repaint both report views' Role pickers from a status payload: each view's persisted
  // choice is kept while the team still lists it and falls back to All roles otherwise. The
  // views are defined below; the boot poll and each fetch call this once they exist.
  function syncReportRoles(d) {
    for (const view of [usage, failures]) view.syncRoles(d);
  }
  // report-role:end

  // view-scaffold:start
  // The window pickers' choices and the views' shared head (title, blurb, picker, Refresh).
  function viewHead(title, blurb, pickerId, choices, current, refreshId, rolePickerId, sinceChoices) {
    // A dropped blurb renders as no subtitle at all, never the string "undefined". The Role
    // picker rides the toolbar when the view has one (the shared Usage/Failures shape); the
    // options are filled by syncRoles from the team's role list. The trailing-window buttons
    // (a view that configured sinceChoices) sit in the same segmented control after the day
    // buttons; each carries its length as data-since so windowView can mark exactly one active.
    const rolePicker = rolePickerId
      ? "<label><span class='sr-only'>Role</span><select class='field' id='" + rolePickerId + "' data-role='1'><option value=''>All roles</option></select></label>"
      : "";
    const sinceButtons = (sinceChoices || []).map(([ms, label]) =>
      "<button type='button' data-since='" + ms + "'>" + esc(String(label)) + "</button>").join("");
    // The step buttons (hidden until windowView shows them on a live since window) ride only a
    // view that offers trailing windows.
    const stepButtons = (sinceChoices || []).length
      ? "<span id='" + pickerId + "step' style='display:none'>" +
        "<button type='button' class='btn btn-sm' data-step='earlier'>◀ Earlier</button>" +
        "<button type='button' class='btn btn-sm' data-step='later'>Later ▶</button></span>"
      : "";
    return "<div class='view-head'><div><h1>" + esc(title) + "</h1>" +
      (blurb ? "<p>" + esc(blurb) + "</p>" : "") + "</div><div class='toolbar'>" + rolePicker +
      "<div class='seg' id='" + pickerId + "'>" + choices.map((n) => "<button type='button' data-days='" + n + "' class='" +
        (n === current ? "active" : "") + "'>" + n + " days</button>").join("") + sinceButtons + "</div>" +
      stepButtons +
      "<button type='button' class='btn btn-sm' id='" + refreshId + "'>" + icon("refresh") + "Refresh</button></div></div>";
  }
  // The window-view scaffold Usage and Failures share: a lazily built panel (shared head
  // with a window picker and Refresh, body holding a Loading… placeholder until the first
  // render), the picker's active choice re-marked on every fetch, a GET of the view's endpoint
  // (o.endpoint selects the day or since shape) rendered into the body — with an error panel
  // naming the view on failure — optional 60-second throttling (Usage's event-driven refetch),
  // and click wiring for the picker's data-days and data-since buttons (persisted through
  // recall/store, each clearing the other so exactly one window shape is live) and the Refresh
  // button. On a trailing window, ◀ Earlier / Later ▶ step it back by its own length through
  // ?sinceMs=&untilMs=, the twin of report --since --until. Usage and Failures are two
  // configurations of this one scaffold.
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
    // The persisted Role scope for this view: "" is the team-wide report. Only a view that
    // configured a rolePickerId reads it, so a view without a picker never touches storage.
    let role = o.roleKey ? recall(o.roleKey) || "" : "";
    // How many window lengths the trailing window is stepped back; view state, never persisted.
    let step = 0;
    let fetchedAt = 0;
    // Keep this view's Role picker in step with the team's role list (custom roles included).
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
      const stepEl = $(o.pickerId + "step");
      if (stepEl) {
        stepEl.style.display = sinceMs ? "" : "none";
        stepEl.querySelector("[data-step='earlier']").disabled = !reportCanStepEarlier(sinceMs, step);
        stepEl.querySelector("[data-step='later']").disabled = step === 0;
      }
      syncRoles(lastStatus);
      try {
        $(o.bodyId).innerHTML = o.render(await getJson(o.endpoint(days, role, sinceMs, step)));
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
        const st = clickClosest(ev, "[data-step]");
        if (st) {
          if (st.dataset.step === "earlier") {
            if (reportCanStepEarlier(sinceMs, step)) step += 1;
          } else step = Math.max(0, step - 1);
          fetchView();
          return;
        }
        const s = clickClosest(ev, "[data-since]");
        if (s) {
          step = 0;
          sinceMs = Number(s.dataset.since);
          store(o.sinceKey, String(sinceMs));
          fetchView();
          return;
        }
        const b = clickClosest(ev, "[data-days]");
        if (b) {
          // A day-window click clears a live trailing window, so the two cannot disagree
          // about which is in force; the empty string is the stored "no since" sentinel.
          step = 0;
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

  // The server's cap on sinceMs for both endpoints (REPORT_SINCE_MAX_MS in
  // src/events/event-window.ts); the two must agree, and a test pins it.
  const REPORT_MAX_MS = 604_800_000;
  // True while the next earlier window's sinceMs, (step + 2) * sinceMs, stays within the cap.
  const reportCanStepEarlier = (sinceMs, step) => !!sinceMs && (step + 2) * sinceMs <= REPORT_MAX_MS;

  // The /api/report and /api/failures endpoints for one window and role scope, shared by the
  // two window views so their URL shape cannot drift: a trailing window asks ?sinceMs=, the
  // default asks ?days=, and a scope appends the same &role=.
  // A stepped since window (step > 0) asks the bounded past window
  // ?sinceMs=(step+1)*len&untilMs=step*len.
  const reportEndpoint = (resource, days, role, sinceMs, step) =>
    (sinceMs
      ? "/api/" + resource + "?sinceMs=" + (step > 0 ? (step + 1) * sinceMs + "&untilMs=" + step * sinceMs : sinceMs)
      : "/api/" + resource + "?days=" + days) +
    (role ? "&role=" + encodeURIComponent(role) : "");

  const usage = windowView({
    panelId: "report", title: "Usage", bodyId: "usagebody",
    blurb: "What the team produced and what it cost, per day and per role.",
    pickerId: "usagewindow", choices: [7, 14, 30, 90], refreshId: "usagerefresh",
    key: "usage-days", defaultDays: 14, roleKey: "usage-role", rolePickerId: "usagerole",
    sinceKey: "usage-since", sinceChoices: REPORT_SINCE_CHOICES,
    errorTitle: "Usage report unavailable",
    endpoint: (days, role, sinceMs, step) => reportEndpoint("report", days, role, sinceMs, step),
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
        block("Work vs maintenance commits", chartCommitTiers(d), "per day · work + maintenance") + block("Merged commits", chartCommits(d)) + block("Commits by role", chartCommitsByRole(d)) + (seriesHasBacklogAdded(d) ? block("Backlog items opened", chartBacklogItemsOpened(d), "per day · plans added + bugs filed") : "") + (seriesHasBacklogItems(d) ? block("Backlog items done", chartBacklogItems(d), "per day · features done + bugs fixed") : "") + (seriesHasBacklogLagMedian(d) ? block("Backlog lag median", chartBacklogLagMedian(d), "per day · filing to done") : "") + block("Runs by role", chartRunsByRole(d)) +
        block("Output tokens", chartTokens(d)) + block("Tokens by role", chartTokensByRole(d)) + block("Spend by role", chartCostByRole(d)) +
        (!d.role && seriesHasAny(d, "costByProvider") ? block("Spend by provider", chartCostByProvider(d)) : "") +
        block("Rejections by role", chartRejectionsByRole(d)) +
        (seriesHasAny(d, "postMergeRejectionsByRole") ? block("Post-merge rejections by role", chartPostMergeRejectionsByRole(d)) : "") +
        (seriesHasAny(d, "revisionsByRole") ? block("Revisions by role", chartRevisionsByRole(d)) : "") +
        (seriesHasAny(d, "refusalsByRole") ? block("Refusals by role", chartRefusalsByRole(d)) : "") +
        (seriesHasAny(d, "revertsByRole") ? block("Reverts by role", chartRevertsByRole(d)) : "") +
        (seriesHasAny(d, "fallbacksByRole") ? block("Fallbacks by role", chartFallbacksByRole(d)) : "") +
        (seriesHasAny(d, "imageReroutesByRole") ? block("Image reroutes by role", chartImageReroutesByRole(d)) : "") +
        (seriesHasAny(d, "failedRunsByRole") ? block("Failed runs by role", chartFailedRunsByRole(d)) : "") +
        (seriesHasAny(d, "mergedByRole") ? block("Merged by role", chartMergedByRole(d)) : "") +
        (!d.role && seriesHasAny(d, "runsByModel") ? block("Runs by model", chartRunsByModel(d)) : "") +
        (!d.role && seriesHasAny(d, "deferredByReason") ? block("Deferred runs by reason", chartDeferredByReason(d), "per day · backlog, no-work, plans-full") : "") +
        (seriesHasAny(d, "mergeFailedByRole") ? block("Merge failures by role", chartMergeFailuresByRole(d)) : "") +
        (seriesHasAny(d, "mergeFailedByReason") ? block("Merge failures by reason", chartMergeFailuresByReason(d)) : "") +
        (!d.role && seriesHasAny(d, "validationGapsByTag") ? block("Validation gaps", chartValidationGaps(d), "per day · what made fixed bugs hard to confirm") : "") +
        (seriesHasCheckMedian(d) ? block("Merge check median", chartCheckMedian(d), "per day · passing full-suite checks") : "") +
        (seriesHasCheckFailures(d) ? block("Red merge checks", chartCheckFailures(d), "per day · failed full-suite checks") : "") +
        (seriesHasMainRedMs(d) ? block("Main red time", chartMainRedMs(d), "per day · no passing full check") : "") +
        (seriesHasMergeWaitMedian(d) ? block("Merge wait median", chartMergeWaitMedian(d), "per day · enqueue to merged on main") : "") +
        (seriesHasMergeSlotMedian(d) ? block("Merge slot median", chartMergeSlotMedian(d), "per day · verification start to outcome") : "") +
        (seriesHasRunMedian(d) ? block("Run duration median", chartRunMedian(d), "per day · run_start to run_end") : "") +
        (seriesHasReviewMedian(d) ? block("Review duration median", chartReviewMedian(d), "per day · reviewer runs that reached a verdict") : "") +
        (seriesHasProviderWaitMedian(d) ? block("Provider wait median", chartProviderWaitMedian(d), "per day · waits of 30s or more for a provider slot") : "") +
        (seriesHasSlotWaitMedian(d) ? block("Workspace wait median", chartSlotWaitMedian(d), "per day · waits of 30s or more for a workspace") : "") +
        (seriesHasCheckWaitMedian(d) ? block("Check wait median", chartCheckWaitMedian(d), "per day · waits of 30s or more for a check slot") : "") +
        (d.totals.notionalCostUsd > 0
          ? block("Estimated spend by role", chartNotionalByRole(d), "per day · API-equivalent, not in the cap") : "") +
        (!d.role && seriesHasAny(d, "notionalByProvider") ? block("Estimated spend by provider", chartNotionalByProvider(d), "per day · API-equivalent, not in the cap") : "") + "</div>" +
        (d.role ? "<p class='muted scope-note'>Role scope: " + esc(d.role) +
          " · merge runs and backlog tallies (features done / bugs fixed / plans added / bugs filed) are team-wide and omitted.</p>" : "") +
        (d.from ? "<p class='muted window-note'>" + esc(d.from + " → " + d.to) +
          (!d.coversFullWindow ? " · " + ${JSON.stringify(SPARSE_WINDOW_NOTE)} : "") + "</p>" : "");
    },
  });

  // report-quarantine:start
  // The Failures view's flake-quarantine list, painted as its own card below the digest: the
  // read twin of the amber quarantine alert (whose See-failures action lands here). An empty
  // or absent section (a clean quarantine) renders nothing, so a window with a digest but no
  // quarantine is unchanged. Built over the same renderQuarantineSection the server serves.
  function quarantineCardHtml(md) {
    const q = String(md || "").trim();
    return q ? "<article class='card md'>" + renderMarkdown(q, true) + "</article>" : "";
  }
  // report-quarantine:end

  const failures = windowView({
    panelId: "failures", title: "Failures", bodyId: "failbody",
    blurb: "What went wrong, where, and how often — the digest the selfcheck role reads.",
    pickerId: "failwindow", choices: [7, 14, 30], refreshId: "failrefresh",
    key: "fail-days", defaultDays: 14, roleKey: "fail-role", rolePickerId: "failrole",
    sinceKey: "fail-since", sinceChoices: REPORT_SINCE_CHOICES,
    errorTitle: "Failure digest unavailable",
    endpoint: (days, role, sinceMs, step) => reportEndpoint("failures", days, role, sinceMs, step),
    render: (d) => {
      // The view head already titles the page, so the digest's own "# …" heading is dropped.
      const md = String(d.markdown || "").replace(/^# .*\n+/, "");
      const digest = md.trim()
        ? "<article class='card md'>" + renderMarkdown(md, true) + "</article>"
        : "<div class='card empty'><strong>No failure digest</strong>Nothing has been recorded in this window.</div>";
      return digest + quarantineCardHtml(d.quarantine);
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
