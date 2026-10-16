// vocabulary: plain
/** The dashboard's fleet view, browser-side — the main screen between polls: the sidebar's
 * project name and fleet status (loops running, build state, main's check, quiet hours),
 * the alerts band for whatever needs a human (a failing loop, a red main, a spent budget,
 * an old build, open questions, a pause), today's progress tiles with their
 * per-day bar chart, the backlog with its questions/plans/bugs tabs, and the notable activity
 * feed (the loops table with its per-row actions lives in gui-client-loops.ts; the composer
 * rendered onto this view lives in gui-client-composer.ts). renderFleet repaints all of it
 * from each /api/status poll. Spliced into gui-client.ts's script, reaching its helpers (esc,
 * icon, getJson, postJson, postAction, plural, agree, recall, fmtAgo, fmtTokens, fmtUsd,
 * paintPanel, showFlash) through that concatenation. */
export const GUI_CLIENT_FLEET_JS = String.raw`  // ---- sidebar: project, fleet status, budget and pause controls ----
  // restart-button:start
  // The restart affordance's exact markup — one home shared by the sidebar's stale-build row
  // and alertParts()'s build alert, so styling and the global [data-act='restart'] handler
  // serve both icons from one place.
  function restartButton(glyph) {
    return "<button type='button' class='alert-icon' data-act='restart' title='Restart onto the update now'>" + glyph + "</button>";
  }
  // The disk row's reclaim affordance: its icon IS the button when the row is held or in the
  // reclaim band; the global [data-act='reclaim'] handler posts /api/reclaim.
  function reclaimButton(glyph) {
    return "<button type='button' class='alert-icon' data-act='reclaim' title='Reclaim idle build outputs now'>" + glyph + "</button>";
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
      // drift. Empty on a map-less fleet, so the sidebar stays unchanged.
      if (d.permitsBadge) {
        const tok = String(d.permitsBadge).replace(/^ · /, "");
        rows += row("blue", icon("gauge"), esc(tok),
          "Roles running at once out of the team limit, then each capped provider's own running/cap; a role waits to start when its provider is at its cap.");
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
      // fleet-alerts quiet alert above).
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
    if (lastStatus && activeView === "fleet") renderStats(lastStatus); // vocabulary-ok: view id
  }
  // stats:start
  function statTile(t) {
    const open = t.act ? "<button type='button' class='stat' data-act='" + t.act + "'" + (t.arg ? " data-arg='" + esc(t.arg) + "'" : "") + (t.hint ? " title='" + esc(t.hint) + "'" : "") + ">" : "<div class='stat'>";
    return open + "<span class='stat-label'>" + icon(t.icon) + esc(t.label) + "</span><span class='stat-value'>" + t.value + "</span>" +
      "<span class='stat-sub'>" + t.sub + "</span>" + (t.meter || "") + (t.act ? "</button>" : "</div>");
  }
  function renderStats(d) {
    const loops = d.loops || [];
    // The running set (phaseInfo.live), not the permit-holder inFlight: the exempt running
    // director is genuinely in flight, so the tile must count it even though it holds no
    // maxConcurrent permit (BUGS.md 2026-10-06).
    const live = loops.filter((l) => phaseInfo(l.phase).live);
    const kinds = {};
    for (const l of live) { const k = phaseInfo(l.phase).key; kinds[k] = (kinds[k] || 0) + 1; }
    const KIND_WORDS = { working: "working", reviewing: "reviewing", landing: "merging" }; // vocabulary-ok: phase key, renamed with the status model
    const liveSub = live.length
      ? Object.keys(KIND_WORDS).filter((k) => kinds[k]).map((k) => kinds[k] + " " + KIND_WORDS[k]).join(" · ")
      : d.running ? "every role is between runs" : "the team is stopped";
    const t = today && today.totals;
    const plans = (d.plans || []).length;
    const bugs = (d.bugs || []).length;
    const qs = (d.questions || []).length;
    paintPanel("stats", [
      { label: "In flight", icon: "bolt", value: live.length + " <small>of " + loops.length + " roles</small>", sub: esc(liveSub) },
      { label: "Merged today", icon: "merge", act: "view", arg: "history", hint: "See every run in History",
        value: t ? String(t.commits) + " <small>" + agree(t.commits, "commit", "commits") + "</small>" : "—",
        sub: t ? esc(plural(t.featuresDone, "feature") + " done · " + plural(t.bugsFixed, "bug") + " fixed · " + workSplit(t)) : "counting…" },
      { label: "Runs today", icon: "refresh", act: "view", arg: "usage", hint: "See usage per day and per role",
        value: t ? String(t.ticks) + " <small>" + agree(t.ticks, "run", "runs") + "</small>" : "—",
        sub: t ? esc(fmtTokens(t.tokensOut) + " output tokens" + (t.costUsd > 0 ? " · " + fmtUsd(t.costUsd) : "")) : "counting…" },
      { label: "Backlog", icon: "inbox", act: "backlog", hint: "Jump to the backlog", value: String(plans + bugs) + " <small>open</small>",
        sub: esc(plural(plans, "plan") + " · " + plural(bugs, "bug") + (qs ? " · " + plural(qs, "question") : "")) },
    ].map(statTile).join(""));
  }
  // stats:end

  // ---- backlog: questions, plans, bugs, and queued prompts ----
  let backlogTab = recall("backlog") || "";
  // backlog:start
  // The Queued tab's in-place editor state, beside the tab choice its rows paint from:
  // backlogStatus is the last payload renderBacklog saw, queuedEdit is the open editor
  // ({ role, file, text } or null), and queuedEditPainted marks that its textarea is on
  // screen so the standing 1s poll cannot repaint over what the operator is typing.
  let backlogStatus = null;
  let queuedEdit = null;
  let queuedEditPainted = false;
  // The Plans/Bugs tabs' New form: { kind: "plan" | "bug" } or null, with the same painted
  // guard so a poll does not repaint over the typed title.
  let backlogNew = null;
  let backlogNewPainted = false;
  function setBacklogTab(tab) {
    backlogTab = tab;
    store("backlog", tab);
    queuedEdit = null;
    queuedEditPainted = false;
    backlogNew = null;
    backlogNewPainted = false;
    if (lastStatus) renderBacklog(lastStatus);
  }
  function beginBacklogNew(kind) {
    backlogNew = { kind };
    backlogNewPainted = false;
    renderBacklog(backlogStatus);
  }
  function endBacklogNew() {
    backlogNew = null;
    backlogNewPainted = false;
    renderBacklog(backlogStatus);
  }
  function beginQueuedEdit(role, file, text) {
    backlogTab = "queued";
    queuedEdit = { role, file, text };
    queuedEditPainted = false;
    renderBacklog(backlogStatus);
  }
  function endQueuedEdit() {
    queuedEdit = null;
    queuedEditPainted = false;
    renderBacklog(backlogStatus);
  }
  const BACKLOG = [
    ["questions", "Questions", "question", "indigo", "No open questions", "Roles post here when they need a decision from you."],
    ["plans", "Plans", "plan", "blue", "Nothing planned", "The plan role files features in PLANS.md."],
    ["bugs", "Bugs", "bug", "red", "No open bugs", "Bugs filed in BUGS.md show up here."],
    ["queued", "Inbox", "chat", "gray", "Inbox empty", "Messages you send wait here until their role's next run."], // vocabulary-ok: internal tab key
  ];
  function renderBacklog(d) {
    backlogStatus = d;
    if (queuedEdit && queuedEditPainted) return; // an open editor owns the panel until Save or Cancel
    if (backlogNew && backlogNewPainted) return; // likewise the New form
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
      html = list.map((q) => {
        const addr = "data-file='" + esc(q.file) + "' data-role='" + esc(q.role) + "'";
        // The row being edited swaps its preview for a textarea and a Save/Cancel pair; the
        // address stays the queue-file basename, the same one /api/prompt-cancel uses.
        if (queuedEdit && q.file === queuedEdit.file && q.role === queuedEdit.role) {
          queuedEditPainted = true;
          return "<div class='list-item'><span class='li-icon'>" + icon("chat") + "</span>" +
            "<textarea id='queuedit' class='queuedit'>" + esc(queuedEdit.text) + "</textarea>" +
            "<button type='button' class='btn btn-sm rowaction' data-action='prompteditsave' " + addr + ">Save</button>" +
            "<button type='button' class='btn btn-sm rowaction' data-action='prompteditcancel' " + addr + ">Cancel</button></div>";
        }
        return "<div class='list-item'><span class='li-icon'>" + icon("chat") + "</span><div class='li-main'><span class='li-title'>" + esc(q.preview) +
          "</span><span class='li-meta'>" + esc((q.role === "director" ? "for the director" : "for the " + roleLabel(q.role) + " role") +
            (q.notBeforeMs && q.notBeforeMs > Date.now() ? " · delivers in " + humanSeconds(Math.round((q.notBeforeMs - Date.now()) / 1000))
              : (q.queuedAtMs ? " · queued " + fmtAgo(q.queuedAtMs) : ""))) + "</span></div>" +
          "<button type='button' class='btn btn-sm rowaction' data-action='promptcancel' " + addr + ">Cancel</button>" +
          "<button type='button' class='btn btn-sm rowaction' data-action='promptedit' " + addr + ">Edit</button></div>";
      }).join("");
    } else {
      const open = openEntryKey();
      // The eligibility holds beside the title, from the payload's parallel arrays (indexed by
      // the same tab position the click sends): empty for eligible rows so their markup is
      // unchanged, and the Questions tab carries no holds.
      const holds = key === "plans" ? (d.planHolds || []) : key === "bugs" ? (d.bugHolds || []) : [];
      // Blocked entries (a hold of any kind) paint after the pickable ones under one divider;
      // each row keeps its original data-index so the drawer and Answer still address it.
      const blocked = key === "plans" ? (d.planBlocked || []) : key === "bugs" ? (d.bugBlocked || []) : [];
      const rows = list.map((title, i) => {
        const t = splitTitle(title);
        const mark = holds[i] || "";
        return "<div class='list-item t-" + tone + (open === key + ":" + i ? " active" : "") + "'><span class='li-icon'>" + icon(ic) + "</span>" +
          "<button type='button' class='li-open backloglink' data-file='" + key + "' data-index='" + i + "'><span class='li-title'>" + esc(t.title) + "</span>" +
          (t.meta ? "<span class='li-meta'>" + esc(t.meta) + "</span>" : "") +
          (mark ? "<span class='li-meta'>" + esc(mark.trim()) + "</span>" : "") + "</button>" +
          (key === "questions" ? "<button type='button' class='btn btn-sm backloglink' data-file='questions' data-index='" + i + "'>Answer</button>" : "") + "</div>";
      });
      const ready = rows.filter((r, i) => !blocked[i]);
      const held = rows.filter((r, i) => blocked[i]);
      html = ready.join("") + (held.length ? "<div class='list-item list-divider'><span class='li-meta'>Blocked (" + held.length + ")</span></div>" + held.join("") : "");
    }
    if (key === "plans" || key === "bugs") {
      const kind = key === "plans" ? "plan" : "bug";
      if (backlogNew && backlogNew.kind === kind) {
        backlogNewPainted = true;
        html = "<div class='list-item'><input id='backlognew' type='text' placeholder='" + (kind === "plan" ? "Plan title" : "Bug symptom") + "'>" +
          "<textarea id='backlognewbody' rows='6' placeholder='Details (optional, markdown)'></textarea>" +
          "<button type='button' class='btn btn-sm rowaction' data-action='backlognewsave' data-kind='" + kind + "'>Save</button>" +
          "<button type='button' class='btn btn-sm rowaction' data-action='backlognewcancel'>Cancel</button></div>" + html;
      } else {
        html = "<div class='list-item'><button type='button' class='btn btn-sm' data-action='backlognew' data-kind='" + kind + "'>" +
          (kind === "plan" ? "New plan" : "File a bug") + "</button></div>" + html;
      }
    }
    paintPanel("backlog", html);
  }
  // backlog:end
  $("backlogtabs").addEventListener("click", (ev) => {
    const b = clickClosest(ev, "button[data-tab]");
    if (b) setBacklogTab(b.dataset.tab);
  });
  $("backlog").addEventListener("click", async (ev) => {
    const fresh = clickClosest(ev, "button[data-action='backlognew']");
    if (fresh) { beginBacklogNew(fresh.dataset.kind); return; }
    if (clickClosest(ev, "button[data-action='backlognewcancel']")) { endBacklogNew(); return; }
    const freshSave = clickClosest(ev, "button[data-action='backlognewsave']");
    if (freshSave) {
      const input = $("backlognew");
      const title = input ? input.value.trim() : "";
      if (!title) return;
      const bodyBox = $("backlognewbody");
      await postAction("/api/backlog-file", { kind: freshSave.dataset.kind, title, body: bodyBox ? bodyBox.value : "" }, (d) => "Filed: " + d.title + uncommittedTail(d));
      endBacklogNew();
      return;
    }
    const cancel = clickClosest(ev, "button.rowaction[data-action='promptcancel']");
    if (cancel) {
      await postAction("/api/prompt-cancel", { role: cancel.dataset.role, file: cancel.dataset.file }, (d) =>
        d && d.status === "cancelled"
          ? "Cancelled: " + (d.preview || "")
          : "No longer in the inbox — " + (cancel.dataset.role ? roleLabel(cancel.dataset.role) : "the director") + " already took it");
      return;
    }
    const edit = clickClosest(ev, "button.rowaction[data-action='promptedit']");
    if (edit) {
      try {
        const d = await getJson("/api/prompt-text?role=" + encodeURIComponent(edit.dataset.role) + "&file=" + encodeURIComponent(edit.dataset.file));
        if (d && d.status === "gone") {
          showFlash("No longer in the inbox — " + (edit.dataset.role ? roleLabel(edit.dataset.role) : "the director") + " already took it");
          refresh();
        } else {
          beginQueuedEdit(edit.dataset.role, edit.dataset.file, (d && d.text) || "");
        }
      } catch (err) {
        showFlash("error: " + err.message);
      }
      return;
    }
    const save = clickClosest(ev, "button.rowaction[data-action='prompteditsave']");
    if (save) {
      const area = $("queuedit");
      const text = area ? area.value.trim() : "";
      if (!text) { showFlash("error: prompt text is empty"); return; }
      await postAction("/api/prompt-edit", { role: save.dataset.role, file: save.dataset.file, text }, (d) =>
        d && d.status === "edited"
          ? "Edited: " + (d.newText || "")
          : "No longer in the inbox — " + (save.dataset.role ? roleLabel(save.dataset.role) : "the director") + " already took it");
      endQueuedEdit();
      return;
    }
    const editCancel = clickClosest(ev, "button.rowaction[data-action='prompteditcancel']");
    if (editCancel) {
      endQueuedEdit();
      return;
    }
    const entry = clickClosest(ev, ".backloglink");
    if (entry) toggleEntry(entry.dataset.file, Number(entry.dataset.index));
  });

  // activity:start
  // The Activity card's own narrowing, beside the Notable/All segmented choice: a Loop picker
  // and a text box filter the events the card carries, and — once a filter is set — a debounced
  // /api/logs search reaches past that carried window into the log's recent slice (the same
  // loop/match rule 'tumwater logs --role'/'--grep' apply to the CLI feed). Both persist like
  // the Notable/All choice, so a reload keeps the operator's scope.
  let feedFilter = recall("feed") === "all" ? "all" : "notable";
  let feedRole = recall("feed-role") || "";
  let feedText = recall("feed-grep") || "";
  const KINDS = { landing: ["merge", "green"], problem: ["fail", "red"], attention: ["question", "indigo"], info: ["info", "blue"], routine: ["dot", "gray"] };
  // Server-backed search state. feedResults is the /api/logs slice once it answers (newest
  // first, the shape renderFeed consumes), null while the card paints its carried window; the
  // debounce feedTimer keeps each keystroke from firing a request; feedSeq numbers requests
  // so a stale answer (a later filter issued a newer one) never paints; feedError names a
  // fetch failure so the empty state can explain it; and feedQueryKey tracks which filter the
  // last search was for, so renderFeed re-arms exactly when the filter changes (never per poll).
  let feedResults = null;
  let feedSeq = 0;
  let feedTimer = null;
  let feedError = "";
  let feedQueryKey = "";
  // Only the non-empty filters ride the query: an absent grep/role means unfiltered server-side,
  // exactly as handleLogs reads them.
  function feedLogsQuery() {
    const params = [];
    if (feedText) params.push("grep=" + encodeURIComponent(feedText));
    if (feedRole) params.push("role=" + encodeURIComponent(feedRole));
    return "/api/logs?" + params.join("&");
  }
  // Re-arm the debounced search for the current filter. An empty filter drops any slice and
  // invalidates an in-flight request; otherwise renderFeed has already repainted the locally
  // narrowed window and this waits out the typing pause before asking the server to reach
  // past it. The 250 ms pause is the point: a keystroke narrows at once, the request follows.
  function searchFeed() {
    if (feedTimer) clearTimeout(feedTimer);
    feedResults = null;
    feedError = "";
    const seq = ++feedSeq;
    if (!feedRole && !feedText) return;
    feedTimer = setTimeout(() => { feedTimer = null; void fetchFeedSearch(seq); }, 250);
  }
  async function fetchFeedSearch(seq) {
    try {
      const d = await getJson(feedLogsQuery(), pollSignal());
      if (seq !== feedSeq) return; // a later filter change issued a newer request
      feedResults = (d && d.events ? d.events : []).slice().reverse(); // newest first
    } catch (err) {
      if (seq !== feedSeq) return;
      feedResults = null;
      feedError = err && err.message ? err.message : "Search unavailable";
    }
    if (lastStatus) renderFeed(lastStatus);
  }
  // The Loop picker's options follow the fleet's role list (custom loops included), keyed so a
  // poll with no roster change repaints nothing. A role the fleet dropped falls back to All
  // loops and persists, exactly as syncRolePicker does for the report and History pickers.
  function syncFeedRoles(d) {
    if (!d) return;
    feedRole = syncRolePicker("feedrole", (d.loops || []).map((l) => l.role), feedRole, "feed-role");
  }
  // An empty feed state: a li.empty with a bold head, a body, and the shared Clear-filter
  // button that ends all three search/error/filter-empty rows — one home for the button's
  // markup so the three cannot drift. The last empty state (nothing notable / no events yet)
  // carries no Clear-filter action, so it stays literal.
  const emptyFeedRow = (head, body) => "<li class='empty'><strong>" + head + "</strong>" + body +
    "<button type='button' class='linkish' data-action='feedclear'>Clear filter</button></li>";
  // A per-type tally for the Activity feed, mirroring the CLI's logs --count display rule
  // (read-only from src/cli/log-commands.ts's sayTally): one N × <type> chip per present event
  // type, count-descending then type-name ascending. A pure function of the rows in hand, so the
  // chips and the <li> rows below cannot drift on which events count; "" for an empty array so
  // empty and empty-state feeds paint no stray chips.
  function tallyChips(events) {
    if (!events.length) return "";
    const counts = new Map();
    for (const e of events) counts.set(e.type, (counts.get(e.type) || 0) + 1);
    return "<div class='feed-tally chips'>" + [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([type, n]) => "<span class='chip mono' title='" + esc(type) + "'>" + n + " × " + esc(eventTypeLabel(type)) + "</span>").join("") + "</div>";
  }
  function renderFeed(d) {
    syncFeedRoles(d);
    // Re-arm the debounced server search whenever the filter changed since the last paint (so a
    // recalled filter searches once at load, and no poll refetches an unchanged one).
    const key = feedRole + "\u0000" + feedText;
    if (key !== feedQueryKey) {
      feedQueryKey = key;
      searchFeed();
    }
    const items = (d.eventItems || []).slice().reverse(); // newest first
    const notable = feedFilter === "all" ? items : items.filter((it) => eventKind(it) !== "routine");
    const needle = feedText.toLowerCase();
    const local = notable.filter((it) =>
      (!feedRole || it.loop === feedRole) &&
      (!needle || (it.loop + " " + it.type + " " + it.message).toLowerCase().includes(needle)));
    // The server's /api/logs slice replaces the carried window once it answers; the Notable/All
    // choice still culls it. A failed fetch paints the search-empty state, never a misleading
    // partial window.
    const serverRows = feedResults !== null
      ? (feedFilter === "all" ? feedResults : feedResults.filter((it) => eventKind(it) !== "routine"))
      : null;
    const shown = feedError ? [] : serverRows !== null ? serverRows : local;
    markActive($("feedfilter"), "filter", feedFilter);
    const roles = new Set((d.loops || []).map((l) => l.role));
    paintPanel("feed", shown.length
      ? tallyChips(shown) + shown.map((it) => {
        const kind = eventKind(it);
        const tone = it.type === "tick_end" && kind === "problem" ? resultInfo(it.result).tone : KINDS[kind][1];
        const whoLabel = it.loop === "harness" ? "tumwater" : roleLabel(it.loop); // vocabulary-ok: the harness event source
        const who = roles.has(it.loop) // vocabulary-ok: event field name
          ? "<button type='button' class='linkish feed-loop' data-open='" + esc(it.loop) + "'>" + esc(whoLabel) + "</button>" // vocabulary-ok: CSS class and event field
          : "<span class='feed-loop'>" + esc(whoLabel) + "</span>"; // vocabulary-ok: CSS class
        return "<li class='feed-item k-" + kind + "'><span class='feed-icon t-" + tone + "'>" + icon(KINDS[kind][0]) + "</span>" +
          "<div class='feed-msg clamp2' title='" + esc(it.message) + "'>" + who + esc(it.message) + "</div>" +
          "<time class='feed-time' title='" + esc(fmtClock(it.ts)) + "'>" + esc(fmtAgo(it.ts)) + "</time></li>";
      }).join("")
      : feedResults !== null
        ? emptyFeedRow("No events match this filter in the log's recent slice", "Widen the Search or Role picker to look further back. ")
        : feedError
          ? emptyFeedRow("Search unavailable", esc(feedError) + " — the running server may predate the /api/logs endpoint. ")
          : notable.length
            ? emptyFeedRow("No recent events match this filter", "Clear the Role or Search box to see the recent feed again. ")
            : "<li class='empty'><strong>" + (items.length ? "Nothing notable lately" : "No events yet") + "</strong>" +
              (items.length ? "Merges, failures, and questions show up here. All events has every run start and check." : "Events appear here as the roles work.") + "</li>");
  }
  function clearFeedFilter() {
    feedRole = "";
    feedText = "";
    store("feed-role", "");
    store("feed-grep", "");
    if ($("feedrole")) $("feedrole").value = "";
    if ($("feedgrep")) $("feedgrep").value = "";
    if (lastStatus) renderFeed(lastStatus);
  }
  $("feedfilter").addEventListener("click", (ev) => {
    const b = clickClosest(ev, "button[data-filter]");
    if (!b) return;
    feedFilter = b.dataset.filter;
    store("feed", feedFilter);
    if (lastStatus) renderFeed(lastStatus);
  });
  $("feedrole").addEventListener("change", (ev) => {
    feedRole = ev.target.value;
    store("feed-role", feedRole);
    if (lastStatus) renderFeed(lastStatus);
  });
  // The box's value is restored once at load and otherwise left untouched: renderFeed repaints
  // the feed on every status poll, so writing feedText back into the box there would wipe the
  // operator's in-progress typing before the committed text caught up. Filter on input so the
  // feed narrows as the operator types.
  $("feedgrep").value = feedText;
  $("feedgrep").addEventListener("input", (ev) => {
    feedText = ev.target.value.trim();
    store("feed-grep", feedText);
    if (lastStatus) renderFeed(lastStatus);
  });
  // The empty state's #feed is static markup, so its delegated listener registers at load like
  // the #feedfilter one above.
  $("feed").addEventListener("click", (ev) => {
    if (clickClosest(ev, "button[data-action='feedclear']")) clearFeedFilter();
  });
  // activity:end

  function renderFleet(d) {
    const loops = d.loops || [];
    const sub = plural(loops.length, "role") + " · " + (d.running ? loops.filter((l) => phaseInfo(l.phase).live).length + " in flight" : "the team is stopped") +
      (d.paused ? " · paused" : "");
    if ($("fleetsub").textContent !== sub) $("fleetsub").textContent = sub;
    renderStats(d);
    renderLoops(d);
    renderBacklog(d);
    renderFeed(d);
  }
`;
