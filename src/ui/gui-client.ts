/** The browser-side dashboard app inlined as the GUI page's only <script>: it polls
 * /api/status every second, renders the loop table, event feed, backlog, and report, and
 * posts prompts to /api/prompt. Split out of gui-page.ts — which keeps the page's markup
 * and CSS shell — because this runs in the browser as a separate runtime that cannot import
 * the harness modules; it keeps its own copies of the small display formatters (see
 * text.ts). Edit here when the dashboard's client behavior changes. */
export const GUI_CLIENT_JS = `  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  // A failed API call, named for the operator: endpoint, HTTP status, and the server's
  // error text — every error body this server sends is JSON {error} except the 404's
  // plain "not found", so parse leniently. The message surfaces in the budget-save flash
  // and the report panel; the panel polls swallow it (they keep the last good content).
  async function apiError(path, r) {
    let detail = "";
    try {
      const body = (await r.text()).trim();
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* plain-text body */ }
      detail = parsed && typeof parsed.error === "string" ? parsed.error : body;
    } catch { /* unreadable body — the status alone still names the failure */ }
    return new Error(path + " failed: HTTP " + r.status + (detail ? " — " + detail : ""));
  }
  // One response guard for every API call this page makes: send the request and, on a non-2xx,
  // throw apiError (endpoint, status, and the server's error) instead of letting a JSON error
  // body be treated as data. Every endpoint call routes through apiFetch, so the r.ok check
  // lives in one place and cannot be dropped at a single site.
  async function apiFetch(path, init) {
    const r = await fetch(path, init);
    if (!r.ok) throw await apiError(path, r);
    return r;
  }
  // A GET whose body is JSON: apiFetch plus the parse (the polling reads below).
  async function getJson(path) {
    return (await apiFetch(path)).json();
  }
  // A POST whose body is JSON: apiFetch with the JSON content-type and a serialized payload.
  // The one place the write endpoints' method/header/body shape lives (the budget, pause, and
  // prompt calls below), so each can never drop the content-type or hand-roll the request.
  async function postJson(path, payload) {
    return apiFetch(path, { method: "POST", headers: { "content-type": "application/json" },
                           body: JSON.stringify(payload) });
  }
  const fmtTokens = (n) => (n >= 1000000 ? (n / 1000000).toFixed(1) + "M" : n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n || 0));
  // last-tick-fmt:start
  // Last tick cell — mirrors the TUI's lastTickCell in status-render.ts: the absolute local
  // time of the last tick end alongside its relative age ("14:32:05 · 3m ago"). Zero-padded
  // HH:MM:SS, prefixed MM-DD once older than a day; "-" when never ticked. The age bucketing
  // is a JS copy of humanSeconds there (whole seconds since ts; <60 → Ns, <3600 → rounded Nm,
  // else rounded Nh) — the page cannot import TS, per the fmtTokens precedent. Computed from
  // Date.now() at render time, so labels stay fresh on the existing 1-second poll.
  const fmtLastTick = (ts) => {
    if (!ts) return "-";
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    let s = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    if (Date.now() - ts > 86400000) s = p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + s;
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    const age = (sec < 60 ? sec + "s" : sec < 3600 ? Math.round(sec / 60) + "m" : Math.round(sec / 3600) + "h") + " ago";
    return s + " · " + age;
  };
  // last-tick-fmt:end
  // loop-sort:start
  // Loop-table row order — shared by rule with the TUI/status table's TS twin
  // (status-model.ts sortLoopsByState, cross-checked against this copy in test/gui.test.ts):
  // in-flight phases first — working, reviewing, landing — before inactive ones; within each
  // category by last tick most-recent-first. Null (never completed a tick) sorts last in its
  // category; ties break on role name so an identical payload always renders in the same
  // order. The page cannot import TS (the fmtTokens/lastTickCell precedent), so the two copies
  // stay in lockstep by test. /api/status and status --json keep their payload (config)
  // order — grouping is a display concern of the two rendered tables.
  function sortLoops(loops) {
    const cat = (l) => ((l.phase.startsWith("working") || l.phase.startsWith("reviewing") || l.phase.startsWith("landing")) ? 0 : 1);
    return loops.slice().sort((a, b) => {
      if (cat(a) !== cat(b)) return cat(a) - cat(b);
      const ta = a.lastTickEndedAt ?? 0;
      const tb = b.lastTickEndedAt ?? 0;
      if (ta !== tb) return tb - ta;
      return a.role.localeCompare(b.role);
    });
  }
  // loop-sort:end
  // ---- report / failures tabs: the usage dashboard and the failure digest ---------
  // Top-level views inside one page: "fleet" (today's dashboard, default), "report" (usage
  // charts) and "failures" (the bounded Markdown digest). The director prompt form sits
  // outside all of them — an operator control, visible on every tab. The 1s status poll keeps
  // running on every tab; report/failures data is fetched only on tab activation (both move at
  // tick granularity, not per second).
  let activeView = "fleet";
  function switchView(v) {
    if (v !== "fleet" && v !== "report" && v !== "failures") return;
    activeView = v;
    document.getElementById("fleet-view").hidden = v !== "fleet";
    document.getElementById("report").hidden = v !== "report";
    document.getElementById("failures").hidden = v !== "failures";
    document.getElementById("tab-fleet").classList.toggle("active", v === "fleet");
    document.getElementById("tab-report").classList.toggle("active", v === "report");
    document.getElementById("tab-failures").classList.toggle("active", v === "failures");
    if (v === "report") fetchReport(); // on every activation — re-clicking refetches
    if (v === "failures") fetchFailures(); // likewise
  }

  // report-chart:start
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

  // Fetch the failure digest on tab activation and render the Markdown into #failures, the
  // same bounded text that "tumwater report --failures" prints (server-rendered, so the
  // browser stays a thin viewer). Re-clicking the tab refetches, like the report tab.
  async function fetchFailures() {
    const panel = document.getElementById("failures");
    try {
      const d = await getJson("/api/failures?days=14");
      panel.innerHTML = "<span class='muted'>failure digest — last 14 days — click the tab again to refresh</span>\\n" + esc(d.markdown || "(no digest)");
    } catch (e) {
      // Same guard as fetchReport: name the endpoint, status, and server error.
      panel.innerHTML = "<span class='muted'>failures unavailable" + (e && e.message ? " — " + esc(e.message) : "") + "</span>";
    }
  }

  // budget-edit:start
  // The header's daily cost budget badge is editable: clicking swaps just that fragment for
  // an inline input + set/cancel; saving POSTs /api/budget, which writes tumwater.json through
  // the same shared setter as the TUI's Ctrl+B. No optimistic local state: on success the
  // badge re-renders from the next 1 s poll (the orchestrator picks the new cap up within ~2
  // s), and a failed save flashes the server's error and keeps the editor open so the operator
  // can fix it. lastStatus is the latest /api/status payload, kept so cancel can restore the
  // badge without waiting for the next poll.
  let lastStatus = null;
  // The serving process's startup build sha, remembered from the first successful poll so a
  // later change (a redeploy re-execs the server) reloads this page onto the new code.
  let serverBuildSha = null;
  let budgetEditing = false;
  function renderBudgetBadge(d) {
    if (budgetEditing) return; // keep the editor until set/cancel decides
    // An all-free fleet has no spend a cap could ever bind: its badge is plain text (no
    // link, no pointer) so it cannot open a cap editor that would never take effect. Every
    // other state keeps the clickable badge — the affordance for editing the cap.
    document.getElementById("budgetwrap").innerHTML = d.budget && d.budget.free
      ? "<span>" + esc(d.budgetBadge || "") + "</span>"
      : "<a href='#' id='budgetbadge'>" + esc(d.budgetBadge || "") + "</a>";
  }
  function openBudgetEditor() {
    budgetEditing = true;
    // Pre-filled with the current cap — empty when disabled (empty means "no cap" on save).
    const cap = lastStatus && lastStatus.budget && lastStatus.budget.capUsd > 0 ? String(lastStatus.budget.capUsd) : "";
    document.getElementById("budgetwrap").innerHTML =
      "<input type='number' min='0' step='0.01' id='budgetinput' value='" + esc(cap) + "' style='width:9em;padding:2px 6px'>"
      + " <button id='budgetset'>set</button> <button id='budgetcancel'>cancel</button>";
    const input = document.getElementById("budgetinput");
    input.focus();
    input.select();
  }
  function showFlash(msg) {
    const f = document.getElementById("flash");
    f.textContent = msg;
    setTimeout(() => (f.textContent = ""), 3000);
  }
  async function saveBudget() {
    const input = document.getElementById("budgetinput");
    if (!input) return;
    // A type=number input reports value "" both for a field the operator cleared on purpose
    // (post 0 = no cap, below) and for text the browser rejected ("$25", "5,000") — the two
    // look identical through .value. validity.badInput tells them apart, so a typo flashes an
    // error instead of silently disabling the spend cap; stay in edit mode so it can be fixed.
    if (input.validity && input.validity.badInput) {
      showFlash("budget must be a number of 0 or more (clear the field for no cap)");
      return;
    }
    // Empty means "no cap" (0 disables).
    const value = input.value === "" ? 0 : Number(input.value);
    try {
      await postJson("/api/budget", { maxDailyCostUsd: value });
      budgetEditing = false; // the next poll re-renders the badge from the payload
    } catch (e) {
      showFlash("error: " + e.message); // stay in edit mode so the operator can fix it
    }
  }
  document.addEventListener("click", (ev) => {
    if (ev.target.closest("#budgetbadge")) { ev.preventDefault(); openBudgetEditor(); return; }
    if (ev.target.id === "budgetset") { saveBudget(); return; }
    if (ev.target.id === "budgetcancel") { budgetEditing = false; renderBudgetBadge(lastStatus); }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && ev.target.id === "budgetinput") saveBudget(); // Enter saves, like set
  });
  // budget-edit:end

  // pause-control:start
  // The header's fleet pause/resume control: one click POSTs /api/pause, the same operator
  // gate "tumwater pause" / "resume" write, so a shell-less operator watching the dashboard
  // (e.g. over "gui --all-interfaces") can halt a runaway fleet. No optimistic state: the
  // badge re-renders from the next 1 s poll's d.paused (the marker is persistent state —
  // pausing before startup starts an already-paused fleet), and a failed POST flashes the
  // server's error so the operator knows the marker did not change.
  function renderPauseBadge(d) {
    document.getElementById("pausewrap").innerHTML = d.paused
      ? "<a href='#' id='pausebadge'> · paused — resume</a>"
      : "<a href='#' id='pausebadge'> · pause</a>";
  }
  async function togglePause() {
    // The opposite of the last server-reported state; the poll re-renders the badge after a
    // successful POST, so the control never paints a state the marker does not hold. Routes
    // through the shared apiFetch guard, like every other endpoint call.
    const target = !(lastStatus && lastStatus.paused);
    try {
      await postJson("/api/pause", { paused: target });
    } catch (e) {
      showFlash("error: " + e.message); // no optimistic state; fix and click again
    }
  }
  document.addEventListener("click", (ev) => {
    if (ev.target.closest("#pausebadge")) { ev.preventDefault(); togglePause(); }
  });
  // pause-control:end

  let transcriptRole = null; // loop whose transcript panel is open (null = closed)
  let backlogKey = null; // "file:index" of the open backlog entry (null = closed) — mutually
                         // exclusive with transcriptRole: both render into #transcript, so only
                         // one can be open at a time.
  async function refreshTranscript() {
    const panel = document.getElementById("transcript");
    if (!transcriptRole && !backlogKey) { panel.hidden = true; panel.innerHTML = ""; return; }
    try {
      if (transcriptRole) {
        // The shared getJson guard (same as the backlog branch below and fetchReport above):
        // every error body /api/transcript sends is JSON ({error}) with no lines, so without
        // it a failed poll (400 for an out-of-catalog role, 500 when the log read throws)
        // would render "(no transcript yet for this loop)" — claiming the log is empty.
        // Throwing keeps the previous panel content, like every other failed poll here.
        const d = await getJson("/api/transcript?role=" + encodeURIComponent(transcriptRole) + "&n=50");
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
        const d = await getJson("/api/backlog?file=" + encodeURIComponent(file) + "&index=" + encodeURIComponent(index));
        panel.hidden = false;
        panel.innerHTML = "<span class='muted'>" + esc(d.title) +
          " — click the entry again to close</span>\\n" + (esc(d.body) || "(no details for this entry)");
      }
    } catch { /* keep the previous panel content on a failed poll */ }
  }
  async function refresh() {
    try {
      // The shared getJson guard (same as the panel fetches below): the server's own 500
      // catch sends a JSON {error} body. Without that check the body would be assigned to
      // lastStatus and the frame would render from an error object ("orchestrator not
      // running", empty loops) before throwing — and the budget editor would prefill from
      // it. Throwing before the assignment keeps lastStatus at the last good payload and
      // lands in the catch below, which reports the honest "connection lost" and keeps the
      // last good frame.
      const d = await getJson("/api/status");
      lastStatus = d;
      // A newer serving build means this page is stale: reload before painting a frame. The
      // first non-null sha is remembered; the failed-poll catch below never touches it, so it
      // survives the gap while the old server closes and the new one binds the port.
      if (d.serverBuildSha) {
        if (serverBuildSha === null) serverBuildSha = d.serverBuildSha;
        else if (d.serverBuildSha !== serverBuildSha) {
          location.reload();
          return;
        }
      }
      const qn = (d.questions || []).length;
      // The build badge arrives pre-formatted from the payload — status-model's buildBadge,
      // the same string the TUI/status header renders, so the two surfaces cannot drift.
      // The land-queue badge is the same pattern (status-model's landingBadge —
      // "· land queue: N" while anything is queued or landing, empty when idle), appended
      // in the same order as renderStatus's header: after the running/pid+build part, before
      // the inbox badge.
      document.getElementById("header").textContent =
        (d.running ? "running (pid " + d.pid + (d.buildBadge || "") + ")" : "orchestrator not running") +
        (d.landingBadge || "") +
        (d.inbox ? " · inbox: " + d.inbox : "") +
        (qn ? " · questions: " + qn : "");
      // The daily cost budget badge arrives preformatted from the payload — status-model's
      // budgetBadge, the same string the TUI/status header renders (n/a for an all-free
      // fleet; "· no cap" when disabled), so the two surfaces cannot drift. It is its own
      // element because it is clickable (in priced states — an all-free fleet renders
      // plain text, not a link): the editor swaps just this fragment.
      renderBudgetBadge(d);
      renderPauseBadge(d);
      document.getElementById("loops").innerHTML = sortLoops(d.loops).map((l) => {
        const cls = l.phase.startsWith("working") ? "working" : (l.lastResult || "");
        const last = l.lastResult ? l.lastResult + (l.lastSummary ? " — " + l.lastSummary : "") : "-";
        // User-defined loops carry an asterisk in the link text (the payload's custom flag);
        // data-role stays the bare id so the transcript fetch keeps working.
        return "<tr><td><a href='#' class='looplink" + (transcriptRole === l.role ? " active" : "") +
          "' data-role='" + esc(l.role) + "'>" + esc(l.role) + (l.custom ? "*" : "") + "</a></td>"
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
    switchView(a.id.slice(4)); // "fleet" | "report" | "failures" — re-clicking the active tab refetches
  });
  document.getElementById("promptform").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const input = document.getElementById("prompt");
    const text = input.value.trim();
    if (!text) return;
    // Same response guard as saveBudget and the poll fetches: a network failure or the
    // server's 4xx/5xx must not clear the box and claim "queued" for a prompt that was
    // never accepted — flash the error and keep the operator's text so it can be resubmitted.
    try {
      await postJson("/api/prompt", { text });
    } catch (e) {
      showFlash("error: " + e.message);
      return;
    }
    input.value = "";
    showFlash("queued");
    refresh();
  });
  attachReportTip();
  refresh();
  setInterval(refresh, 1000);`;
