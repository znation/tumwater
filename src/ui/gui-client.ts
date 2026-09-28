/** The browser-side dashboard app inlined as the GUI page's only <script>: it polls
 * /api/status every second, renders the loop table, event feed, backlog, and report, and
 * drives the write endpoints (/api/prompt, /api/prompt-role, /api/budget, /api/pause,
 * /api/wake, /api/abort, /api/pause-role). Split out of gui-page.ts — which keeps the page's markup
 * and CSS shell — because this runs in the browser as a separate runtime that cannot import
 * the harness modules; it keeps its own copies of the small display formatters (see
 * text.ts). Two cohesive slices live in their own modules, interpolated into this template
 * as byte-exact splices so the served script is byte-identical to the pre-split single
 * blob: the report tab's chart builders in gui-client-report.ts, and the header's operator
 * controls (budget editor, fleet pause) in gui-client-operator.ts; edit here when the fleet
 * view, badges, transcript, or prompt form change. */
import { GUI_CLIENT_REPORT_JS } from "./gui-client-report.js";
import { GUI_CLIENT_OPERATOR_JS } from "./gui-client-operator.js";
export const GUI_CLIENT_JS = `  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  // A failed API call, named for the operator: endpoint, HTTP status, and the server's
  // error text — every error body this server sends is JSON {error} except the 404's
  // plain "not found", so parse leniently. The message surfaces in the budget-save flash
  // and the report panel; the panel polls swallow it (they keep the last good content).
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
  // token is set. Read it once here, attach it as a Bearer header to every API call, and
  // strip it from the address bar so a screen share does not leak it. Empty when the
  // server is open — fetch stays byte-for-byte untouched.
  const guiToken = (typeof location !== "undefined" && new URLSearchParams(location.search).get("token")) || "";
  if (guiToken) {
    const stripped = new URL(location.href);
    stripped.searchParams.delete("token");
    history.replaceState(null, "", stripped.pathname + stripped.search);
  }
  // One response guard for every API call this page makes: send the request and, on a non-2xx,
  // throw apiError (endpoint, status, and the server's error) instead of letting a JSON error
  // body be treated as data. Every endpoint call routes through apiFetch, so the r.ok check
  // lives in one place and cannot be dropped at a single site.
  async function apiFetch(path, init) {
    const headers = new Headers(init && init.headers);
    if (guiToken) headers.set("authorization", "Bearer " + guiToken);
    const r = await fetch(path, Object.assign({}, init || {}, { headers: headers }));
    if (!r.ok) throw await apiError(path, r);
    return r;
  }
  // A GET whose body is JSON: apiFetch plus the parse (the polling reads below).
  async function getJson(path) {
    return (await apiFetch(path)).json();
  }
  // A POST whose body is JSON: apiFetch with the JSON content-type and a serialized payload.
  // The one place the write endpoints' method/header/body shape lives (the budget, pause, and
  // prompt calls below), so each can never drop the content-type or hand-roll the request.
  async function postJson(path, payload) {
    return apiFetch(path, { method: "POST", headers: { "content-type": "application/json" },
                           body: JSON.stringify(payload) });
  }
  const fmtTokens = (n) => (n >= 1000000 ? (n / 1000000).toFixed(1) + "M" : n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n || 0));
  // Money for the page: $ + two decimals — the client-side copy of src/text.ts's usd() rule
  // (the page cannot import TS, per the fmtTokens precedent). One home shared by the status
  // table's cost/today cells and the report tab's stat blocks and cost-chart tooltips.
  const fmtUsd = (n) => "$" + n.toFixed(2);
  // last-tick-fmt:start
  // Last tick cell — mirrors the TUI's lastTickCell in status-render.ts: the absolute local
  // time of the last tick end alongside its relative age ("14:32:05 · 3m ago"). Zero-padded
  // HH:MM:SS, prefixed MM-DD once older than a day; "-" when never ticked. The age bucketing
  // is a JS copy of humanSeconds there (whole seconds since ts; <60 → Ns, <3600 → rounded Nm,
  // else rounded Nh) — the page cannot import TS, per the fmtTokens precedent. Computed from
  // Date.now() at render time, so labels stay fresh on the existing 1-second poll.
  const fmtLastTick = (ts) => {
    if (!ts) return "-";
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    let s = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    if (Date.now() - ts > 86400000) s = p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + s;
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    const age = (sec < 60 ? sec + "s" : sec < 3600 ? Math.round(sec / 60) + "m" : Math.round(sec / 3600) + "h") + " ago";
    return s + " · " + age;
  };
  // last-tick-fmt:end
  // next-run-fmt:start
  // Next-run cell — mirrors the TUI's nextRunCell in status-render.ts: "-" for a loop in
  // flight (an active phase — working/reviewing/landing, the same three prefixes sortLoops
  // classifies; the payload's inFlight flag derives from the same check) or parked awaiting
  // a slot (an inactive phase prefix, but a reserved loop with no next run to speak of — the
  // TUI twin catches it via s.running, which the payload does not carry, so the prefix is
  // this copy's equivalent check), or a stopped fleet; "now" when due;
  // otherwise the remaining time through the same s/m/h bucketing as fmtLastTick's age,
  // prefixed "backoff " while backoffSeconds > 0 (the wake row-action clears exactly that).
  // Raw nextRunAt/backoffSeconds come from the payload; Date.now() at render time keeps the
  // countdown fresh on the existing 1-second poll. The page cannot import TS (the fmtTokens
  // precedent), so the two copies stay in lockstep by test.
  const fmtNextRun = (l, fleetRunning) => {
    const active = l.phase.startsWith("working") || l.phase.startsWith("reviewing") || l.phase.startsWith("landing") || l.phase.startsWith("awaiting slot");
    if (!fleetRunning || active) return "-";
    const sec = Math.round((l.nextRunAt - Date.now()) / 1000);
    if (sec <= 0) return "now";
    const label = sec < 60 ? sec + "s" : sec < 3600 ? Math.round(sec / 60) + "m" : Math.round(sec / 3600) + "h";
    return (l.backoffSeconds > 0 ? "backoff " : "") + label;
  };
  // next-run-fmt:end
  // loop-sort:start
  // Loop-table row order — shared by rule with the TUI/status table's TS twin
  // (status-model.ts sortLoopsByState, cross-checked against this copy in test/gui.test.ts):
  // in-flight phases first — working, reviewing, landing — before inactive ones; within each
  // category by last tick most-recent-first. Null (never completed a tick) sorts last in its
  // category; ties break on role name so an identical payload always renders in the same
  // order. The page cannot import TS (the fmtTokens/lastTickCell precedent), so the two copies
  // stay in lockstep by test. /api/status and status --json keep their payload (config)
  // order — grouping is a display concern of the two rendered tables.
  function sortLoops(loops) {
    const cat = (l) => ((l.phase.startsWith("working") || l.phase.startsWith("reviewing") || l.phase.startsWith("landing")) ? 0 : 1);
    return loops.slice().sort((a, b) => {
      if (cat(a) !== cat(b)) return cat(a) - cat(b);
      const ta = a.lastTickEndedAt ?? 0;
      const tb = b.lastTickEndedAt ?? 0;
      if (ta !== tb) return tb - ta;
      return a.role.localeCompare(b.role);
    });
  }
  // loop-sort:end
  // ---- report / failures tabs: the usage dashboard and the failure digest ---------
  // Top-level views inside one page: "fleet" (today's dashboard, default), "report" (usage
  // charts) and "failures" (the bounded Markdown digest). The director prompt form sits
  // outside all of them — an operator control, visible on every tab. The 1s status poll keeps
  // running on every tab; report/failures data is fetched only on tab activation (both move at
  // tick granularity, not per second).
  let activeView = "fleet";
  function switchView(v) {
    if (v !== "fleet" && v !== "report" && v !== "failures") return;
    activeView = v;
    document.getElementById("fleet-view").hidden = v !== "fleet";
    document.getElementById("report").hidden = v !== "report";
    document.getElementById("failures").hidden = v !== "failures";
    document.getElementById("tab-fleet").classList.toggle("active", v === "fleet");
    document.getElementById("tab-report").classList.toggle("active", v === "report");
    document.getElementById("tab-failures").classList.toggle("active", v === "failures");
    if (v === "report") fetchReport(); // on every activation — re-clicking refetches
    if (v === "failures") fetchFailures(); // likewise
  }

  ${GUI_CLIENT_REPORT_JS}
  // Fetch the failure digest on tab activation and render the Markdown into #failures, the
  // same bounded text that "tumwater report --failures" prints (server-rendered, so the
  // browser stays a thin viewer). Re-clicking the tab refetches, like the report tab.
  async function fetchFailures() {
    const panel = document.getElementById("failures");
    try {
      const d = await getJson("/api/failures?days=14");
      panel.innerHTML = "<span class='muted'>failure digest — last 14 days — click the tab again to refresh</span>\\n" + esc(d.markdown || "(no digest)");
    } catch (e) {
      // Same guard as fetchReport: name the endpoint, status, and server error.
      panel.innerHTML = "<span class='muted'>failures unavailable" + (e && e.message ? " — " + esc(e.message) : "") + "</span>";
    }
  }

${GUI_CLIENT_OPERATOR_JS}

  let transcriptRole = null; // loop whose transcript panel is open (null = closed)
  let backlogKey = null; // "file:index" of the open backlog entry (null = closed) — mutually
                         // exclusive with transcriptRole: both render into #transcript, so only
                         // one can be open at a time.
  // The detail panel's currently rendered HTML: the 1s poll re-fetches while a panel is open,
  // but a quiet loop returns the same content poll after poll, so skip the innerHTML rebuild
  // when the frame is unchanged — rewriting identical HTML re-parses it (multi-KB backlog
  // bodies every second) and wipes the operator's text selection mid-read for nothing.
  let lastPanelHtml = null;
  // The same skip for the three panels the 1s poll rewrites unconditionally: the loop table,
  // the backlog lists, and the event feed. On an idle fleet every payload (and so every HTML
  // string) is identical poll after poll, and assigning it anyway re-parses the whole subtree
  // and churns layout for nothing; caching each panel's last-rendered string keeps a quiet
  // poll from touching the DOM at all. Event handlers are delegated on the containers, so a
  // skipped rebuild leaves them working.
  const lastPaint = {}; // panel id -> last HTML string paintPanel painted there
  // One skip-rebuild helper for the three panels the 1s poll rewrites (the loop table, the
  // backlog lists, and the event feed): paint id with html only when the string differs from
  // what the panel already holds. Returns true when it repainted, so a panel with extra
  // after-work (the feed's scroll stickiness) can run it only on a real rebuild.
  function paintPanel(id, html) {
    if (html === lastPaint[id]) return false;
    document.getElementById(id).innerHTML = html;
    lastPaint[id] = html;
    return true;
  }
  function renderDetail(panel, html) {
    if (html !== lastPanelHtml) {
      panel.innerHTML = html;
      lastPanelHtml = html;
    }
    panel.hidden = false;
  }
  async function refreshTranscript() {
    const panel = document.getElementById("transcript");
    if (!transcriptRole && !backlogKey) {
      if (lastPanelHtml !== "") { panel.innerHTML = ""; lastPanelHtml = ""; }
      panel.hidden = true;
      return;
    }
    try {
      if (transcriptRole) {
        // The shared getJson guard (same as the backlog branch below and fetchReport above):
        // every error body /api/transcript sends is JSON ({error}) with no lines, so without
        // it a failed poll (400 for an out-of-catalog role, 500 when the log read throws)
        // would render "(no transcript yet for this loop)" — claiming the log is empty.
        // Throwing keeps the previous panel content, like every other failed poll here.
        const d = await getJson("/api/transcript?role=" + encodeURIComponent(transcriptRole) + "&n=50");
        const lines = Array.isArray(d.lines) ? d.lines : [];
        renderDetail(panel, "<span class='muted'>transcript: " + esc(transcriptRole) +
          " — click the loop name again to close</span>\\n" +
          (lines.length ? lines.map(esc).join("\\n") : "(no transcript yet for this loop)"));
      } else {
        // A backlog entry's full text, fetched on demand (bodies can be multi-KB) and re-fetched
        // on the same 1s poll while open — the panel's pre-wrap preserves its newlines. The body
        // is model-written markdown: escape it before innerHTML like every other dynamic value,
        // or HTML in a plan/bug entry would execute in the dashboard (XSS).
        const [file, index] = backlogKey.split(":");
        const d = await getJson("/api/backlog?file=" + encodeURIComponent(file) + "&index=" + encodeURIComponent(index));
        renderDetail(panel, "<span class='muted'>" + esc(d.title) +
          " — click the entry again to close</span>\\n" + (esc(d.body) || "(no details for this entry)"));
      }
    } catch { /* keep the previous panel content on a failed poll */ }
  }
  async function refresh() {
    try {
      // The shared getJson guard (same as the panel fetches below): the server's own 500
      // catch sends a JSON {error} body. Without that check the body would be assigned to
      // lastStatus and the frame would render from an error object ("orchestrator not
      // running", empty loops) before throwing — and the budget editor would prefill from
      // it. Throwing before the assignment keeps lastStatus at the last good payload and
      // lands in the catch below, which reports the honest "connection lost" and keeps the
      // last good frame.
      const d = await getJson("/api/status");
      lastStatus = d;
      // A newer serving build means this page is stale: reload before painting a frame. The
      // first non-null sha is remembered; the failed-poll catch below never touches it, so it
      // survives the gap while the old server closes and the new one binds the port.
      if (d.serverBuildSha) {
        if (serverBuildSha === null) serverBuildSha = d.serverBuildSha;
        else if (d.serverBuildSha !== serverBuildSha) {
          location.reload();
          return;
        }
      }
      const qn = (d.questions || []).length;
      // The build badge arrives pre-formatted from the payload — status-model's buildBadge,
      // the same string the TUI/status header renders, so the two surfaces cannot drift.
      // The land-queue badge is the same pattern (status-model's landingBadge —
      // "· land queue: N" while anything is queued or landing, empty when idle), appended
      // in the same order as renderStatus's header: after the running/pid+build part, before
      // the inbox badge.
      document.getElementById("header").textContent =
        (d.running ? "running (pid " + d.pid + (d.buildBadge || "") + ")" : "orchestrator not running") +
        (d.landingBadge || "") +
        (d.inbox ? " · inbox: " + d.inbox : "") +
        (qn ? " · questions: " + qn : "");
      // The daily cost budget badge arrives preformatted from the payload — status-model's
      // budgetBadge, the same string the TUI/status header renders (n/a for an all-free
      // fleet; "· no cap" when disabled), so the two surfaces cannot drift. It is its own
      // element because it is clickable (in priced states — an all-free fleet renders
      // plain text, not a link): the editor swaps just this fragment.
      renderBudgetBadge(d);
      renderPauseBadge(d);
      const loopsHtml = sortLoops(d.loops).map((l) => {
        const cls = l.phase.startsWith("working") ? "working" : (l.lastResult || "");
        const last = l.lastResult ? l.lastResult + (l.lastSummary ? " — " + l.lastSummary : "") : "-";
        // Per-role prompts 2/2 — a loop with queued prompts carries the same "p:N" marker on
        // its state cell the TUI's table renders (status-render.ts's roleQueued), driven by
        // the payload's roleInbox counts.
        const queuedN = (d.roleInbox || {})[l.role] || 0;
        const queuedMarker = queuedN > 0 ? " p:" + queuedN : "";
        // User-defined loops carry an asterisk in the link text (the payload's custom flag);
        // data-role stays the bare id so the transcript fetch keeps working.
        return "<tr><td><a href='#' class='looplink" + (transcriptRole === l.role ? " active" : "") +
          "' data-role='" + esc(l.role) + "'>" + esc(l.role) + (l.custom ? "*" : "") + "</a></td>"
          + "<td class='wide " + cls + "'>" + esc(l.phase + queuedMarker)
          + "</td><td class='wide'>" + esc(l.currentWork ?? "-") + "</td><td>" + l.ticks + "</td><td>" + l.commits + "</td><td>" + fmtTokens(l.generated) +
          "</td><td>" + fmtTokens(l.peakCtx) +
          // today: the loop's spend for the local day (0 while its stamp is stale), same
          // two-decimal rule as cost — formatted client-side from the payload, like cost.
          "</td><td>" + fmtUsd(l.costUsd) + "</td><td>" + fmtUsd(l.todayUsd) + "</td><td>" + fmtLastTick(l.lastTickEndedAt) +
          "</td><td class='wide'>" + esc(last) +
          "</td><td>" + fmtNextRun(l, d.running) +
          // The row's operator controls: wake always (it is safe on an idle loop — it just
          // clears any backoff), abort only while a tick is actually in flight (the payload's
          // inFlight flag; there is nothing to abort otherwise), and a pause/resume toggle
          // from the payload's pausedRoles list (the "tumwater pause --role" marker).
          "</td><td><a href='#' class='rowaction' data-action='wake' data-role='" + esc(l.role) + "'>wake</a>" +
          (l.inFlight ? " <a href='#' class='rowaction' data-action='abort' data-role='" + esc(l.role) + "'>abort</a>" : "") +
          " <a href='#' class='rowaction' data-action='" + ((d.pausedRoles || []).includes(l.role) ? "resume" : "pause") +
          "' data-role='" + esc(l.role) + "'>" + ((d.pausedRoles || []).includes(l.role) ? "resume" : "pause") + "</a>" +
          " <a href='#' class='rowaction' data-action='prompt' data-role='" + esc(l.role) + "'>prompt</a>" +
          "</td></tr>";
      }).join("");
      paintPanel("loops", loopsHtml);
      // Project status: planned features, open bugs, and open questions — fresh from
      // /api/status each poll. Each entry line is a link into the detail panel (its full text,
      // fetched on demand from /api/backlog); queued prompts stay plain — they have no body.
      const backlogLink = (file, items) => items.map((t, i) =>
        "<a class='backloglink" + (backlogKey === file + ":" + i ? " active" : "") + "' data-file='" + file +
        "' data-index='" + i + "'>" + esc(t) + "</a>").join("\\n");
      const backlogList = (title, items, file) => "<span class='muted'>" + esc(title + " (" + items.length + ")") + "</span>\\n" +
        (items.length ? (file ? backlogLink(file, items) : items.map(esc).join("\\n")) : "(none)");
      const backlogHtml =
        backlogList("planned features", d.plans || [], "plans") + "\\n\\n" + backlogList("open bugs", d.bugs || [], "bugs") +
        "\\n\\n" + backlogList("open questions", d.questions || [], "questions") +
        // Queued director prompts in execution order (previews, truncated server-side);
        // (none) while the inbox is empty, like the other sections. Per-role prompts 2/2 —
        // role queues ride the same section, labeled with their role (full text stays in the
        // queue files: "tumwater prompt --list --role" reads it).
        "\\n\\n" + backlogList("queued prompts", (d.inboxPrompts || []).concat(
          Object.keys(d.roleInbox || {}).filter((r) => d.roleInbox[r] > 0)
            .map((r) => r + ": " + d.roleInbox[r] + " queued"),
        ));
      paintPanel("backlog", backlogHtml);
      const feedHtml = d.events.map(esc).join("<br>");
      const feed = document.getElementById("feed");
      // Stickiness is judged on the pre-rebuild scroll state, as it always was.
      const stick = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 4;
      if (paintPanel("feed", feedHtml) && stick) feed.scrollTop = feed.scrollHeight;
    } catch {
      document.getElementById("header").textContent = "connection lost";
    }
    await refreshTranscript(); // panel re-fetches on the same 1s poll while open
  }
  document.getElementById("loops").addEventListener("click", (ev) => {
    const a = ev.target.closest("a.looplink");
    if (!a) return;
    ev.preventDefault();
    backlogKey = null; // opening/switching a transcript closes any open backlog entry
    transcriptRole = transcriptRole === a.dataset.role ? null : a.dataset.role; // toggle / switch
    refresh();
  });
  // row-actions:start
  // The loop rows' wake/abort/pause/prompt controls: one delegated listener beside the looplink one
  // above. A click POSTs to the same marker-writing core the CLI commands use (/api/wake,
  // /api/abort, /api/pause-role), no confirmation dialog — a wake is harmless and an abort
  // matches the row's visible in-flight state. The server's confirmation message flashes in
  // the header (the budget/pause error-flash mechanism; pause/resume has no server message,
  // so the flash is composed from the endpoint's changed/paused flags), and the next 1 s poll
  // re-renders the state (abort → the row's phase drops to idle once the marker is consumed;
  // pause/resume → the row's toggle and "paused" phase swap). A failed POST flashes the error.
  document.getElementById("loops").addEventListener("click", async (ev) => {
    const a = ev.target.closest("a.rowaction");
    if (!a) return;
    ev.preventDefault();
    if (a.dataset.action === "prompt") {
      // Open the shared per-role prompt bar addressed to this row's loop. No POST on open —
      // sending is the bar form's job below.
      rolePromptRole = a.dataset.role;
      promptLabel.textContent = "prompt for " + rolePromptRole + ":";
      promptWrap.hidden = false;
      promptInput.focus();
      return;
    }
    const path = a.dataset.action === "abort" ? "/api/abort"
      : (a.dataset.action === "pause" || a.dataset.action === "resume") ? "/api/pause-role"
      : "/api/wake";
    try {
      const d = await postJson(path, { role: a.dataset.role });
      let msg = d && typeof d.message === "string" ? d.message : path + " accepted";
      if (a.dataset.action === "pause" || a.dataset.action === "resume") {
        msg = a.dataset.role + (d && d.changed
          ? (a.dataset.action === "pause" ? " paused" : " resumed")
          : (a.dataset.action === "pause" ? " was already paused" : " was not paused"));
      }
      showFlash(msg);
    } catch (e) {
      showFlash("error: " + e.message);
    }
  });
  // The shared per-role prompt bar (gui-page's #rolepromptwrap): the rows' prompt link opens
  // it addressed to that loop; send POSTs /api/prompt-role — the same submit path
  // "tumwater prompt --role" uses — and the flash reports the single-role wake. A failed POST
  // keeps the text and flashes the error, the same contract the director prompt form honors.
  const promptWrap = document.getElementById("rolepromptwrap");
  const promptLabel = document.getElementById("rolepromptlabel");
  const promptInput = document.getElementById("roleprompt");
  let rolePromptRole = null;
  const closePromptBar = () => {
    rolePromptRole = null;
    promptWrap.hidden = true;
    promptInput.value = "";
  };
  document.getElementById("rolepromptform").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = promptInput.value.trim();
    if (!text || !rolePromptRole) return;
    const role = rolePromptRole;
    try {
      const d = await postJson("/api/prompt-role", { role, text });
      showFlash(d && typeof d.message === "string" ? d.message : "queued for the " + role + " loop");
      closePromptBar();
      refresh();
    } catch (e) {
      showFlash("error: " + e.message);
    }
  });
  document.getElementById("rolepromptcancel").addEventListener("click", closePromptBar);
  // row-actions:end
  document.getElementById("backlog").addEventListener("click", (ev) => {
    const a = ev.target.closest("a.backloglink");
    if (!a) return;
    ev.preventDefault();
    transcriptRole = null; // opening/switching an entry closes any open transcript
    const key = a.dataset.file + ":" + a.dataset.index;
    backlogKey = backlogKey === key ? null : key; // toggle / switch, same rule as loop links
    refresh();
  });
  document.getElementById("viewnav").addEventListener("click", (ev) => {
    const a = ev.target.closest("a");
    if (!a || !a.id.startsWith("tab-")) return;
    ev.preventDefault();
    switchView(a.id.slice(4)); // "fleet" | "report" | "failures" — re-clicking the active tab refetches
  });
  document.getElementById("promptform").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const input = document.getElementById("prompt");
    const text = input.value.trim();
    if (!text) return;
    // Same response guard as saveBudget and the poll fetches: a network failure or the
    // server's 4xx/5xx must not clear the box and claim "queued" for a prompt that was
    // never accepted — flash the error and keep the operator's text so it can be resubmitted.
    try {
      await postJson("/api/prompt", { text });
    } catch (e) {
      showFlash("error: " + e.message);
      return;
    }
    input.value = "";
    showFlash("queued");
    refresh();
  });
  attachReportTip();
  refresh();
  setInterval(refresh, 1000);`;
