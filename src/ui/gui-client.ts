/** The browser-side dashboard app inlined as the GUI page's only <script>: it polls
 * /api/status every second, renders the loop table, event feed, backlog, and report, and
 * posts prompts to /api/prompt. Split out of gui-page.ts — which keeps the page's markup
 * and CSS shell — because this runs in the browser as a separate runtime that cannot import
 * the harness modules; it keeps its own copies of the small display formatters (see
 * text.ts). The report tab's chart builders live in gui-client-report.ts, interpolated
 * into this template by string concatenation so the served script is byte-identical to
 * the pre-split single blob; edit here when the fleet view, badges, transcript, or
 * prompt form change. */
import { GUI_CLIENT_REPORT_JS } from "./gui-client-report.js";
export const GUI_CLIENT_JS = `  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
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

  // budget-edit:start
  // The header's daily cost budget badge is editable: clicking swaps just that fragment for
  // an inline input + set/cancel; saving POSTs /api/budget, which writes tumwater.json through
  // the same shared setter as the TUI's Ctrl+B. No optimistic local state: on success the
  // badge re-renders from the next 1 s poll (the orchestrator picks the new cap up within ~2
  // s), and a failed save flashes the server's error and keeps the editor open so the operator
  // can fix it. lastStatus is the latest /api/status payload, kept so cancel can restore the
  // badge without waiting for the next poll.
  let lastStatus = null;
  // The serving process's startup build sha, remembered from the first successful poll so a
  // later change (a redeploy re-execs the server) reloads this page onto the new code.
  let serverBuildSha = null;
  let budgetEditing = false;
  function renderBudgetBadge(d) {
    if (budgetEditing) return; // keep the editor until set/cancel decides
    // An all-free fleet has no spend a cap could ever bind: its badge is plain text (no
    // link, no pointer) so it cannot open a cap editor that would never take effect. Every
    // other state keeps the clickable badge — the affordance for editing the cap.
    document.getElementById("budgetwrap").innerHTML = d.budget && d.budget.free
      ? "<span>" + esc(d.budgetBadge || "") + "</span>"
      : "<a href='#' id='budgetbadge'>" + esc(d.budgetBadge || "") + "</a>";
  }
  function openBudgetEditor() {
    budgetEditing = true;
    // Pre-filled with the current cap — empty when disabled (empty means "no cap" on save).
    const cap = lastStatus && lastStatus.budget && lastStatus.budget.capUsd > 0 ? String(lastStatus.budget.capUsd) : "";
    document.getElementById("budgetwrap").innerHTML =
      "<input type='number' min='0' step='0.01' id='budgetinput' value='" + esc(cap) + "' style='width:9em;padding:2px 6px'>"
      + " <button id='budgetset'>set</button> <button id='budgetcancel'>cancel</button>";
    const input = document.getElementById("budgetinput");
    input.focus();
    input.select();
  }
  function showFlash(msg) {
    const f = document.getElementById("flash");
    f.textContent = msg;
    setTimeout(() => (f.textContent = ""), 3000);
  }
  async function saveBudget() {
    const input = document.getElementById("budgetinput");
    if (!input) return;
    // A type=number input reports value "" both for a field the operator cleared on purpose
    // (post 0 = no cap, below) and for text the browser rejected ("$25", "5,000") — the two
    // look identical through .value. validity.badInput tells them apart, so a typo flashes an
    // error instead of silently disabling the spend cap; stay in edit mode so it can be fixed.
    if (input.validity && input.validity.badInput) {
      showFlash("budget must be a number of 0 or more (clear the field for no cap)");
      return;
    }
    // Empty means "no cap" (0 disables).
    const value = input.value === "" ? 0 : Number(input.value);
    try {
      await postJson("/api/budget", { maxDailyCostUsd: value });
      budgetEditing = false; // the next poll re-renders the badge from the payload
    } catch (e) {
      showFlash("error: " + e.message); // stay in edit mode so the operator can fix it
    }
  }
  document.addEventListener("click", (ev) => {
    if (ev.target.closest("#budgetbadge")) { ev.preventDefault(); openBudgetEditor(); return; }
    if (ev.target.id === "budgetset") { saveBudget(); return; }
    if (ev.target.id === "budgetcancel") { budgetEditing = false; renderBudgetBadge(lastStatus); }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && ev.target.id === "budgetinput") saveBudget(); // Enter saves, like set
  });
  // budget-edit:end

  // pause-control:start
  // The header's fleet pause/resume control: one click POSTs /api/pause, the same operator
  // gate "tumwater pause" / "resume" write, so a shell-less operator watching the dashboard
  // (e.g. over "gui --all-interfaces") can halt a runaway fleet. No optimistic state: the
  // badge re-renders from the next 1 s poll's d.paused (the marker is persistent state —
  // pausing before startup starts an already-paused fleet), and a failed POST flashes the
  // server's error so the operator knows the marker did not change.
  function renderPauseBadge(d) {
    document.getElementById("pausewrap").innerHTML = d.paused
      ? "<a href='#' id='pausebadge'> · paused — resume</a>"
      : "<a href='#' id='pausebadge'> · pause</a>";
  }
  async function togglePause() {
    // The opposite of the last server-reported state; the poll re-renders the badge after a
    // successful POST, so the control never paints a state the marker does not hold. Routes
    // through the shared apiFetch guard, like every other endpoint call.
    const target = !(lastStatus && lastStatus.paused);
    try {
      await postJson("/api/pause", { paused: target });
    } catch (e) {
      showFlash("error: " + e.message); // no optimistic state; fix and click again
    }
  }
  document.addEventListener("click", (ev) => {
    if (ev.target.closest("#pausebadge")) { ev.preventDefault(); togglePause(); }
  });
  // pause-control:end

  let transcriptRole = null; // loop whose transcript panel is open (null = closed)
  let backlogKey = null; // "file:index" of the open backlog entry (null = closed) — mutually
                         // exclusive with transcriptRole: both render into #transcript, so only
                         // one can be open at a time.
  async function refreshTranscript() {
    const panel = document.getElementById("transcript");
    if (!transcriptRole && !backlogKey) { panel.hidden = true; panel.innerHTML = ""; return; }
    try {
      if (transcriptRole) {
        // The shared getJson guard (same as the backlog branch below and fetchReport above):
        // every error body /api/transcript sends is JSON ({error}) with no lines, so without
        // it a failed poll (400 for an out-of-catalog role, 500 when the log read throws)
        // would render "(no transcript yet for this loop)" — claiming the log is empty.
        // Throwing keeps the previous panel content, like every other failed poll here.
        const d = await getJson("/api/transcript?role=" + encodeURIComponent(transcriptRole) + "&n=50");
        const lines = Array.isArray(d.lines) ? d.lines : [];
        panel.hidden = false;
        panel.innerHTML = "<span class='muted'>transcript: " + esc(transcriptRole) +
          " — click the loop name again to close</span>\\n" +
          (lines.length ? lines.map(esc).join("\\n") : "(no transcript yet for this loop)");
      } else {
        // A backlog entry's full text, fetched on demand (bodies can be multi-KB) and re-fetched
        // on the same 1s poll while open — the panel's pre-wrap preserves its newlines. The body
        // is model-written markdown: escape it before innerHTML like every other dynamic value,
        // or HTML in a plan/bug entry would execute in the dashboard (XSS).
        const [file, index] = backlogKey.split(":");
        const d = await getJson("/api/backlog?file=" + encodeURIComponent(file) + "&index=" + encodeURIComponent(index));
        panel.hidden = false;
        panel.innerHTML = "<span class='muted'>" + esc(d.title) +
          " — click the entry again to close</span>\\n" + (esc(d.body) || "(no details for this entry)");
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
      document.getElementById("loops").innerHTML = sortLoops(d.loops).map((l) => {
        const cls = l.phase.startsWith("working") ? "working" : (l.lastResult || "");
        const last = l.lastResult ? l.lastResult + (l.lastSummary ? " — " + l.lastSummary : "") : "-";
        // User-defined loops carry an asterisk in the link text (the payload's custom flag);
        // data-role stays the bare id so the transcript fetch keeps working.
        return "<tr><td><a href='#' class='looplink" + (transcriptRole === l.role ? " active" : "") +
          "' data-role='" + esc(l.role) + "'>" + esc(l.role) + (l.custom ? "*" : "") + "</a></td>"
          + "<td class='wide " + cls + "'>" + esc(l.phase)
          + "</td><td class='wide'>" + esc(l.currentWork ?? "-") + "</td><td>" + l.ticks + "</td><td>" + l.commits + "</td><td>" + fmtTokens(l.generated) +
          "</td><td>" + fmtTokens(l.peakCtx) +
          // today: the loop's spend for the local day (0 while its stamp is stale), same
          // two-decimal rule as cost — formatted client-side from the payload, like cost.
          "</td><td>$" + l.costUsd.toFixed(2) + "</td><td>$" + l.todayUsd.toFixed(2) + "</td><td>" + fmtLastTick(l.lastTickEndedAt) +
          "</td><td class='wide'>" + esc(last) +
          // The row's operator controls: wake always (it is safe on an idle loop — it just
          // clears any backoff), abort only while a tick is actually in flight (the payload's
          // inFlight flag; there is nothing to abort otherwise).
          "</td><td><a href='#' class='rowaction' data-action='wake' data-role='" + esc(l.role) + "'>wake</a>" +
          (l.inFlight ? " <a href='#' class='rowaction' data-action='abort' data-role='" + esc(l.role) + "'>abort</a>" : "") +
          "</td></tr>";
      }).join("");
      // Project status: planned features, open bugs, and open questions — fresh from
      // /api/status each poll. Each entry line is a link into the detail panel (its full text,
      // fetched on demand from /api/backlog); queued prompts stay plain — they have no body.
      const backlogLink = (file, items) => items.map((t, i) =>
        "<a class='backloglink" + (backlogKey === file + ":" + i ? " active" : "") + "' data-file='" + file +
        "' data-index='" + i + "'>" + esc(t) + "</a>").join("\\n");
      const backlogList = (title, items, file) => "<span class='muted'>" + esc(title + " (" + items.length + ")") + "</span>\\n" +
        (items.length ? (file ? backlogLink(file, items) : items.map(esc).join("\\n")) : "(none)");
      document.getElementById("backlog").innerHTML =
        backlogList("planned features", d.plans || [], "plans") + "\\n\\n" + backlogList("open bugs", d.bugs || [], "bugs") +
        "\\n\\n" + backlogList("open questions", d.questions || [], "questions") +
        // Queued director prompts in execution order (previews, truncated server-side);
        // (none) while the inbox is empty, like the other sections.
        "\\n\\n" + backlogList("queued prompts", d.inboxPrompts || []);
      const feed = document.getElementById("feed");
      const stick = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 4;
      feed.innerHTML = d.events.map(esc).join("<br>");
      if (stick) feed.scrollTop = feed.scrollHeight;
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
  // The loop rows' wake/abort controls: one delegated listener beside the looplink one above.
  // A click POSTs to the same marker-writing core the CLI commands use (/api/wake, /api/abort),
  // no confirmation dialog — a wake is harmless and an abort matches the row's visible
  // in-flight state. The server's confirmation message flashes in the header (the budget/pause
  // error-flash mechanism), and the next 1 s poll re-renders the state (abort → the row's
  // phase drops to idle once the marker is consumed); a failed POST flashes the error instead.
  document.getElementById("loops").addEventListener("click", async (ev) => {
    const a = ev.target.closest("a.rowaction");
    if (!a) return;
    ev.preventDefault();
    const path = a.dataset.action === "abort" ? "/api/abort" : "/api/wake";
    try {
      const d = await postJson(path, { role: a.dataset.role });
      showFlash(d && typeof d.message === "string" ? d.message : path + " accepted");
    } catch (e) {
      showFlash("error: " + e.message);
    }
  });
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
