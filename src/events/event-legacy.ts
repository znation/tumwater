import { TUMWATER_SOURCE, type HarnessEvent } from "./events.js";
import { canonicalRoleId } from "../roles/legacy-role-ids.js";

/** Old event lines read under today's names. `.tumwater/log/events.jsonl` (and its rotated
 * `events.jsonl.1`) outlive the build that wrote them, and a long-lived supervisor on an older
 * build keeps writing old names, so every reader normalizes on read: `normalizeLegacyEvent` is
 * applied by `parseEventLine` (which every file reader goes through) and by `logEvent` (so
 * in-process subscribers see exactly what readers see). Its rewrites are permanent.
 *
 * Role ids (`dry`, `telemetry`) are deliberately NOT mapped here. The role-id rename aliases an
 * event's `source` id through its own legacy-id table when it switches each id, so mapping them
 * here would show `dedupe` while the role is still `dry`. */

/** An old event type name → today's name. */
const LEGACY_EVENT_TYPES: Readonly<Record<string, HarnessEvent["type"]>> = {
  tick_start: "run_start", // vocabulary-ok: legacy event name read from old logs // retired-name-ok: legacy name
  tick_end: "run_end", // vocabulary-ok: legacy event name read from old logs // retired-name-ok: legacy name
  tick_deferred: "run_deferred", // vocabulary-ok: legacy event name read from old logs // retired-name-ok: legacy name
  tick_aborted: "run_aborted", // vocabulary-ok: legacy event name read from old logs // retired-name-ok: legacy name
  // retired-name-ok:start old event names
  fleet_paused: "team_paused", // vocabulary-ok: legacy event name read from old logs
  fleet_resumed: "team_resumed", // vocabulary-ok: legacy event name read from old logs
  // retired-name-ok:end
  // retired-name-ok:start old event names
  land_queued: "merge_queued", // vocabulary-ok: legacy event name read from old logs
  landed: "merge_done", // vocabulary-ok: legacy event name read from old logs
  land_failed: "merge_failed", // vocabulary-ok: legacy event name read from old logs
  // retired-name-ok:end
  // retired-name-ok:start old subscription-window event names
  claude_window_limited: "subscription_window_limited", // vocabulary-ok: legacy event name read from old logs
  claude_window_reset: "subscription_window_reset", // vocabulary-ok: legacy event name read from old logs
  // retired-name-ok:end
};

/** A field rewrite applied after the type rename. Each guards on the JS type it expects. */
interface LegacyEventRewrite {
  name: string;
  apply(ev: HarnessEvent): void;
}

/** The ordered field rewrites; later parts of the series append here, and they run in order. */
const LEGACY_EVENT_REWRITES: LegacyEventRewrite[] = [
  {
    // The run number rode `tick` on run_start, run_end, prompt_taken, image_blind, image_reroute.
    name: "tick-to-run", // retired-name-ok: legacy name
    apply(ev) {
      const e = ev as Record<string, unknown>;
      if ("tick" in e && !("run" in e)) { // vocabulary-ok: legacy field name read from old logs // retired-name-ok: legacy field
        e.run = e.tick; // vocabulary-ok: legacy field name read from old logs // retired-name-ok: legacy field
        delete e.tick; // vocabulary-ok: legacy field name read from old logs // retired-name-ok: legacy field
      }
    },
  },
  {
    // build_check.scope and conflict_handback.reason said "landing" for what is now "merge".
    name: "merge-scope-value",
    apply(ev) {
      const e = ev as Record<string, unknown>;
      if (e.type === "build_check" && e.scope === "landing") e.scope = "merge"; // vocabulary-ok: legacy event value read from old logs
      if (e.type === "conflict_handback" && e.reason === "landing") e.reason = "merge"; // vocabulary-ok: legacy event value read from old logs
    },
  },
  {
    // slot_wait.purpose said "tick"/"vet" for what is now "run"/"verify".
    name: "slot-purpose",
    apply(ev) {
      const e = ev as Record<string, unknown>;
      if (e.type !== "slot_wait") return;
      if (e.purpose === "tick") e.purpose = "run"; // vocabulary-ok: legacy event value read from old logs // retired-name-ok: legacy name
      if (e.purpose === "vet") e.purpose = "verify"; // vocabulary-ok: legacy event value read from old logs
    },
  },
  {
    // The restart event's drain fields became finish fields.
    name: "restart-finish-fields",
    apply(ev) {
      const e = ev as Record<string, unknown>;
      if (e.type !== "restart") return;
      const renames: [string, string][] = [
        ["drainedMs", "finishedMs"], // vocabulary-ok: legacy field name read from old logs
        ["abortedTicks", "abortedRuns"], // vocabulary-ok: legacy field name read from old logs
        ["drainWindowMs", "finishWindowMs"], // vocabulary-ok: legacy field name read from old logs
      ];
      for (const [from, to] of renames) {
        if (from in e && !(to in e)) {
          e[to] = e[from];
          delete e[from];
        }
      }
    },
  },
  {
    // The writer's id rode `loop`, with "harness" for tumwater's own events. A staged-claim
    // `claim` line also carried a payload `source: "staged"`, which moves to `origin` first. A
    // call site that still passes `source: "harness"` (the warn helpers' callers) maps too.
    // Kept permanently though no TypeScript type accepts `loop` any more: old logs and a
    // still-running old supervisor keep writing it, so the read path and logEvent need this.
    name: "writer-id-to-source",
    apply(ev) {
      const e = ev as Record<string, unknown>;
      if (typeof e.loop === "string") { // vocabulary-ok: legacy field name read from old logs // retired-name-ok: legacy field, read permanently
        if (e.type === "claim" && e.source === "staged" && !("origin" in e)) {
          e.origin = e.source;
          delete e.source;
        }
        e.source = e.loop; // vocabulary-ok: legacy field name read from old logs // retired-name-ok: legacy field, read permanently
        delete e.loop; // vocabulary-ok: legacy field name read from old logs // retired-name-ok: legacy field, read permanently
      }
      if (e.source === "harness") e.source = TUMWATER_SOURCE; // vocabulary-ok: legacy event source read from old logs
    },
  },
  {
    // A retired role id on an old line reads as the role's current id. The table grows a row
    // per retired role as future switch parts rename; a row already present applies here.
    name: "legacy-role-ids",
    apply(ev) {
      const e = ev as Record<string, unknown>;
      if (typeof e.source === "string") e.source = canonicalRoleId(e.source);
      if (typeof e.role === "string") e.role = canonicalRoleId(e.role);
    },
  },
  {
    // The four subscription-window events now name their backend (plans/codex-backend.md part
    // 2b/9). The old claude_window_* names map (above) to subscription_window_* with no
    // backend, so a line written before the rename gets `backend: "claude"` here; a current
    // line written with its own backend is left alone. Kept permanently: a still-running old
    // supervisor and old rotated logs keep writing the old names without a backend.
    name: "subscription-window-backend",
    apply(ev) {
      const e = ev as Record<string, unknown>;
      if (
        e.type === "subscription_window_reserved" ||
        e.type === "subscription_window_warning" ||
        e.type === "subscription_window_limited" ||
        e.type === "subscription_window_reset"
      ) {
        if (typeof e.backend !== "string") e.backend = "claude";
      }
    },
  },
];

/** Today's name for an old event type name; any other string comes back unchanged. */
export function canonicalEventType(name: string): string {
  return Object.prototype.hasOwnProperty.call(LEGACY_EVENT_TYPES, name) ? LEGACY_EVENT_TYPES[name]! : name;
}

/** Rewrite a freshly parsed event line in place to today's names and return it. Never throws; a
 * current line comes back untouched. */
export function normalizeLegacyEvent<T extends { type?: unknown }>(ev: T): T {
  if (typeof ev.type === "string") {
    const next = canonicalEventType(ev.type);
    if (next !== ev.type) ev.type = next;
  }
  for (const rewrite of LEGACY_EVENT_REWRITES) {
    try {
      rewrite.apply(ev as unknown as HarnessEvent);
    } catch {
      // A malformed field is left as written: normalizing must never lose the line.
    }
  }
  return ev;
}
