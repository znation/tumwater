/** The dashboard's roles table, browser-side — the team's rows grouped by what the roles are
 * doing (working, merge, needs-attention, paused, idle), each with its status pill, current
 * work, spend, and per-row operator controls (prompt, wake, pause/resume, and the two-click
 * abort), patched cell by cell so a ticking row keeps focus and hover. renderRoles repaints it
 * from each /api/status poll; renderTeam (gui-client-team.ts) calls it. Spliced into
 * gui-client.ts's script, reaching its helpers (esc, icon, phaseInfo, sortRoles, postAction,
 * setTarget, focusComposer, rerender, …) through that concatenation. */
export const GUI_CLIENT_ROLES_JS = String.raw`
  // ---- roles ----
  // row-actions:start
  // A two-click confirm, the confirmSlot shape the drawer's note-clear/entry-cancel also use:
  // the first click stores a { id, title?, until } record and repaints; armed() fires a second
  // click inside the 5 s window; a 5100 ms auto-disarm drops an unconfirmed record past its
  // expiry. Defined here (the earliest consumer splice) so the roles' abort in this file, an
  // earlier splice, and the drawer's notes-clear/entry-cancel in a later splice all share
  // one arm, guard, and disarm instead of three copies.
  function confirmSlot(repaint) {
    let confirm = null; // { id, title?, until }
    return {
      armed: (id, title) => Boolean(confirm && confirm.id === id && (title === undefined || confirm.title === title) && confirm.until > Date.now()),
      disarm: () => { confirm = null; },
      arm(id, title) {
        confirm = { id, title, until: Date.now() + 5000 };
        repaint();
        setTimeout(() => { if (confirm && confirm.id === id && confirm.until <= Date.now()) { confirm = null; repaint(); } }, 5100);
      },
    };
  }
  // The abort slot: keyed by role, so arming is per role — a second click on the same role's
  // abort fires, while a first click on another role's abort re-arms instead of posting.
  const confirmAbortSlot = confirmSlot(rerender);
  const abortConfirming = (role) => confirmAbortSlot.armed(role);
  // The abort-all slot: keyed "all" (no role id), so a first click on any other action's
  // button disarms a pending abort-all — the same per-key arming as the per-role slot above.
  const confirmAbortAllSlot = confirmSlot(rerender);
  const abortAllConfirming = () => confirmAbortAllSlot.armed("all");
  // The Roles card header's Abort all button (inserted into the card head at script load):
  // one click arms it, a second within 5 s hits POST /api/abort-all. Danger tone; the title
  // names the confirm-again contract, like the per-row stop's.
  const rolesAbortAllButton = () => "<button type='button' class='btn btn-sm btn-danger' id='abortall' data-action='abort-all' title='Click again to stop every running role&#39;s run'>" + icon("stop") + "<span>Abort all</span></button>";
  // The drawer's Disable slot: a second click on the same role's Disable fires, a first click
  // on another role's re-arms — the same per-role keying as the abort slot it sits beside.
  const confirmDisableSlot = confirmSlot(rerender);
  const disableConfirming = (role) => confirmDisableSlot.armed(role);
  let roleChooser = null; // { role, action, until }: the one open duration chooser ("pause-for" or "wake-in")
  const roleChooserOpen = (role, action) => Boolean(roleChooser && roleChooser.role === role && roleChooser.action === action && roleChooser.until > Date.now());
  const rolePauseMenuOpen = (role) => roleChooserOpen(role, "pause-for");
  const roleWakeMenuOpen = (role) => roleChooserOpen(role, "wake-in");
  const ROLE_PAUSE_CHOICES = [[1800, "30m"], [3600, "1h"], [7200, "2h"], [28800, "8h"], [0, "standing"]];
  const ROLE_WAKE_CHOICES = ROLE_PAUSE_CHOICES.filter((c) => c[0] > 0); // a wake has no "standing" choice
  // A role's controls, from its table row or its drawer: prompt (aims the composer at the role),
  // wake, pause/resume (the target state is always explicit), and abort, which discards the
  // run's work — the first click arms it, a second within 5 s fires it.
  async function rowAction(action, role, forSeconds) {
    if (action === "abort-all") {
      if (!abortAllConfirming()) {
        // First click arms it; any other click (handled below) disarms it.
        confirmAbortAllSlot.arm("all");
        confirmAbortSlot.disarm();
        confirmDisableSlot.disarm();
        roleChooser = null;
        return;
      }
      confirmAbortAllSlot.disarm();
      await postAction("/api/abort-all", {}, (d) =>
        (d && typeof d.message === "string" ? d.message : "abort requested for every running role"));
      return;
    }
    confirmAbortAllSlot.disarm();
    if (action === "prompt") {
      setTarget(role);
      focusComposer();
      return;
    }
    if (action === "abort" && !abortConfirming(role)) {
      confirmAbortSlot.arm(role);
      return;
    }
    if (action === "disable" && !disableConfirming(role)) {
      confirmDisableSlot.arm(role);
      return;
    }
    if ((action === "pause-for" || action === "wake-in") && forSeconds === undefined) {
      roleChooser = { role, action, until: Date.now() + 10000 };
      rerender();
      return;
    }
    confirmAbortSlot.disarm();
    confirmDisableSlot.disarm();
    roleChooser = null;
    const pausing = action === "pause" || action === "pause-for";
    const timed = action === "pause-for" && forSeconds > 0;
    const path = action === "abort" ? "/api/abort" : action === "disable" ? "/api/role-disable" : action === "reset-counters" ? "/api/reset-counters" : action === "wake-cancel" ? "/api/wake-cancel" : pausing || action === "resume" ? "/api/pause-role" : "/api/wake";
    const wakeIn = action === "wake-in";
    const body = pausing || action === "resume" ? { role, paused: pausing, ...(timed ? { forSeconds } : {}) } : wakeIn ? { role, inSeconds: forSeconds } : { role };
    await postAction(path, body, (d) => {
      if (action === "disable") {
        // The role drops out of d.roles on the next poll, so without closing it the open
        // drawer would fall to its "no longer part of the team" head.
        closeDrawer();
        return d && typeof d.message === "string" ? d.message : role + ": done";
      }
      let msg = d && typeof d.message === "string" ? d.message : action === "wake-cancel" ? role + ": scheduled wake cancelled" : role + ": done";
      if (wakeIn && !(d && typeof d.message === "string")) msg = role + " wakes in " + humanSeconds(forSeconds);
      else if (timed) msg = role + " paused for " + humanSeconds(forSeconds);
      else if (pausing || action === "resume") {
        msg = role + (d && d.changed
          ? (pausing ? " paused — it starts no new runs" : " resumed")
          : (pausing ? " was already paused" : " was not paused"));
      }
      return msg;
    });
  }
  // row-actions:end
  // roles-table:start
  // The status pill's second line: what the phase label carried, or when an idle role runs next.
  // The future operator wakes that name this role (or its base role), earliest first. Reads the
  // payload's scheduledWakes, falling back to the lone scheduledWake of an older server.
  function scheduledWakesFor(l, d) {
    const all = d.scheduledWakes || (d.scheduledWake ? [d.scheduledWake] : []);
    return all.filter((w) => w.atMs > Date.now() && (w.roles.includes(l.role) || (l.instanceOf && w.roles.includes(l.instanceOf))))
      .sort((a, b) => a.atMs - b.atMs);
  }
  function scheduledWakeFor(l, d) {
    return scheduledWakesFor(l, d)[0] || null;
  }
  function phaseDetail(l, info, d) {
    const detail = phaseDetailBase(l, info, d);
    const w = scheduledWakeFor(l, d);
    if (!w) return detail;
    return (detail ? detail + " · " : "") + "your wake in " + humanSeconds(secsUntil(w.atMs, Date.now()));
  }
  function phaseDetailBase(l, info, d) {
    const raw = fmtNextRun(l, d.running);
    const slowed = / ×(\d+)$/.exec(raw);
    const next = slowed ? raw.slice(0, slowed.index) : raw;
    const backoff = next.startsWith("sleeping ") ? "sleeping — next check in " + next.slice(9) : "";
    // A yield-scaled clock: the role's recent runs merged nothing, so it runs less often.
    const note = slowed ? " · slowed ×" + slowed[1] + ", nothing merged lately" : "";
    // The consecutive cut-off and no-change streaks (status-payload cutOffStreak/noChangeStreak,
    // mirrored from status-model rolePhase's suffix): how many completed runs in a row hit the
    // context ceiling or returned nothing to do. Shown only on a resting idle cell
    // (sleeping/queued/idle/deferred) — never on live work, a pause, a failure, or main-red,
    // which the status label likewise leaves bare. A cut-off run is also a no_change, so the
    // cut-off streak wins when both read 2+ — it names the costly cause the plain suffix would
    // bury. Observational only, like the phase text.
    const cutOff = ["sleeping", "queued", "idle", "deferred"].includes(info.key) && (l.cutOffStreak || 0) >= 2
      ? " · cut off ×" + l.cutOffStreak : "";
    const noChange = !cutOff && ["sleeping", "queued", "idle", "deferred"].includes(info.key) && (l.noChangeStreak || 0) >= 2
      ? " · no change ×" + l.noChangeStreak : "";
    const streak = cutOff || noChange;
    if (info.key === "sleeping") return (backoff || (next === "-" ? "" : next === "now" ? "wakes now" : "wakes in " + next)) + note + streak;
    if (info.key === "queued") return (backoff || info.detail) + note + streak;
    if (info.key === "paused" && d.pausedRolesUntil && !d.paused && (d.pausedLoops || []).includes(l.role)) return info.detail + " · resumes in " + humanSeconds(secsUntil(d.pausedRolesUntil, Date.now())); // retired-name-ok: serialized /api key
    return info.detail + streak;
  }
  function roleCells(l, d) {
    const info = phaseInfo(l.phase);
    const paused = (d.pausedLoops || []).includes(l.role); // retired-name-ok: serialized /api key
    const queued = (d.roleInbox || {})[l.role] || 0;
    const detail = phaseDetail(l, info, d);
    const stalled = info.live && STALL.test(l.phase);
    const name = "<div class='role-name'><button type='button' class='linkish role' data-open='" + esc(l.role) + "' title='Open " + esc(roleLabel(l.role)) + "'>" + esc(roleLabel(l.role)) + "</button>" +
      (l.custom ? "<span class='tag' title='A custom role from tumwater.json'>custom</span>" : "") +
      (l.modelTier ? "<span class='tag' title='The model tier this role resolves at'>" + esc(l.modelTier) + "</span>" : "") +
      (queued ? "<span class='tag t-indigo' title='" + esc(plural(queued, "message") + " in this role's inbox") + "'>" + icon("chat") + queued + "</span>" : "") +
      "</div><div class='sub'>" + esc(plural(l.commits, "commit") + " · " + plural(l.runs, "run") + " · merged " + (l.lastMergedAt ? fmtAgo(l.lastMergedAt) : "never")) + (l.model ? " · " + esc(l.model) : "") +
      (l.modelFromPi ? " <span class='tag' title='pi&#39;s own default model, from its settings.json: tumwater.json names no model'>(pi default)</span>" : "") + "</div>";
    const status = pill(info) + (detail ? "<div class='sub" + (stalled ? " t-red" : "") + "' title='" + esc(l.phase) + "'>" + esc(detail) + "</div>" : "");
    let activity;
    if (info.live || info.key === "vetted") { // vocabulary-ok: internal phase key
      // Parallel work instances, part 6/7: while idle or merge, show the entry the instance
      // claimed before the merge summary placeholder.
      const text = l.currentWork || l.claim || mergeSummary(d, l.role);
      const pending = info.key === "working" ? "Starting up…" : info.key === "reviewing" ? "Reviewing the change…" : "Merging the change…";
      activity = text ? "<div class='now clamp2' title='" + esc(text) + "'>" + esc(text) + "</div>" : "<div class='muted'>" + pending + "</div>";
    } else if (l.claim) {
      // An idle instance holding a claim names its entry; the pill detail carries why an
      // idle role with none is idle.
      const text = l.claim;
      activity = "<div class='now clamp2' title='" + esc(text) + "'>" + esc(text) + "</div>";
    } else if (l.lastResult) {
      const r = resultInfo(l.lastResult);
      const why = resultWhy(l);
      activity = "<div class='clamp2' title='" + esc(why || r.label) + "'><span class='res t-" + r.tone + "'>" + esc(r.label) + "</span>" +
        (why ? " <span class='now'>" + esc(why) + "</span>" : "") + "</div><div class='sub'>" + esc(fmtAgo(l.lastRunEndedAt)) + "</div>";
    } else activity = "<div class='muted'>No runs yet</div>";
    const spent = "<div>" + esc(fmtUsd(l.todayUsd)) + "</div><div class='sub'>" + esc(fmtUsd(l.costUsd)) + " total</div>";
    const b = (action, ic, title, cls) => "<button type='button' class='icon-btn rowaction" + (cls ? " " + cls : "") + "' data-action='" + action +
      "' data-role='" + esc(l.role) + "' title='" + esc(title) + "' aria-label='" + esc(title) + "'>" + icon(ic) + "</button>";
    let actions = b("prompt", "chat", "Message " + roleLabel(l.role));
    // The running set (info.live), not the permit-holder inFlight: the exempt running director
    // has an abortable run without holding a maxConcurrent permit (BUGS.md 2026-10-06).
    if (info.live) {
      actions += abortConfirming(l.role)
        ? "<button type='button' class='icon-btn rowaction confirming' data-action='abort' data-role='" + esc(l.role) + "' title='Click again to stop this run'>" + icon("stop") + "Stop?</button>"
        : b("abort", "stop", "Stop " + roleLabel(l.role) + "'s run", "danger");
    } else actions += b("wake", "bolt", "Wake " + roleLabel(l.role) + " now");
    if (paused) actions += b("resume", "play", "Resume " + roleLabel(l.role));
    else if (rolePauseMenuOpen(l.role)) {
      actions += ROLE_PAUSE_CHOICES.map((c) => "<button type='button' class='icon-btn rowaction' data-action='pause-for' data-for='" + c[0] +
        "' data-role='" + esc(l.role) + "' title='Pause " + esc(roleLabel(l.role)) + " " + (c[0] ? "for " + c[1] : "until resumed") + "'>" + esc(c[1]) + "</button>").join("");
    } else actions += b("pause", "pause", "Pause " + roleLabel(l.role)) + b("pause-for", "clock", "Pause " + roleLabel(l.role) + " for a duration");
    return { info, cells: [name, status, activity, spent, "<div class='actions'>" + actions + "</div>"] };
  }
  // roles-table:end
  const ROLE_TDS = ["c-role", "c-status", "c-activity", "c-today num", "c-actions"];
  let roleKeys = "";
  // Rows are patched cell by cell: a working role's elapsed time changes every second, and
  // rewriting only that cell keeps focus and hover on the row's buttons.
  function patchRoles(rows) {
    const tbody = $("rolerows");
    const keys = rows.map((r) => r.key).join("|");
    if (keys !== roleKeys) {
      roleKeys = keys;
      tbody.innerHTML = rows.map((r) => "<tr class='" + r.cls + "'" + (r.role ? " data-role='" + esc(r.role) + "'" : "") + ">" +
        r.cells.map((c, j) => (r.group ? "<td colspan='5'>" : "<td class='" + ROLE_TDS[j] + "'>") + c + "</td>").join("") + "</tr>").join("");
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
  function renderRoles(d) {
    $("rolestable").classList.toggle("free", Boolean(d.budget && d.budget.free));
    const byGroup = ROLE_GROUPS.map(() => []);
    for (const l of sortRoles(d.roles || [])) {
      const rank = roleRank(l.phase);
      byGroup[ROLE_GROUPS.findIndex((g) => g.slice(1).includes(rank))].push(l);
    }
    const selected = openRoleId();
    const rows = [];
    ROLE_GROUPS.forEach((g, gi) => {
      if (!byGroup[gi].length) return;
      rows.push({ key: "g" + gi, cls: "group", group: true, cells: [esc(g[0]) + "<span class='badge'>" + byGroup[gi].length + "</span>"] });
      for (const l of byGroup[gi]) {
        const { info, cells } = roleCells(l, d);
        rows.push({ key: "l:" + l.role, role: l.role, cls: "role-row clickable" + (info.live ? " live" : "") + (selected === l.role ? " selected" : ""), cells });
      }
    });
    if (!rows.length) rows.push({ key: "empty", cls: "group", group: true, cells: ["No roles are enabled in tumwater.json"] });
    patchRoles(rows);
  }
  $("rolerows").addEventListener("click", (ev) => {
    const b = clickClosest(ev, "button.rowaction");
    if (b) { ev.preventDefault(); rowAction(b.dataset.action, b.dataset.role, b.dataset.for === undefined ? undefined : Number(b.dataset.for)); return; }
    const tr = clickClosest(ev, "tr[data-role]");
    if (tr) toggleRole(tr.dataset.role);
  });
  $("resetall").addEventListener("click", () =>
    postAction("/api/reset-counters", {}, (d) => (d && typeof d.message === "string" ? d.message : "counters reset")));
  $("wakeall").addEventListener("click", () =>
    postAction("/api/wake", {}, (d) => (d && typeof d.message === "string" ? d.message : "every role woken")));
  // Insert the Abort all button into the Roles card header beside the card title/refresh
  // control (the same card head that holds Reset counters / Wake later / Wake all), and arm
  // its two-click confirm through the shared rowAction abort-all branch. One insert on load;
  // re-renders leave the header alone.
  (function () {
    const head = $("roles-title") && $("roles-title").parentElement;
    if (!head || document.getElementById("abortall")) return;
    head.insertAdjacentHTML("beforeend", rolesAbortAllButton());
    document.getElementById("abortall").addEventListener("click", (ev) => {
      ev.preventDefault();
      rowAction("abort-all", "all");
    });
  })();
  // wake-later:start
  const WAKE_LATER_CHOICES = [[1800, "In 30 minutes"], [3600, "In 1 hour"], [7200, "In 2 hours"], [28800, "In 8 hours"]];
  function openWakeLaterMenu() {
    openPopover("wakelaterwrap", {
      menu: true,
      role: "menu",
      html: "<div class='menu-title'>Wake every role</div>" +
        WAKE_LATER_CHOICES.map((c) => "<button type='button' class='menu-item' role='menuitem' data-wakein='" + c[0] + "'>" +
          icon("clock") + esc(c[1]) + "</button>").join("") +
        "<button type='button' class='menu-item' role='menuitem' data-wakecancel='1'>" + icon("x") + "Cancel scheduled wakes</button>",
      onClosed: () => {},
    });
  }
  function wakeLater(inSeconds) {
    closeMenus();
    return postAction("/api/wake", { inSeconds }, (d) =>
      d && typeof d.message === "string" ? d.message : "wake scheduled in " + humanSeconds(inSeconds));
  }
  onClick((t, ev) => {
    if (t.closest("#wakelater")) {
      ev.preventDefault();
      if (openMenu && openMenu.root === $("wakelaterwrap")) closeMenus();
      else openWakeLaterMenu();
      return;
    }
    if (t.closest("[data-wakecancel]")) {
      closeMenus();
      postAction("/api/wake-cancel", {}, (d) => (d && typeof d.message === "string" ? d.message : "scheduled wakes cancelled"));
      return;
    }
    const choice = t.closest("[data-wakein]");
    if (choice) wakeLater(Number(choice.dataset.wakein));
  });
  // wake-later:end
`;
