/** The browser-side dashboard app inlined as the GUI page's only <script>. It polls /api/status
 * every second and renders, in the order an operator needs them: the masthead's fleet status
 * (running, build, land queue) and fleet controls (budget, pause); alerts for whatever needs a
 * human (a failing loop, a red main, a spent budget, an old build, open questions, a pause);
 * the composer that steers the director or one loop; and the fleet view — today's progress,
 * the loops grouped by what they are doing, the backlog, and the notable activity. The
 * drawer, the History/Usage/Failures views, the operator controls, and the Markdown renderer
 * live in their own modules and are spliced in below; everything shares one scope. The page
 * cannot import the harness modules, so it keeps its own copies of the few display rules it
 * needs (formatters, loop order), each pinned against its TypeScript twin by test. Written as
 * String.raw templates so the served script is exactly the text below — no double escaping. */
import { GUI_CLIENT_DRAWER_JS } from "./gui-client-drawer.js";
import { GUI_CLIENT_HISTORY_JS } from "./gui-client-history.js";
import { GUI_CLIENT_MARKDOWN_JS } from "./gui-client-markdown.js";
import { GUI_CLIENT_OPERATOR_JS } from "./gui-client-operator.js";
import { GUI_CLIENT_REPORT_JS } from "./gui-client-report.js";
import { ICON_PATHS } from "./gui-icons.js";
import { DIRECTOR_PROMPT_MAX_CHARS } from "../inbox.js";

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

/** The view model: pure functions from payload fields to what the page shows — no DOM. */
const MODEL_JS = String.raw`  // view-model:start
  // How a loop's phase label (status-model.ts loopPhase) reads here: a status word and tone for
  // its pill, whether it is live work, and the detail the label carried after its first word.
  function phaseInfo(phase) {
    const p = String(phase || "");
    const after = (n) => p.slice(n).replace(/^[\s·,]+/, "");
    if (p.startsWith("working")) return { key: "working", label: "Working", tone: "blue", live: true, detail: after(7) };
    if (p.startsWith("reviewing")) return { key: "reviewing", label: "Reviewing", tone: "violet", live: true, detail: after(9) };
    if (p.startsWith("landing")) return { key: "landing", label: "Landing", tone: "orange", live: true, detail: after(7) };
    if (p.startsWith("vetted")) return { key: "vetted", label: "Approved", tone: "indigo", live: false, detail: "waiting for the merge slot" };
    if (p.startsWith("awaiting slot")) return { key: "awaiting", label: "Waiting for a slot", tone: "gray", live: false, detail: after(13) ? "for " + after(13) : "" };
    if (p === "failing") return { key: "failing", label: "Failing", tone: "red", live: false, detail: "the same error, tick after tick" };
    if (p === "main red") return { key: "mainred", label: "Main red", tone: "red", live: false, detail: "blocked until main's suite passes" };
    if (p === "paused") return { key: "paused", label: "Paused", tone: "amber", live: false, detail: "starts no new ticks" };
    if (p === "budget paused") return { key: "budget", label: "Budget paused", tone: "amber", live: false, detail: "today's cap is spent" };
    if (p.startsWith("sleeping")) return { key: "sleeping", label: "Sleeping", tone: "gray", live: false, detail: "" };
    if (p === "queued") return { key: "queued", label: "Queued", tone: "gray", live: false, detail: "due — waiting for a free slot" };
    if (p === "waiting for prompts") return { key: "waiting", label: "Waiting", tone: "gray", live: false, detail: "runs when you send it a prompt" };
    if (p === "stopped") return { key: "stopped", label: "Stopped", tone: "gray", live: false, detail: "the fleet is not running" };
    return { key: "other", label: p || "unknown", tone: "gray", live: false, detail: "" };
  }
  // A stalled tool call or a long silence, as the phase label names them (status-model.ts's
  // inFlightDetail) — the cue that a working loop may be stuck.
  const STALL = /tool call stalled[^·]*|no pi output for [^·]*/;
  // A tick result (tick-outcome.ts TickResult) in words, with the tone of its outcome.
  const RESULTS = {
    changed: ["Landed", "green"],
    queued: ["Queued to land", "indigo"],
    no_change: ["No change", "gray"],
    skipped: ["Skipped", "gray"],
    refused: ["Refused", "amber"],
    rejected: ["Rejected in review", "amber"],
    review_error: ["Review failed", "red"],
    merge_conflict: ["Merge conflict", "red"],
    merge_blocked: ["Merge blocked", "red"],
    error: ["Error", "red"],
    aborted: ["Interrupted", "amber"],
    quiet_killed: ["Stalled, resumed", "amber"],
    user_aborted: ["Aborted by you", "gray"],
    main_red: ["Main red", "red"],
  };
  function resultInfo(result) {
    const r = RESULTS[result];
    return r ? { label: r[0], tone: r[1] } : { label: String(result || "—").replace(/_/g, " "), tone: "gray" };
  }
  const PROBLEM_RESULTS = ["refused", "rejected", "review_error", "merge_conflict", "merge_blocked", "error", "aborted", "quiet_killed", "main_red"];
  // What explains a loop's last result: its summary, or — for a problem that carries none — the
  // last error the loop recorded.
  const resultWhy = (l) => l.lastSummary || (PROBLEM_RESULTS.includes(l.lastResult) || l.phase === "failing" ? l.lastError || "" : "");
  // loop-sort:start
  // Loop order — status-model.ts's loopRank/sortLoopsByState, the TUI's order too: live work
  // (working, reviewing, landing), then work waiting in the pipeline (approved, awaiting a
  // slot), then loops that need attention (failing, main red), then paused, then idle; within a
  // rank the most recent tick first, a never-ticked loop last, ties by name.
  function loopRank(phase) {
    const p = String(phase || "");
    if (isActivePhase(p)) return 0;
    if (p.startsWith("vetted") || p.startsWith("awaiting slot")) return 1;
    if (p === "failing" || p === "main red") return 2;
    if (p === "paused" || p === "budget paused") return 3;
    return 4;
  }
  function sortLoops(loops) {
    return loops.slice().sort((a, b) => {
      const ra = loopRank(a.phase);
      const rb = loopRank(b.phase);
      if (ra !== rb) return ra - rb;
      const ta = a.lastTickEndedAt ?? 0;
      const tb = b.lastTickEndedAt ?? 0;
      if (ta !== tb) return tb - ta;
      return a.role.localeCompare(b.role);
    });
  }
  // loop-sort:end
  // The fleet table's section for each rank.
  const LOOP_GROUPS = [["In progress", 0, 1], ["Needs attention", 2], ["Paused", 3], ["Idle", 4]];
  // The payload's alerts (fleet-alerts.ts fleetAlerts — the TUI's attention lines use the same
  // list), plus the one only the page can know: that its server stopped answering.
  const OFFLINE_ALERT = { key: "offline", tone: "red", title: "Lost contact with the dashboard server",
    detail: "Retrying every second. Everything below is the last state it reported.", actions: [] };
  function pageAlerts(d, offline) {
    return (offline ? [OFFLINE_ALERT] : []).concat((d && d.alerts) || []);
  }
  const ALERT_ICONS = { offline: "offline", budget: "dollar", fallback: "info", mainred: "fail", failing: "fail", stuck: "clock",
    build: "refresh", questions: "question", paused: "pause", stopped: "info" };
  // Alerts that ask something of the operator (the page title counts them); blue and gray ones
  // are information.
  const needsYou = (alerts) => alerts.filter((a) => a.tone === "red" || a.tone === "amber" || a.tone === "indigo").length;
  // An activity item's kind — its icon and tone, and whether the Notable filter keeps it.
  const ROUTINE_EVENTS = ["tick_start", "wake", "tick_deferred", "review_start", "review_verdict", "land_queued", "landed", "resume", "counters_reset"];
  const PROBLEM_EVENTS = ["land_failed", "review_rejected", "review_failed", "restart_blocked", "restart_refused", "budget_paused", "supervisor_exit", "warning"];
  function eventKind(item) {
    if (item.type === "merged") return "landing";
    if (item.type === "question_posted") return "attention";
    if (item.type === "tick_end") return PROBLEM_RESULTS.includes(item.result) ? "problem" : "routine";
    if (item.type === "build_check") return item.result === "passed" || item.result === "skipped" ? "routine" : "problem";
    if (PROBLEM_EVENTS.includes(item.type)) return "problem";
    if (ROUTINE_EVENTS.includes(item.type)) return "routine";
    return "info";
  }
  // A backlog title's trailing "(planned 2026-09-29)"-style note, split off as metadata.
  function splitTitle(t) {
    const m = /\s*\(((?:planned|reported|found|refined|asked|posted|filed|opened|done)\b[^)]*)\)\s*$/i.exec(String(t));
    return m ? { title: String(t).slice(0, m.index), meta: m[1] } : { title: String(t), meta: "" };
  }
  // Queued prompts in execution order — the director's first, then each loop's — each with the
  // queue-file address its Cancel button sends (never a list position, so a stale frame can
  // never cancel the wrong prompt).
  function queuedPrompts(d) {
    const out = (d.inboxPrompts || []).map((p, i) => ({ role: "director", preview: p, file: (d.inboxFiles || [])[i] || "" }));
    for (const r of Object.keys(d.roleInboxPrompts || {}).sort()) {
      for (const e of d.roleInboxPrompts[r] || []) out.push({ role: r, preview: e.preview, file: e.file });
    }
    return out;
  }
  // view-model:end
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

/** The fleet view and the page chrome that renders from every poll. */
const FLEET_JS = String.raw`  // ---- sidebar: project, fleet status, budget and pause controls ----
  function landingTitle(q) {
    const f = q.inFlight;
    const now = f ? " Landing now: " + f.role + " — " + (f.summary || "") + (f.stage ? " (" + String(f.stage).replace("-", " ") + ")" : "") : "";
    return plural(q.depth, "change") + " in the land queue." + now;
  }
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
        const counts = c.counts ? " · " + c.counts.pass + "/" + c.counts.tests : "";
        const verdict = c.status === "passed" ? "green" : c.status === "failed" ? "red" : c.status;
        rows += row(c.status === "passed" ? "green" : c.status === "failed" ? "red" : "amber", icon(c.status === "passed" ? "check" : c.status === "failed" ? "fail" : "info"),
          "Main " + verdict + esc(counts), ((d.mainCheckBadge || "").replace(/^ · /, "") + (c.at ? " — checked " + fmtAgo(c.at) : "")).trim());
      }
      if (d.landQueue && d.landQueue.depth > 0) rows += row("orange", icon("merge"), "Land queue " + d.landQueue.depth, landingTitle(d.landQueue));
    }
    paintPanel("statuschips", rows);
    renderBudgetBadge(d);
    renderPauseBadge(d);
  }

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

  // ---- loops ----
  // row-actions:start
  let confirmAbort = null; // { role, until } while an abort waits for its confirming click
  const abortConfirming = (role) => Boolean(confirmAbort && confirmAbort.role === role && confirmAbort.until > Date.now());
  // A loop's controls, from its table row or its drawer: prompt (aims the composer at the loop),
  // wake, pause/resume (the target state is always explicit), and abort, which discards the
  // tick's work — the first click arms it, a second within 5 s fires it.
  async function rowAction(action, role) {
    if (action === "prompt") {
      setTarget(role);
      focusComposer();
      return;
    }
    if (action === "abort" && !abortConfirming(role)) {
      confirmAbort = { role, until: Date.now() + 5000 };
      rerender();
      setTimeout(() => { if (confirmAbort && confirmAbort.role === role && confirmAbort.until <= Date.now()) { confirmAbort = null; rerender(); } }, 5100);
      return;
    }
    confirmAbort = null;
    const path = action === "abort" ? "/api/abort" : action === "pause" || action === "resume" ? "/api/pause-role" : "/api/wake";
    const body = action === "pause" || action === "resume" ? { role, paused: action === "pause" } : { role };
    try {
      const d = await postJson(path, body);
      let msg = d && typeof d.message === "string" ? d.message : role + ": done";
      if (action === "pause" || action === "resume") {
        msg = role + (d && d.changed
          ? (action === "pause" ? " paused — it starts no new ticks" : " resumed")
          : (action === "pause" ? " was already paused" : " was not paused"));
      }
      showFlash(msg);
    } catch (e) {
      showFlash("error: " + e.message);
    }
    refresh();
  }
  // row-actions:end
  // The status pill's second line: what the phase label carried, or when an idle loop runs next.
  function phaseDetail(l, info, d) {
    const raw = fmtNextRun(l, d.running);
    const slowed = / ×(\d+)$/.exec(raw);
    const next = slowed ? raw.slice(0, slowed.index) : raw;
    const backoff = next.startsWith("backoff ") ? "backing off — retries in " + next.slice(8) : "";
    // A yield-scaled clock: the loop's recent ticks landed nothing, so it ticks less often.
    const note = slowed ? " · slowed ×" + slowed[1] + ", nothing landed lately" : "";
    if (info.key === "sleeping") return (backoff || (next === "-" ? "" : next === "now" ? "wakes now" : "wakes in " + next)) + note;
    if (info.key === "queued") return (backoff || info.detail) + note;
    return info.detail;
  }
  function loopCells(l, d) {
    const info = phaseInfo(l.phase);
    const paused = (d.pausedRoles || []).includes(l.role);
    const queued = (d.roleInbox || {})[l.role] || 0;
    const detail = phaseDetail(l, info, d);
    const stalled = info.live && STALL.test(l.phase);
    const name = "<div class='loop-name'><button type='button' class='linkish role' data-open='" + esc(l.role) + "' title='Open " + esc(l.role) + "'>" + esc(l.role) + "</button>" +
      (l.custom ? "<span class='tag' title='A user-defined loop from tumwater.json'>custom</span>" : "") +
      (queued ? "<span class='tag t-indigo' title='" + esc(plural(queued, "prompt") + " queued for this loop") + "'>" + icon("chat") + queued + "</span>" : "") +
      "</div><div class='sub'>" + esc(plural(l.commits, "commit") + " · " + plural(l.ticks, "tick")) + "</div>";
    const status = pill(info) + (detail ? "<div class='sub" + (stalled ? " t-red" : "") + "' title='" + esc(l.phase) + "'>" + esc(detail) + "</div>" : "");
    let activity;
    if (info.live || info.key === "vetted") {
      const text = l.currentWork || landingSummary(d, l.role);
      const pending = info.key === "working" ? "Starting up…" : info.key === "reviewing" ? "Reviewing the change…" : "Landing the change…";
      activity = text ? "<div class='now clamp2' title='" + esc(text) + "'>" + esc(text) + "</div>" : "<div class='muted'>" + pending + "</div>";
    } else if (l.lastResult) {
      const r = resultInfo(l.lastResult);
      const why = resultWhy(l);
      activity = "<div class='clamp2' title='" + esc(why || r.label) + "'><span class='res t-" + r.tone + "'>" + esc(r.label) + "</span>" +
        (why ? " <span class='now'>" + esc(why) + "</span>" : "") + "</div><div class='sub'>" + esc(fmtAgo(l.lastTickEndedAt)) + "</div>";
    } else activity = "<div class='muted'>No ticks yet</div>";
    const spent = "<div>" + esc(fmtUsd(l.todayUsd)) + "</div><div class='sub'>" + esc(fmtUsd(l.costUsd)) + " total</div>";
    const b = (action, ic, title, cls) => "<button type='button' class='icon-btn rowaction" + (cls ? " " + cls : "") + "' data-action='" + action +
      "' data-role='" + esc(l.role) + "' title='" + esc(title) + "' aria-label='" + esc(title) + "'>" + icon(ic) + "</button>";
    let actions = b("prompt", "chat", "Prompt " + l.role);
    if (l.inFlight) {
      actions += abortConfirming(l.role)
        ? "<button type='button' class='icon-btn rowaction confirming' data-action='abort' data-role='" + esc(l.role) + "' title='Click again to abort the running tick'>" + icon("stop") + "Abort?</button>"
        : b("abort", "stop", "Abort " + l.role + "'s running tick", "danger");
    } else actions += b("wake", "bolt", "Wake " + l.role + " now");
    actions += paused ? b("resume", "play", "Resume " + l.role) : b("pause", "pause", "Pause " + l.role);
    return { info, cells: [name, status, activity, spent, "<div class='actions'>" + actions + "</div>"] };
  }
  const LOOP_TDS = ["c-loop", "c-status", "c-activity", "c-today num", "c-actions"];
  let loopKeys = "";
  // Rows are patched cell by cell: a working loop's elapsed time changes every second, and
  // rewriting only that cell keeps focus and hover on the row's buttons.
  function patchLoops(rows) {
    const tbody = $("loops");
    const keys = rows.map((r) => r.key).join("|");
    if (keys !== loopKeys) {
      loopKeys = keys;
      tbody.innerHTML = rows.map((r) => "<tr class='" + r.cls + "'" + (r.role ? " data-role='" + esc(r.role) + "'" : "") + ">" +
        r.cells.map((c, j) => (r.group ? "<td colspan='5'>" : "<td class='" + LOOP_TDS[j] + "'>") + c + "</td>").join("") + "</tr>").join("");
      Array.from(tbody.rows).forEach((tr, i) => Array.from(tr.cells).forEach((td, j) => { td._html = rows[i].cells[j]; }));
      return;
    }
    rows.forEach((r, i) => {
      const tr = tbody.rows[i];
      if (tr.className !== r.cls) tr.className = r.cls;
      r.cells.forEach((html, j) => {
        const td = tr.cells[j];
        if (td._html !== html) { td.innerHTML = html; td._html = html; }
      });
    });
  }
  function renderLoops(d) {
    $("loopstable").classList.toggle("free", Boolean(d.budget && d.budget.free));
    const byGroup = LOOP_GROUPS.map(() => []);
    for (const l of sortLoops(d.loops || [])) {
      const rank = loopRank(l.phase);
      byGroup[LOOP_GROUPS.findIndex((g) => g.slice(1).includes(rank))].push(l);
    }
    const selected = openLoopRole();
    const rows = [];
    LOOP_GROUPS.forEach((g, gi) => {
      if (!byGroup[gi].length) return;
      rows.push({ key: "g" + gi, cls: "group", group: true, cells: [esc(g[0]) + "<span class='badge'>" + byGroup[gi].length + "</span>"] });
      for (const l of byGroup[gi]) {
        const { info, cells } = loopCells(l, d);
        rows.push({ key: "l:" + l.role, role: l.role, cls: "loop clickable" + (info.live ? " live" : "") + (selected === l.role ? " selected" : ""), cells });
      }
    });
    if (!rows.length) rows.push({ key: "empty", cls: "group", group: true, cells: ["No loops are enabled in tumwater.json"] });
    patchLoops(rows);
  }
  $("loops").addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;
    const b = t.closest("button.rowaction");
    if (b) { ev.preventDefault(); rowAction(b.dataset.action, b.dataset.role); return; }
    const tr = t.closest("tr[data-role]");
    if (tr) toggleLoop(tr.dataset.role);
  });
  $("wakeall").addEventListener("click", async () => {
    try {
      const d = await postJson("/api/wake", {});
      showFlash(d && typeof d.message === "string" ? d.message : "every loop woken");
    } catch (e) {
      showFlash("error: " + e.message);
    }
    refresh();
  });

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
    const b = ev.target instanceof Element ? ev.target.closest("button[data-tab]") : null;
    if (b) setBacklogTab(b.dataset.tab);
  });
  $("backlog").addEventListener("click", async (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;
    const cancel = t.closest("button.rowaction[data-action='promptcancel']");
    if (cancel) {
      try {
        const d = await postJson("/api/prompt-cancel", { role: cancel.dataset.role, file: cancel.dataset.file });
        showFlash(d && d.status === "cancelled"
          ? "Cancelled: " + (d.preview || "")
          : "No longer queued — " + (cancel.dataset.role || "the director") + " already took it");
      } catch (e) {
        showFlash("error: " + e.message);
      }
      refresh();
      return;
    }
    const entry = t.closest(".backloglink");
    if (entry) toggleEntry(entry.dataset.file, Number(entry.dataset.index));
  });

  // ---- activity ----
  let feedFilter = recall("feed") === "all" ? "all" : "notable";
  const KINDS = { landing: ["merge", "green"], problem: ["fail", "red"], attention: ["question", "indigo"], info: ["info", "blue"], routine: ["dot", "gray"] };
  function renderFeed(d) {
    const items = (d.eventItems || []).slice().reverse(); // newest first
    const shown = feedFilter === "all" ? items : items.filter((it) => eventKind(it) !== "routine");
    Array.from($("feedfilter").children).forEach((b) => b.classList.toggle("active", b.dataset.filter === feedFilter));
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
    const b = ev.target instanceof Element ? ev.target.closest("button[data-filter]") : null;
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

export const GUI_CLIENT_JS = [CORE_JS, FORMAT_JS, MODEL_JS, DOM_JS, GUI_CLIENT_MARKDOWN_JS, GUI_CLIENT_OPERATOR_JS, FLEET_JS,
  GUI_CLIENT_DRAWER_JS, GUI_CLIENT_HISTORY_JS, GUI_CLIENT_REPORT_JS, BOOT_JS].join("\n");
