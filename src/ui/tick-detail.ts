/** Rendering + command half of `tumwater tick <role> <n>`: one completed tick's full event
 * block printed as a short summary header followed by the tick's events through the shared
 * formatEvent. The payload itself is collected by tick-detail-data.ts (the collector-in-core
 * convention beside history-data.ts / ui/history.ts), so the CLI and the GUI History drill-down
 * serve the same payload; this module renders it for the terminal. Read-only over the event
 * log, stdout only. */
import { fail, parseCountFlag, say, sayJson } from "../cli-args.js";
import { knownRoleIdsCached } from "../config.js";
import { readTickDetail, type TickDetail } from "../tick-detail-data.js";
import { formatEvent } from "../event-format.js";
import { unknownRoleMessage } from "../roles.js";
import { shortSha, shortSpanPhrase } from "../text.js";

/** The tick command's synopsis, word for word what cli.ts's dispatcher gate and cmdTick's own
 * arity and unknown-role guards fail with — one string so the three sites cannot drift apart
 * when the command's shape changes. */
export const TICK_USAGE = "tumwater tick <role> <n> [--json]";

/** The not-found wording a missed tick lookup owes its surface — `tumwater tick <role> <n>`'s
 * stdout line and the GUI /api/tick endpoint's 404 JSON error, one template so the CLI's prose
 * and the browser's error card cannot drift when the phrasing moves. Names the shape a user
 * can act on: the tick number, the loop, and that the scanned window (not the world) is what
 * came up empty. */
export function tickNotFoundMessage(role: string, tick: number): string {
  return `no tick #${tick} for ${role} in the scanned window (the retained log may have rotated past it)`;
}

/** The human view of a TickDetail: one summary line — result (or the in-flight/unpaired
 * marker), duration, usage, and the pinned commit sha when the block's `land_queued`/`landed`
 * event carries one — then each event through formatEvent, the shared renderer `logs` and the
 * TUI use, so the trail reads exactly like the feed it came from. */
export function renderTickDetail(d: TickDetail): string {
  const summary: string[] = [];
  if (d.endTs === null) summary.push(d.startTs === null ? "unpaired" : "in flight");
  else summary.push(d.result || "?");
  if (d.durationMs !== null) summary.push(shortSpanPhrase(d.durationMs));
  if (d.usage !== "") summary.push(d.usage);
  const queued = d.events.find(
    (e) => (e.type === "land_queued" || e.type === "landed") && typeof e.commit === "string" && e.commit !== "",
  );
  let header = `${d.role} tick #${d.tick} — ${summary.join(" · ")}`;
  if (queued !== undefined) header += ` · commit ${shortSha(queued.commit)}`;
  return [header, ...d.events.map(formatEvent)].join("\n");
}

/** `tumwater tick <role> <n> [--json]`: print one completed tick's full event trail. Read-only:
 * stdout only, no state file created — a tick the scan cannot find prints a not-found line and
 * exits 0 (history's empty-output convention: an absent record is an answer, not a failure),
 * and under --json it prints the JSON document `null` instead — the report --json precedent
 * that every exit-0 output is parseable, never prose. */
export async function cmdTick(root: string, positionals: string[], json: boolean): Promise<void> {
  // Positional arity is exactly <role> <n> — cli.ts has already peeled the flags off and gated
  // them (only --json is admitted), so anything left over that is not the pair is a mistake.
  if (positionals.length !== 2) fail(`usage: ${TICK_USAGE}`);
  const [role, nRaw] = positionals as [string, string];
  // The role is validated like every role-targeting command's --role (knownRoleIdsCached: the
  // built-ins plus user-defined loops, read through the never-throwing cached loader so a
  // transiently broken tumwater.json cannot take a read-only view down), with the shared
  // unknown-role wording plus the usage the positional command owes.
  const ids = knownRoleIdsCached(root);
  if (!ids.includes(role)) fail(`${unknownRoleMessage(role, ids)} (usage: ${TICK_USAGE})`);
  // The tick number is a positive integer, through the shared count parser (a non-positive or
  // non-numeric n fails naming the shape; there is no cap — the number selects, it does not
  // size the scan).
  const tick = parseCountFlag("<n>", nRaw);
  const detail = readTickDetail(root, role, tick);
  if (detail === null) {
    // Not found stays exit 0 in both renderings, but --json still owes a parseable document in
    // every exit-0 case (the report --json precedent, the invariant this command's own doc
    // comment claims): `null` is the JSON answer for a single-record lookup that missed — the
    // prose line would end a jq pipe mid-fleet-incident.
    if (json) sayJson(null);
    else say(tickNotFoundMessage(role, tick));
    return;
  }
  // --json swaps the renderer for the collector's own payload, exactly as history --json: a
  // JSON document in every exit-0 case, never prose.
  if (json) sayJson(detail);
  else say(renderTickDetail(detail));
}
