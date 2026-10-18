// vocabulary: plain
/** The dashboard's boot, browser-side: view routing over #fragment links (Back/Forward and
 * bookmarks work, re-clicking the open tab refetches), #role/<role> opening that loop's
 * drawer with the address bar following it, the global action dispatcher behind the
 * data-act/data-open attributes (alert and tile buttons, loop names anywhere, questions),
 * the keyboard shortcuts (Escape closes the drawer, "/" focuses the composer), the theme
 * toggle, and the one-second /api/status poll that renders every view and reloads the page
 * when the serving build moves. Spliced into gui-client.ts's script as its last section,
 * reaching the shared state and the render helpers of every other section through that
 * concatenation. */
export const GUI_CLIENT_BOOT_JS = String.raw`  // One tail for the "…written to the file but the worktree was left dirty" toasts: the
  // cancel/edit/file backlog actions share the same committed===false copy, kept in one place
  // so the operator-facing wording about an uncommitted edit cannot drift between them. The
  // question-answer toast names QUESTIONS.md explicitly, so it stays inline.
  function uncommittedTail(d) {
    return d.committed === false ? ", but NOT committed to main (uncommitted in the checkout)" : "";
  }
  // ---- views ----
  // view-routing:start
  const VIEWS = { team: "team-view", history: "history", usage: "report", failures: "failures", pending: "pending", settings: "settings-view" }; // vocabulary-ok: view ids
  function switchView(v) {
    if (v === "fleet") v = "team"; // vocabulary-ok: legacy dashboard hash, still routed
    if (!VIEWS[v]) v = "team";
    activeView = v;
    for (const k of Object.keys(VIEWS)) {
      $(VIEWS[k]).hidden = k !== v;
      const tab = $("tab-" + k);
      tab.classList.toggle("active", k === v);
      if (k === v) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
    if (v === "team" && lastStatus) renderTeam(lastStatus);
    if (v === "history") fetchHistory();
    if (v === "usage") fetchReport();
    if (v === "failures") fetchFailures();
    if (v === "pending") fetchPending();
    if (v === "settings") { fetchSettings(); fetchDoctor(); fetchRetirable(); fetchBrief(); }
  }
  // Tabs are plain #fragment links, so Back/Forward and bookmarks work; re-clicking the open
  // tab refetches its data. #role/<role> opens that loop's drawer (over Team on a fresh load),
  // and the address bar follows the open drawer, so a loop's live view can be linked to.
  let routed = false;
  function route() {
    // A malformed percent-escape in the fragment (#%, an unencoded paste) makes
    // decodeURIComponent throw; routing on the raw text instead keeps the page alive. This
    // matters at boot: route() runs before pollLoop(), so an unguarded throw here aborts the
    // script and the dashboard never polls again — a frozen page from a hand-edited URL.
    let h = location.hash.slice(1);
    try { h = decodeURIComponent(h); } catch { /* malformed escape: route on the raw fragment */ }
    if (h.startsWith("role/") || h.startsWith("loop/")) { // vocabulary-ok: legacy dashboard hash, still routed
      if (!routed) switchView("team");
      if (openLoopRole() !== h.slice(h.indexOf("/") + 1)) openLoop(h.slice(h.indexOf("/") + 1));
    } else switchView(h);
    routed = true;
  }
  // view-routing:end
  window.addEventListener("hashchange", route);
  $("viewnav").addEventListener("click", (ev) => {
    const a = clickClosest(ev, "a.tab");
    if (a && a.getAttribute("href") === location.hash) { ev.preventDefault(); switchView(location.hash.slice(1)); }
  });

  // The Settings view's Save buttons: the panel's rows are plain forms, and one delegated
  // submit listener saves the row's key (saveSetting, gui-client-settings). No per-row wiring,
  // so rows can repaint freely.
  document.addEventListener("submit", (ev) => {
    const form = ev.target instanceof Element ? ev.target.closest("form.settings-row") : null;
    if (form) { ev.preventDefault(); saveSetting(form); }
  });
  // The Initial prompt card's Save: its own form class, so the settings listener above never
  // routes it to saveSetting.
  document.addEventListener("submit", (ev) => {
    const form = ev.target instanceof Element ? ev.target.closest("form.brief-form") : null;
    if (form) { ev.preventDefault(); saveBrief(form); }
  });
  // The Settings view's Clear buttons: one delegated click listener resolves the row's Clear
  // through clickClosest and calls clearSetting (gui-client-settings). No per-row wiring, so
  // the panel repaints freely.
  document.addEventListener("click", (ev) => {
    const btn = clickClosest(ev, "button[data-action='unset']");
    const form = btn ? btn.closest("form.settings-row") : null;
    if (form) { ev.preventDefault(); clearSetting(form); }
  });
  // The Health check card's Re-run button: runs the doctor checks again.
  document.addEventListener("click", (ev) => {
    if (clickClosest(ev, "button[data-action='doctor-rerun']")) { ev.preventDefault(); fetchDoctor(); }
    if (clickClosest(ev, "button[data-action='notify-test']")) { ev.preventDefault(); testNotify(); }
    const retire = clickClosest(ev, "button[data-action='retire']");
    if (retire) { ev.preventDefault(); confirmRetire(retire.dataset.role); }
    const enable = clickClosest(ev, "button[data-action='enable']");
    if (enable) { ev.preventDefault(); enableRole(enable.dataset.role); }
  });
  // The Health card's Problems only checkbox: repaint the cached report with only its warn
  // and fail rows (toggleDoctorProblems, gui-client-settings), without rerunning the checks.
  document.addEventListener("change", (ev) => {
    const box = clickClosest(ev, "input[data-action='doctor-problems']");
    if (box) toggleDoctorProblems(box.checked);
  });
  // ---- global actions: alert and tile buttons, loop names anywhere, questions ----
  // run-act:start
  // The backlog drawer rows resolve a list entry's title from the last polled status by its
  // backlog file and 0-based position (entry-cancel, entry-edit, and the mention action). The
  // call sites keep their arg's "file:index" split because that shape is theirs alone.
  function entryTitleAt(file, index) {
    return ((lastStatus && lastStatus[file]) || [])[Number(index)];
  }
  function runAct(act, arg) {
    if (act === "role") openLoop(arg);
    else if (act === "close") closeDrawer();
    else if (act === "view") location.hash = arg;
    else if (act === "budget") openBudgetEditor();
    else if (act === "resume") setTeamPause(false);
    else if (act === "copy") copyText(arg);
    else if (act === "restart")
      postAction("/api/restart", {}, (d) =>
        d && typeof d.message === "string"
          ? d.message
          : "Restart requested — tumwater applies it within one poll");
    else if (act === "reclaim")
      postAction("/api/reclaim", {}, (d) =>
        d && typeof d.message === "string" ? d.message : "Reclaim requested");
    else if (act === "questions" || act === "queued" || act === "backlog") {
      if (activeView !== "team") location.hash = "team";
      if (act !== "backlog") setBacklogTab(act);
      $("backlogcard").scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (act === "answer") {
      const q = ((lastStatus && lastStatus.questions) || [])[Number(arg)];
      if (q !== undefined) draftForDirector("Answer to the open question “" + splitTitle(q).title + "”: ");
    } else if (act === "answer-record") {
      const q = ((lastStatus && lastStatus.questions) || [])[Number(arg)];
      const area = $("answertext");
      const decision = area ? area.value.trim() : "";
      if (q === undefined) return;
      if (!decision) { showFlash("Write an answer first"); return; }
      postAction("/api/question-answer", { position: Number(arg) + 1, title: q, decision }, (d) => {
        closeDrawer();
        return d && d.status === "answered"
          ? "Answered “" + splitTitle(q).title + "” — moved to ## Answered" + (d.committed === false ? ", but NOT committed to main (QUESTIONS.md is uncommitted in the checkout)" : "")
          : "That question was already answered or moved — refreshed";
      });
    } else if (act === "entry-cancel") {
      const [file, index] = arg.split(":");
      const title = entryTitleAt(file, index);
      if (title === undefined) return;
      if (!entryCancelArmed(arg, title)) { armEntryCancel(arg, title); return; }
      disarmEntryCancel();
      postAction("/api/backlog-cancel", { kind: file === "bugs" ? "bug" : "plan", position: Number(index) + 1, title }, (d) => {
        closeDrawer();
        return d && d.status === "cancelled"
          ? "Cancelled “" + splitTitle(title).title + "” from " + (file === "bugs" ? "BUGS.md" : "PLANS.md") + uncommittedTail(d)
          : "That entry was already removed or moved — refreshed";
      });
    } else if (act === "entry-release") {
      const [file, index] = arg.split(":");
      const title = entryTitleAt(file, index);
      if (title === undefined) return;
      postAction("/api/backlog-release", { kind: file === "bugs" ? "bug" : "plan", position: Number(index) + 1, title }, (d) => {
        closeDrawer();
        if (d && d.status === "released") {
          return "Released “" + splitTitle(title).title + "” in " + (file === "bugs" ? "BUGS.md" : "PLANS.md") + " — " + (file === "bugs" ? "bugfix" : "feature") + " will pick it up" + uncommittedTail(d);
        }
        return d && d.status === "not_refused"
          ? "That entry carries no Refused or Waiting note — refreshed"
          : "That entry was removed or moved — refreshed";
      });
    } else if (act === "entry-top") {
      const [file, index] = arg.split(":");
      const title = entryTitleAt(file, index);
      if (title === undefined) return;
      postAction("/api/backlog-top", { kind: file === "bugs" ? "bug" : "plan", position: Number(index) + 1, title }, (d) => {
        closeDrawer();
        if (d && d.status === "moved_to_top") {
          return "Moved “" + splitTitle(title).title + "” to the top of " + (file === "bugs" ? "BUGS.md" : "PLANS.md") + " — " + (file === "bugs" ? "bugfix" : "feature") + " takes it next" + uncommittedTail(d);
        }
        return d && d.status === "already_first"
          ? "That entry is already first — refreshed"
          : "That entry was removed or moved — refreshed";
      });
    } else if (act === "entry-edit") {
      const [file, index] = arg.split(":");
      const title = entryTitleAt(file, index);
      if (title !== undefined) startEntryEdit(arg, title);
    } else if (act === "entry-edit-discard") {
      stopEntryEdit();
      refreshEntry();
    } else if (act === "entry-edit-save") {
      const [file, index] = arg.split(":");
      // The title captured when editing began, not the list's current one: a shifted list must
      // reach the server's title check as a mismatch rather than silently retarget the save.
      const title = entryEditing && entryEditing.key === arg ? entryEditing.title : undefined;
      const titleBox = $("entryedittitle");
      const bodyBox = $("entryeditbody");
      const newTitle = titleBox ? titleBox.value.trim() : "";
      if (title === undefined) return;
      if (!newTitle) { showFlash("Write a title first"); return; }
      postAction("/api/backlog-edit", { kind: file === "bugs" ? "bug" : "plan", position: Number(index) + 1, title, newTitle, newBody: bodyBox ? bodyBox.value : "" }, (d) => {
        stopEntryEdit();
        closeDrawer();
        return d && d.status === "edited"
          ? "Edited “" + splitTitle(d.title).title + "” in " + (file === "bugs" ? "BUGS.md" : "PLANS.md") + uncommittedTail(d)
          : "That entry was removed or moved — refreshed";
      });
    } else if (act === "note-edit") {
      const note = drawerRole && drawerRole.view && typeof drawerRole.view.notes === "string" ? drawerRole.view.notes : "";
      startNoteEdit(arg, note);
    } else if (act === "note-discard") {
      stopNoteEdit();
    } else if (act === "note-save" || act === "note-clear") {
      let text = "";
      if (act === "note-save") {
        const box = $("noteedittext");
        text = box ? box.value : "";
      } else {
        if (!noteClearArmed(arg)) { armNoteClear(arg); return; }
        disarmNoteClear();
      }
      postAction("/api/role-notes", { role: arg, text }, (d) => {
        noteEditing = null;
        loadDrawerRole(arg);
        return d && typeof d.message === "string" ? d.message : "Notes updated";
      });
    } else if (act === "cap-edit") {
      startCapEdit(arg, drawerRole?.view?.dailyCap?.capUsd ?? 0);
    } else if (act === "cap-discard") {
      stopCapEdit();
    } else if (act === "cap-save") {
      const input = $("capeditinput");
      if (!input) return;
      // A type=number input reports "" both for a field cleared on purpose (no cap) and for
      // text the browser rejected ("$2"); validity.badInput tells them apart, so a typo is an
      // error instead of silently removing the cap — the team editor's guard, in scope from
      // the operator blob concatenated earlier.
      if (input.validity && input.validity.badInput) {
        showFlash("error: the cap must be a number of 0 or more — leave it empty for no cap");
        return;
      }
      const parsed = parseBudgetField(input.value);
      if (!parsed.ok) {
        showFlash("error: " + parsed.error);
        return;
      }
      const value = parsed.value;
      postAction("/api/role-cap", { role: arg, maxDailyCostUsd: value }, (d) => {
        capEditing = null;
        loadDrawerRole(arg);
        return value > 0 ? "Daily cap set to " + fmtCap(value) : "Daily cap removed";
      });
    } else if (act === "interval-edit") {
      startIntervalEdit(arg, drawerRole?.view?.minRunIntervalOverride ?? "");
    } else if (act === "interval-discard") {
      stopIntervalEdit();
    } else if (act === "interval-save") {
      const input = $("intervaleditinput");
      if (!input) return;
      // A type=number input reports "" both for a field cleared on purpose (the team
      // default) and for text the browser rejected ("$2"); validity.badInput tells them
      // apart, so a typo is an error instead of silently clearing the override — the cap
      // arm's guard, in scope from the operator blob concatenated earlier.
      if (input.validity && input.validity.badInput) {
        showFlash("error: the interval must be a number of 0 or more — leave it empty for the team default");
        return;
      }
      const raw = input.value.trim();
      const value = raw === "" ? null : Number(raw);
      postAction("/api/role-interval", { role: arg, minRunIntervalSeconds: value }, (d) => {
        intervalEditing = null;
        loadDrawerRole(arg);
        return d && typeof d.message === "string" ? d.message : "Min run interval updated";
      });
    } else if (act === "instructions-edit") {
      startInstructionsEdit(arg, drawerRole?.view?.instructions ?? "");
    } else if (act === "instructions-discard") {
      stopInstructionsEdit();
    } else if (act === "instructions-save") {
      const box = $("instructionsedittext");
      const text = box ? box.value : "";
      postAction("/api/role-instructions", { role: arg, text }, (d) => {
        instructionsEditing = null;
        loadDrawerRole(arg);
        return d && typeof d.message === "string" ? d.message : "Instructions updated";
      });
    } else if (act === "quiet-edit") {
      startQuietEdit(arg, drawerRole?.view?.quietHours?.find((w) => w && w.scope === "role")?.window ?? "");
    } else if (act === "quiet-discard") {
      stopQuietEdit();
    } else if (act === "quiet-save") {
      const input = $("quieteditinput");
      const window = input ? input.value : "";
      // A text input has no badInput guard; an empty value reaches the server's clear branch,
      // and a malformed window is refused by checkQuietHours, flashed through postAction's
      // error path.
      postAction("/api/role-quiet-hours", { role: arg, window }, (d) => {
        quietEditing = null;
        loadDrawerRole(arg);
        return d && typeof d.message === "string" ? d.message : "Quiet hours updated";
      });
    } else if (act === "mention") {
      const [file, index] = arg.split(":");
      const title = entryTitleAt(file, index);
      if (title !== undefined) draftForDirector("About “" + splitTitle(title).title + "”: ");
    }
  }
  // run-act:end
  onClick((t, ev) => {
    const act = t.closest("[data-act]");
    if (act) { ev.preventDefault(); runAct(act.dataset.act, act.dataset.arg || ""); return; }
    const open = t.closest("[data-open]");
    // A history row's drill-down button sits inside the row's data-open cell area but must not
    // open the drawer — expansion is the button's alone (gui-client-history's own delegated
    // handler toggles the card).
    if (open && !t.closest("#rolerows") && !t.closest("[data-tickdetail]")) { // vocabulary-ok: element selectors
      ev.preventDefault();
      toggleLoop(open.dataset.open);
    }
  });
  const typing = (el) => el instanceof Element && el.closest("input, textarea, select, [contenteditable]") !== null;
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (openMenu) { closeMenus(); return; }
      if (drawer && !typing(ev.target)) { closeDrawer(); return; }
    }
    if (ev.key === "/" && !typing(ev.target) && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      focusComposer();
    }
  });
  // Sound: the browser keeps an AudioContext created before the first user gesture suspended,
  // so the first pointerdown or keydown arms it (armAudio, gui-client-sound.ts). One-time
  // listeners: once armed, later gestures have nothing to do.
  document.addEventListener("pointerdown", armAudio, { once: true });
  document.addEventListener("keydown", armAudio, { once: true });
  $("themetoggle").addEventListener("click", () => {
    const root = document.documentElement;
    const current = root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    store("theme", next);
  });

  // ---- the poll ----
  function rerender() {
    if (!lastStatus) return;
    if (activeView === "team") renderTeam(lastStatus);
    if (activeView === "pending") renderPendingQueue(lastStatus);
    if (drawer && drawer.kind === "loop") renderLoopDrawer(lastStatus); // vocabulary-ok: drawer kind
  }
  let lastEventKey = null;
  // New events are what move the numbers the other panels show (today's merges, the History
  // rows, the open loop's recent ticks), so they refetch on that signal, each throttled.
  function onNewEvents() {
    refreshToday(false);
    if (activeView === "history") fetchHistory(true);
    if (activeView === "usage") fetchReport(true);
    loadLoopTicks(false);
  }
  async function refresh() {
    let d;
    try {
      // The guarded getJson: the server's 500 sends a JSON {error} body, which must never be
      // taken for team state — a failed poll keeps the last good frame and says so. The
      // bounded wait covers the other failure a bare fetch never reports: a connection the
      // server accepted but never answers (pollSignal).
      d = await getJson("/api/status", pollSignal());
    } catch {
      offline = true;
      renderSidebar(lastStatus);
      renderAlerts(lastStatus);
      return;
    }
    offline = false;
    lastStatus = d;
    // A newer serving build means this page is stale: reload before painting a frame.
    if (d.serverBuildSha) {
      if (serverBuildSha === null) serverBuildSha = d.serverBuildSha;
      else if (d.serverBuildSha !== serverBuildSha) {
        location.reload();
        return;
      }
    }
    try {
      renderSidebar(d);
      renderAlerts(d);
      renderComposer(d);
      if (activeView === "team") renderTeam(d);
      if (activeView === "pending") renderPendingQueue(d);
      if (activeView === "history") syncHistoryRoles(d);
      // Keep the Usage/Failures Loop pickers in step with the team while either is open.
      if (activeView === "usage" || activeView === "failures") syncReportRoles(d);
      const items = d.eventItems || [];
      const last = items[items.length - 1];
      const key = last ? last.ts + ":" + last.type + ":" + last.source : "";
      if (lastEventKey !== null && key !== lastEventKey) onNewEvents();
      lastEventKey = key;
    } catch (err) {
      console.error("tumwater: render failed", err);
    }
    await refreshDrawer();
  }

  // One poll in flight at a time: the next poll starts one interval after the previous one
  // settles (render included), so a slow response can never stack overlapping polls against
  // the server — the fixed setInterval fired on schedule regardless of whether the last poll
  // had finished. The chain's one contract is to keep polling: refresh guards its own fetches
  // and renders, but anything that escapes it is caught here, because a rejection would kill
  // the chain at the setTimeout below and freeze the page exactly like the wedged server this
  // loop exists to survive — so the reschedule runs no matter how the poll ended. pollSignal
  // bounds each request so a wedged server cannot park an iteration forever.
  async function pollLoop() {
    try {
      await refresh();
    } catch (err) {
      console.error("tumwater: poll failed", err);
    }
    setTimeout(pollLoop, 1000);
  }
  composerHint();
  attachReportTip();
  route();
  refreshToday(true);
  pollLoop();`;
