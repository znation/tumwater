// vocabulary: plain
/** The dashboard's detail drawer, browser-side: a sheet on the right that opens over the page
 * without losing it. For a loop it shows the state, the loop's controls (prompt, wake now or later,
 * pause/resume, abort), what it is working on, its last result, the metrics the fleet table
 * leaves out (tokens, context, cost, timings), its recent ticks (/api/history filtered to the
 * loop), and its live transcript (/api/transcript, re-fetched on the 1 s poll and kept pinned
 * to the bottom while the reader is there). For a backlog entry it shows the entry in full
 * (/api/backlog), rendered as Markdown, with a shortcut into the composer — answering a
 * question, or asking the director about a plan or bug — and, for a plan or bug, a two-click
 * Cancel that removes the entry (/api/backlog-cancel). Esc, the close button, or clicking the
 * same row again closes it. Spliced into gui-client.ts's script, reaching its helpers through
 * that concatenation. */
export const GUI_CLIENT_DRAWER_JS = String.raw`  let drawer = null; // { kind: "loop", role } | { kind: "entry", file, index } while open
  let drawerTicks = null; // the open loop's recent history rows (null until fetched)
  let drawerTicksAt = 0;
  let drawerChange = null; // the open loop's unlanded change: { role, state: "loading"|"ok"|"error", view, message }
  let drawerRole = null; // the open loop's /api/role payload: { role, state: "loading"|"ok"|"error", view, message }
  const openEntryKey = () => (drawer && drawer.kind === "entry" ? drawer.file + ":" + drawer.index : null);
  const openLoopRole = () => (drawer && drawer.kind === "loop" ? drawer.role : null); // vocabulary-ok: the drawer kind stays "loop"
  // One key/value row builder shared by the loop-metrics table (renderLoopDrawer) and the
  // Configuration section (drawerConfigHtml): identical markup, formerly copy-pasted into two
  // local consts (kv and row) so the row shape could drift between the two sections.
  const kvRow = (k, v, title) => "<div><dt>" + esc(k) + "</dt><dd title='" + esc(title || v) + "'>" + esc(v) + "</dd></div>";

  function showDrawer(bodyHtml) {
    for (const id of ["drawerhead", "draweractions", "drawermeta", "drawerrole", "transcript", "entrybody"]) delete lastPaint[id];
    $("drawerhead").innerHTML = "";
    $("drawerbody").innerHTML = bodyHtml;
    $("drawer").hidden = false;
    $("scrim").hidden = false;
  }
  function closeDrawer() {
    const wasLoop = openLoopRole();
    drawer = null;
    entryEditing = null;
    noteEditing = null;
    disarmNoteClear();
    if (wasLoop && location.hash.startsWith("#loop/")) history.replaceState(null, "", "#" + activeView); // vocabulary-ok: the #loop/ hash stays
    drawerTicks = null;
    drawerChange = null;
    drawerRole = null;
    $("drawer").hidden = true;
    $("scrim").hidden = true;
    $("drawerhead").innerHTML = "";
    $("drawerbody").innerHTML = "";
    for (const id of ["drawerhead", "draweractions", "drawermeta", "drawerrole", "transcript", "entrybody"]) delete lastPaint[id];
    if (lastStatus) renderFleet(lastStatus); // drop the row highlight
  }

  function openLoop(role) {
    drawer = { kind: "loop", role }; // vocabulary-ok: the drawer kind stays "loop"
    const hash = "#loop/" + encodeURIComponent(role); // vocabulary-ok: the #loop/ hash stays
    if (location.hash !== hash) history.replaceState(null, "", hash);
    drawerTicks = null;
    drawerTicksAt = 0;
    drawerChange = null;
    drawerRole = null;
    showDrawer("<div id='draweractions' class='drawer-actions'></div><div id='drawermeta'></div><div id='drawerrole'></div><section class='transcript-sec'><div class='sec-head'><h3>Live transcript</h3>" +
      "<span class='muted' style='margin-left:auto;font-size:13px'>last 200 lines</span></div>" +
      "<pre id='transcript' class='transcript'><span class='muted'>Loading…</span></pre></section>");
    if (lastStatus) {
      renderLoopDrawer(lastStatus);
      renderFleet(lastStatus);
    }
    loadLoopTicks(true);
    loadDrawerChange(role);
    loadDrawerRole(role);
    refreshTranscript(true);
  }
  function toggleLoop(role) {
    if (openLoopRole() === role) closeDrawer();
    else openLoop(role);
  }
  function openEntry(file, index) {
    drawer = { kind: "entry", file, index: Number(index) };
    entryEditing = null;
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
      paintPanel("drawerhead", "<div class='kicker'>Role</div><h2 id='drawertitle' class='mono'>" + esc(roleLabel(role)) +
        "</h2><span class='muted'>This role is no longer part of the team.</span>");
      paintPanel("draweractions", "");
      paintPanel("drawermeta", drawerChangeSection());
      paintPanel("drawerrole", drawerRoleSection());
      return;
    }
    const info = phaseInfo(l.phase);
    const paused = (d.pausedRoles || []).includes(l.role);
    const detail = phaseDetail(l, info, d);
    paintPanel("drawerhead", "<div class='kicker'>Role" + (l.custom ? " · user-defined" : "") + "</div>" +
      "<h2 id='drawertitle' class='mono'>" + esc(roleLabel(l.role)) + "</h2><div class='chips'>" + pill(info) +
      (detail ? "<span class='muted'>" + esc(detail) + "</span>" : "") + "</div>");

    const btn = (action, ic, label, cls) => "<button type='button' class='btn btn-sm rowaction" + (cls ? " " + cls : "") + "' data-action='" + action +
      "' data-role='" + esc(l.role) + "'>" + icon(ic) + esc(label) + "</button>";
    let actions = btn("prompt", "chat", "Message this role");
    // The running set (info.live), not the permit-holder inFlight: the exempt running director
    // has an abortable tick without holding a maxConcurrent permit (BUGS.md 2026-10-06).
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

    const working = info.live || info.key === "vetted"; // vocabulary-ok: the persisted phase key
    const now = working
      ? "<section><div class='sec-head'><h3>" + (info.key === "working" ? "Working on" : info.key === "reviewing" ? "Under review" : "Merging") +
        "</h3></div><div class='note'>" + esc(l.currentWork || landingSummary(d, l.role) || (info.key === "working" ? "Starting up…" : "Waiting for its first words…")) + "</div></section>"
      : "";
    const r = l.lastResult ? resultInfo(l.lastResult) : null;
    const why = resultWhy(l);
    const last = "<section><div class='sec-head'><h3>Last result</h3>" + (l.lastTickEndedAt ? "<span class='muted' style='font-size:13px'>" + esc(fmtAgo(l.lastTickEndedAt)) + "</span>" : "") +
      "</div><div class='note'>" + (r ? "<span class='res t-" + r.tone + "'>" + esc(r.label) + "</span>" + (why ? " — " + esc(why) : "") : "<span class='muted'>No completed runs yet.</span>") + "</div></section>";
    const next = fmtNextRun(l, d.running);
    // fmtNextRun's shapes: "-", "now" (possibly with a " ×N" yield suffix), and a bare or
    // "backoff "-prefixed countdown. A backoff countdown keeps the label but as a suffix;
    // a suffixed "now" passes through as-is — it is due now, not a future time.
    const nextNote = next === "-" ? "—"
      : next === "now" || next.startsWith("now ") ? next
      : next.startsWith("sleeping ") ? "in " + next.slice(9) + " (sleeping)"
      : "in " + next;
    const tickWord = info.live ? "this run" : "last run";
    const stats = "<dl class='kv'>" + kvRow("Commits", String(l.commits)) + kvRow("Runs", String(l.ticks)) +
      kvRow("Tokens, " + tickWord, fmtTokens(l.generated)) + kvRow("Peak context, " + tickWord, fmtTokens(l.peakCtx)) +
      kvRow("Spent today", fmtUsd(l.todayUsd)) + kvRow("Spent in total", fmtUsd(l.costUsd)) +
      kvRow("Last run ended", l.lastTickEndedAt ? fmtAgo(l.lastTickEndedAt) : "never", fmtLastTick(l.lastTickEndedAt)) +
      kvRow("Last merged", l.lastLandedAt ? fmtAgo(l.lastLandedAt) : "never") +
      kvRow("Next run", nextNote) + "</dl>";
    const ticks = drawerTicks === null
      ? "<p class='muted'>Loading…</p>"
      : drawerTicks.length
        ? "<ul class='ticks'>" + drawerTicks.map((t) => { // vocabulary-ok: the ticks class stays
          const res = resultInfo(t.result);
          return "<li><span class='when' title='" + esc(t.time) + "'>#" + esc(t.tick) + " · " + esc(fmtAgo(t.ts)) + "</span>" +
            "<span class='clamp1' title='" + esc(t.detail) + "'><span class='res t-" + res.tone + "'>" + esc(res.label) + "</span> " + esc(t.detail) + "</span>" +
            "<span class='when'>" + (t.durationMs === null ? "" : esc(fmtSpan(Number(t.durationMs)))) + "</span></li>";
        }).join("") + "</ul>"
        : "<p class='muted'>No completed runs in the log yet.</p>";
    paintPanel("draweractions", actions);
    paintPanel("drawermeta", now + last + stats +
      "<section><div class='sec-head'><h3>Recent runs</h3></div>" + ticks + "</section>" + drawerChangeSection());
    // The notebook/prompt live in their own panel, outside drawermeta: the poll rewrites
    // drawermeta whenever its countdown or tick-age text changes, and an innerHTML rewrite
    // would collapse an opened Next tick prompt. This panel's markup is stable while its
    // payload is unchanged, so paintPanel leaves it (and the disclosure's open state) alone.
    paintPanel("drawerrole", drawerRoleSection());
  }

  // The open loop's unlanded change, as /api/diff?role serves it: the full patch the CLI's
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
    if (view.diff) html += "<pre class='mono diff'>" + esc(String(view.diff).replace(/\n+$/, "")) + "</pre>";
    if (dirty.length) {
      html += "<p class='note'>Uncommitted: " + esc(dirty.join(", ")) + "</p>";
      if (view.uncommittedDiff) html += "<pre class='mono diff'>" + esc(String(view.uncommittedDiff).replace(/\n+$/, "")) + "</pre>";
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
  // caller's state cell. A stale answer (the drawer moved to another loop) is dropped;
  // later status polls repaint from the stored view. The assign callback writes that cell
  // (drawerChange / drawerRole), so the loading/ok/error contract lives here once for both
  // the pending-change and notebook sections.
  async function loadDrawerSection(role, url, fallbackMessage, assign) {
    if (!role) return;
    assign({ role, state: "loading" });
    try {
      const d = await getJson(url + encodeURIComponent(role), pollSignal());
      if (openLoopRole() !== role) return;
      assign({ role, state: "ok", view: d });
    } catch (err) {
      if (openLoopRole() !== role) return;
      assign({ role, state: "error", message: err && err.message ? err.message : fallbackMessage });
    }
    if (lastStatus) renderLoopDrawer(lastStatus);
  }
  // The open loop's unlanded change, as /api/diff?role serves it.
  function loadDrawerChange(role) {
    return loadDrawerSection(role, "/api/diff?role=", "Pending change unavailable", (v) => { drawerChange = v; });
  }

  // The open loop's notebook and next-tick prompt, as /api/role serves them (rolePayload):
  // the same note and assembled prompt the CLI's role command shows, so the operator can
  // diagnose a loop from the page. The note renders in a <pre>; the next prompt sits in a
  // <details> so it does not push the rest of the drawer down. Both empty cases say so in a
  // muted line. It paints into its own #drawerrole panel, not #drawermeta: the poll rewrites
  // drawermeta whenever its countdown or tick-age text changes, and an innerHTML rewrite would
  // collapse an opened <details>. This panel's string is stable while the payload is unchanged,
  // so paintPanel skips it and the disclosure stays open.
  function drawerRoleSection() {
    const r = drawerRole;
    let body;
    if (!r || r.state === "loading") body = "<p class='muted'>Loading…</p>";
    else if (r.state === "error") body = "<p class='muted'>" + esc(r.message || "Notes and prompt unavailable") + "</p>";
    else {
      const view = r.view && typeof r.view === "object" ? r.view : {};
      const note = typeof view.note === "string" && view.note.trim() !== "" ? view.note : null;
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
        // The loop's recent tick outcomes (rolePayload's recentOutcomes, read from the event
        // log), rendered like the Recent ticks list above: each with its relative age, result
        // label, summary, and duration. Mirrors the Recent tick outcomes section of
        // tumwater role <id> — no backticks allowed here (this whole script is one big
        // String.raw template), so the page and the CLI read one loop's outcomes identically.
        (outcomes.length ? "<section><div class='sec-head'><h3>Recent outcomes" +
          "<span class='muted' style='font-size:13px'>· " + outcomes.length + "</span></h3></div>" +
          "<ul class='ticks'>" + outcomes.map((o) => { // vocabulary-ok: the ticks class stays
            const info = resultInfo(o.result);
            const detail = typeof o.summary === "string" && o.summary.trim() !== "" ? o.summary : "";
            return "<li><span class='when' title='" + esc(new Date(Number(o.ts)).toLocaleString()) + "'>" + esc(fmtAgo(Number(o.ts))) + "</span>" +
              "<span class='clamp1' title='" + esc(detail) + "'><span class='res t-" + info.tone + "'>" + esc(info.label) + "</span>" + (detail ? " " + esc(detail) : "") + "</span>" +
              "<span class='when'>" + (o.durationMs == null ? "" : esc(fmtSpan(Number(o.durationMs)))) + "</span></li>";
          }).join("") + "</ul></section>" : "") +
        drawerConfigHtml(view);
    }
    return "<section>" + body + "</section>";
  }
  // A Configuration section built from the same /api/role payload the CLI's tumwater role
  // <id> renders (rolePayload), so the drawer's and the terminal's rows read one document and
  // cannot drift: what the loop RUNS ON (model/tier, provider cap, image reading, the
  // fallback pairs, billing, min tick interval) and CARRIES (queued prompts, the instructions
  // override, find text). Each row is guarded by a present/own check so an absent field
  // renders no row — a cap-less fleet shows no Provider row, no fallback shows no fallback
  // rows, and a notes-only payload adds an empty (omitted) section. Labels and wording mirror
  // role-render.ts's family; no backticks allowed here (this whole script is one big
  // String.raw template).
  function drawerConfigHtml(view) {
    const pair = (p, m) => [p, m].filter(Boolean).join("/");
    const singleLine = (s) => String(s).replace(/\s+/g, " ").trim();
    // A verbatim value's single-line clamped rendering (80 chars + ellipsis) with the full
    // text riding the title tooltip — the same clamp+tooltip idiom the tick summaries use.
    const clamp = (t) => { const one = singleLine(t); return one.length > 80 ? one.slice(0, 80) + "…" : one; };
    const rows = [];
    // A role that runs on pi's own saved default carries no provider/model but a piDefault
    // selector (rolePayload's resolvedModelFields leaves both undefined), and the CLI's
    // Model line names that default (<agent> default (<selector>), agentDefault). Mirror
    // that branch so the drawer names the model a default pi fleet actually runs on.
    const defaultLine = typeof view.piDefault === "string"
      ? (view.agent && view.agent !== "pi" ? view.agent : "pi") + " default (" + view.piDefault + ")"
      : "";
    const modelLine = defaultLine !== "" ? defaultLine : pair(view.provider, view.model);
    if (modelLine !== "" || view.modelTier !== undefined) {
      rows.push(kvRow("Model", (modelLine !== "" ? modelLine + " " : "") + (view.modelTier !== undefined ? "(" + view.modelTier + " tier)" : "").trim()));
    }
    if (view.providerKey !== undefined && view.providerCap !== undefined) {
      rows.push(kvRow("Provider", view.providerKey + " (cap " + view.providerCap + ")"));
    }
    if (view.imageInput !== undefined) {
      const images = view.imageInput === true ? "yes"
        : view.imageInput === false ? (view.imageReroute ? "no — reruns on " + view.imageReroute : "no")
        : "unknown";
      rows.push(kvRow("Images", images));
    }
    if (view.modelFallback && typeof view.modelFallback === "object" && view.modelFallback.model !== undefined) {
      const fb = view.modelFallback;
      const when = typeof fb.since === "number" ? " since " + fmtAgo(fb.since) : "";
      rows.push(kvRow("Model fallback", pair(fb.provider, fb.model) + " — on fallback" + when + " (primary failing: " + (fb.reason ?? "") + ")"));
    }
    if (view.fallback && typeof view.fallback === "object" && view.fallback.model !== undefined) {
      rows.push(kvRow("Budget fallback", pair(view.fallback.provider, view.fallback.model) + " (" + (view.fallbackFree ? "free" : "priced") + ")"));
    }
    if (view.billing !== undefined) {
      const window = view.billing === "subscription" && view.billingWindow ? " (" + view.billingWindow + " window)" : "";
      rows.push(kvRow("Billing", (view.billing === "api" ? "API" : view.billing) + window));
    }
    if (typeof view.minTickIntervalSeconds === "number") rows.push(kvRow("Min run interval", view.minTickIntervalSeconds + "s"));
    // The windows governing the loop, worded like role-render.ts's Quiet hours line; the end time
    // mirrors quietWindowEnd (browser code cannot import it).
    if (Array.isArray(view.quietHours)) view.quietHours.forEach(function (w) {
      if (!w || typeof w.window !== "string") return;
      const end = String(w.window).split("-")[1];
      const state = w.inWindow ? "holding now — quiet until " + (end ? end.trim() : "") : "not holding now";
      rows.push(kvRow("Quiet hours", w.window + " (" + (w.scope === "role" ? "own window" : "team window") + "; " + state + ")"));
    });
    if (typeof view.inboxCount === "number") rows.push(kvRow("Queued prompts", String(view.inboxCount)));
    // The loop's own spend over its retained event window (rolePayload's usage, summed from the
    // same tick_end events recentOutcomes reads): how much the loop burned on tokens and cost,
    // with a notional suffix only when a claude-subscription seam burned non-zero notional spend
    // — mirroring role-render.ts's Spend line, so the drawer and tumwater role <id> read one
    // loop's spend identically. Each numeric field is coerced (foreign shapes read as 0) and an
    // all-zero usage is absent on the payload, so this row never renders for a never-costly loop.
    if (view.usage && typeof view.usage === "object") {
      const u = view.usage;
      const real = Number(u.costUsd) || 0;
      const tokens = Number(u.tokens) || 0;
      const notional = Number(u.notionalCostUsd) || 0;
      let spend = fmtUsd(real) + " · " + fmtTokens(tokens) + " tokens";
      if (notional !== 0) spend += " · " + fmtUsd(notional) + " notional";
      rows.push(kvRow("Spend", spend));
    }
    // The per-role daily cap (rolePayload's dailyCap), worded like role-render.ts's Daily cap line.
    if (view.dailyCap && typeof view.dailyCap === "object") {
      const dc = view.dailyCap;
      let cap = fmtUsd(Number(dc.spentUsd) || 0) + " of " + fmtUsd(Number(dc.capUsd) || 0) + " spent today (" + (dc.over ? "holding now — no new runs until local midnight" : "not holding") + ")";
      if (Array.isArray(dc.roleIds) && dc.roleIds.length > 1) cap += " · shared by " + dc.roleIds.join(", ");
      rows.push(kvRow("Daily cap", cap));
    }
    if (typeof view.instructions === "string" && view.instructions.trim() !== "") rows.push(kvRow("Instructions override", clamp(view.instructions), view.instructions));
    if (typeof view.find === "string" && view.find.trim() !== "") rows.push(kvRow("Find text", clamp(view.find), view.find));
    return rows.length ? "<section><div class='sec-head'><h3>Configuration</h3></div><dl class='kv'>" + rows.join("") + "</dl></section>" : "";
  }
  // An open notebook edit holds the draft's starting text, not the live payload, so a poll
  // refetch neither wipes the textarea nor changes the painted panel string. Clear waits for a
  // confirming click like entry cancel: the first click arms it for 5 s, the second posts.
  let noteEditing = null; // { role, text }
  function repaintDrawerRole() { if (lastStatus) renderLoopDrawer(lastStatus); }
  // The notebook clear and the backlog entry cancel each build a two-click confirm slot from
  // the shared confirmSlot factory (defined in the loops splice, an earlier one), so the arm,
  // guard, and disarm logic lives once.
  const noteClear = confirmSlot(repaintDrawerRole);
  const noteClearArmed = (role) => noteClear.armed(role);
  function armNoteClear(role) { noteClear.arm(role); }
  function disarmNoteClear() { noteClear.disarm(); }
  function startNoteEdit(role, text) { noteEditing = { role, text }; disarmNoteClear(); repaintDrawerRole(); }
  function stopNoteEdit() { noteEditing = null; repaintDrawerRole(); }
  // The notebook fetch shares loadDrawerSection; closing the drawer clears drawerRole, so
  // reopening refetches.
  function loadDrawerRole(role) {
    return loadDrawerSection(role, "/api/role?role=", "Notes and prompt unavailable", (v) => { drawerRole = v; });
  }

  async function loadLoopTicks(force) {
    const role = openLoopRole();
    if (!role || (!force && Date.now() - drawerTicksAt < 5000)) return;
    drawerTicksAt = Date.now();
    try {
      const d = await getJson("/api/history?n=8&role=" + encodeURIComponent(role), pollSignal());
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
      d = await getJson("/api/transcript?role=" + encodeURIComponent(role) + "&n=200", pollSignal());
    } catch {
      return; // keep the previous content on a failed poll
    }
    const pre = $("transcript");
    if (openLoopRole() !== role || !pre) return;
    const lines = Array.isArray(d.lines) ? d.lines : [];
    const html = lines.length ? transcriptHtml(lines) : "<span class='muted'>No transcript yet — it fills in once this role's next run starts.</span>";
    // Stay pinned to the newest line while the reader is at the bottom; leave them be if they
    // scrolled up to read.
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 12;
    if (paintPanel("transcript", html) && (initial || atBottom)) pre.scrollTop = pre.scrollHeight;
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
  const ENTRY_KINDS = { plans: "Planned feature", bugs: "Open bug", questions: "Open question" };
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
    const action = file === "questions"
      ? "<textarea id='answertext' rows='3' placeholder='Your answer — recorded in QUESTIONS.md'></textarea>" +
        "<button type='button' class='btn btn-sm btn-primary' data-act='answer-record' data-arg='" + index + "'>" + icon("chat") + "Record answer</button>" +
        "<button type='button' class='btn btn-sm' data-act='answer' data-arg='" + index + "'>Ask the director instead</button>"
      : "<button type='button' class='btn btn-sm' data-act='mention' data-arg='" + esc(file + ":" + index) + "'>" + icon("chat") + "Ask the director about this</button>" +
        "<button type='button' class='btn btn-sm' data-act='entry-edit' data-arg='" + esc(file + ":" + index) + "'>Edit this entry</button>" +
        "<button type='button' class='btn btn-sm btn-danger' data-act='entry-cancel' data-arg='" + esc(file + ":" + index) + "'>" + (entryCancelArmed(file + ":" + index) ? "Click again to cancel" : "Cancel this entry") + "</button>";
    // The body is model-written Markdown: renderMarkdown escapes every piece of it.
    paintPanel("entrybody", "<div class='drawer-actions'>" + action + "</div><div class='md'>" +
      (d.body ? renderMarkdown(d.body) : "<p class='muted'>No details for this entry.</p>") + "</div>");
  }

  async function refreshDrawer() {
    if (!drawer) return;
    if (drawer.kind === "loop") { // vocabulary-ok: the drawer kind stays "loop"
      if (lastStatus) renderLoopDrawer(lastStatus);
      await refreshTranscript(false);
    } else {
      await refreshEntry();
    }
  }
  $("scrim").addEventListener("click", closeDrawer);
  $("drawer").addEventListener("click", (ev) => {
    const b = clickClosest(ev, "button.rowaction");
    if (b) rowAction(b.dataset.action, b.dataset.role, b.dataset.for === undefined ? undefined : Number(b.dataset.for));
  });
`;
