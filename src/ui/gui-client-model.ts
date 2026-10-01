/** The dashboard's view model, browser-side — the pure layer between the status payload and
 * what the page shows, with no DOM of its own: each loop's phase pill (label, tone, live
 * detail), its last result in words with the tone of its outcome, the loop sort order and
 * rank groups, the alerts list with the page's own offline entry, the activity feed's
 * kind/tone classification, the backlog title's trailing "(planned …)" metadata, and the
 * queued prompts in execution order. It is the browser twin of the rules status-model.ts
 * computes server-side; test/gui-client.test.ts pins the copies against each other. Spliced
 * into gui-client.ts's script, reaching its helpers (esc, isActivePhase) through that
 * concatenation. */
export const GUI_CLIENT_MODEL_JS = String.raw`  // view-model:start
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
    build: "refresh", questions: "question", paused: "pause", quiet: "pause", stopped: "info" };
  // Alerts that ask something of the operator (the page title counts them); blue and gray ones
  // are information.
  const needsYou = (alerts) => alerts.filter((a) => a.tone === "red" || a.tone === "amber" || a.tone === "indigo").length;
  // An activity item's kind — its icon and tone, and whether the Notable filter keeps it.
  const ROUTINE_EVENTS = ["tick_start", "wake", "tick_deferred", "review_start", "review_verdict", "land_queued", "landed", "resume", "counters_reset"];
  const PROBLEM_EVENTS = ["land_failed", "review_rejected", "review_failed", "restart_blocked", "restart_refused", "budget_warning", "budget_paused", "role_cap_paused", "supervisor_exit", "warning"];
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
