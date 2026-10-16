/** The dashboard's view model, browser-side — the pure layer between the status payload and
 * what the page shows, with no DOM of its own: each loop's phase pill (label, tone, live
 * detail), its last result in words with the tone of its outcome, the loop sort order and
 * rank groups, the alerts list with the page's own offline entry, the activity feed's
 * kind/tone classification, the backlog title's trailing "(planned …)" metadata, and the
 * queued prompts in execution order. It is the browser twin of the rules status-model.ts
 * computes server-side; test/gui-client.test.ts pins the copies against each other. Spliced
 * into gui-client.ts's script, reaching its helpers (esc, isActivePhase) through that
 * concatenation. The stamp-metadata pattern is interpolated from backlog-structure.ts's
 * ENTRY_STAMP_META_SOURCE — String.raw interpolates substitutions normally — so the
 * browser regex cannot drift from the server twin the tests pin it against. */
import { ENTRY_STAMP_META_SOURCE } from "../../backlog/backlog-structure.js";
import { STALL_SOURCE } from "../tick-progress-model.js";
import { PROBLEM_EVENTS, PROBLEM_RESULTS, ROUTINE_BUILD_RESULTS, ROUTINE_EVENTS } from "../tone.js";
import { LOOP_RANK_RULES } from "../status-model.js";

export const GUI_CLIENT_MODEL_JS = String.raw`  // view-model:start
  // How a loop's phase label (status-model.ts loopPhase) reads here: a status word and tone for
  // its pill, whether it is live work, and the detail the label carried after its first word.
  function phaseInfo(phase) {
    // status-model.ts loopPhase appends a " · no change ×N" streak suffix to a resting idle
    // cell's label. Strip it so the exact/startsWith matches and the parsed detail see the
    // plain phase; phaseDetailBase re-appends the streak once itself from the payload's
    // noChangeStreak, so the GUI renders it exactly once.
    const p = String(phase || "").replace(/ · no change ×\d+$/, "");
    const after = (n) => p.slice(n).replace(/^[\s·,]+/, "");
    if (p.startsWith("director working")) return { key: "working", label: "Working (director)", tone: "blue", live: true, detail: after(16) };
    if (p.startsWith("working")) return { key: "working", label: "Working", tone: "blue", live: true, detail: after(7) };
    if (p.startsWith("reviewing")) return { key: "reviewing", label: "Reviewing", tone: "violet", live: true, detail: after(9) };
    if (p.startsWith("merging")) return { key: "landing", label: "Merging", tone: "orange", live: true, detail: after(7) };
    if (p.startsWith("approved")) return { key: "vetted", label: "Approved", tone: "indigo", live: false, detail: "waiting to merge" };
    if (p.startsWith("waiting to start")) return { key: "awaiting", label: "Waiting to start", tone: "gray", live: false, detail: after(16) ? "for " + after(16) : "" };
    // A waiter parked on a full provider key (provider-concurrency part 5/5): the phase reads
    // waiting for <key> 2m, and this chip names the provider alongside the wait, so the
    // operator sees which cap is full — the same chip and tone as a fleet-total waiter.
    if (p.startsWith("waiting for ")) {
      const m = after(12).match(/^(\S+)(?:\s+(.*))?$/);
      const prov = m ? m[1] : "";
      const dur = m && m[2] ? m[2].trim() : "";
      return {
        key: "awaiting", label: "Waiting to start", tone: "gray", live: false,
        detail: (prov ? "on " + prov : "") + (dur ? " for " + dur : ""),
      };
    }
    if (p === "failing") return { key: "failing", label: "Failing", tone: "red", live: false, detail: "failed runs in a row" };
    if (p === "main's check is failing") return { key: "mainred", label: "Main's check failing", tone: "red", live: false, detail: "blocked until main's check passes" };
    if (p.startsWith("paused")) return { key: "paused", label: "Paused", tone: "amber", live: false, detail: "starts no new runs" };
    if (p === "waiting: budget spent") return { key: "budget", label: "Waiting", tone: "amber", live: false, detail: "budget" };
    if (p === "waiting: daily cap spent") return { key: "cap", label: "Waiting", tone: "amber", live: false, detail: "daily cap" };
    if (p === "waiting: low disk") return { key: "disk", label: "Waiting", tone: "amber", live: false, detail: "low disk" };
    if (p === "waiting: bootstrap") return { key: "bootstrap", label: "Waiting", tone: "amber", live: false, detail: "bootstrap" };
    if (p.startsWith("waiting: maintenance allowance used")) return { key: "quota", label: "Waiting", tone: "amber", live: false, detail: "maintenance " + after(35) };
    if (p.startsWith("sleeping")) return { key: "sleeping", label: "Sleeping", tone: "gray", live: false, detail: "" };
    if (p.startsWith("idle: ")) return { key: "idle", label: "Idle", tone: "gray", live: false, detail: p.slice(6) };
    if (p.startsWith("deferred (")) return { key: "deferred", label: "Deferred", tone: "gray", live: false, detail: p.slice(10, -1) };
    if (p === "due") return { key: "queued", label: "Due", tone: "gray", live: false, detail: "starts on the next poll" };
    if (p === "ready for messages") return { key: "waiting", label: "Ready", tone: "gray", live: false, detail: "runs when you send it a message" };
    if (p === "stopped") return { key: "stopped", label: "Stopped", tone: "gray", live: false, detail: "the fleet is not running" };
    return { key: "other", label: p || "unknown", tone: "gray", live: false, detail: "" };
  }
  // A stalled tool call or a long silence, as the phase label names them (tick-progress-model.ts's
  // inFlightDetail) — the cue that a working loop may be stuck. The pattern is that module's
  // STALL_SOURCE (interpolated at module build), shared with fleet-alerts.ts's server-side
  // matcher so the two cannot drift from the wording the cell renders.
  const STALL = new RegExp(${JSON.stringify(STALL_SOURCE)});
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
  // The problem results and the named event sets are tone.ts's lists, interpolated at module
  // build (like STALL above) so the page cannot drift from the server's eventKind.
  const PROBLEM_RESULTS = ${JSON.stringify(PROBLEM_RESULTS)};
  const ROUTINE_BUILD_RESULTS = ${JSON.stringify(ROUTINE_BUILD_RESULTS)};
  // What explains a loop's last result: its summary, or — for a problem that carries none — the
  // last error the loop recorded.
  const resultWhy = (l) => l.lastSummary || (PROBLEM_RESULTS.includes(l.lastResult) || l.phase === "failing" ? l.lastError || "" : "");
  // loop-sort:start
  // Loop order — status-model.ts's loopRank/sortLoopsByState, the TUI's order too: the running
  // director first (its own live work, outside the maxConcurrent cap it bypasses — BUGS.md
  // 2026-10-06), then live work (working, reviewing, landing), then work waiting in the pipe
  // line (approved, awaiting a slot), then loops that need attention (failing, main red), then
  // paused, then idle; within a rank the most recent tick first, a never-ticked loop last, ties
  // by name. The phase → rank rules are status-model.ts's LOOP_RANK_RULES (interpolated at
  // module build, like STALL/PROBLEM_RESULTS above), so the literals cannot drift from the
  // server's copy.
  const LOOP_RANK_RULES = ${JSON.stringify(LOOP_RANK_RULES)};
  function loopRank(phase) {
    const p = String(phase || "");
    for (const r of LOOP_RANK_RULES) {
      if (r.active ? isActivePhase(p) : (r.phases || []).includes(p) || (r.prefixes || []).some((x) => p.startsWith(x)))
        return r.rank;
    }
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
  // The fleet table's section for each rank. The running director has its own section so it
  // does not join the In-progress rows an operator scans against maxConcurrent; the permit
  // holders (rank 0) and the pipeline waiters (rank 1, labeled "Waiting to start") keep
  // sharing In progress (BUGS.md 2026-10-06).
  const LOOP_GROUPS = [["Director", -1], ["In progress", 0, 1], ["Needs attention", 2], ["Paused", 3], ["Idle", 4]];
  // The payload's alerts (fleet-alerts.ts fleetAlerts — the TUI's attention lines use the same
  // list), plus the one only the page can know: that its server stopped answering.
  const OFFLINE_ALERT = { key: "offline", tone: "red", title: "Lost contact with the dashboard server",
    detail: "Retrying every second. Everything below is the last state it reported.", actions: [] };
  function pageAlerts(d, offline) {
    return (offline ? [OFFLINE_ALERT] : []).concat((d && d.alerts) || []);
  }
  const ALERT_ICONS = { offline: "offline", budget: "dollar", fallback: "info", mainred: "fail", failing: "fail", stuck: "clock",
    build: "refresh", questions: "question", paused: "pause", quiet: "pause", stopped: "info" };
  // needs-you:start
  // Alerts that ask something of the operator (the page title counts them); blue and gray ones
  // are information.
  const NEEDS_YOU = (a) => a.tone === "red" || a.tone === "amber" || a.tone === "indigo";
  const needsYou = (alerts) => alerts.filter(NEEDS_YOU).length;
  // The needs-you alerts' keys — the set the sound cue diffs each poll against the last poll's.
  const needsYouKeys = (alerts) => alerts.filter(NEEDS_YOU).map((a) => a.key);
  // The needs-you keys of the given alerts that prevKeys (the previous poll's set, or null on
  // the first poll) lacks — exactly the alerts a new cue should announce. A null prev yields
  // every needs-you key, so a page opened onto an already-alerting fleet cues once.
  const newNeedsYouKeys = (prevKeys, alerts) => {
    const prior = new Set(prevKeys || []);
    return needsYouKeys(alerts).filter((k) => !prior.has(k));
  };
  // needs-you:end
  // An activity item's kind — its icon and tone, and whether the Notable filter keeps it.
  const ROUTINE_EVENTS = ${JSON.stringify(ROUTINE_EVENTS)};
  const PROBLEM_EVENTS = ${JSON.stringify(PROBLEM_EVENTS)};
  function eventKind(item) {
    if (item.type === "merged") return "landing";
    if (item.type === "question_posted") return "attention";
    if (item.type === "entry_refused") return "attention";
    if (item.type === "tick_end") return PROBLEM_RESULTS.includes(item.result) ? "problem" : "routine";
    if (item.type === "build_check") return ROUTINE_BUILD_RESULTS.includes(item.result) ? "routine" : "problem";
    if (PROBLEM_EVENTS.includes(item.type)) return "problem";
    if (ROUTINE_EVENTS.includes(item.type)) return "routine";
    return "info";
  }
  // A backlog title's trailing "(planned 2026-09-29)"-style note, split off as metadata —
  // the pattern is backlog-structure.ts's ENTRY_STAMP_META_SOURCE (interpolated at module
  // load, compiled once here), the same regex fleet-alerts.ts strips through via
  // stripEntryStamp, so a new stamp verb reaches both dashboards from one edit.
  const ENTRY_STAMP_RE = new RegExp(${JSON.stringify(ENTRY_STAMP_META_SOURCE)}, "i");
  function splitTitle(t) {
    const m = ENTRY_STAMP_RE.exec(String(t));
    return m ? { title: String(t).slice(0, m.index), meta: m[1] } : { title: String(t), meta: "" };
  }
  // Queued prompts in execution order — the director's first, then each loop's — each with the
  // queue-file address its Cancel button sends (never a list position, so a stale frame can
  // never cancel the wrong prompt).
  function queuedPrompts(d) {
    const out = (d.inboxPrompts || []).map((p, i) => ({ role: "director", preview: p, file: (d.inboxFiles || [])[i] || "",
      queuedAtMs: (d.inboxQueuedAt || [])[i] ?? null, notBeforeMs: (d.inboxNotBefore || [])[i] ?? null }));
    for (const r of Object.keys(d.roleInboxPrompts || {}).sort()) {
      for (const e of d.roleInboxPrompts[r] || []) out.push({ role: r, preview: e.preview, file: e.file, queuedAtMs: e.queuedAtMs ?? null, notBeforeMs: e.notBeforeMs ?? null });
    }
    return out;
  }
  // view-model:end
`;
