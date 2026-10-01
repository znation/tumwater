/** The dashboard's boot, browser-side: view routing over #fragment links (Back/Forward and
 * bookmarks work, re-clicking the open tab refetches), #loop/<role> opening that loop's
 * drawer with the address bar following it, the global action dispatcher behind the
 * data-act/data-open attributes (alert and tile buttons, loop names anywhere, questions),
 * the keyboard shortcuts (Escape closes the drawer, "/" focuses the composer), the theme
 * toggle, and the one-second /api/status poll that renders every view and reloads the page
 * when the serving build moves. Spliced into gui-client.ts's script as its last section,
 * reaching the shared state and the render helpers of every other section through that
 * concatenation. */
export const GUI_CLIENT_BOOT_JS = String.raw`  // ---- views ----
  // view-routing:start
  const VIEWS = { fleet: "fleet-view", history: "history", usage: "report", failures: "failures" };
  function switchView(v) {
    if (!VIEWS[v]) v = "fleet";
    activeView = v;
    for (const k of Object.keys(VIEWS)) {
      $(VIEWS[k]).hidden = k !== v;
      const tab = $("tab-" + k);
      tab.classList.toggle("active", k === v);
      if (k === v) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
    if (v === "fleet" && lastStatus) renderFleet(lastStatus);
    if (v === "history") fetchHistory();
    if (v === "usage") fetchReport();
    if (v === "failures") fetchFailures();
  }
  // Tabs are plain #fragment links, so Back/Forward and bookmarks work; re-clicking the open
  // tab refetches its data. #loop/<role> opens that loop's drawer (over Fleet on a fresh load),
  // and the address bar follows the open drawer, so a loop's live view can be linked to.
  let routed = false;
  function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h.startsWith("loop/")) {
      if (!routed) switchView("fleet");
      if (openLoopRole() !== h.slice(5)) openLoop(h.slice(5));
    } else switchView(h);
    routed = true;
  }
  // view-routing:end
  window.addEventListener("hashchange", route);
  $("viewnav").addEventListener("click", (ev) => {
    const a = clickClosest(ev, "a.tab");
    if (a && a.getAttribute("href") === location.hash) { ev.preventDefault(); switchView(location.hash.slice(1)); }
  });

  // ---- global actions: alert and tile buttons, loop names anywhere, questions ----
  function runAct(act, arg) {
    if (act === "loop") openLoop(arg);
    else if (act === "close") closeDrawer();
    else if (act === "view") location.hash = arg;
    else if (act === "budget") openBudgetEditor();
    else if (act === "resume") setFleetPause(false);
    else if (act === "copy") copyText(arg);
    else if (act === "restart")
      postAction("/api/restart", {}, (d) =>
        d && typeof d.message === "string"
          ? d.message
          : "Restart requested — the fleet applies it within one poll");
    else if (act === "questions" || act === "queued" || act === "backlog") {
      if (activeView !== "fleet") location.hash = "fleet";
      if (act !== "backlog") setBacklogTab(act);
      $("backlogcard").scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (act === "answer") {
      const q = ((lastStatus && lastStatus.questions) || [])[Number(arg)];
      if (q !== undefined) draftForDirector("Answer to the open question “" + splitTitle(q).title + "”: ");
    } else if (act === "mention") {
      const [file, index] = arg.split(":");
      const title = ((lastStatus && lastStatus[file]) || [])[Number(index)];
      if (title !== undefined) draftForDirector("About “" + splitTitle(title).title + "”: ");
    }
  }
  onClick((t, ev) => {
    const act = t.closest("[data-act]");
    if (act) { ev.preventDefault(); runAct(act.dataset.act, act.dataset.arg || ""); return; }
    const open = t.closest("[data-open]");
    // A history row's drill-down button sits inside the row's data-open cell area but must not
    // open the drawer — expansion is the button's alone (gui-client-history's own delegated
    // handler toggles the card).
    if (open && !t.closest("#loops") && !t.closest("[data-tickdetail]")) { ev.preventDefault(); toggleLoop(open.dataset.open); }
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
    if (activeView === "fleet") renderFleet(lastStatus);
    if (drawer && drawer.kind === "loop") renderLoopDrawer(lastStatus);
  }
  let lastEventKey = null;
  // New events are what move the numbers the other panels show (today's landings, the History
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
      // taken for fleet state — a failed poll keeps the last good frame and says so. The
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
      if (activeView === "fleet") renderFleet(d);
      if (activeView === "history") syncHistoryRoles(d);
      const items = d.eventItems || [];
      const last = items[items.length - 1];
      const key = last ? last.ts + ":" + last.type + ":" + last.loop : "";
      if (lastEventKey !== null && key !== lastEventKey) onNewEvents();
      lastEventKey = key;
    } catch (e) {
      console.error("tumwater: render failed", e);
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
    } catch (e) {
      console.error("tumwater: poll failed", e);
    }
    setTimeout(pollLoop, 1000);
  }
  composerHint();
  attachReportTip();
  route();
  refreshToday(true);
  pollLoop();`;
