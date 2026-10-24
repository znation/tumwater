/** The dashboard's team view, browser-side — the main screen between polls: the sidebar's
 * project name and team status (roles running, build state, main's check, quiet hours),
 * the alerts band for whatever needs a human (a failing role, a red main, a spent budget,
 * an old build, open questions, a pause), and today's progress tiles with their per-day bar
 * chart (the backlog card lives in gui-client-backlog.ts, the notable activity feed in
 * gui-client-feed.ts, the roles table with its per-row actions in gui-client-roles.ts, and the
 * composer rendered onto this view in gui-client-composer.ts). renderTeam repaints all of it
 * from each /api/status poll. Spliced into gui-client.ts's script, reaching its helpers (esc,
 * icon, getJson, postJson, postAction, plural, agree, recall, fmtAgo, fmtTokens, fmtUsd,
 * paintPanel, showFlash) through that concatenation. */
export const GUI_CLIENT_TEAM_JS = String.raw`  // ---- sidebar: project, team status, budget and pause controls ----
  // restart-button:start
  // The alert affordances' exact markup — one home shared by the sidebar's stale-build row and
  // alertParts()'s build alert (a restart) and the held/reclaim disk row (a reclaim), so styling
  // and the global [data-act='restart'] / [data-act='reclaim'] handlers serve both from one place.
  function actionButton(glyph, act, title) {
    return "<button type='button' class='alert-icon' data-act='" + act + "' title='" + title + "'>" + glyph + "</button>";
  }
  function restartButton(glyph) {
    return actionButton(glyph, "restart", "Restart onto the update now");
  }
  function reclaimButton(glyph) {
    return actionButton(glyph, "reclaim", "Reclaim idle build outputs now");
  }
  // restart-button:end
  // sidebar:start
  // A server-rendered badge (badges.ts) leads with its " · " separator; the sidebar strips
  // that separator for its label cell, and upcases the first character to match the row's
  // label style. One home for the rule, so the preformatted badges the payload ships to the
  // sidebar (disk, bootstrap, main check) cannot drift in how the row presents them.
  const stripBadge = (badge) => String(badge || "").replace(/^ · /, "");
  const badgeLabel = (badge) => stripBadge(badge).replace(/^./, (c) => c.toUpperCase());
  function renderSidebar(d) {
    const project = $("project");
    const name = d && d.project ? d.project : "";
    if (project.textContent !== (name || " ")) project.textContent = name || " ";
    const row = (tone, lead, text, title) => "<div class='row" + (tone ? " t-" + tone : "") + "'" + (title ? " title='" + esc(title) + "'" : "") + ">" + lead + text + "</div>";
    let rows;
    if (offline) rows = row("red", icon("offline"), "Offline — retrying");
    else if (!d) rows = row("", "<span class='dot'></span>", "Connecting…");
    else {
      rows = d.running
        ? row("green", "<span class='dot live'></span>", "Running", "Orchestrator running as pid " + d.pid)
        : row("gray", "<span class='dot'></span>", "Stopped", "Start it with tumwater start");
      if (d.build) {
        const stale = d.build.stale;
        // A stale build's refresh icon IS the restart button — restartButton(), the same
        // markup alertParts() emits for the build alert; a fresh build's icon stays inert
        // decoration.
        const lead = stale ? restartButton(icon("refresh")) : icon("refresh");
        rows += row(stale ? (d.build.restartBlocked ? "amber" : "blue") : "", lead,
          "Version <span class='mono'>" + esc(shortSha(d.build.sha)) + "</span>" + (stale ? " · " + esc(d.build.aheadCommits || 0) + " behind" : ""),
          localizeInstants(("Running version" + (d.buildBadge || "").replace(/^, build/, "")).trim()));
      }
      if (d.mainCheck) {
        // Main's newest merge-scope check (status-model's mainCheckBadge): green, red, or — a
        // skipped check — unverified.
        const c = d.mainCheck;
        // The counts fragment ships preformatted (payload's mainCounts, built by the same
        // badges.ts rule as the header badge): pass/tests with the skip and fail counts
        // named in a parenthetical, so a skip never reads like a failure here.
        const counts = d.mainCounts ? " · " + esc(d.mainCounts) : "";
        // The row's tone and its text word agree for a check that ran (green/red); a skipped
        // check colors amber but reads "Main skipped", so the two fallbacks stay distinct.
        const tone = c.status === "passed" ? "green" : c.status === "failed" ? "red" : "amber";
        const word = c.status === "passed" ? "green" : c.status === "failed" ? "red" : c.status;
        const glyph = c.status === "passed" ? "check" : c.status === "failed" ? "fail" : "info";
        rows += row(tone, icon(glyph),
          "Main " + word + esc(counts), (stripBadge(d.mainCheckBadge) + (c.at ? " — checked " + fmtAgo(c.at) : "")).trim());
      }
      // The ci parity row (the full suite's glance verdict): the payload's preformatted
      // ciParityBadge/ciParityTone, upcased for the row's label style like the other badges —
      // the same answer the TUI/status header carries, so the two surfaces cannot drift —
      // toned by the shared ciParityTone map (current→green, failed→red, stale→blue).
      if (d.ciParityBadge) {
        rows += row(d.ciParityTone, icon("check"),
          esc(badgeLabel(d.ciParityBadge)),
          "The last full-suite run the ci role recorded: covered a tip and how long ago, " +
          "current when that tip with this lock still is main's head, stale when main or the lock " +
          "has moved since, failed when the suite failed on it.");
      }
      // The disk floor (plans/disk-floor.md, part 4/4): the sidebar row renders the payload's
      // preformatted diskBadge (upcased for the row's label style) — the same facts the
      // TUI/status header carries, so the two surfaces cannot drift — and names the free space,
      // and the hold there.
      if (d.diskBadge) {
        const held = Boolean(d.disk && d.disk.held);
        const low = Boolean(d.disk && !held && d.disk.reclaimGB > 0 && d.disk.freeGB < d.disk.reclaimGB);
        rows += row(held ? "amber" : "blue", held || low ? reclaimButton(icon("info")) : icon("info"),
          esc(badgeLabel(d.diskBadge)),
          held
            ? "Free space is below the " + esc(String(d.disk.holdGB)) + " GB floor, so the team starts no new work until it recovers. Build outputs are reclaimed first."
            : low
              ? "Free space is below the " + esc(String(d.disk.reclaimGB)) + " GB reclaim threshold; idle build outputs are being cleaned."
              : "");
      }
      // The permit pool (plans/provider-concurrency.md §8): the payload's preformatted
      // permitsBadge — running 5 of 8 · omlx 3/3 · claude 2/6 — upcased for the row's label
      // style, the same reading the TUI/status header carries, so the two surfaces cannot
      // drift. Empty on a map-less team, so the sidebar stays unchanged.
      if (d.permitsBadge) {
        const tok = String(d.permitsBadge).replace(/^ · /, "");
        rows += row("blue", icon("gauge"), esc(tok),
          "Roles running at once out of the team limit, then each capped provider's own running/cap; a role waits to start when its provider is at its cap.");
      }
      // The check-permit pool: the payload's checksBadge, present only while a check runs or waits.
      if (d.checksBadge) {
        const tok = String(d.checksBadge).replace(/^ · /, "");
        rows += row("blue", icon("gauge"), esc(tok),
          "Checks of the project's suite running at once out of maxConcurrentChecks, then how many wait for a check slot; merge checks go first.");
      }
      // The workspace pool: the payload's preformatted workspacesBadge, present only while the
      // pool is full or a run waits for a slot.
      if (d.workspacesBadge) {
        rows += row("blue", icon("gauge"), esc(String(d.workspacesBadge).replace(/^ · /, "")),
          "Pooled workspaces leased out of worktreeSlots, shown once the pool is full, then how many runs wait for one; raise worktreeSlots when runs keep waiting.");
      }
      // The run --for deadline: the payload's preformatted runWindowBadge, like the disk row.
      if (d.runWindowBadge) {
        rows += row("blue", icon("info"), esc(badgeLabel(d.runWindowBadge)),
          d.scheduledStopAt !== undefined && d.scheduledStopAt === d.runStopsAt
            ? "A scheduled stop (tumwater stop --in) — the team finishes current work, then stops."
            : "tumwater was started with start --for; at the deadline it finishes current work, prints a per-role summary, and stops.");
      }
      // The configured quiet-hours window ("Quiet hours … part 2/2"): the schedule as
      // standing information, amber while the local clock is inside it — the same
      // inside/outside wording the TUI/status header's quietBadge carries, derived from the
      // payload's raw quietHours/inQuietHours fields (the active case also raises the
      // team-alerts quiet alert above).
      if (d.quietHours) {
        const end = String(d.quietHours).split("-")[1] || "";
        rows += row(d.inQuietHours ? "amber" : "", icon("pause"),
          d.inQuietHours ? "Quiet until " + esc(end) : "Quiet " + esc(d.quietHours),
          "Quiet hours — roles start no new runs during this local-time window; the director keeps running your messages");
      }
      // New-project bootstrap (plans/work-ratio.md, part 2/2): the payload's preformatted
      // bootstrapBadge, upcased for the row's label style — the same reading the TUI/status
      // header carries, so the surfaces cannot drift.
      if (d.bootstrapBadge) {
        rows += row("blue", icon("info"),
          esc(badgeLabel(d.bootstrapBadge)),
          "New-project bootstrap — maintenance roles wait until enough plans are done; plan, feature and director keep running");
      }
    }
    paintPanel("statuschips", rows);
    renderBudgetBadge(d);
    renderPauseBadge(d);
    renderStopControl(d);
  }
  // sidebar:end

  // ---- alerts ----
  // Alerts are patched by key, and only their text is rewritten in place: a stall alert's
  // "no pi output for 9m47s" updates every second, and rebuilding it would swap its buttons out
  // from under a click in progress.
  function alertParts(a, restartable) {
    // A stale-build alert's refresh icon IS the restart button (PLANS.md 2026-09-30): pressing
    // it forces the team's self-redeploy onto main's head now instead of waiting out the
    // cooldown. Only the build alert carries it, and only while the build is actually stale —
    // a fresh build's icon stays inert decoration.
    const glyph = icon(ALERT_ICONS[a.key] || "info");
    const iconHtml = restartable ? restartButton(glyph) : "<span class='alert-icon'>" + glyph + "</span>";
    return {
      shell: iconHtml + "<div class='alert-body'><div class='alert-title'></div><div class='alert-detail'></div></div>" +
        (a.actions && a.actions.length ? "<div class='alert-actions'>" + a.actions.map((x) => "<button type='button' class='btn btn-sm' data-act='" + esc(x.act) +
          "' data-arg='" + esc(x.arg || "") + "'>" + esc(x.label) + "</button>").join("") + "</div>" : ""),
      cls: "alert t-" + a.tone,
    };
  }
  function renderAlerts(d) {
    const alerts = pageAlerts(d, offline);
    const box = $("alerts");
    const keep = new Set(alerts.map((a) => a.key));
    for (const el of Array.from(box.children)) if (!keep.has(el.dataset.key)) el.remove();
    alerts.forEach((a, i) => {
      const parts = alertParts(a, a.key === "build" && d && d.build && d.build.stale);
      let el = Array.from(box.children).find((c) => c.dataset.key === a.key);
      if (!el) {
        el = document.createElement("div");
        el.dataset.key = a.key;
      }
      if (el._shell !== parts.shell || el.className !== parts.cls) {
        el.className = parts.cls;
        el.innerHTML = parts.shell;
        el._shell = parts.shell;
      }
      el.querySelector(".alert-title").textContent = a.title;
      const detail = el.querySelector(".alert-detail");
      detail.textContent = a.detail || "";
      detail.hidden = !a.detail;
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    });
    const n = needsYou(alerts);
    const title = (n ? "(" + n + ") " : "") + (d && d.project ? d.project + " · " : "") + "tumwater";
    if (document.title !== title) document.title = title;
    const badge = $("navbadge");
    badge.hidden = n === 0;
    if (badge.textContent !== String(n)) badge.textContent = String(n);
    badge.title = plural(n, "thing needs", "things need") + " you";
  }

  // ---- today's progress ----
  // /api/report?days=1, re-read when new events arrive (throttled) — never on a timer.
  let today = null;
  let todayAt = 0;
  let todayLoading = false;
  async function refreshToday(force) {
    if (todayLoading || (!force && Date.now() - todayAt < 20000)) return;
    todayLoading = true;
    try {
      today = await getJson("/api/report?days=1", pollSignal());
      todayAt = Date.now();
    } catch { /* keep the last numbers */ }
    todayLoading = false;
    if (lastStatus && activeView === "team") renderStats(lastStatus);
  }
  // stats:start
  function statTile(t) {
    const open = t.act ? "<button type='button' class='stat' data-act='" + t.act + "'" + (t.arg ? " data-arg='" + esc(t.arg) + "'" : "") + (t.hint ? " title='" + esc(t.hint) + "'" : "") + ">" : "<div class='stat'>";
    return open + "<span class='stat-label'>" + icon(t.icon) + esc(t.label) + "</span><span class='stat-value'>" + t.value + "</span>" +
      "<span class='stat-sub'>" + t.sub + "</span>" + (t.meter || "") + (t.act ? "</button>" : "</div>");
  }
  function renderStats(d) {
    const roles = d.roles || [];
    // The running set (phaseInfo.live), not the permit-holder inFlight: the exempt running
    // director is genuinely in flight, so the tile must count it even though it holds no
    // maxConcurrent permit (BUGS.md 2026-10-06).
    const live = roles.filter((l) => phaseInfo(l.phase).live);
    const kinds = {};
    for (const l of live) { const k = phaseInfo(l.phase).key; kinds[k] = (kinds[k] || 0) + 1; }
    const KIND_WORDS = { working: "working", reviewing: "reviewing", landing: "merging" }; // vocabulary-ok: phase key, renamed with the status model // retired-name-ok: phase key, renamed with the status model
    const liveSub = live.length
      ? Object.keys(KIND_WORDS).filter((k) => kinds[k]).map((k) => kinds[k] + " " + KIND_WORDS[k]).join(" · ")
      : d.running ? "every role is between runs" : "the team is stopped";
    const t = today && today.totals;
    const plans = (d.plans || []).length;
    const bugs = (d.bugs || []).length;
    const qs = (d.questions || []).length;
    paintPanel("stats", [
      { label: "In flight", icon: "bolt", value: live.length + " <small>of " + roles.length + " roles</small>", sub: esc(liveSub) },
      { label: "Merged today", icon: "merge", act: "view", arg: "history", hint: "See every run in History",
        value: t ? String(t.commits) + " <small>" + agree(t.commits, "commit", "commits") + "</small>" : "—",
        sub: t ? esc(plural(t.featuresDone, "feature") + " done · " + plural(t.bugsFixed, "bug") + " fixed · " + workSplit(t)) : "counting…" },
      { label: "Runs today", icon: "refresh", act: "view", arg: "usage", hint: "See usage per day and per role",
        value: t ? String(t.runs) + " <small>" + agree(t.runs, "run", "runs") + "</small>" : "—",
        sub: t ? esc(fmtTokens(t.tokensOut) + " output tokens" + (t.costUsd > 0 ? " · " + fmtUsd(t.costUsd) : "")) : "counting…" },
      { label: "Backlog", icon: "inbox", act: "backlog", hint: "Jump to the backlog", value: String(plans + bugs) + " <small>open</small>",
        sub: esc(plural(plans, "plan") + " · " + plural(bugs, "bug") + (qs ? " · " + plural(qs, "question") : "")) },
    ].map(statTile).join(""));
  }
  // stats:end

  function renderTeam(d) {
    const roles = d.roles || [];
    const sub = plural(roles.length, "role") + " · " + (d.running ? roles.filter((l) => phaseInfo(l.phase).live).length + " in flight" : "the team is stopped") +
      (d.paused ? " · paused" : "");
    if ($("teamsub").textContent !== sub) $("teamsub").textContent = sub;
    renderStats(d);
    renderRoles(d);
    renderBacklog(d);
    renderFeed(d);
  }
`;
