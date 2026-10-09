/** The browser-side dashboard app inlined as the GUI page's only <script>. It polls /api/status
 * every second and renders, in the order an operator needs them: the masthead's fleet status
 * (running, build, main check) and fleet controls (budget, pause); alerts for whatever needs a
 * human (a failing loop, a red main, a spent budget, an old build, open questions, a pause);
 * the composer that steers the director or one loop; and the fleet view — today's progress,
 * the loops grouped by what they are doing, the backlog, and the notable activity. The
 * view-model, the drawer, the History/Usage/Failures/Pending views, the operator controls, the
 * composer, the Markdown renderer, and the routing/poll boot live in their own modules and
 * are spliced in below; everything shares one scope. The page
 * cannot import the harness modules, so it keeps its own copies of the few display rules it
 * needs (formatters, loop order), each pinned against its TypeScript twin by test. Written as
 * String.raw templates so the served script is exactly the text below — no double escaping. */
import { GUI_CLIENT_BOOT_JS } from "./gui-client-boot.js";
import { GUI_CLIENT_COMPOSER_JS } from "./gui-client-composer.js";
import { GUI_CLIENT_DRAWER_JS } from "./gui-client-drawer.js";
import { GUI_CLIENT_FLEET_JS } from "./gui-client-fleet.js";
import { GUI_CLIENT_HISTORY_JS } from "./gui-client-history.js";
import { GUI_CLIENT_LOOPS_JS } from "./gui-client-loops.js";
import { GUI_CLIENT_MARKDOWN_JS } from "./gui-client-markdown.js";
import { GUI_CLIENT_MODEL_JS } from "./gui-client-model.js";
import { GUI_CLIENT_OPERATOR_JS } from "./gui-client-operator.js";
import { GUI_CLIENT_PENDING_JS } from "./gui-client-pending.js";
import { GUI_CLIENT_REPORT_JS } from "./gui-client-report.js";
import { GUI_CLIENT_SETTINGS_JS } from "./gui-client-settings.js";
import { GUI_CLIENT_SOUND_JS } from "./gui-client-sound.js";
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
  async function getJson(path, init) {
    return (await apiFetch(path, init)).json();
  }
  // Bounded wait for the dashboard's periodic fetches (the 1 s status poll and the today/drawer
  // refreshes its await chain drives): a server that accepts the connection but never answers
  // would otherwise hold the poll open forever, leaving the page frozen on stale data with no
  // offline alert — the catch in refresh() only runs when fetch rejects. The timeout aborts the
  // request, so the poll fails, the red "Lost contact" alert shows, and the loop keeps polling.
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
  // repaint: on success the message — a string, or the derived form the fleet callers build
  // from the endpoint's answer (which can be null when it sent no JSON) — on failure
  // "error: <reason>" with the popover left open and the standing 1s status poll repainting
  // from the server's state. The one POST-and-toast step every fleet and operator control
  // shares. Single-homed here, in the core before every splice: a second declaration in a
  // later splice would shadow this one (function declarations hoist; the last in one scope
  // wins), which is how the budget editor once called the fleet shape with a string message.
  async function postAction(path, body, okMsg) {
    let d;
    try {
      d = await postJson(path, body);
    } catch (e) {
      showFlash("error: " + e.message);
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
  // agree, shared by plural below and gui-client-fleet.ts's stats tiles, whose noun sits in
  // <small>.
  const agree = (n, one, many) => (n === 1 ? one : many);
  const plural = (n, one, many) => n + " " + agree(n, one, many || one + "s");
  // The landed-commit work/maintenance split the sidebar's "Landed today" tile and the report's
  // "Commits landed" tile both print. report-data.ts leaves the counts optional, so a missing
  // count reads 0 here rather than "undefined".
  const workSplit = (t) => (t.workCommits ?? 0) + " work / " + (t.maintenanceCommits ?? 0) + " maintenance";
  // The unlanded-commit list both change views paint — each commit's sha and subject on its
  // own clamped line. The Pending roster's Ahead cell and the loop drawer's Pending change
  // section had the byte-identical map; a missing or non-array list paints nothing.
  const commitRowsHtml = (commits) =>
    (Array.isArray(commits) ? commits : []).map((c) => "<div class='mono clamp1'>" + esc(c.sha) + " " + esc(c.subject || "—") + "</div>").join("");
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
  // A PERMIT-HOLDING loop in flight — status-model.ts's isActivePhase: its phase starts with
  // working, reviewing, or landing. One home for the three prefixes fmtNextRun shares with the
  // shared loop-rank rules (status-model.ts's LOOP_RANK_RULES, whose rank-0 rule tests this
  // predicate); the running director's own director-working label is checked beside it rather
  // than folded in, because it holds no permit (BUGS.md 2026-10-06).
  const isActivePhase = (phase) => phase.startsWith("working") || phase.startsWith("reviewing") || phase.startsWith("landing");
  // active-phase-fmt:end
  // last-tick-fmt:start
  // The absolute local time of a tick end with its age ("14:32:05 · 3m ago"), prefixed MM-DD
  // once older than a day; "-" when never ticked — status-render.ts's lastTickCell.
  // Whole elapsed seconds since an instant, clamped at zero and rounded to the nearest
  // second — datetime.ts's elapsedSeconds (the browser runtime cannot import it), shared by
  // fmtLastTick and fmtAgo below so the clamp cannot drift between the page's ages.
  const ageSec = (ts) => Math.max(0, Math.round((Date.now() - ts) / 1000));
  const fmtLastTick = (ts) => {
    if (!ts) return "-";
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    let s = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    if (Date.now() - ts > 86400000) s = p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + s;
    const sec = ageSec(ts);
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
    // A torn loop object — a payload missing its phase field — reads as the empty (inactive)
    // phase rather than throwing: the browser copy is untyped, and its sibling phaseInfo/
    // loopRank already coerce the same way, so one bad row must not blank the whole table.
    const phase = String(l.phase || "");
    const active = isActivePhase(phase) || phase.startsWith("awaiting slot") || phase.startsWith("director working");
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
    const sec = ageSec(ts);
    return sec < 60 ? "just now" : humanSeconds(sec) + " ago";
  };
  const fmtClock = (ts) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  // A tick's duration: seconds under two minutes, then minutes, then hours. Each bucket is
  // chosen from the rounded count so a span just under a cutoff never prints "120s" or "120m".
  const fmtSpan = (ms) => {
    const sec = Math.round(ms / 1000);
    if (sec < 120) return sec + "s";
    const min = Math.round(ms / 60000);
    if (min < 120) return min + "m";
    return (ms / 3600000).toFixed(1) + "h";
  };
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
  // The Element a delegated click landed on, narrowed by closest(selector): null when the
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
  // The standard "this view could not load" panel: a title plus the server's error message,
  // if any. cls is "empty" for the bare panels (history, drawer) and "card empty" where the
  // view frames panels in cards (the report views). Drawer paints it through paintPanel so a
  // retry loop does not repaint; callers that own the element assign it directly.
  function errorPanel(title, err, cls) {
    return "<div class='" + (cls || "empty") + "'><strong>" + esc(title) + "</strong>" +
      esc(err && err.message ? err.message : "") + "</div>";
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
  let activeView = "fleet";
`;

export const GUI_CLIENT_JS = [CORE_JS, FORMAT_JS, GUI_CLIENT_MODEL_JS, DOM_JS, GUI_CLIENT_MARKDOWN_JS, GUI_CLIENT_SOUND_JS, GUI_CLIENT_OPERATOR_JS, GUI_CLIENT_LOOPS_JS, GUI_CLIENT_FLEET_JS, GUI_CLIENT_COMPOSER_JS,
  GUI_CLIENT_DRAWER_JS, GUI_CLIENT_HISTORY_JS, GUI_CLIENT_PENDING_JS, GUI_CLIENT_REPORT_JS, GUI_CLIENT_SETTINGS_JS, GUI_CLIENT_BOOT_JS].join("\n");
