/** The dashboard's fleet view, browser-side — the main screen between polls: the sidebar's
 * project name and fleet status (loops running, build state, main's check, quiet hours), the alerts band for whatever needs a human (a failing loop, a red main,
 * a spent budget, an old build, open questions, a pause), today's progress tiles with their
 * per-day bar chart, the backlog with its questions/plans/bugs tabs, and the notable activity
 * feed (the loops table with its per-row actions lives in gui-client-loops.ts; the composer
 * rendered onto this view lives in gui-client-composer.ts). renderFleet repaints all of it
 * from each /api/status poll. Spliced into gui-client.ts's script, reaching its helpers (esc,
 * icon, getJson, postJson, plural, recall, fmtAgo, fmtTokens, fmtUsd, paintPanel, showFlash)
 * through that concatenation. */
export const GUI_CLIENT_FLEET_JS = String.raw`  // ---- sidebar: project, fleet status, budget and pause controls ----
  // post-action:start
  // Fire one POST and report its outcome in the flash bar — the derived success message, or
  // "error: <reason>" when the server refused — then refresh so the page reflects the new
  // state. The shape every fleet action button shares; message() derives the wording from the
  // endpoint's answer (which can be null when it sent no JSON).
  async function postAction(path, body, message) {
    try {
      showFlash(message(await postJson(path, body)));
    } catch (e) {
      showFlash("error: " + e.message);
    }
    refresh();
  }
  // post-action:end
  // restart-button:start
  // The restart affordance's exact markup — one home shared by the sidebar's stale-build row
  // and alertParts()'s build alert, so styling and the global [data-act='restart'] handler
  // serve both icons from one place.
  function restartButton(glyph) {
    return "<button type='button' class='alert-icon' data-act='restart' title='Restart onto the new build now'>" + glyph + "</button>";
  }
  // restart-button:end
  // sidebar:start
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
        : row("gray", "<span class='dot'></span>", "Stopped", "Start it with tumwater run");
      if (d.build) {
        const stale = d.build.stale;
        // A stale build's refresh icon IS the restart button — restartButton(), the same
        // markup alertParts() emits for the build alert; a fresh build's icon stays inert
        // decoration.
        const lead = stale ? restartButton(icon("refresh")) : icon("refresh");
        rows += row(stale ? (d.build.restartBlocked ? "amber" : "blue") : "", lead,
          "Build <span class='mono'>" + esc(shortSha(d.build.sha)) + "</span>" + (stale ? " · " + esc(d.build.aheadCommits || 0) + " behind" : ""),
          localizeInstants(("Running build" + (d.buildBadge || "").replace(/^, build/, "")).trim()));
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
          "Main " + word + esc(counts), ((d.mainCheckBadge || "").replace(/^ · /, "") + (c.at ? " — checked " + fmtAgo(c.at) : "")).trim());
      }
      // The configured quiet-hours window ("Quiet hours … part 2/2"): the schedule as
      // standing information, amber while the local clock is inside it — the same
      // inside/outside wording the TUI/status header's quietBadge carries, derived from the
      // payload's raw quietHours/inQuietHours fields (the active case also raises the
      // fleet-alerts quiet alert above).
      if (d.quietHours) {
        const end = String(d.quietHours).split("-")[1] || "";
        rows += row(d.inQuietHours ? "amber" : "", icon("pause"),
          d.inQuietHours ? "Quiet until " + esc(end) : "Quiet " + esc(d.quietHours),
          "Quiet hours — role loops start no new ticks during this local-time window; the director keeps running your prompts");
      }
    }
    paintPanel("statuschips", rows);
    renderBudgetBadge(d);
    renderPauseBadge(d);
    renderSoundBadge();
  }
  // sidebar:end

  // ---- alerts ----
  // needs-you-cue:start
  // The sound half of the alerts band: when this poll's alerts carry a needs-you key the last
  // poll lacked, play that alert's cue (playAlertCue, gui-client-sound.ts, no-ops while muted
  // or before the first gesture). renderAlerts passes no clock, so every fresh alert in one
  // poll lands on the same Date.now() and playAlertCue's 2 s rate limit collapses the poll
  // to a single cue — deliberate, an alert storm is one chirp (gui-client-sound.ts). The
  // i * 2000 spacing exists for the test path, which passes a stepped clock so each fresh
  // alert clears the window and sounds its own cue. The keys seen now are kept for the next
  // poll's diff; lastNeedsYouKeys starts null, so a page opened onto an already-alerting
  // fleet cues once.
  let lastNeedsYouKeys = null;
  function cueNewNeedsYou(alerts, now) {
    const fresh = newNeedsYouKeys(lastNeedsYouKeys, alerts);
    lastNeedsYouKeys = needsYouKeys(alerts);
    fresh.forEach((key, i) => {
      const a = alerts.find((x) => x.key === key);
      if (a) playAlertCue(a.tone, now === undefined ? undefined : now + i * 2000);
    });
    return fresh;
  }
  // needs-you-cue:end
  // Alerts are patched by key, and only their text is rewritten in place: a stall alert's
  // "no pi output for 9m47s" ticks every second, and rebuilding it would swap its buttons out
  // from under a click in progress.
  function alertParts(a, restartable) {
    // A stale-build alert's refresh icon IS the restart button (PLANS.md 2026-09-30): pressing
    // it forces the fleet's self-redeploy onto main's head now instead of waiting out the
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
    cueNewNeedsYou(alerts);
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
    if (lastStatus && activeView === "fleet") renderStats(lastStatus);
  }
  function statTile(t) {
    const open = t.act ? "<button type='button' class='stat' data-act='" + t.act + "'" + (t.arg ? " data-arg='" + esc(t.arg) + "'" : "") + (t.hint ? " title='" + esc(t.hint) + "'" : "") + ">" : "<div class='stat'>";
    return open + "<span class='stat-label'>" + icon(t.icon) + esc(t.label) + "</span><span class='stat-value'>" + t.value + "</span>" +
      "<span class='stat-sub'>" + t.sub + "</span>" + (t.meter || "") + (t.act ? "</button>" : "</div>");
  }
  function renderStats(d) {
    const loops = d.loops || [];
    const live = loops.filter((l) => l.inFlight);
    const kinds = {};
    for (const l of live) { const k = phaseInfo(l.phase).key; kinds[k] = (kinds[k] || 0) + 1; }
    const liveSub = live.length
      ? ["working", "reviewing", "landing"].filter((k) => kinds[k]).map((k) => kinds[k] + " " + k).join(" · ")
      : d.running ? "every loop is between ticks" : "the fleet is stopped";
    const t = today && today.totals;
    const plans = (d.plans || []).length;
    const bugs = (d.bugs || []).length;
    const qs = (d.questions || []).length;
    paintPanel("stats", [
      { label: "In flight", icon: "bolt", value: live.length + " <small>of " + loops.length + " loops</small>", sub: esc(liveSub) },
      { label: "Landed today", icon: "merge", act: "view", arg: "history", hint: "See every tick in History",
        value: t ? String(t.commits) + " <small>" + (t.commits === 1 ? "commit" : "commits") + "</small>" : "—",
        sub: t ? esc(plural(t.featuresDone, "feature") + " done · " + plural(t.bugsFixed, "bug") + " fixed") : "counting…" },
      { label: "Ticks today", icon: "refresh", act: "view", arg: "usage", hint: "See usage per day and per loop",
        value: t ? String(t.ticks) + " <small>" + (t.ticks === 1 ? "tick" : "ticks") + "</small>" : "—",
        sub: t ? esc(fmtTokens(t.tokensOut) + " output tokens" + (t.costUsd > 0 ? " · " + fmtUsd(t.costUsd) : "")) : "counting…" },
      { label: "Backlog", icon: "inbox", act: "backlog", hint: "Jump to the backlog", value: String(plans + bugs) + " <small>open</small>",
        sub: esc(plural(plans, "plan") + " · " + plural(bugs, "bug") + (qs ? " · " + plural(qs, "question") : "")) },
    ].map(statTile).join(""));
  }

  // ---- backlog: questions, plans, bugs, and queued prompts ----
  let backlogTab = recall("backlog") || "";
  function setBacklogTab(tab) {
    backlogTab = tab;
    store("backlog", tab);
    if (lastStatus) renderBacklog(lastStatus);
  }
  // backlog:start
  const BACKLOG = [
    ["questions", "Questions", "question", "indigo", "No open questions", "Loops post here when they need a decision from you."],
    ["plans", "Plans", "plan", "blue", "Nothing planned", "The plan loop files features in PLANS.md."],
    ["bugs", "Bugs", "bug", "red", "No open bugs", "Bugs filed in BUGS.md show up here."],
    ["queued", "Queued", "chat", "gray", "No queued prompts", "Prompts you send wait here until their loop takes them."],
  ];
  function renderBacklog(d) {
    const items = { questions: d.questions || [], plans: d.plans || [], bugs: d.bugs || [], queued: queuedPrompts(d) };
    if (!items[backlogTab]) backlogTab = items.questions.length ? "questions" : "plans";
    paintPanel("backlogtabs", BACKLOG.map(([k, label]) => "<button type='button' role='tab' data-tab='" + k + "' aria-selected='" + (k === backlogTab) + "'" +
      (k === backlogTab ? " class='active'" : "") + ">" + label + "<span class='badge" + (k === "questions" && items.questions.length ? " t-indigo" : "") + "'>" +
      items[k].length + "</span></button>").join(""));
    const [key, , ic, tone, emptyTitle, emptyText] = BACKLOG.find((s) => s[0] === backlogTab);
    const list = items[key];
    let html;
    if (!list.length) html = "<div class='empty'><strong>" + esc(emptyTitle) + "</strong>" + esc(emptyText) + "</div>";
    else if (key === "queued") {
      html = list.map((q) => "<div class='list-item'><span class='li-icon'>" + icon("chat") + "</span><div class='li-main'><span class='li-title'>" + esc(q.preview) +
        "</span><span class='li-meta'>" + esc((q.role === "director" ? "for the director" : "for the " + q.role + " loop") +
          (q.queuedAtMs ? " · queued " + fmtAgo(q.queuedAtMs) : "")) + "</span></div>" +
        "<button type='button' class='btn btn-sm rowaction' data-action='promptcancel' data-file='" + esc(q.file) + "' data-role='" + esc(q.role) + "'>Cancel</button></div>").join("");
    } else {
      const open = openEntryKey();
      html = list.map((title, i) => {
        const t = splitTitle(title);
        return "<div class='list-item t-" + tone + (open === key + ":" + i ? " active" : "") + "'><span class='li-icon'>" + icon(ic) + "</span>" +
          "<button type='button' class='li-open backloglink' data-file='" + key + "' data-index='" + i + "'><span class='li-title'>" + esc(t.title) + "</span>" +
          (t.meta ? "<span class='li-meta'>" + esc(t.meta) + "</span>" : "") + "</button>" +
          (key === "questions" ? "<button type='button' class='btn btn-sm' data-act='answer' data-arg='" + i + "'>Answer</button>" : "") + "</div>";
      }).join("");
    }
    paintPanel("backlog", html);
  }
  // backlog:end
  $("backlogtabs").addEventListener("click", (ev) => {
    const b = clickClosest(ev, "button[data-tab]");
    if (b) setBacklogTab(b.dataset.tab);
  });
  $("backlog").addEventListener("click", async (ev) => {
    const cancel = clickClosest(ev, "button.rowaction[data-action='promptcancel']");
    if (cancel) {
      await postAction("/api/prompt-cancel", { role: cancel.dataset.role, file: cancel.dataset.file }, (d) =>
        d && d.status === "cancelled"
          ? "Cancelled: " + (d.preview || "")
          : "No longer queued — " + (cancel.dataset.role || "the director") + " already took it");
      return;
    }
    const entry = clickClosest(ev, ".backloglink");
    if (entry) toggleEntry(entry.dataset.file, Number(entry.dataset.index));
  });

  // ---- activity ----
  let feedFilter = recall("feed") === "all" ? "all" : "notable";
  const KINDS = { landing: ["merge", "green"], problem: ["fail", "red"], attention: ["question", "indigo"], info: ["info", "blue"], routine: ["dot", "gray"] };
  function renderFeed(d) {
    const items = (d.eventItems || []).slice().reverse(); // newest first
    const shown = feedFilter === "all" ? items : items.filter((it) => eventKind(it) !== "routine");
    markActive($("feedfilter"), "filter", feedFilter);
    const roles = new Set((d.loops || []).map((l) => l.role));
    paintPanel("feed", shown.length
      ? shown.map((it) => {
        const kind = eventKind(it);
        const tone = it.type === "tick_end" && kind === "problem" ? resultInfo(it.result).tone : KINDS[kind][1];
        const who = roles.has(it.loop)
          ? "<button type='button' class='linkish feed-loop' data-open='" + esc(it.loop) + "'>" + esc(it.loop) + "</button>"
          : "<span class='feed-loop'>" + esc(it.loop) + "</span>";
        return "<li class='feed-item k-" + kind + "'><span class='feed-icon t-" + tone + "'>" + icon(KINDS[kind][0]) + "</span>" +
          "<div class='feed-msg clamp2' title='" + esc(it.message) + "'>" + who + esc(it.message) + "</div>" +
          "<time class='feed-time' title='" + esc(fmtClock(it.ts)) + "'>" + esc(fmtAgo(it.ts)) + "</time></li>";
      }).join("")
      : "<li class='empty'><strong>" + (items.length ? "Nothing notable lately" : "No events yet") + "</strong>" +
        (items.length ? "Landings, failures, and questions show up here. All events has every tick start and check." : "Events appear here as the loops work.") + "</li>");
  }
  $("feedfilter").addEventListener("click", (ev) => {
    const b = clickClosest(ev, "button[data-filter]");
    if (!b) return;
    feedFilter = b.dataset.filter;
    store("feed", feedFilter);
    if (lastStatus) renderFeed(lastStatus);
  });

  function renderFleet(d) {
    const loops = d.loops || [];
    const sub = plural(loops.length, "loop") + " · " + (d.running ? loops.filter((l) => l.inFlight).length + " in flight" : "the fleet is stopped") +
      (d.paused ? " · paused" : "");
    if ($("fleetsub").textContent !== sub) $("fleetsub").textContent = sub;
    renderStats(d);
    renderLoops(d);
    renderBacklog(d);
    renderFeed(d);
  }
`;
