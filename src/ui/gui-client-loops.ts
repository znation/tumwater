/** The dashboard's loops table, browser-side — the fleet's rows grouped by what the loops are
 * doing (working, landing, needs-attention, paused, idle), each with its status pill, current
 * work, spend, and per-row operator controls (prompt, wake, pause/resume, and the two-click
 * abort), patched cell by cell so a ticking row keeps focus and hover. renderLoops repaints it
 * from each /api/status poll; renderFleet (gui-client-fleet.ts) calls it. Spliced into
 * gui-client.ts's script, reaching its helpers (esc, icon, phaseInfo, sortLoops, postAction,
 * setTarget, focusComposer, rerender, …) through that concatenation. */
export const GUI_CLIENT_LOOPS_JS = String.raw`
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
    await postAction(path, body, (d) => {
      let msg = d && typeof d.message === "string" ? d.message : role + ": done";
      if (action === "pause" || action === "resume") {
        msg = role + (d && d.changed
          ? (action === "pause" ? " paused — it starts no new ticks" : " resumed")
          : (action === "pause" ? " was already paused" : " was not paused"));
      }
      return msg;
    });
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
  $("wakeall").addEventListener("click", () =>
    postAction("/api/wake", {}, (d) => (d && typeof d.message === "string" ? d.message : "every loop woken")));
`;
