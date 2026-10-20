// vocabulary: plain
/** The dashboard's detail drawer, browser-side: a sheet on the right that opens over the page
 * without losing it. For a role it shows the state, the role's controls (prompt, wake now or later,
 * pause/resume, abort), what it is working on, its last result, the metrics the team table
 * leaves out (tokens, context, cost, timings), its recent runs (/api/history filtered to the
 * role), and its live transcript (/api/transcript, re-fetched on the 1 s poll and kept pinned
 * to the bottom while the reader is there; a "Show prompts" button adds each agent run's prompt
 * with `&prompt=1`). For a backlog entry it shows the entry in full
 * (/api/backlog), rendered as Markdown, with a shortcut into the composer — answering a
 * question, or asking the director about a plan or bug — and, for a plan or bug, a two-click
 * Cancel that removes the entry (/api/backlog-cancel). Esc, the close button, or clicking the
 * same row again closes it. Spliced into gui-client.ts's script, reaching its helpers through
 * that concatenation. */
export const GUI_CLIENT_DRAWER_JS = String.raw`  let drawer = null; // { kind: "role", role } | { kind: "entry", file, index } while open
  let drawerRuns = null; // the open role's recent history rows (null until fetched)
  let drawerRunsAt = 0;
  let drawerChange = null; // the open role's unmerged change: { role, state: "loading"|"ok"|"error", view, message }
  let drawerRole = null; // the open role's /api/role payload: { role, state: "loading"|"ok"|"error", view, message }
  const openEntryKey = () => (drawer && drawer.kind === "entry" ? drawer.file + ":" + drawer.index : null);
  const openRoleId = () => (drawer && drawer.kind === "role" ? drawer.role : null);
  // One key/value row builder shared by the role-metrics table (renderRoleDrawer) and the
  // Configuration section (drawerConfigHtml, in gui-client-drawer-config.ts): identical markup,
  // formerly copy-pasted into two local consts (kv and row) so the row shape could drift.
  const kvRow = (k, v, title) => "<div><dt>" + esc(k) + "</dt><dd title='" + esc(title || v) + "'>" + esc(v) + "</dd></div>";
  // A diff block in the Change section (the committed change and the dirty-tree uncommitted
  // diff, drawerChangeHtml's two arms): trim the trailing newline the diff carriage-returned,
  // escape the rest, and wrap it in the shared .diff pre. Formerly copy-pasted into both arms
  // so the trim/escape could drift between them.
  const diffPre = (text) => "<pre class='mono diff'>" + esc(String(text).replace(/\n+$/, "")) + "</pre>";

  function showDrawer(bodyHtml) {
    for (const id of ["drawerhead", "draweractions", "drawermeta", "drawerrole", "transcript", "entrybody"]) delete lastPaint[id];
    $("drawerhead").innerHTML = "";
    $("drawerbody").innerHTML = bodyHtml;
    $("drawer").hidden = false;
    $("scrim").hidden = false;
  }
  function closeDrawer() {
    const wasRole = openRoleId();
    drawer = null;
    entryEditing = null;
    noteEditing = null;
    capEditing = null;
    instructionsEditing = null;
    quietEditing = null;
    intervalEditing = null;
    instancesEditing = null;
    modelEditing = null;
    disarmNoteClear();
    if (wasRole && (location.hash.startsWith("#role/") || location.hash.startsWith("#loop/"))) history.replaceState(null, "", "#" + activeView); // vocabulary-ok: legacy dashboard hash, still routed
    drawerRuns = null;
    drawerChange = null;
    drawerRole = null;
    $("drawer").hidden = true;
    $("scrim").hidden = true;
    $("drawerhead").innerHTML = "";
    $("drawerbody").innerHTML = "";
    for (const id of ["drawerhead", "draweractions", "drawermeta", "drawerrole", "transcript", "entrybody"]) delete lastPaint[id];
    if (lastStatus) renderTeam(lastStatus); // drop the row highlight
  }

  let transcriptPrompts = false;
  function openRole(role) {
    drawer = { kind: "role", role };
    transcriptPrompts = false;
    const hash = "#role/" + encodeURIComponent(role);
    if (location.hash !== hash) history.replaceState(null, "", hash);
    drawerRuns = null;
    drawerRunsAt = 0;
    drawerChange = null;
    drawerRole = null;
    showDrawer("<div id='draweractions' class='drawer-actions'></div><div id='drawermeta'></div><div id='drawerrole'></div><section class='transcript-sec'><div class='sec-head'><h3>Live transcript</h3>" +
      "<button type='button' class='btn btn-sm' id='transcriptprompts' data-transcript-prompts style='margin-left:auto'>Show prompts</button>" +
      "<span class='muted' style='margin-left:12px;font-size:13px'>last 200 lines</span></div>" +
      "<pre id='transcript' class='transcript'><span class='muted'>Loading…</span></pre></section>");
    if (lastStatus) {
      renderRoleDrawer(lastStatus);
      renderTeam(lastStatus);
    }
    loadRoleRuns(true);
    loadDrawerChange(role);
    loadDrawerRole(role);
    refreshTranscript(true);
  }
  function toggleRole(role) {
    if (openRoleId() === role) closeDrawer();
    else openRole(role);
  }
  function openEntry(file, index) {
    drawer = { kind: "entry", file, index: Number(index) };
    entryEditing = null;
    showDrawer("<div id='entrybody'><div class='empty'>Loading…</div></div>");
    if (lastStatus) renderTeam(lastStatus);
    refreshEntry();
  }
  function toggleEntry(file, index) {
    if (openEntryKey() === file + ":" + index) closeDrawer();
    else openEntry(file, index);
  }
  // The change the merge slot holds for a role — what a merge (or approved) row is about.
  function mergeSummary(d, role) {
    const f = d.mergeQueue && d.mergeQueue.inFlight;
    if (!f) return "";
    const change = (Array.isArray(f.changes) ? f.changes : [f]).find((c) => c.role === role);
    return change && change.summary ? change.summary : "";
  }

  function renderRoleDrawer(d) {
    const role = openRoleId();
    if (!role) return;
    const l = (d.roles || []).find((x) => x.role === role);
    if (!l) {
      paintPanel("drawerhead", "<div class='kicker'>Role</div><h2 id='drawertitle' class='mono'>" + esc(roleLabel(role)) +
        "</h2><span class='muted'>This role is no longer part of the team.</span>");
      paintPanel("draweractions", "");
      paintPanel("drawermeta", drawerChangeSection());
      paintPanel("drawerrole", drawerRoleSection());
      return;
    }
    const info = phaseInfo(l.phase);
    const paused = (d.pausedLoops || []).includes(l.role); // retired-name-ok: serialized /api key
    const detail = phaseDetail(l, info, d);
    paintPanel("drawerhead", "<div class='kicker'>Role" + (l.custom ? " · user-defined" : "") + "</div>" +
      "<h2 id='drawertitle' class='mono'>" + esc(roleLabel(l.role)) + "</h2><div class='chips'>" + pill(info) +
      (detail ? "<span class='muted'>" + esc(detail) + "</span>" : "") + "</div>");

    const btn = (action, ic, label, cls) => "<button type='button' class='btn btn-sm rowaction" + (cls ? " " + cls : "") + "' data-action='" + action +
      "' data-role='" + esc(l.role) + "'>" + icon(ic) + esc(label) + "</button>";
    let actions = btn("prompt", "chat", "Message this role");
    // The running set (info.live), not the permit-holder inFlight: the exempt running director
    // has an abortable run without holding a maxConcurrent permit (BUGS.md 2026-10-06).
    if (info.live) actions += abortConfirming(l.role) ? btn("abort", "stop", "Click again to stop", "btn-danger confirming") : btn("abort", "stop", "Stop this run", "btn-danger");
    else {
      actions += btn("wake", "bolt", "Wake now");
      if (roleWakeMenuOpen(l.role)) {
        actions += ROLE_WAKE_CHOICES.map((c) => "<button type='button' class='btn btn-sm rowaction' data-action='wake-in' data-for='" + c[0] +
          "' data-role='" + esc(l.role) + "'>in " + esc(c[1]) + "</button>").join("");
      } else actions += btn("wake-in", "clock", "Wake later…");
      // Exact id only: the cancel matches ids exactly, so an instance named via its base role
      // would cancel nothing.
      if (scheduledWakesFor(l, d).some((w) => w.roles.includes(l.role))) actions += btn("wake-cancel", "x", "Cancel scheduled wake");
    }
    if (paused) actions += btn("resume", "play", "Resume");
    else if (rolePauseMenuOpen(l.role)) {
      actions += ROLE_PAUSE_CHOICES.map((c) => "<button type='button' class='btn btn-sm rowaction' data-action='pause-for' data-for='" + c[0] +
        "' data-role='" + esc(l.role) + "'>" + esc(c[1]) + "</button>").join("");
    } else actions += btn("pause", "pause", "Pause") + btn("pause-for", "clock", "Pause for…");
    actions += btn("reset-counters", "refresh", "Reset counters");
    // The two-click Disable, the drawer half of the enable/disable pair (the Settings card's
    // Enable re-enables). The director cannot be disabled, so it shows no Disable button.
    if (l.role !== "director") actions += disableConfirming(l.role) ? btn("disable", "x", "Click again to disable", "btn-danger confirming") : btn("disable", "x", "Disable", "btn-danger");

    const working = info.live || info.key === "vetted"; // vocabulary-ok: the persisted phase key
    const now = working
      ? "<section><div class='sec-head'><h3>" + (info.key === "working" ? "Working on" : info.key === "reviewing" ? "Under review" : "Merging") +
        "</h3></div><div class='note'>" + esc(l.currentWork || mergeSummary(d, l.role) || (info.key === "working" ? "Starting up…" : "Waiting for its first words…")) + "</div></section>"
      : "";
    const r = l.lastResult ? resultInfo(l.lastResult) : null;
    const why = resultWhy(l);
    const last = "<section><div class='sec-head'><h3>Last result</h3>" + (l.lastRunEndedAt ? "<span class='muted' style='font-size:13px'>" + esc(fmtAgo(l.lastRunEndedAt)) + "</span>" : "") +
      "</div><div class='note'>" + (r ? "<span class='res t-" + r.tone + "'>" + esc(r.label) + "</span>" + (why ? " — " + esc(why) : "") : "<span class='muted'>No completed runs yet.</span>") + "</div></section>";
    const next = fmtNextRun(l, d.running);
    // fmtNextRun's shapes: "-", "now" (possibly with a " ×N" yield suffix), and a bare or
    // "backoff "-prefixed countdown. A backoff countdown keeps the label but as a suffix;
    // a suffixed "now" passes through as-is — it is due now, not a future time.
    const nextNote = next === "-" ? "—"
      : next === "now" || next.startsWith("now ") ? next
      : next.startsWith("sleeping ") ? "in " + next.slice(9) + " (sleeping)"
      : "in " + next;
    const runWord = info.live ? "this run" : "last run";
    const stats = "<dl class='kv'>" + kvRow("Commits", String(l.commits)) + kvRow("Runs", String(l.runs)) +
      kvRow("Tokens, " + runWord, fmtTokens(l.generated)) + kvRow("Peak context, " + runWord, fmtTokens(l.peakCtx)) +
      kvRow("Spent today", fmtUsd(l.todayUsd)) + kvRow("Spent in total", fmtUsd(l.costUsd)) +
      kvRow("Last run ended", l.lastRunEndedAt ? fmtAgo(l.lastRunEndedAt) : "never", fmtLastRun(l.lastRunEndedAt)) +
      kvRow("Last merged", l.lastMergedAt ? fmtAgo(l.lastMergedAt) : "never") +
      kvRow("Next run", nextNote) + "</dl>";
    const runs = drawerRuns === null
      ? "<p class='muted'>Loading…</p>"
      : drawerRuns.length
        ? "<ul class='ticks'>" + drawerRuns.map((t) => { // vocabulary-ok: the ticks class stays
          const res = resultInfo(t.result);
          return "<li><span class='when' title='" + esc(t.time) + "'>#" + esc(t.run) + " · " + esc(fmtAgo(t.ts)) + "</span>" +
            "<span class='clamp1' title='" + esc(t.detail) + "'><span class='res t-" + res.tone + "'>" + esc(res.label) + "</span> " + esc(t.detail) + "</span>" +
            "<span class='when'>" + (t.durationMs === null ? "" : esc(fmtSpan(Number(t.durationMs)))) + "</span></li>";
        }).join("") + "</ul>"
        : "<p class='muted'>No completed runs in the log yet.</p>";
    paintPanel("draweractions", actions);
    paintPanel("drawermeta", now + last + stats +
      "<section><div class='sec-head'><h3>Recent runs</h3></div>" + runs + "</section>" + drawerChangeSection());
    // The notebook/prompt live in their own panel, outside drawermeta: the poll rewrites
    // drawermeta whenever its countdown or run-age text changes, and an innerHTML rewrite
    // would collapse an opened Next run prompt. This panel's markup is stable while its
    // payload is unchanged, so paintPanel leaves it (and the disclosure's open state) alone.
    paintPanel("drawerrole", drawerRoleSection());
  }

  // The open role's unmerged change, as /api/diff?role serves it: the full patch the CLI's
  // tumwater diff --role prints. Degrades like the collector — a missing worktree, a missing
  // base branch, or no work each get a plain statement, and an unreadable payload says so
  // rather than rendering a half-view. Pure of side effects; the view paints what it returns.
  function drawerChangeHtml(view) {
    if (!view || typeof view !== "object") return "<p class='muted'>Pending change unavailable.</p>";
    const commits = Array.isArray(view.commits) ? view.commits : [];
    const dirty = Array.isArray(view.dirtyFiles) ? view.dirtyFiles : [];
    if (view.state === "absent") return "<p class='muted'>No workspace yet — this role has not run.</p>";
    if (view.state === "no-base") return "<p class='muted'>Main branch " + esc(view.mainBranch) + " does not exist.</p>";
    if (view.state !== "ready" || (view.ahead === 0 && dirty.length === 0)) return "<p class='muted'>No unlanded work.</p>";
    let html = "<p class='note'>" + esc(view.branch) + " · " + esc(plural(view.ahead, "commit")) +
      " ahead of " + esc(view.mainBranch) +
      (dirty.length ? " · " + esc(plural(dirty.length, "uncommitted file")) : "") + "</p>";
    html += commitRowsHtml(commits);
    if (view.diff) html += diffPre(view.diff);
    if (dirty.length) {
      html += "<p class='note'>Uncommitted: " + esc(dirty.join(", ")) + "</p>";
      if (view.uncommittedDiff) html += diffPre(view.uncommittedDiff);
    }
    return html;
  }
  function drawerChangeSection() {
    const c = drawerChange;
    let body;
    if (!c || c.state === "loading") body = "<p class='muted'>Loading…</p>";
    else if (c.state === "error") body = "<p class='muted'>" + esc(c.message || "Pending change unavailable") + "</p>";
    else body = drawerChangeHtml(c.view);
    return "<section><div class='sec-head'><h3>Pending change</h3></div>" + body + "</section>";
  }
  // Fetch one drawer section's payload once when the drawer opens, storing it in the
  // caller's state cell. A stale answer (the drawer moved to another role) is dropped;
  // later status polls repaint from the stored view. The assign callback writes that cell
  // (drawerChange / drawerRole), so the loading/ok/error contract lives here once for both
  // the pending-change and notebook sections.
  async function loadDrawerSection(role, url, fallbackMessage, assign) {
    if (!role) return;
    assign({ role, state: "loading" });
    try {
      const d = await getJson(url + encodeURIComponent(role), pollSignal());
      if (openRoleId() !== role) return;
      assign({ role, state: "ok", view: d });
    } catch (err) {
      if (openRoleId() !== role) return;
      assign({ role, state: "error", message: err && err.message ? err.message : fallbackMessage });
    }
    if (lastStatus) renderRoleDrawer(lastStatus);
  }
  // The open role's unmerged change, as /api/diff?role serves it.
  function loadDrawerChange(role) {
    return loadDrawerSection(role, "/api/diff?role=", "Pending change unavailable", (v) => { drawerChange = v; });
  }

  // The open role's notebook and next-run prompt, as /api/role serves them (rolePayload):
  // the same note and assembled prompt the CLI's role command shows, so the operator can
  // diagnose a role from the page. The note renders in a <pre>; the next prompt sits in a
  // <details> so it does not push the rest of the drawer down. Both empty cases say so in a
  // muted line. It paints into its own #drawerrole panel, not #drawermeta: the poll rewrites
  // drawermeta whenever its countdown or run-age text changes, and an innerHTML rewrite would
  // collapse an opened <details>. This panel's string is stable while the payload is unchanged,
  // so paintPanel skips it and the disclosure stays open.
  function drawerRoleSection() {
    const r = drawerRole;
    let body;
    if (!r || r.state === "loading") body = "<p class='muted'>Loading…</p>";
    else if (r.state === "error") body = "<p class='muted'>" + esc(r.message || "Notes and prompt unavailable") + "</p>";
    else {
      const view = r.view && typeof r.view === "object" ? r.view : {};
      const note = typeof view.notes === "string" && view.notes.trim() !== "" ? view.notes : null;
      const nextPrompt = typeof view.nextPrompt === "string" && view.nextPrompt.trim() !== "" ? view.nextPrompt : null;
      const outcomes = Array.isArray(view.recentOutcomes) ? view.recentOutcomes : [];
      const canEdit = r.role !== "director";
      const editing = canEdit && noteEditing && noteEditing.role === r.role;
      const buttons = !canEdit ? "" : "<span style='margin-left:auto'><button type='button' class='btn btn-sm' data-act='note-edit' data-arg='" + esc(r.role) + "'>Edit</button>" +
        (note ? " <button type='button' class='btn btn-sm btn-danger' data-act='note-clear' data-arg='" + esc(r.role) + "'>" + (noteClearArmed(r.role) ? "Click again to clear" : "Clear") + "</button>" : "") + "</span>";
      const noteBody = editing
        ? "<textarea id='noteedittext' rows='12' class='mono' style='width:100%'>" + esc(noteEditing.text) + "</textarea>" +
          "<div><button type='button' class='btn btn-sm btn-primary' data-act='note-save' data-arg='" + esc(r.role) + "'>Save</button> " +
          "<button type='button' class='btn btn-sm' data-act='note-discard' data-arg='" + esc(r.role) + "'>Discard</button></div>"
        : note ? "<pre class='mono'>" + esc(note) + "</pre>" : "<p class='muted'>No notes yet.</p>";
      body = "<div class='sec-head'><h3>Notes</h3>" + (editing ? "" : buttons) + "</div>" + noteBody +
        "<details><summary>Next run's prompt</summary>" + (nextPrompt ? "<pre class='mono'>" + esc(nextPrompt) + "</pre>" : "<p class='muted'>Nothing to run (empty inbox).</p>") + "</details>" +
        // The role's recent run outcomes (rolePayload's recentOutcomes, read from the event
        // log), rendered like the Recent runs list above: each with its relative age, result
        // label, summary, and duration. Mirrors the Recent run outcomes section of
        // tumwater role <id> — no backticks allowed here (this whole script is one big
        // String.raw template), so the page and the CLI read one role's outcomes identically.
        (outcomes.length ? "<section><div class='sec-head'><h3>Recent outcomes" +
          "<span class='muted' style='font-size:13px'>· " + outcomes.length + "</span></h3></div>" +
          "<ul class='ticks'>" + outcomes.map((o) => { // vocabulary-ok: the ticks class stays
            const info = resultInfo(o.result);
            const detail = typeof o.summary === "string" && o.summary.trim() !== "" ? o.summary : "";
            return "<li><span class='when' title='" + esc(new Date(Number(o.ts)).toLocaleString()) + "'>" + esc(fmtAgo(Number(o.ts))) + "</span>" +
              "<span class='clamp1' title='" + esc(detail) + "'><span class='res t-" + info.tone + "'>" + esc(info.label) + "</span>" + (detail ? " " + esc(detail) : "") + "</span>" +
              "<span class='when'>" + (o.durationMs == null ? "" : esc(fmtSpan(Number(o.durationMs)))) + "</span></li>";
          }).join("") + "</ul></section>" : "") +
        drawerConfigHtml(view, r.role);
    }
    return "<section>" + body + "</section>";
  }
  // An open notebook edit holds the draft's starting text, not the live payload, so a poll
  // refetch neither wipes the textarea nor changes the painted panel string. Clear waits for a
  // confirming click like entry cancel: the first click arms it for 5 s, the second posts.
  let noteEditing = null; // { role, text }
  let capEditing = null; // { role, value }
  let instructionsEditing = null; // { role, text }
  let quietEditing = null; // { role, window }
  let intervalEditing = null; // { role, value } — value is the seeded override (number) or "" when none
  let instancesEditing = null; // { role, value } — value is the seeded count (number) or "" when none
  let modelEditing = null; // { role, provider, model, thinking } — the seeded raw overrides ("" when unset)
  function repaintDrawerRole() { if (lastStatus) renderRoleDrawer(lastStatus); }
  // The notebook clear and the backlog entry cancel each build a two-click confirm slot from
  // the shared confirmSlot factory (defined in the roles splice, an earlier one), so the arm,
  // guard, and disarm logic lives once.
  const noteClear = confirmSlot(repaintDrawerRole);
  const noteClearArmed = (role) => noteClear.armed(role);
  function armNoteClear(role) { noteClear.arm(role); }
  function disarmNoteClear() { noteClear.disarm(); }
  function startNoteEdit(role, text) { noteEditing = { role, text }; disarmNoteClear(); repaintDrawerRole(); }
  function stopNoteEdit() { noteEditing = null; repaintDrawerRole(); }
  function startCapEdit(role, capUsd) { capEditing = { role, value: capUsd ? Number(capUsd) || 0 : 0 }; repaintDrawerRole(); }
  function stopCapEdit() { capEditing = null; repaintDrawerRole(); }
  function startInstructionsEdit(role, text) { instructionsEditing = { role, text: String(text ?? "") }; repaintDrawerRole(); }
  function stopInstructionsEdit() { instructionsEditing = null; repaintDrawerRole(); }
  function startIntervalEdit(role, value) { intervalEditing = { role, value: value === "" || value == null ? "" : Number(value) }; repaintDrawerRole(); }
  function stopIntervalEdit() { intervalEditing = null; repaintDrawerRole(); }
  function startInstancesEdit(role, value) { instancesEditing = { role, value: value === "" || value == null ? "" : Number(value) }; repaintDrawerRole(); }
  function stopInstancesEdit() { instancesEditing = null; repaintDrawerRole(); }
  function startModelEdit(role, seed) { modelEditing = { role, provider: String((seed && seed.provider) ?? ""), model: String((seed && seed.model) ?? ""), thinking: String((seed && seed.thinking) ?? "") }; repaintDrawerRole(); }
  function stopModelEdit() { modelEditing = null; repaintDrawerRole(); }
  function startQuietEdit(role, window) { quietEditing = { role, window: String(window ?? "") }; repaintDrawerRole(); }
  function stopQuietEdit() { quietEditing = null; repaintDrawerRole(); }
  // The notebook fetch shares loadDrawerSection; closing the drawer clears drawerRole, so
  // reopening refetches.
  function loadDrawerRole(role) {
    return loadDrawerSection(role, "/api/role?role=", "Notes and prompt unavailable", (v) => { drawerRole = v; });
  }

  async function loadRoleRuns(force) {
    const role = openRoleId();
    if (!role || (!force && Date.now() - drawerRunsAt < 5000)) return;
    drawerRunsAt = Date.now();
    try {
      const d = await getJson("/api/history?n=8&role=" + encodeURIComponent(role), pollSignal());
      if (openRoleId() !== role) return;
      drawerRuns = d && Array.isArray(d.rows) ? d.rows : [];
    } catch {
      if (drawerRuns === null) drawerRuns = [];
    }
    if (lastStatus) renderRoleDrawer(lastStatus);
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
    const role = openRoleId();
    if (!role) return;
    const prompts = transcriptPrompts;
    let d;
    try {
      d = await getJson("/api/transcript?role=" + encodeURIComponent(role) + "&n=200" + (prompts ? "&prompt=1" : ""), pollSignal());
    } catch {
      return; // keep the previous content on a failed poll
    }
    const pre = $("transcript");
    if (openRoleId() !== role || !pre || transcriptPrompts !== prompts) return;
    const lines = Array.isArray(d.lines) ? d.lines : [];
    const html = lines.length ? transcriptHtml(lines) : "<span class='muted'>No transcript yet — it fills in once this role's next run starts.</span>";
    // Stay pinned to the newest line while the reader is at the bottom; leave them be if they
    // scrolled up to read.
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 12;
    if (paintPanel("transcript", html) && (initial || atBottom)) pre.scrollTop = pre.scrollHeight;
  }

  function toggleTranscriptPrompts() {
    transcriptPrompts = !transcriptPrompts;
    const b = $("transcriptprompts");
    if (b) b.textContent = transcriptPrompts ? "Hide prompts" : "Show prompts";
    refreshTranscript(true);
  }

  // A plan/bug cancel waits for its confirming click, the confirmAbort shape: the first click
  // arms it for 5 s, a second inside the window fires, and a timeout disarms. The slot records
  // the title too: a list that shifted between the clicks must re-arm, not cancel whatever
  // entry now sits at that position.
  const entryCancel = confirmSlot(refreshEntry);
  const entryCancelArmed = (key, title) => entryCancel.armed(key, title);
  function disarmEntryCancel() { entryCancel.disarm(); }
  function armEntryCancel(key, title) { entryCancel.arm(key, title); }
  // An open edit form: painted once, so a poll never overwrites the operator's draft; the
  // server's title check catches an entry that changed underneath it at save time.
  let entryEditing = null; // { key, title, painted }
  function startEntryEdit(key, title) {
    entryEditing = { key, title, painted: false };
    refreshEntry();
  }
  function stopEntryEdit() { entryEditing = null; }
  const ENTRY_KINDS = { plans: "Planned feature", bugs: "Open bug", questions: "Open question", done: "Done plan", fixed: "Fixed bug", answered: "Answered question" };
  async function refreshEntry() {
    if (!drawer || drawer.kind !== "entry") return;
    const file = drawer.file;
    const index = drawer.index;
    let d;
    try {
      d = await getJson("/api/backlog?file=" + encodeURIComponent(file) + "&index=" + encodeURIComponent(index), pollSignal());
    } catch (err) {
      // Keep what is shown; only a first load that fails says so.
      if (lastPaint.entrybody === undefined) paintPanel("entrybody", errorPanel("Could not load this entry", err));
      return;
    }
    if (openEntryKey() !== file + ":" + index) return;
    const t = splitTitle(d.title || "");
    paintPanel("drawerhead", "<div class='kicker'>" + esc(ENTRY_KINDS[file] || "Entry") + (t.meta ? " · " + esc(t.meta) : "") + "</div>" +
      "<h2 id='drawertitle'>" + esc(t.title) + "</h2>");
    if (entryEditing && entryEditing.key === file + ":" + index) {
      if (entryEditing.painted) return;
      entryEditing.painted = true;
      paintPanel("entrybody", "<div class='drawer-actions'>" +
        "<button type='button' class='btn btn-sm btn-primary' data-act='entry-edit-save' data-arg='" + esc(file + ":" + index) + "'>Save</button>" +
        "<button type='button' class='btn btn-sm' data-act='entry-edit-discard'>Discard</button></div>" +
        "<input id='entryedittitle' type='text' value='" + esc(t.title) + "'>" +
        "<textarea id='entryeditbody' rows='14'>" + esc(d.body || "") + "</textarea>");
      return;
    }
    const action = file === "done" || file === "fixed" || file === "answered" ? "" : file === "questions"
      ? "<textarea id='answertext' rows='3' placeholder='Your answer — recorded in QUESTIONS.md'></textarea>" +
        "<button type='button' class='btn btn-sm btn-primary' data-act='answer-record' data-arg='" + index + "'>" + icon("chat") + "Record answer</button>" +
        "<button type='button' class='btn btn-sm' data-act='answer' data-arg='" + index + "'>Ask the director instead</button>"
      : "<button type='button' class='btn btn-sm' data-act='mention' data-arg='" + esc(file + ":" + index) + "'>" + icon("chat") + "Ask the director about this</button>" +
        (d.refused || d.waiting ? "<button type='button' class='btn btn-sm btn-primary' data-act='entry-release' data-arg='" + esc(file + ":" + index) + "'>Release this entry</button>" : "") +
        (index > 0 ? "<button type='button' class='btn btn-sm' data-act='entry-top' data-arg='" + esc(file + ":" + index) + "'>Move to top</button>" : "") +
        "<button type='button' class='btn btn-sm' data-act='entry-edit' data-arg='" + esc(file + ":" + index) + "'>Edit this entry</button>" +
        "<button type='button' class='btn btn-sm btn-danger' data-act='entry-cancel' data-arg='" + esc(file + ":" + index) + "'>" + (entryCancelArmed(file + ":" + index) ? "Click again to cancel" : "Cancel this entry") + "</button>";
    // The body is model-written Markdown: renderMarkdown escapes every piece of it.
    paintPanel("entrybody", (action ? "<div class='drawer-actions'>" + action + "</div>" : "") + "<div class='md'>" +
      (d.body ? renderMarkdown(d.body) : "<p class='muted'>No details for this entry.</p>") + "</div>");
  }

  async function refreshDrawer() {
    if (!drawer) return;
    if (drawer.kind === "role") {
      if (lastStatus) renderRoleDrawer(lastStatus);
      await refreshTranscript(false);
    } else {
      await refreshEntry();
    }
  }
  $("scrim").addEventListener("click", closeDrawer);
  $("drawer").addEventListener("click", (ev) => {
    if (clickClosest(ev, "button[data-transcript-prompts]")) {
      toggleTranscriptPrompts();
      return;
    }
    const b = clickClosest(ev, "button.rowaction");
    if (b) rowAction(b.dataset.action, b.dataset.role, b.dataset.for === undefined ? undefined : Number(b.dataset.for));
  });
`;
