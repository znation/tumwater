import type { HarnessEvent } from "./events.js";

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
  tick_start: "run_start", // vocabulary-ok: legacy event name read from old logs
  tick_end: "run_end", // vocabulary-ok: legacy event name read from old logs
  fleet_paused: "team_paused", // vocabulary-ok: legacy event name read from old logs
  fleet_resumed: "team_resumed", // vocabulary-ok: legacy event name read from old logs
};

/** A field rewrite applied after the type rename. Each guards on the JS type it expects. */
interface LegacyEventRewrite {
  name: string;
  apply(ev: HarnessEvent): void;
}

/** The ordered field rewrites; later parts of the series append here, and they run in order. */
const LEGACY_EVENT_REWRITES: LegacyEventRewrite[] = [];

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
