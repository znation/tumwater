/** The dashboard's detail drawer, browser-side: a sheet on the right that opens over the page
 * without losing it. For a loop it shows the state, the loop's controls (prompt, wake,
 * pause/resume, abort), what it is working on, its last result, the metrics the fleet table
 * leaves out (tokens, context, cost, timings), its recent ticks (/api/history filtered to the
 * loop), and its live transcript (/api/transcript, re-fetched on the 1 s poll and kept pinned
 * to the bottom while the reader is there). For a backlog entry it shows the entry in full
 * (/api/backlog), rendered as Markdown, with a shortcut into the composer — answering a
 * question, or asking the director about a plan or bug. Esc, the close button, or clicking the
 * same row again closes it. Spliced into gui-client.ts's script, reaching its helpers through
 * that concatenation. */
export const GUI_CLIENT_DRAWER_JS = String.raw`  let drawer = null; // { kind: "loop", role } | { kind: "entry", file, index } while open
  let drawerTicks = null; // the open loop's recent history rows (null until fetched)
  let drawerTicksAt = 0;
  const openEntryKey = () => (drawer && drawer.kind === "entry" ? drawer.file + ":" + drawer.index : null);
  const openLoopRole = () => (drawer && drawer.kind === "loop" ? drawer.role : null);

  function showDrawer(bodyHtml) {
    for (const id of ["drawerhead", "draweractions", "drawermeta", "transcript", "entrybody"]) delete lastPaint[id];
    $("drawerhead").innerHTML = "";
    $("drawerbody").innerHTML = bodyHtml;
    $("drawer").hidden = false;
    $("scrim").hidden = false;
  }
  function closeDrawer() {
    const wasLoop = openLoopRole();
    drawer = null;
    if (wasLoop && location.hash.startsWith("#loop/")) history.replaceState(null, "", "#" + activeView);
    drawerTicks = null;
    $("drawer").hidden = true;
    $("scrim").hidden = true;
    $("drawerhead").innerHTML = "";
    $("drawerbody").innerHTML = "";
    for (const id of ["drawerhead", "draweractions", "drawermeta", "transcript", "entrybody"]) delete lastPaint[id];
    if (lastStatus) renderFleet(lastStatus); // drop the row highlight
  }

  function openLoop(role) {
    drawer = { kind: "loop", role };
    const hash = "#loop/" + encodeURIComponent(role);
    if (location.hash !== hash) history.replaceState(null, "", hash);
    drawerTicks = null;
    drawerTicksAt = 0;
    showDrawer("<div id='draweractions' class='drawer-actions'></div><div id='drawermeta'></div><section class='transcript-sec'><div class='sec-head'><h3>Live transcript</h3>" +
      "<span class='muted' style='margin-left:auto;font-size:13px'>last 200 lines</span></div>" +
      "<pre id='transcript' class='transcript'><span class='muted'>Loading…</span></pre></section>");
    if (lastStatus) {
      renderLoopDrawer(lastStatus);
      renderFleet(lastStatus);
    }
    loadLoopTicks(true);
    refreshTranscript(true);
  }
  function toggleLoop(role) {
    if (openLoopRole() === role) closeDrawer();
    else openLoop(role);
  }
  function openEntry(file, index) {
    drawer = { kind: "entry", file, index: Number(index) };
    showDrawer("<div id='entrybody'><div class='empty'>Loading…</div></div>");
    if (lastStatus) renderFleet(lastStatus);
    refreshEntry();
  }
  function toggleEntry(file, index) {
    if (openEntryKey() === file + ":" + index) closeDrawer();
    else openEntry(file, index);
  }

  // The change the landing slot holds for a role — what a landing (or approved) row is about.
  function landingSummary(d, role) {
    const f = d.landQueue && d.landQueue.inFlight;
    if (!f) return "";
    const change = (Array.isArray(f.changes) ? f.changes : [f]).find((c) => c.role === role);
    return change && change.summary ? change.summary : "";
  }

  function renderLoopDrawer(d) {
    const role = openLoopRole();
    if (!role) return;
    const l = (d.loops || []).find((x) => x.role === role);
    if (!l) {
      paintPanel("drawerhead", "<div class='kicker'>Loop</div><h2 id='drawertitle' class='mono'>" + esc(role) +
        "</h2><span class='muted'>This loop is no longer part of the fleet.</span>");
      paintPanel("draweractions", "");
      paintPanel("drawermeta", "");
      return;
    }
    const info = phaseInfo(l.phase);
    const paused = (d.pausedRoles || []).includes(l.role);
    const detail = phaseDetail(l, info, d);
    paintPanel("drawerhead", "<div class='kicker'>Loop" + (l.custom ? " · user-defined" : "") + "</div>" +
      "<h2 id='drawertitle' class='mono'>" + esc(l.role) + "</h2><div class='chips'>" + pill(info) +
      (detail ? "<span class='muted'>" + esc(detail) + "</span>" : "") + "</div>");

    const btn = (action, ic, label, cls) => "<button type='button' class='btn btn-sm rowaction" + (cls ? " " + cls : "") + "' data-action='" + action +
      "' data-role='" + esc(l.role) + "'>" + icon(ic) + esc(label) + "</button>";
    let actions = btn("prompt", "chat", "Prompt this loop");
    if (l.inFlight) actions += abortConfirming(l.role) ? btn("abort", "stop", "Click again to abort", "btn-danger confirming") : btn("abort", "stop", "Abort this tick", "btn-danger");
    else actions += btn("wake", "bolt", "Wake now");
    actions += paused ? btn("resume", "play", "Resume") : btn("pause", "pause", "Pause");

    const working = info.live || info.key === "vetted";
    const now = working
      ? "<section><div class='sec-head'><h3>" + (info.key === "working" ? "Working on" : info.key === "reviewing" ? "Under review" : "Landing") +
        "</h3></div><div class='note'>" + esc(l.currentWork || landingSummary(d, l.role) || (info.key === "working" ? "Starting up…" : "Waiting for its first words…")) + "</div></section>"
      : "";
    const r = l.lastResult ? resultInfo(l.lastResult) : null;
    const why = resultWhy(l);
    const last = "<section><div class='sec-head'><h3>Last result</h3>" + (l.lastTickEndedAt ? "<span class='muted' style='font-size:13px'>" + esc(fmtAgo(l.lastTickEndedAt)) + "</span>" : "") +
      "</div><div class='note'>" + (r ? "<span class='res t-" + r.tone + "'>" + esc(r.label) + "</span>" + (why ? " — " + esc(why) : "") : "<span class='muted'>No completed ticks yet.</span>") + "</div></section>";
    const kv = (k, v, title) => "<div><dt>" + esc(k) + "</dt><dd title='" + esc(title || v) + "'>" + esc(v) + "</dd></div>";
    const next = fmtNextRun(l, d.running);
    const tickWord = l.inFlight ? "this tick" : "last tick";
    const stats = "<dl class='kv'>" + kv("Commits", String(l.commits)) + kv("Ticks", String(l.ticks)) +
      kv("Tokens, " + tickWord, fmtTokens(l.generated)) + kv("Peak context, " + tickWord, fmtTokens(l.peakCtx)) +
      kv("Spent today", fmtUsd(l.todayUsd)) + kv("Spent in total", fmtUsd(l.costUsd)) +
      kv("Last tick ended", l.lastTickEndedAt ? fmtAgo(l.lastTickEndedAt) : "never", fmtLastTick(l.lastTickEndedAt)) +
      kv("Next run", next === "-" ? "—" : next === "now" ? "now" : "in " + next.replace("backoff ", "") + (next.startsWith("backoff ") ? " (backoff)" : "")) + "</dl>";
    const ticks = drawerTicks === null
      ? "<p class='muted'>Loading…</p>"
      : drawerTicks.length
        ? "<ul class='ticks'>" + drawerTicks.map((t) => {
          const res = resultInfo(t.result);
          return "<li><span class='when' title='" + esc(t.time) + "'>#" + esc(t.tick) + " · " + esc(fmtAgo(t.ts)) + "</span>" +
            "<span class='clamp1' title='" + esc(t.detail) + "'><span class='res t-" + res.tone + "'>" + esc(res.label) + "</span> " + esc(t.detail) + "</span>" +
            "<span class='when'>" + (t.durationMs === null ? "" : esc(fmtSpan(Number(t.durationMs)))) + "</span></li>";
        }).join("") + "</ul>"
        : "<p class='muted'>No completed ticks in the log yet.</p>";
    paintPanel("draweractions", actions);
    paintPanel("drawermeta", now + last + stats +
      "<section><div class='sec-head'><h3>Recent ticks</h3></div>" + ticks + "</section>");
  }

  async function loadLoopTicks(force) {
    const role = openLoopRole();
    if (!role || (!force && Date.now() - drawerTicksAt < 5000)) return;
    drawerTicksAt = Date.now();
    try {
      const d = await getJson("/api/history?n=8&role=" + encodeURIComponent(role));
      if (openLoopRole() !== role) return;
      drawerTicks = d && Array.isArray(d.rows) ? d.rows : [];
    } catch {
      if (drawerTicks === null) drawerTicks = [];
    }
    if (lastStatus) renderLoopDrawer(lastStatus);
  }

  // Transcript lines by kind (transcript.ts's rendering): run separators, tool calls, thinking,
  // and retry warnings get their own color; assistant text stays plain.
  function transcriptHtml(lines) {
    return lines.map((line, i) => {
      const cls = /^── /.test(line) ? "l-sep" : /^→ /.test(line) ? "l-tool" : /^· /.test(line) ? "l-think" : /^⚠ /.test(line) ? "l-warn" : "";
      return (cls === "l-sep" && i > 0 ? "\n" : "") + (cls ? "<span class='" + cls + "'>" + esc(line) + "</span>" : esc(line));
    }).join("\n");
  }
  async function refreshTranscript(initial) {
    const role = openLoopRole();
    if (!role) return;
    let d;
    try {
      d = await getJson("/api/transcript?role=" + encodeURIComponent(role) + "&n=200");
    } catch {
      return; // keep the previous content on a failed poll
    }
    const pre = $("transcript");
    if (openLoopRole() !== role || !pre) return;
    const lines = Array.isArray(d.lines) ? d.lines : [];
    const html = lines.length ? transcriptHtml(lines) : "<span class='muted'>No transcript yet — it fills in once this loop's next tick starts.</span>";
    // Stay pinned to the newest line while the reader is at the bottom; leave them be if they
    // scrolled up to read.
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 12;
    if (paintPanel("transcript", html) && (initial || atBottom)) pre.scrollTop = pre.scrollHeight;
  }

  const ENTRY_KINDS = { plans: "Planned feature", bugs: "Open bug", questions: "Open question" };
  async function refreshEntry() {
    if (!drawer || drawer.kind !== "entry") return;
    const file = drawer.file;
    const index = drawer.index;
    let d;
    try {
      d = await getJson("/api/backlog?file=" + encodeURIComponent(file) + "&index=" + encodeURIComponent(index));
    } catch (e) {
      // Keep what is shown; only a first load that fails says so.
      if (lastPaint.entrybody === undefined) paintPanel("entrybody", errorPanel("Could not load this entry", e));
      return;
    }
    if (openEntryKey() !== file + ":" + index) return;
    const t = splitTitle(d.title || "");
    paintPanel("drawerhead", "<div class='kicker'>" + esc(ENTRY_KINDS[file] || "Entry") + (t.meta ? " · " + esc(t.meta) : "") + "</div>" +
      "<h2 id='drawertitle'>" + esc(t.title) + "</h2>");
    const action = file === "questions"
      ? "<button type='button' class='btn btn-sm btn-primary' data-act='answer' data-arg='" + index + "'>" + icon("chat") + "Answer in the composer</button>"
      : "<button type='button' class='btn btn-sm' data-act='mention' data-arg='" + esc(file + ":" + index) + "'>" + icon("chat") + "Ask the director about this</button>";
    // The body is model-written Markdown: renderMarkdown escapes every piece of it.
    paintPanel("entrybody", "<div class='drawer-actions'>" + action + "</div><div class='md'>" +
      (d.body ? renderMarkdown(d.body) : "<p class='muted'>No details for this entry.</p>") + "</div>");
  }

  async function refreshDrawer() {
    if (!drawer) return;
    if (drawer.kind === "loop") {
      if (lastStatus) renderLoopDrawer(lastStatus);
      await refreshTranscript(false);
    } else {
      await refreshEntry();
    }
  }
  $("scrim").addEventListener("click", closeDrawer);
  $("drawer").addEventListener("click", (ev) => {
    const b = ev.target instanceof Element ? ev.target.closest("button.rowaction") : null;
    if (b) rowAction(b.dataset.action, b.dataset.role);
  });
`;
