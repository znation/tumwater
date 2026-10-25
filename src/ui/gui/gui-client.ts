/** The browser-side dashboard app inlined as the GUI page's only <script>. It polls /api/status
 * every second and renders, in the order an operator needs them: the masthead's team status
 * (running, build, main check) and team controls (budget, pause); alerts for whatever needs a
 * human (a failing role, a red main, a spent budget, an old build, open questions, a pause);
 * the composer that steers the director or one role; and the team view — today's progress,
 * the roles grouped by what they are doing, the backlog, and the notable activity. The
 * view-model, the drawer, the History/Usage/Failures/Pending views, the operator controls, the
 * composer, the Markdown renderer, and the routing/poll boot live in their own modules and
 * are spliced in below; everything shares one scope. The page
 * cannot import the harness modules, so it keeps its own copies of the few display rules it
 * needs (formatters, role order), each pinned against its TypeScript twin by test. Written as
 * String.raw templates so the served script is exactly the text below — no double escaping. */
import { GUI_CLIENT_BACKLOG_JS } from "./gui-client-backlog.js";
import { GUI_CLIENT_BOOT_JS } from "./gui-client-boot.js";
import { GUI_CLIENT_COMPOSER_JS } from "./gui-client-composer.js";
import { GUI_CLIENT_DRAWER_JS } from "./gui-client-drawer.js";
import { GUI_CLIENT_DRAWER_CONFIG_JS } from "./gui-client-drawer-config.js";
import { GUI_CLIENT_FEED_JS } from "./gui-client-feed.js";
import { GUI_CLIENT_TEAM_JS } from "./gui-client-team.js";
import { GUI_CLIENT_HISTORY_JS } from "./gui-client-history.js";
import { GUI_CLIENT_LABELS_JS } from "./gui-client-labels.js";
import { GUI_CLIENT_ROLES_JS } from "./gui-client-roles.js";
import { GUI_CLIENT_MARKDOWN_JS } from "./gui-client-markdown.js";
import { GUI_CLIENT_MODEL_JS } from "./gui-client-model.js";
import { GUI_CLIENT_OPERATOR_JS } from "./gui-client-operator.js";
import { GUI_CLIENT_PENDING_JS } from "./gui-client-pending.js";
import { GUI_CLIENT_REPORT_CHART_JS } from "./gui-client-report-chart.js";
import { GUI_CLIENT_REPORT_JS } from "./gui-client-report.js";
import { GUI_CLIENT_SETTINGS_JS } from "./gui-client-settings.js";
import { ICON_PATHS } from "./gui-icons.js";
import { ACTIVE_PHASE_PREFIXES } from "../status-model.js";

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
  // The bounded wait every API call shares. The periodic poll passes pollSignal()'s tighter
  // bound as init.signal, but an operator action (pause, prompt, config edit, report fetch)
  // passes none — and fetch has no default timeout, so a server killed outright (SIGKILL, an
  // OOM kill) leaves a half-open connection whose reply never comes: the action's flash never
  // appears and a retry stacks another pending request. The default bound is deliberately
  // generous — it must outlast a 32 MiB attachment upload and a slow report read — while still
  // failing the request loudly instead of hanging. A caller-supplied signal wins, so the poll
  // keeps its 15 s. AbortSignal.timeout is standard since 2022; where a browser lacks it the
  // fetch stays unbounded, exactly the old behavior.
  const API_TIMEOUT_MS = 120000;
  function apiTimeoutSignal(existing) {
    if (existing !== undefined) return existing;
    return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(API_TIMEOUT_MS)
      : undefined;
  }
  // One response guard for every API call: on a non-2xx, throw apiError instead of letting a
  // JSON error body be read as data, and give the request the bounded wait above when the
  // caller brought none.
  async function apiFetch(path, init) {
    const headers = new Headers(init && init.headers);
    if (guiToken) headers.set("authorization", "Bearer " + guiToken);
    const r = await fetch(path, Object.assign({}, init || {}, { signal: apiTimeoutSignal(init && init.signal), headers: headers }));
    if (!r.ok) throw await apiError(path, r);
    return r;
  }
  async function getJson(path, init) {
    return (await apiFetch(path, init)).json();
  }
  // Bounded wait for the dashboard's periodic fetches (the 1 s status poll and the today/drawer
  // refreshes its await chain drives), tighter than apiFetch's default above: a server that
  // accepts the connection but never answers
  // would otherwise hold the poll open forever, leaving the page frozen on stale data with no
  // offline alert — the catch in refresh() only runs when fetch rejects. The timeout aborts the
  // request, so the poll fails, the red "Lost contact" alert shows, and polling continues.
  // AbortSignal.timeout is standard since 2022; where a browser lacks it the fetch stays
  // unbounded, exactly the old behavior.
  const POLL_TIMEOUT_MS = 15000;
  function pollSignal() {
    return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) }
      : {};
  }
  // A JSON POST; resolves to the endpoint's JSON answer (null if it sent none).
  async function postJson(path, payload) {
    const r = await apiFetch(path, { method: "POST", headers: { "content-type": "application/json" },
                                     body: JSON.stringify(payload) });
    try { return await r.json(); } catch { return null; }
  }
  // post-action:start
  // Fire one POST and report its outcome in the flash bar, then close any open popover and
  // repaint: on success the message — a string, or the derived form the team callers build
  // from the endpoint's answer (which can be null when it sent no JSON) — on failure
  // "error: <reason>" with the popover left open and the standing 1s status poll repainting
  // from the server's state. The one POST-and-toast step every team and operator control
  // shares. Single-homed here, in the core before every splice: a second declaration in a
  // later splice would shadow this one (function declarations hoist; the last in one scope
  // wins), which is how the budget editor once called the team shape with a string message.
  async function postAction(path, body, okMsg) {
    let d;
    try {
      d = await postJson(path, body);
    } catch (err) {
      showFlash("error: " + err.message);
      return;
    }
    showFlash(typeof okMsg === "function" ? okMsg(d) : okMsg);
    closeMenus();
    refresh();
  }
  // post-action:end
`;

/** Display formatters — the client copies of text.ts / status-model.ts / status-render.ts
 * rules. The marked regions are the ones tests run against their TypeScript twins. */
const FORMAT_JS = String.raw`  // format:start
  const fmtTokens = (n) => (n >= 1000000 ? (n / 1000000).toFixed(1) + "M" : n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n || 0));
  const fmtUsd = (n) => "$" + n.toFixed(2);
  // An abbreviated commit hash: its first 8 characters — format.ts's shortSha, so the page's sha
  // cells abbreviate exactly like the event feed's and the review gate's. A missing or foreign
  // value reads "?" (textOr's corrupt-value stand-in), never String(undefined).
  const shortSha = (sha) => (typeof sha === "string" ? sha : typeof sha === "number" && Number.isFinite(sha) ? String(sha) : "?").slice(0, 8);
  // A cap: whole dollars stay bare ($15), fractional ones keep their cents — format.ts's usdCap.
  const fmtCap = (n) => "$" + n.toFixed(2).replace(/\.00$/, "");
  // The number-agreeing word form when the count prints elsewhere in the markup — phrases.ts's
  // agree, shared by plural below and gui-client-team.ts's stats tiles, whose noun sits in
  // <small>.
  const agree = (n, one, many) => (n === 1 ? one : many);
  const plural = (n, one, many) => n + " " + agree(n, one, many || one + "s");
  // The merged-commit work/maintenance split the sidebar's "Merged today" tile and the report's
  // "Commits merged" tile both print. report-types.ts leaves the counts optional, so a missing
  // count reads 0 here rather than "undefined".
  const workSplit = (t) => (t.workCommits ?? 0) + " work / " + (t.maintenanceCommits ?? 0) + " maintenance";
  // The unmerged-commit list both change views paint — each commit's sha and subject on its
  // own clamped line. The Pending roster's Ahead cell and the role drawer's Pending change
  // section had the byte-identical map; a missing or non-array list paints nothing.
  const commitRowsHtml = (commits) =>
    (Array.isArray(commits) ? commits : []).map((c) => "<div class='mono clamp1'>" + esc(c.sha) + " " + esc(c.subject || "—") + "</div>").join("");
  // Title-case a phrase's first character and keep the rest — backend-traits.ts's
  // backendDisplayName rule, the one home of the upcasing gui-client-model.ts's result labels
  // and gui-client-history.ts's window options each inlined, so a label cannot drift between
  // them. A leading em dash or other non-letter upcases to itself, and an empty string stays
  // empty.
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  // A whole-hour window length as "1 hour"/"N hours", or "1 day"/"N days" for a whole
  // number of days — the shared span the activity feed's and History view's stepped-window
  // bounds both print (each previously spelled out the modulo/pluralization inline). A minute
  // count that isn't a whole number of days prints hours (a stepped window is always whole
  // hours), and the singular drops the trailing s.
  const timeSpan = (ms) => { const d = ms % 86400000 === 0; const n = d ? ms / 86400000 : ms / 3600000; return n + (d ? " day" : " hour") + (n === 1 ? "" : "s"); };
  // The "between X and Y ago" window-length phrase a stepped window's two bounds both print
  // (newer first) — the Activity feed's feedWindowPhrase and the History view's histWindowPhrase
  // previously spelled out the span-and-framing inline, so the two could drift on the words
  // around timeSpan. One home keeps the stepped-window phrasing identical everywhere.
  const betweenAgo = (newerMs, olderMs) => "between " + timeSpan(newerMs) + " and " + timeSpan(olderMs) + " ago";
  // human-seconds-fmt:start
  // Whole-second s/m/h/d label: <60 → Ns, <3600 → rounded Nm, <86400 → rounded Nh, else
  // rounded Nd — datetime.ts's humanSeconds, shared by every relative time on the page. A
  // minute count that rounds to 60 rolls into the hour bucket and an hour count that rounds
  // to 24 into the day bucket, so the label stays in the documented s/m/h/d set.
  const humanSeconds = (sec) => {
    if (sec < 60) return sec + "s";
    if (sec < 3600) {
      const minutes = Math.round(sec / 60);
      if (minutes < 60) return minutes + "m";
    }
    if (sec < 86400) {
      const hours = Math.round(sec / 3600);
      if (hours < 24) return hours + "h";
    }
    return Math.round(sec / 86400) + "d";
  };
  // human-seconds-fmt:end
  // active-phase-fmt:start
  // A PERMIT-HOLDING role in flight — status-model.ts's isActivePhase. The three prefixes are
  // interpolated from status-model.ts's ACTIVE_PHASE_PREFIXES (String.raw still substitutes),
  // so this copy cannot drift from the server's; the running director's own director-working
  // label is checked beside it rather than folded in, because it holds no permit (BUGS.md
  // 2026-10-06).
  const ACTIVE_PHASE_PREFIXES = ${JSON.stringify(ACTIVE_PHASE_PREFIXES)};
  const isActivePhase = (phase) => ACTIVE_PHASE_PREFIXES.some((p) => phase.startsWith(p));
  // active-phase-fmt:end
  // last-run-fmt:start
  // Whole seconds between two epoch-ms instants, clamped at zero and rounded to the nearest
  // second — datetime.ts's secondsSince/secondsUntil (the browser runtime cannot import
  // them), shared by every relative time on the page so the clamp cannot drift between
  // fmtLastRun, fmtAgo, and the spliced views' pause/wake/queue ages.
  const secsSince = (sinceMs, now) => Math.max(0, Math.round((now - sinceMs) / 1000));
  const secsUntil = (atMs, now) => Math.max(0, Math.round((atMs - now) / 1000));
  // The absolute local time of a run end with its age ("14:32:05 · 3m ago"), prefixed MM-DD
  // once older than a day; "-" when never ran — status-render.ts's lastRunCell.
  const ageSec = (ts) => secsSince(ts, Date.now());
  const fmtLastRun = (ts) => {
    if (!ts) return "-";
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    let s = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    if (Date.now() - ts > 86400000) s = p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + s;
    const sec = ageSec(ts);
    const age = humanSeconds(sec) + " ago";
    return s + " · " + age;
  };
  // last-run-fmt:end
  // next-run-fmt:start
  // When an idle role may run again — status-render.ts's nextRunCell: "-" for a role in flight
  // or parked awaiting a slot (it has no next run to speak of) and for a stopped team; "now"
  // when due; otherwise the remaining time, prefixed "backoff " while backing off. A yield-scaled
  // clock rides as a " ×N" suffix: a quiet role's effective gap is longer than the countdown.
  const fmtNextRun = (l, teamRunning) => {
    // A torn role object — a payload missing its phase field — reads as the empty (inactive)
    // phase rather than throwing: the browser copy is untyped, and its sibling phaseInfo/
    // roleRank already coerce the same way, so one bad row must not blank the whole table.
    const phase = String(l.phase || "");
    const active = isActivePhase(phase) || phase.startsWith("waiting to start") || phase.startsWith("waiting for ") || phase.startsWith("director working");
    if (!teamRunning || active) return "-";
    const sec = Math.round((l.nextRunAt - Date.now()) / 1000);
    const suffix = l.yieldMultiplier > 1 ? " ×" + l.yieldMultiplier : "";
    if (sec <= 0) return "now" + suffix;
    return (l.backoffSeconds > 0 ? "sleeping " : "") + humanSeconds(sec) + suffix;
  };
  // next-run-fmt:end
  // A relative age for lists; the first minute reads "just now" so rows do not churn every
  // second.
  const fmtAgo = (ts) => {
    if (!ts) return "never";
    const sec = ageSec(ts);
    return sec < 60 ? "just now" : humanSeconds(sec) + " ago";
  };
  const fmtClock = (ts) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  // The local wall-clock HH:MM of an instant — datetime.ts's clockHm, shared by the operator
  // view's window clock (returnsAt/heldUntil/~cap-at stamps) and the role drawer's ~cap-at
  // stamp, which each spelled the two-digit getHours/getMinutes join inline.
  const clockHm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  // A run's duration: seconds under two minutes, then minutes, then hours. Each bucket is
  // chosen from the rounded count so a span just under a cutoff never prints "120s" or "120m".
  const fmtSpan = (ms) => {
    const sec = Math.round(ms / 1000);
    if (sec < 120) return sec + "s";
    const min = Math.round(ms / 60000);
    if (min < 120) return min + "m";
    return (ms / 3600000).toFixed(1) + "h";
  };
  // A run's wall-clock span cell: fmtSpan when a row carries a duration, a dash when it does not
  // (a run whose start sits outside the window). Shared by the History table and summary rows
  // (and any future duration cell) so the null rule and its em-dash cannot drift between them.
  const durCell = (ms) => (ms === null || ms === undefined ? "—" : esc(fmtSpan(Number(ms))));
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
  // click-delegate:start
  // One delegated document-level click listener: fn receives the clicked element and the
  // event, and is skipped when the click has no Element target (a text node) — the guard
  // every delegated handler on the page repeated, so the contract cannot drift per handler.
  // fn decides for itself whether to preventDefault.
  function onClick(fn) {
    document.addEventListener("click", (ev) => {
      const t = ev.target instanceof Element ? ev.target : null;
      if (t) fn(t, ev);
    });
  }
  // The Element a delegated click merged on, narrowed by closest(selector): null when the
  // click's target is not an Element (a text node, say) or nothing matches. One home for the
  // instanceof-Element guard every per-element delegated handler on the page needs before it
  // can read ev.target (the same pitfall onClick guards for document-level handlers), so the
  // guard and the narrowing cannot drift per handler.
  function clickClosest(ev, selector) {
    const t = ev.target instanceof Element ? ev.target : null;
    return t ? t.closest(selector) : null;
  }
  // click-delegate:end
  const pill = (info) => "<span class='pill t-" + info.tone + "'><span class='dot" + (info.live ? " live" : "") + "'></span>" + esc(info.label) + "</span>";
  // Repaint a panel only when its markup changed: an idle team's payload is identical poll
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
  // panel-build:start
  // Build a view's static skeleton the first time its view opens and leave it alone after:
  // later opens refetch their data into it, so re-parsing the markup would drop the view's own
  // listeners. Returns true when it built the panel this call (an absent panel or one already
  // marked returns false), so the caller can wire its once-only listeners in the same branch.
  function buildOnce(id, html) {
    const panel = $(id);
    if (!panel || panel.dataset.built) return false;
    panel.dataset.built = "1";
    panel.innerHTML = html;
    return true;
  }
  // panel-build:end
  // err-message:start
  // The one error-message read every fetch/parse catch shares: a thrown Error's message when
  // it has one (the server's JSON body, or the client's own throws, put it there), else the
  // caller's fallback. Single-homed here in the core before every splice so the catch blocks
  // cannot drift the ternary's shape; settings' clientErrorMessage feeds it String(err) as the
  // fallback.
  function errMessage(err, fallback) {
    return err && err.message ? err.message : fallback;
  }
  // err-message:end
  // The standard "this view could not load" panel: a title plus the server's error message,
  // if any. cls is "empty" for the bare panels (history, drawer) and "card empty" where the
  // view frames panels in cards (the report views). Drawer paints it through paintPanel so a
  // retry loop does not repaint; callers that own the element assign it directly.
  function errorPanel(title, err, cls) {
    return "<div class='" + (cls || "empty") + "'><strong>" + esc(title) + "</strong>" +
      esc(errMessage(err, "")) + "</div>";
  }
  // Mark the one button of a segmented filter whose dataset[attr] matches current as
  // "active" and clear the rest: one home for the toggle loop each of the page's segmented
  // controls (the feed's kinds, the history's ranges, the report's day windows) repeated.
  // Tolerates a missing container (a view not yet built) and compares as strings, so a
  // numeric current works against its String-coerced dataset values.
  function markActive(box, attr, current) {
    if (!box) return;
    Array.from(box.children).forEach((b) => b.classList.toggle("active", String(b.dataset[attr]) === String(current)));
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
  let activeView = "team";
`;

export const GUI_CLIENT_JS = [CORE_JS, FORMAT_JS, GUI_CLIENT_LABELS_JS, GUI_CLIENT_MODEL_JS, DOM_JS, GUI_CLIENT_MARKDOWN_JS, GUI_CLIENT_OPERATOR_JS, GUI_CLIENT_ROLES_JS, GUI_CLIENT_TEAM_JS, GUI_CLIENT_BACKLOG_JS, GUI_CLIENT_FEED_JS, GUI_CLIENT_COMPOSER_JS,
  GUI_CLIENT_DRAWER_JS, GUI_CLIENT_DRAWER_CONFIG_JS, GUI_CLIENT_HISTORY_JS, GUI_CLIENT_PENDING_JS, GUI_CLIENT_REPORT_CHART_JS, GUI_CLIENT_REPORT_JS, GUI_CLIENT_SETTINGS_JS, GUI_CLIENT_BOOT_JS].join("\n");
