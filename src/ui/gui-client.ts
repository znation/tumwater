/** The browser-side dashboard app inlined as the GUI page's only <script>. It polls /api/status
 * every second and renders, in the order an operator needs them: the masthead's fleet status
 * (running, build, land queue) and fleet controls (budget, pause); alerts for whatever needs a
 * human (a failing loop, a red main, a spent budget, an old build, open questions, a pause);
 * the composer that steers the director or one loop; and the fleet view — today's progress,
 * the loops grouped by what they are doing, the backlog, and the notable activity. The
 * view-model, the drawer, the History/Usage/Failures views, the operator controls, and the
 * Markdown renderer live in their own modules and are spliced in below; everything shares
 * one scope. The page
 * cannot import the harness modules, so it keeps its own copies of the few display rules it
 * needs (formatters, loop order), each pinned against its TypeScript twin by test. Written as
 * String.raw templates so the served script is exactly the text below — no double escaping. */
import { GUI_CLIENT_DRAWER_JS } from "./gui-client-drawer.js";
import { GUI_CLIENT_FLEET_JS } from "./gui-client-fleet.js";
import { GUI_CLIENT_HISTORY_JS } from "./gui-client-history.js";
import { GUI_CLIENT_MARKDOWN_JS } from "./gui-client-markdown.js";
import { GUI_CLIENT_MODEL_JS } from "./gui-client-model.js";
import { GUI_CLIENT_OPERATOR_JS } from "./gui-client-operator.js";
import { GUI_CLIENT_REPORT_JS } from "./gui-client-report.js";
import { ICON_PATHS } from "./gui-icons.js";

/** The client's opening: escaping and the guarded API helpers every call goes through. Kept
 * free of DOM access so tests can run it with only a stubbed fetch. */
const CORE_JS = String.raw`  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  // A failed API call, named for the operator: endpoint, HTTP status, and the server's error
  // text — every error body this server sends is JSON {error} except the 404's plain "not
  // found", so parse leniently.
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
  // Opt-in shared-token auth: the CLI prints the dashboard URL with ?token=<secret> when a
  // token is set. Read it once, send it as a Bearer header on every API call, and strip it from
  // the address bar so a screen share does not leak it.
  const guiToken = (typeof location !== "undefined" && new URLSearchParams(location.search).get("token")) || "";
  if (guiToken) {
    const stripped = new URL(location.href);
    stripped.searchParams.delete("token");
    history.replaceState(null, "", stripped.pathname + stripped.search + stripped.hash);
  }
  // One response guard for every API call: on a non-2xx, throw apiError instead of letting a
  // JSON error body be read as data.
  async function apiFetch(path, init) {
    const headers = new Headers(init && init.headers);
    if (guiToken) headers.set("authorization", "Bearer " + guiToken);
    const r = await fetch(path, Object.assign({}, init || {}, { headers: headers }));
    if (!r.ok) throw await apiError(path, r);
    return r;
  }
  async function getJson(path) {
    return (await apiFetch(path)).json();
  }
  // A JSON POST; resolves to the endpoint's JSON answer (null if it sent none).
  async function postJson(path, payload) {
    const r = await apiFetch(path, { method: "POST", headers: { "content-type": "application/json" },
                                     body: JSON.stringify(payload) });
    try { return await r.json(); } catch { return null; }
  }
`;

/** Display formatters — the client copies of text.ts / status-model.ts / status-render.ts
 * rules. The marked regions are the ones tests run against their TypeScript twins. */
const FORMAT_JS = String.raw`  // format:start
  const fmtTokens = (n) => (n >= 1000000 ? (n / 1000000).toFixed(1) + "M" : n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n || 0));
  const fmtUsd = (n) => "$" + n.toFixed(2);
  // A cap: whole dollars stay bare ($15), fractional ones keep their cents — text.ts's usdCap.
  const fmtCap = (n) => "$" + n.toFixed(2).replace(/\.00$/, "");
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  // human-seconds-fmt:start
  // Whole-second s/m/h label: <60 → Ns, <3600 → rounded Nm, else rounded Nh — status-model.ts's
  // humanSeconds, shared by every relative time on the page.
  const humanSeconds = (sec) => (sec < 60 ? sec + "s" : sec < 3600 ? Math.round(sec / 60) + "m" : Math.round(sec / 3600) + "h");
  // human-seconds-fmt:end
  // active-phase-fmt:start
  // A loop in flight — status-model.ts's isActivePhase: its phase starts with working,
  // reviewing, or landing. One home for the three prefixes fmtNextRun and loopRank share.
  const isActivePhase = (phase) => phase.startsWith("working") || phase.startsWith("reviewing") || phase.startsWith("landing");
  // active-phase-fmt:end
  // last-tick-fmt:start
  // The absolute local time of a tick end with its age ("14:32:05 · 3m ago"), prefixed MM-DD
  // once older than a day; "-" when never ticked — status-render.ts's lastTickCell.
  const fmtLastTick = (ts) => {
    if (!ts) return "-";
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    let s = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    if (Date.now() - ts > 86400000) s = p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + s;
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    const age = humanSeconds(sec) + " ago";
    return s + " · " + age;
  };
  // last-tick-fmt:end
  // next-run-fmt:start
  // When an idle loop may tick again — status-render.ts's nextRunCell: "-" for a loop in flight
  // or parked awaiting a slot (it has no next run to speak of) and for a stopped fleet; "now"
  // when due; otherwise the remaining time, prefixed "backoff " while backing off. A yield-scaled
  // clock rides as a " ×N" suffix: a quiet role's effective gap is longer than the countdown.
  const fmtNextRun = (l, fleetRunning) => {
    const active = isActivePhase(l.phase) || l.phase.startsWith("awaiting slot");
    if (!fleetRunning || active) return "-";
    const sec = Math.round((l.nextRunAt - Date.now()) / 1000);
    const suffix = l.yieldMultiplier > 1 ? " ×" + l.yieldMultiplier : "";
    if (sec <= 0) return "now" + suffix;
    return (l.backoffSeconds > 0 ? "backoff " : "") + humanSeconds(sec) + suffix;
  };
  // next-run-fmt:end
  // A relative age for lists; the first minute reads "just now" so rows do not churn every
  // second.
  const fmtAgo = (ts) => {
    if (!ts) return "never";
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return sec < 60 ? "just now" : humanSeconds(sec) + " ago";
  };
  const fmtClock = (ts) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  // A tick's duration: seconds under two minutes, then minutes, then hours.
  const fmtSpan = (ms) => (ms < 120000 ? Math.round(ms / 1000) + "s" : ms < 7200000 ? Math.round(ms / 60000) + "m" : (ms / 3600000).toFixed(1) + "h");
  // Server text sometimes carries ISO instants (a restart cooldown's deadline); show them in
  // the viewer's local time.
  const localizeInstants = (s) => String(s).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => fmtClock(Date.parse(iso)));
  // format:end
`;

/** Shared DOM helpers: icons, pills, panels that repaint only on change, local preferences,
 * the toast, and the one-open-menu registry. */
const DOM_JS = String.raw`  const ICONS = ${JSON.stringify(ICON_PATHS)};
  const icon = (name) => "<svg class='i' viewBox='0 0 24 24' aria-hidden='true'>" + (ICONS[name] || "") + "</svg>";
  const $ = (id) => document.getElementById(id);
  const pill = (info) => "<span class='pill t-" + info.tone + "'><span class='dot" + (info.live ? " live" : "") + "'></span>" + esc(info.label) + "</span>";
  // Repaint a panel only when its markup changed: an idle fleet's payload is identical poll
  // after poll, and rewriting identical HTML re-parses it, churns layout, and drops the
  // reader's text selection for nothing. Returns true when it repainted.
  const lastPaint = {};
  function paintPanel(id, html) {
    if (html === lastPaint[id]) return false;
    const el = $(id);
    if (!el) return false;
    el.innerHTML = html;
    lastPaint[id] = html;
    return true;
  }
  // Per-viewer preferences (theme, open backlog tab, filters): best effort, never required.
  function store(key, value) {
    try { localStorage.setItem("tumwater-" + key, value); } catch { /* storage unavailable */ }
  }
  function recall(key) {
    try { return localStorage.getItem("tumwater-" + key); } catch { return null; }
  }
  let flashTimer = null;
  function showFlash(msg) {
    const f = $("flash");
    const error = /^error/.test(msg);
    f.textContent = msg;
    f.className = "toast" + (error ? " error" : "");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { f.textContent = ""; }, error ? 7000 : 3500);
  }
  // At most one popover (budget editor, pause menu) is open; a click outside it or Esc closes it.
  let openMenu = null; // { root, close }
  function closeMenus() {
    if (!openMenu) return;
    const m = openMenu;
    openMenu = null;
    m.close();
  }
  document.addEventListener("pointerdown", (ev) => {
    if (openMenu && ev.target instanceof Node && !openMenu.root.contains(ev.target)) closeMenus();
  }, true);
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showFlash("Copied: " + text);
    } catch {
      showFlash("The command is: " + text);
    }
  }
  // The latest /api/status payload, and the serving process's build sha from the first poll —
  // a later change means a redeploy re-execed the server, and the page reloads onto it.
  let lastStatus = null;
  let serverBuildSha = null;
  let offline = false;
  let activeView = "fleet";
`;

/** Routing between views, global actions and keys, the theme toggle, and the poll loop. */
const BOOT_JS = String.raw`  // ---- views ----
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
  window.addEventListener("hashchange", route);
  $("viewnav").addEventListener("click", (ev) => {
    const a = ev.target instanceof Element ? ev.target.closest("a.tab") : null;
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
  document.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;
    const act = t.closest("[data-act]");
    if (act) { ev.preventDefault(); runAct(act.dataset.act, act.dataset.arg || ""); return; }
    const open = t.closest("[data-open]");
    if (open && !t.closest("#loops")) { ev.preventDefault(); toggleLoop(open.dataset.open); }
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
      // taken for fleet state — a failed poll keeps the last good frame and says so.
      d = await getJson("/api/status");
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

  composerHint();
  attachReportTip();
  route();
  refreshToday(true);
  refresh();
  setInterval(refresh, 1000);`;

export const GUI_CLIENT_JS = [CORE_JS, FORMAT_JS, GUI_CLIENT_MODEL_JS, DOM_JS, GUI_CLIENT_MARKDOWN_JS, GUI_CLIENT_OPERATOR_JS, GUI_CLIENT_FLEET_JS,
  GUI_CLIENT_DRAWER_JS, GUI_CLIENT_HISTORY_JS, GUI_CLIENT_REPORT_JS, BOOT_JS].join("\n");
