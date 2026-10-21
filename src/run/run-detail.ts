/** Command half of `tumwater history <role> <n>` and its `--last` / `--stat` / `--patch` /
 * `--transcript` forms: the read-only command body that resolves which run to open, validates
 * it, and prints the rendered trail (or the not-found line). The payload is collected by
 * run-detail-data.ts (runCommitSha / runMergedSha beside it) and rendered by
 * run-detail-render.ts, so the CLI, the TUI's History drill-down, and the GUI's /api/run serve
 * the same text. Read-only over the event log, stdout only. */
import { fail, say, sayJson } from "../cli/cli-output.js";
import { parseCountFlag } from "../cli/cli-args.js";
import { knownRoleIdsCached } from "../config/config.js";
import { HISTORY_MAX_RUNS, HISTORY_RESULT_FLAG_NAMES, historyClass, readRunRows, runRowsOnModels, type HistoryResultClass, type RunRow } from "../history/history-data.js";
import { parseHistoryModelList, parseHistoryResultList } from "../history/history.js";
import { readRunDetail } from "./run-detail-data.js";
import { runDetailPatch, runDetailStat, renderRunDetail, runTranscriptLines } from "./run-detail-render.js";
import { unknownRoleMessage } from "../roles/roles.js";
import { canonicalRoleId } from "../roles/legacy-role-ids.js";

/** The run command's synopsis, word for word what cli.ts's dispatcher gate and cmdRunDetail's own
 * arity and unknown-role guards fail with — one string so the three sites cannot drift apart
 * when the command's shape changes. */
export const RUN_DETAIL_USAGE = "tumwater history <role> [<n>] [--last [--result <class>[,...]] [--model <selector>[,...]]] [--stat] [--patch] [--transcript [--prompt] [--grep <text>]] [--json]";

/** The shared not-found frame both wordings complete — what the scan looked for, the role,
 * and that the scanned window (not the world) is what came up empty. Exactly two consumers,
 * the not-found wordings below (the numbered form's exported message and the --last form's
 * exported sibling), so the trailing hedge cannot drift between them. */
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
 * completed run, not a number the user supplied. Two consumers: cmdRunDetail's stdout line and
 * the GUI /api/run?last=1 404 error, so the CLI and the browser cannot word the miss apart. */
export function runNotFoundLastMessage(
  role: string | null,
  classes: HistoryResultClass[] | null = null,
  models: string[] | null = null,
): string {
  const flagNames = classes?.map((c) => HISTORY_RESULT_FLAG_NAMES[c]).join(",");
  const what = `completed run${classes ? ` with result "${flagNames}"` : ""}${models ? ` on model "${models.join(",")}"` : ""}`;
  return runNotFoundPhrase(role ?? "any role", what);
}

/** The newest completed run's row for a role (`null` for every role), or null when the scanned
 * window holds none: the run `tumwater history <role> --last` opens, and bare `history --last`
 * with no role. With neither filter it is readRunRows' newest row; with `classes` it is the
 * newest row in those outcome classes, and with `models` the newest that started on one of those
 * selectors. Also GET /api/run?last=1 with no role. */
export function newestRunRow(
  root: string,
  role: string | null,
  classes: HistoryResultClass[] | null,
  models: string[] | null,
): RunRow | null {
  if (!classes && !models) return readRunRows(root, 1, role)[0] ?? null;
  const rows = models ? runRowsOnModels(readRunRows(root, HISTORY_MAX_RUNS, role), models) : readRunRows(root, HISTORY_MAX_RUNS, role);
  return rows.find((r) => !classes || classes.includes(historyClass(r.result))) ?? null;
}

/** The newest completed run's number for a role, or null when the scanned window holds none:
 * the run `history <role> <n>` resolves for `--last`; newestRunRow's number. */
function newestRunNumber(
  root: string,
  role: string,
  classes: HistoryResultClass[] | null,
  models: string[] | null,
): number | null {
  return newestRunRow(root, role, classes, models)?.run ?? null;
}

/** `tumwater history <role> [<n>] [--last [--result <class>[,...]]] [--stat] [--patch]
 * [--transcript [--prompt] [--grep <text>]] [--json]`: print one completed
 * run's full event trail. Read-only: stdout only, no state file created — a run the
 * scan cannot find prints a not-found line and exits 0 (history's empty-output convention:
 * an absent record is an answer, not a failure), and under --json it prints the JSON document
 * `null` instead — the report --json precedent
 * that every exit-0 output is parseable, never prose. `tumwater history <role> --last` resolves
 * the role's newest completed run in the scanned window and prints its trail exactly as the
 * numbered form would — the summary header and event rendering are shared, only the number's
 * provenance differs (readRunRows' newest-first scan, not the user's argument). --last and
 * a numeric <n> are rivals: exactly one positional under --last, exactly two without. With
 * --last, `--result <class>[,...]` picks the newest run in the listed outcome classes instead
 * (the listing's classes, scanning up to HISTORY_MAX_RUNS runs); it needs --last. `--model
 * <selector>[,...]` with --last keeps only runs that started on a listed model (the listing's
 * exact match) and composes with --result; it needs --last too. With --last and no role, the
 * newest run of any role is opened (newestRunRow with a null role) and renders as its
 * role's form. */
export async function cmdRunDetail(
  root: string,
  positionals: string[],
  json: boolean,
  { last = false, stat = false, patch = false, transcript = false, prompt = false, grep = null, result = null, model = null }: {
    last?: boolean;
    stat?: boolean;
    patch?: boolean;
    transcript?: boolean;
    prompt?: boolean;
    grep?: string | null;
    result?: string | null;
    model?: string | null;
  } = {},
): Promise<void> {
  // Positional arity by form: cli.ts has already peeled the flags off and gated them (only
  // --json and --last are admitted), so anything left over that does not fit the chosen form
  // is a mistake. The role is checked first, so a typo is named whatever the count; then
  // --last takes exactly one positional (<role>) and the numeric path exactly two (<role> <n>).
  const bare = last && positionals.length === 0;
  let role = canonicalRoleId(positionals[0] ?? "");
  // The role is validated like every role-targeting command's --role (knownRoleIdsCached: the
  // built-ins plus user-defined roles, read through the never-throwing cached loader so a
  // transiently broken tumwater.json cannot take a read-only view down), with the shared
  // unknown-role wording plus the usage the positional command owes.
  if (positionals.length >= 1) {
    const ids = knownRoleIdsCached(root);
    if (!ids.includes(role)) fail(`${unknownRoleMessage(role, ids)} (usage: ${RUN_DETAIL_USAGE})`);
  }
  const arity = last ? 1 : 2;
  if (positionals.length !== arity && !bare) {
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
  if (result !== null && !last) fail(`history --result needs --last on a one-run trail (usage: ${RUN_DETAIL_USAGE})`);
  if (model !== null && !last) fail(`history --model needs --last on a one-run trail (usage: ${RUN_DETAIL_USAGE})`);
  const classes = result !== null ? parseHistoryResultList(result) : null;
  const models = model !== null ? parseHistoryModelList(model) : null;
  // The run number: either the user's positive integer (the numbered path, through the
  // shared count parser — a non-positive or non-numeric n fails naming the shape; there is
  // no cap — the number selects, it does not size the scan) or the newest completed run's
  // number, read from readRunRows' newest-first scan for the role. An empty scan is not
  // found by construction, so the not-found path below takes it with the last-form wording.
  let runNumber: number | null;
  if (bare) {
    // `history --last` with no role: the newest completed run of any role; its role is the row's.
    const row = newestRunRow(root, null, classes, models);
    if (row !== null) role = row.role;
    runNumber = row?.run ?? null;
  } else {
    runNumber = last ? newestRunNumber(root, role, classes, models) : parseCountFlag("history <n>", positionals[1]);
  }
  const detail = runNumber === null ? null : readRunDetail(root, role, runNumber);
  if (runNumber === null) {
    // The --last scan came up empty: not found by construction, the last-form wording.
    if (json) sayJson(null);
    else say(runNotFoundLastMessage(bare ? null : role, classes, models));
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
