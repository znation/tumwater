/** Rendering + command half of `tumwater history <role> <n>`: one completed run's full event
 * block printed as a short summary header followed by the run's events through the shared
 * formatEvent. The payload itself is collected by run-detail-data.ts (the collector-in-core
 * convention beside history-data.ts / history.ts), so the CLI and the GUI History drill-down
 * serve the same payload; this module renders it for the terminal. Read-only over the event
 * log, stdout only. */
import { fail, say, sayJson } from "../cli/cli-output.js";
import { parseCountFlag } from "../cli/cli-args.js";
import { knownRoleIdsCached } from "../config/config.js";
import { readRunRows } from "../history/history-data.js";
import { readRunDetail, type RunDetail } from "./run-detail-data.js";
import { formatEvent } from "../events/event-format.js";
import { eventTypeLabel } from "../events/event-labels.js";
import { roleLabel } from "../roles/role-labels.js";
import { unknownRoleMessage } from "../roles/roles.js";
import { shortSpanPhrase } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import { piLogPath } from "../paths.js";
import { readRunTranscript } from "../ui/transcript-run.js";
import { gitTry } from "../git/git-run.js";
import { canonicalRoleId } from "../roles/legacy-role-ids.js";

/** The run command's synopsis, word for word what cli.ts's dispatcher gate and cmdRunDetail's own
 * arity and unknown-role guards fail with — one string so the three sites cannot drift apart
 * when the command's shape changes. */
export const RUN_DETAIL_USAGE = "tumwater history <role> [<n>] [--last] [--stat] [--patch] [--transcript [--prompt] [--grep <text>]] [--json]";

/** The shared not-found frame both wordings complete — what the scan looked for, the role,
 * and that the scanned window (not the world) is what came up empty. Exactly two consumers,
 * the not-found wordings below (the numbered form's exported message and the --last form's
 * module-local sibling), so the trailing hedge cannot drift between them. */
function runNotFoundPhrase(role: string, what: string): string {
  return `no ${what} for ${role} in the scanned window (the retained log may have rotated past it)`;
}

/** The not-found wording a missed run lookup owes its surface — `tumwater history <role> <n>`'s
 * stdout line and the GUI /api/run endpoint's 404 JSON error, one template so the CLI's prose
 * and the browser's error card cannot drift when the phrasing moves. Names the shape a user
 * can act on: the run number, the role, and that the scanned window (not the world) is what
 * came up empty. */
export function runNotFoundMessage(role: string, runNumber: number): string {
  return runNotFoundPhrase(role, `run #${runNumber}`);
}

/** The not-found wording for `tumwater history <role> --last`, sibling of runNotFoundMessage —
 * the same surfaces but naming what the last-form scan actually asked for: the newest
 * completed run, not a number the user supplied. Module-local: the GUI's /api/run 404 only
 * ever serves the numbered form, so this wording has no second consumer. */
function runNotFoundLastMessage(role: string): string {
  return runNotFoundPhrase(role, "completed run");
}

/** The commit a run pinned: the `commit` of the first `merge_queued`/`merge_done` event in its
 * block carrying a non-empty one, else null. The one rule both the header's sha and --stat use. */
export function runCommitSha(d: RunDetail): string | null {
  const queued = d.events.find(
    (e) => (e.type === "merge_queued" || e.type === "merge_done") && typeof e.commit === "string" && e.commit !== "", 
  );
  return queued === undefined ? null : (queued.commit as string);
}

/** The sha a run's change merged under on main: the `merged` sha when the merge logged one, else
 * the pinned commit — a no-op fast-forward logs no `merged` event, so its pinned commit is what
 * merged. Null when the run pinned no commit. */
export function runMergedSha(d: RunDetail): string | null {
  return d.mergedSha ?? runCommitSha(d);
}

/** The `git show --stat` summary or full `--patch` of a run's pinned commit. The sha is the
 * authored commit the run pinned: a merge that rebased gives main a different sha with the
 * same changes, so this describes what the run changed. */
async function runCommitShow(root: string, sha: string | null, what: "--stat" | "--patch"): Promise<string> {
  if (sha === null) return "(no commit: this run sent nothing to merge)";
  const out = await gitTry(root, "show", what, "--format=", sha);
  if (out === null) return `(commit ${shortSha(sha)} is not in this repository)`;
  return out.trimEnd();
}

/** The pinned commit's stat text for a run, shared by `run --stat` and GET /api/run so both
 * apply one rule for the sha and the "(no commit …)" / "(commit … is not in this repository)"
 * texts. */
export function runDetailStat(root: string, d: RunDetail): Promise<string> {
  return runCommitShow(root, runCommitSha(d), "--stat");
}

/** The pinned commit's full patch for a run, for `history --patch`. Like runDetailStat it
 * shows the commit the run pinned (runCommitSha), not the `merged as` sha, so the stat and
 * the patch describe the same commit; the placeholder texts are the stat's. GET /api/run is its
 * second caller (the dashboard's "Show patch" button). */
export function runDetailPatch(root: string, d: RunDetail): Promise<string> {
  return runCommitShow(root, runCommitSha(d), "--patch");
}

/** The human view of a RunDetail: one summary line — result (or the in-flight/unpaired
 * marker), duration, usage, and the pinned commit sha when the block's `merge_queued`/`merge_done`
 * event carries one — then each event through formatEvent, the shared renderer `logs` and the
 * TUI use, so the trail reads exactly like the feed it came from. A queued run whose merge
 * has finished shows that verdict in the header and ends with the merge's outcome line; a
 * leftover-recovery run's verdict is the failed attempt it re-queued (resolveQueuedResult),
 * logged before the run began, so that outcome line leads the trail instead — the trail stays
 * in time order. */
export function renderRunDetail(d: RunDetail): string {
  const summary: string[] = [];
  if (d.endTs === null) summary.push(d.startTs === null ? "unpaired" : "in flight");
  else summary.push(d.result ? eventTypeLabel(d.result) : "?");
  if (d.durationMs !== null) summary.push(shortSpanPhrase(d.durationMs));
  if (d.usage !== "") summary.push(d.usage);
  const sha = runCommitSha(d);
  let header = `${roleLabel(d.role)} run #${d.run} — ${summary.join(" · ")}`;
  if (sha !== null) header += ` · commit ${shortSha(sha)}`;
  if (d.mergedSha !== null && d.mergedSha !== sha) header += ` · merged as ${shortSha(d.mergedSha)}`;
  const trail = d.events.map(formatEvent);
  if (d.merge !== null) {
    const first = d.events[0];
    if (first !== undefined && d.merge.ts < first.ts) trail.unshift(formatEvent(d.merge));
    else trail.push(formatEvent(d.merge));
  }
  return [header, ...trail].join("\n");
}

/** The transcript block of `--transcript`: the rendered lines of the agent runs that started in the
 * run's window, or `found: []` plus the `note` the text view prints in their place. The
 * dashboard's `/api/run?transcript` serves the same text. */
export function runTranscriptLines(
  root: string,
  role: string,
  runNumber: number,
  detail: RunDetail,
  opts: { includePrompts?: boolean; grep?: string } = {},
): { found: string[]; note: string } {
  if (detail.startTs === null) {
    return { found: [], note: `(no transcript: run ${runNumber}'s start rotated out of the event log)` };
  }
  return {
    found: readRunTranscript(piLogPath(root, role), detail.startTs, detail.endTs, {
      includePrompts: opts.includePrompts,
      grep: opts.grep?.toLowerCase(),
    }),
    note:
      opts.grep !== undefined
        ? `(no transcript entries matching "${opts.grep}" in ${role} run ${runNumber})`
        : `(no transcript for ${role} run ${runNumber}: rotated out of .tumwater/log/${role}.pi.jsonl, or the run started no agent)`,
  };
}

/** `tumwater history <role> [<n>] [--last] [--stat] [--patch]
 * [--transcript [--prompt] [--grep <text>]] [--json]`: print one completed
 * run's full event trail. Read-only: stdout only, no state file created — a run the
 * scan cannot find prints a not-found line and exits 0 (history's empty-output convention:
 * an absent record is an answer, not a failure), and under --json it prints the JSON document
 * `null` instead — the report --json precedent
 * that every exit-0 output is parseable, never prose. `tumwater history <role> --last` resolves
 * the role's newest completed run in the scanned window and prints its trail exactly as the
 * numbered form would — the summary header and event rendering are shared, only the number's
 * provenance differs (readRunRows' newest-first scan, not the user's argument). --last and a
 * numeric <n> are rivals: exactly one positional under --last, exactly two without. */
export async function cmdRunDetail(
  root: string,
  positionals: string[],
  json: boolean,
  { last = false, stat = false, patch = false, transcript = false, prompt = false, grep = null }: {
    last?: boolean;
    stat?: boolean;
    patch?: boolean;
    transcript?: boolean;
    prompt?: boolean;
    grep?: string | null;
  } = {},
): Promise<void> {
  // Positional arity by form: cli.ts has already peeled the flags off and gated them (only
  // --json and --last are admitted), so anything left over that does not fit the chosen form
  // is a mistake. The role is checked first, so a typo is named whatever the count; then
  // --last takes exactly one positional (<role>) and the numeric path exactly two (<role> <n>).
  const role = canonicalRoleId(positionals[0] ?? "");
  // The role is validated like every role-targeting command's --role (knownRoleIdsCached: the
  // built-ins plus user-defined roles, read through the never-throwing cached loader so a
  // transiently broken tumwater.json cannot take a read-only view down), with the shared
  // unknown-role wording plus the usage the positional command owes.
  if (positionals.length >= 1) {
    const ids = knownRoleIdsCached(root);
    if (!ids.includes(role)) fail(`${unknownRoleMessage(role, ids)} (usage: ${RUN_DETAIL_USAGE})`);
  }
  const arity = last ? 1 : 2;
  if (positionals.length !== arity) {
    if (positionals.length === 1) {
      fail(
        `history ${role} needs a run number or --last — \`tumwater history --role ${role}\` lists its runs (usage: ${RUN_DETAIL_USAGE})`,
      );
    }
    if (positionals.length === 2 && last) {
      fail(`history --last takes no run number (got "${positionals[1]}") (usage: ${RUN_DETAIL_USAGE})`);
    }
    fail(`usage: ${RUN_DETAIL_USAGE}`);
  }
  if (prompt && !transcript) fail(`history --prompt needs --transcript (usage: ${RUN_DETAIL_USAGE})`);
  if (grep !== null && !transcript) fail(`history --grep needs --transcript on a one-run trail (usage: ${RUN_DETAIL_USAGE})`);
  // The run number: either the user's positive integer (the numbered path, through the
  // shared count parser — a non-positive or non-numeric n fails naming the shape; there is
  // no cap — the number selects, it does not size the scan) or the newest completed run's
  // number, read from readRunRows' newest-first scan for the role. An empty scan is not
  // found by construction, so the not-found path below takes it with the last-form wording.
  const runNumber = last
    ? (readRunRows(root, 1, role)[0]?.run ?? null)
    : parseCountFlag("history <n>", positionals[1]);
  const detail = runNumber === null ? null : readRunDetail(root, role, runNumber);
  if (runNumber === null) {
    // The --last scan came up empty: not found by construction, the last-form wording.
    if (json) sayJson(null);
    else say(runNotFoundLastMessage(role));
    return;
  }
  if (detail === null) {
    // Not found stays exit 0 in both renderings, but --json still owes a parseable document in
    // every exit-0 case (the report --json precedent, the invariant this command's own doc
    // comment claims): `null` is the JSON answer for a single-record lookup that missed — the
    // prose line would end a jq pipe mid-team-incident.
    if (json) sayJson(null);
    else say(runNotFoundMessage(role, runNumber));
    return;
  }
  // --json swaps the renderer for the collector's own payload, exactly as history --json: a
  // JSON document in every exit-0 case, never prose.
  const footer: { stat?: string; patch?: string } = {};
  if (stat) footer.stat = await runDetailStat(root, detail);
  if (patch) footer.patch = await runDetailPatch(root, detail);
  const transcriptLines = transcript
    ? runTranscriptLines(root, role, runNumber, detail, { includePrompts: prompt, grep: grep ?? undefined })
    : null;
  if (json) {
    sayJson({ ...detail, ...footer, ...(transcriptLines === null ? {} : { transcript: transcriptLines.found }) });
  } else {
    const transcriptText =
      transcriptLines === null
        ? []
        : [transcriptLines.found.length > 0 ? transcriptLines.found.join("\n") : transcriptLines.note];
    say([renderRunDetail(detail), ...Object.values(footer), ...transcriptText].join("\n\n"));
  }
}
