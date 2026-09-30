/** The dashboard's fleet view, browser-side — the main screen between polls: the sidebar's
 * project name and fleet status (loops running, build state, the land queue's depth and
 * in-flight landing), the alerts band for whatever needs a human (a failing loop, a red main,
 * a spent budget, an old build, open questions, a pause), today's progress tiles with their
 * per-day bar chart, the backlog with its questions/plans/bugs tabs, the notable activity
 * feed, and the composer that steers the director or one single loop (the loops table with
 * its per-row actions lives in gui-client-loops.ts). renderFleet repaints all of it from each
 * /api/status poll. Spliced into gui-client.ts's script, reaching its helpers (esc, icon,
 * getJson, postJson, plural, recall, fmtAgo, fmtTokens, fmtUsd, paintPanel, showFlash)
 * through that concatenation. */
import { DIRECTOR_PROMPT_MAX_CHARS } from "../inbox.js";
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
  function landingTitle(q) {
    const f = q.inFlight;
    const now = f ? " Landing now: " + f.role + " — " + (f.summary || "") + (f.stage ? " (" + String(f.stage).replace("-", " ") + ")" : "") : "";
    return plural(q.depth, "change") + " in the land queue." + now;
  }
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
        rows += row(stale ? (d.build.restartBlocked ? "amber" : "blue") : "", icon("refresh"),
          "Build <span class='mono'>" + esc(String(d.build.sha).slice(0, 8)) + "</span>" + (stale ? " · " + esc(d.build.aheadCommits || 0) + " behind" : ""),
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
        const verdict = c.status === "passed" ? "green" : c.status === "failed" ? "red" : c.status;
        rows += row(c.status === "passed" ? "green" : c.status === "failed" ? "red" : "amber", icon(c.status === "passed" ? "check" : c.status === "failed" ? "fail" : "info"),
          "Main " + verdict + esc(counts), ((d.mainCheckBadge || "").replace(/^ · /, "") + (c.at ? " — checked " + fmtAgo(c.at) : "")).trim());
      }
      // Clickable: the land-queue drawer (gui-client-drawer.ts). Same row markup as the
      // helper, plus the data-action the #statuschips listener dispatches on.
      if (d.landQueue && d.landQueue.depth > 0) rows += "<div class='row t-orange rowclickable' data-action='landqueue' title='" + esc(landingTitle(d.landQueue)) + "'>" + icon("merge") + "Land queue " + d.landQueue.depth + "</div>";
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
  }
  // sidebar:end

  // ---- alerts ----
  // Alerts are patched by key, and only their text is rewritten in place: a stall alert's
  // "no pi output for 9m47s" ticks every second, and rebuilding it would swap its buttons out
  // from under a click in progress.
  function alertParts(a) {
    return {
      shell: "<span class='alert-icon'>" + icon(ALERT_ICONS[a.key] || "info") + "</span><div class='alert-body'><div class='alert-title'></div><div class='alert-detail'></div></div>" +
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
      const parts = alertParts(a);
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
      today = await getJson("/api/report?days=1");
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
        "</span><span class='li-meta'>" + esc(q.role === "director" ? "for the director" : "for the " + q.role + " loop") + "</span></div>" +
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
  $("backlogtabs").addEventListener("click", (ev) => {
    const b = clickClosest(ev, "button[data-tab]");
    if (b) setBacklogTab(b.dataset.tab);
  });
  $("backlog").addEventListener("click", async (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;
    const cancel = t.closest("button.rowaction[data-action='promptcancel']");
    if (cancel) {
      await postAction("/api/prompt-cancel", { role: cancel.dataset.role, file: cancel.dataset.file }, (d) =>
        d && d.status === "cancelled"
          ? "Cancelled: " + (d.preview || "")
          : "No longer queued — " + (cancel.dataset.role || "the director") + " already took it");
      return;
    }
    const entry = t.closest(".backloglink");
    if (entry) toggleEntry(entry.dataset.file, Number(entry.dataset.index));
  });
  // The sidebar's "Land queue N" chip opens the land-queue drawer; every other row is
  // inert (only rows carrying the data-action dispatch).
  $("statuschips").addEventListener("click", (ev) => {
    const r = ev.target instanceof Element ? ev.target.closest("[data-action='landqueue']") : null;
    if (r) toggleLandQueue();
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

  // ---- composer: one box for the director or any single loop ----
  const PROMPT_MAX = ${DIRECTOR_PROMPT_MAX_CHARS};
  const promptInput = $("prompt");
  const targetSelect = $("prompttarget");
  let promptTarget = "director";
  let targetKey = "";
  const drafts = {}; // each target keeps its own unsent draft
  function renderComposer(d) {
    const roles = (d.loops || []).map((l) => l.role).filter((r) => r !== "director");
    const key = roles.join(",");
    if (key !== targetKey) {
      targetKey = key;
      targetSelect.innerHTML = "<option value='director'>Director</option>" + (roles.length ? "<optgroup label='One loop, at its next tick'>" +
        roles.map((r) => "<option value='" + esc(r) + "'>" + esc(r) + "</option>").join("") + "</optgroup>" : "");
      if (promptTarget !== "director" && !roles.includes(promptTarget)) setTarget("director");
      targetSelect.value = promptTarget;
    }
    const n = (d.inbox || 0) + Object.values(d.roleInbox || {}).reduce((a, b) => a + b, 0);
    const link = $("queuelink");
    link.hidden = n === 0;
    link.dataset.act = "queued";
    const text = plural(n, "prompt") + " queued";
    if (link.textContent !== text) link.textContent = text;
  }
  function composerHint() {
    $("prompthint").innerHTML = esc(promptTarget === "director"
      ? "The director runs this next, ahead of every loop."
      : "Queued for the " + promptTarget + " loop's next tick; the loop wakes right away.") +
      " <kbd>Enter</kbd> sends · <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line · <kbd>/</kbd> jumps here";
    promptInput.placeholder = promptTarget === "director" ? "Tell the fleet what to do next…" : "Tell the " + promptTarget + " loop what to do on its next tick…";
  }
  function setTarget(t) {
    if (t === promptTarget) return;
    drafts[promptTarget] = promptInput.value;
    promptTarget = t;
    targetSelect.value = t;
    promptInput.value = drafts[t] || "";
    composerHint();
    autosize();
    updateCount();
  }
  function autosize() {
    promptInput.style.height = "auto";
    promptInput.style.height = Math.min(promptInput.scrollHeight, Math.round(window.innerHeight * 0.4)) + "px";
  }
  function updateCount() {
    const n = promptInput.value.length;
    const count = $("promptcount");
    count.textContent = n > PROMPT_MAX * 0.8 ? n.toLocaleString() + " / " + PROMPT_MAX.toLocaleString() : "";
    count.className = n > PROMPT_MAX ? "res t-red" : "";
  }
  // Put text in the composer for the director and focus it (answering a question, or asking
  // about a backlog entry), leaving the cursor at the end.
  function draftForDirector(text) {
    setTarget("director");
    promptInput.value = text;
    autosize();
    updateCount();
    focusComposer();
    promptInput.setSelectionRange(text.length, text.length);
  }
  // The composer sits on the Fleet view; bring it into sight from anywhere and focus it.
  function focusComposer() {
    if (activeView !== "fleet") location.hash = "fleet";
    if (window.innerWidth <= 1180 && drawer) closeDrawer();
    $("promptform").scrollIntoView({ behavior: "smooth", block: "center" });
    promptInput.focus({ preventScroll: true });
  }
  targetSelect.addEventListener("change", () => setTarget(targetSelect.value));
  promptInput.addEventListener("input", () => { autosize(); updateCount(); });
  promptInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      $("promptform").requestSubmit();
    } else if (ev.key === "Escape") promptInput.blur();
  });
  // composer-send:start
  // Queue a prompt for the director or for one loop, through the same endpoints the CLI's
  // "prompt" and "prompt --role" use. Resolves to the confirmation to show; rejects when the
  // server did not take it (the caller keeps the text so it can be fixed and resent).
  async function sendPrompt(target, text) {
    if (target === "director") {
      await postJson("/api/prompt", { text });
      return "Queued for the director — it runs next";
    }
    await postJson("/api/prompt-role", { role: target, text });
    return "Queued for the " + target + " loop's next tick — it wakes now";
  }
  // composer-send:end
  let sending = false;
  $("promptform").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = promptInput.value.trim();
    if (!text || sending) return;
    const target = promptTarget;
    sending = true;
    $("promptsend").disabled = true;
    try {
      showFlash(await sendPrompt(target, text));
    } catch (e) {
      // The prompt was not accepted: keep the text so it can be fixed and resent.
      showFlash("error: " + e.message);
      return;
    } finally {
      sending = false;
      $("promptsend").disabled = false;
    }
    promptInput.value = "";
    drafts[target] = "";
    if (target !== "director") setTarget("director");
    autosize();
    updateCount();
    refresh();
  });
`;
