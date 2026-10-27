import { fail, say, sayJsonLine } from "./cli-output.js";
import { hasFollowFlag, LOGS_TRANSCRIPT_VALUE_ERROR } from "./cli-flag-specs.js";
import { betweenWindow, durationLabel, failRivalShapes, failUntilShorterThanSince, flagValue, parseCountFlag, parseGrepFlag, parseRoleListScope, parseRoleScope, parseSinceFlag, parseTypeFlag } from "./cli-args.js";
import {
  LOGS_SINCE_MAX_MS,
  readEventsSince,
  SPARSE_WINDOW_NOTE,
} from "../events/event-window.js";
import { compareCodeUnits, increment } from "../collections.js";
import { eventTypeTally } from "../events/event-tally.js";
import { eventRole, parseEventLine, readEventsTailWithEnd } from "../events/event-read.js";
import type { HarnessEvent } from "../events/events.js";
import { eventMatchesGrep, eventResult, formatEvent } from "../events/event-format.js";
import { canonicalEventType } from "../events/event-legacy.js";
import { EVENT_TYPE_LABELS, eventTypeLabel } from "../events/event-labels.js";
import { followFile } from "../files/tail.js";
import { roleInScope } from "../roles/runner-ids.js";
import { expectedSupervisorPid, startParentDeathWatch } from "../process/supervisor.js";
import { typoSuffix } from "../text/suggest.js";
import { splitCommaList } from "../text/text.js";
import { createTranscriptFilter, createTranscriptRenderer } from "../ui/transcript.js";
import { readTranscriptTail } from "../ui/transcript-tail.js";
import { isNotableEvent } from "../ui/tone.js";
import { eventsLogPath, piLogPath } from "../paths.js";

/** The read-only observing half of the CLI's non-dispatch commands: `tumwater logs` and its
 * `--transcript` view, split out of cli.ts so the entry point stays a dispatch table. Unlike
 * operator/operator-commands.ts these write nothing but stdout — they only read the event log and
 * each role's agent transcript. It lives beside the other CLI command bodies (history.ts,
 * cli/cli-query-commands.ts, operator/operator-commands.ts), which may import the ui/ rendering
 * layer they drive — here the event formatter and the transcript renderer — while src/ui/
 * itself stays off src/ module boundaries it does not own. */

/** Print one event as the feed line: formatEvent's rendered line, or — in `--json` mode — the
 * raw HarnessEvent serialized exactly as stored in the log. The one home of the
 * render-or-serialize choice the -n dump, the --since window, and the follow stream share, so
 * the three cannot drift on what `logs --json` emits (the sayJson precedent: one place decides
 * what the machine-readable form looks like). */
function sayEventLine(e: HarnessEvent, json: boolean): void {
  if (json) sayJsonLine(e); // Raw event JSON, not the operator-facing formatEvent line.
  else say(formatEvent(e));
}

/** Render the `--count` tally: one `N × <type>` line per present event type, most-frequent
 * first with ties broken alphabetically by type — the single shape shared by both window
 * sources (-n and --since), so the print and the count cannot drift on which events count.
 * In `--json` mode it emits one compact object mapping `type → count` with keys sorted, the
 * machine-readable twin of the prose tally. */
function sayTally(events: HarnessEvent[], json: boolean): void {
  if (json) {
    // The machine-readable twin keeps its own alphabetical key sort; the prose tally uses the
    // shared eventTypeTally ordering.
    const counts = new Map<string, number>();
    for (const e of events) increment(counts, e.type);
    const obj: Record<string, number> = {};
    for (const [type] of [...counts.entries()].sort((a, b) => compareCodeUnits(a[0], b[0]))) obj[type] = counts.get(type)!;
    sayJsonLine(obj);
    return;
  }
  for (const [type, n] of eventTypeTally(events))
    say(`${n} × ${eventTypeLabel(type)} (${type})`);
}

/** The shared rival-shape guard for logs flags that only apply to the event-log feed:
 * `--transcript` swaps in a transcript rather than the event log (--prompt requires
 * --transcript, so it is excluded with it), so each such flag fails naming both. One wording
 * for all of them — the --json, --count, --type and --since checks cannot drift apart in what
 * they say or why. `active` is the flag's own presence. --grep is not one of them: it also
 * filters the transcript view. */
function rejectTranscriptViewRival(rest: string[], flag: string, active: boolean): void {
  if (active && (rest.includes("--transcript") || rest.includes("--prompt")))
    failRivalShapes(`logs ${flag}`, "--transcript", "the --transcript view is the role's agent transcript, not the event log; --prompt requires --transcript");
}

/** The missing-pattern error cmdLogs prints for a valueless `--grep`, exported so cli.ts's
 * rejectUnknownArgs spec for --grep can fail a trailing `logs --grep` with the same wording
 * (the gate runs before the ready-repo gate and this parser, so the wordings must not drift). */
export const GREP_VALUE_ERROR = "logs --grep needs a pattern";

/** The missing-type error cmdLogs prints for a valueless `--type`, exported so cli.ts's
 * rejectUnknownArgs spec for --type can fail a trailing `logs --type` with the same wording
 * (the gate runs before the ready-repo gate and this parser, so the wordings must not drift). */
export const TYPE_VALUE_ERROR = "logs --type needs an event type";

/** The exact-type empty-match prose: the same no-match shape `--grep` uses, naming the type
 * whose value matched nothing, so the two filters' empty replies cannot drift in form. Past the
 * names, a value that is not itself a real event type picks up a did-you-mean hint (the shell
 * completion already offers the valid codes, so a bare no-match for a near-miss reads as a silent
 * mystery) — while a VALID type that merely has no matching events stays hint-free, a legitimate
 * empty result rather than a typo. A valid type or a legacy alias (canonicalEventType maps the
 * alias onto the current code, which is a label key) never hints. For a comma list the hint
 * is for the first piece that is not a valid type; the prose names the value as typed. */
function typeEmpty(type: string, pieces: string[]): string {
  const bad = pieces.find((p) => !Object.hasOwn(EVENT_TYPE_LABELS, canonicalEventType(p)));
  const hint = bad === undefined ? "" : typoSuffix(bad, Object.keys(EVENT_TYPE_LABELS));
  return `no events matching "${type}"${hint}`;
}

/** Test seams for the follow's parent-death watch: they exist so a test can drive it without
 * reparenting a real process. */
export interface FollowSeams {
  ppid?: () => number;
  intervalMs?: number;
}

/** Follow `file` until Ctrl+C or until the process that started this one is gone (the shape of
 * a `logs -f` leaked to PPID 1 that polled for days). Resolves once the parent is gone. */
export function followUntilParentGone(
  file: string,
  offset: number,
  onLines: (lines: string[]) => void,
  seams: FollowSeams,
): Promise<void> {
  const expected = expectedSupervisorPid();
  const stop = followFile(file, offset, onLines);
  return new Promise((resolve) => {
    startParentDeathWatch(() => {
      stop();
      resolve();
    }, {
      ...(expected !== undefined ? { expectedPpid: expected } : {}),
      ...(seams.ppid ? { ppid: seams.ppid } : {}),
      ...(seams.intervalMs !== undefined ? { intervalMs: seams.intervalMs } : {}),
    });
  });
}


/** The `-n` ceiling for the event-log dump (`tumwater logs -n <count>`): a terminal tail has
 * no use for more than this many scanned events, and bounding it keeps an accidental
 * `-n 999999999` from traversing the whole event file. Sister counts are bounded the same way
 * (history's HISTORY_MAX_RUNS, report's REPORT_MAX_DAYS); the GUI clamps its logs counts too. */
const LOGS_MAX_EVENTS = 100_000;

/** `tumwater logs [-f] [-n <count>] [--since <duration>] [--until <duration>]
 * [--role <id>[,<id>...]] [--transcript <id>] [--prompt]
 * [--grep <text>]`: follow or dump the harness event log, with `--since` a bounded
 * past window of it and `--role` keeping only the listed roles' events (a base role id takes its
 * instances too),
 * or with `--transcript` one role's agent transcript (see cmdLogsTranscript). `-f` follows until
 * Ctrl+C or until its parent process exits. */
export async function cmdLogs(root: string, args: string[], seams: FollowSeams = {}): Promise<void> {
  const feed = parseLogsFeed(root, args);
  // `--since <duration>` is the window-shaped view over the same event log the -n view dumps:
  // it reads a bounded past window (event-window.ts's day-keyed backwards scan) and prints the
  // survivors oldest-first, so an operator can ask for "the hour around that 429 storm" without
  // guessing a count. Rival shapes stay exclusive — follow means "from now on", -n means "last
  // N", and --transcript swaps in a transcript rather than this log — and each failure names
  // both flags. (--prompt requires --transcript, so it is excluded with it.)
  const ms = parseSinceFlag(feed.rest, "logs --since", LOGS_SINCE_MAX_MS);
  const untilMs = parseSinceFlag(feed.rest, "logs --until", LOGS_SINCE_MAX_MS, "--until");
  failUntilShorterThanSince("logs", untilMs, ms);
  if (ms !== null) {
    sayLogsWindow(root, feed, ms, untilMs);
    return;
  }
  const nRaw = flagValue(feed.rest, "-n");
  const limit = nRaw !== null ? parseCountFlag("-n", nRaw, LOGS_MAX_EVENTS) : 50;
  // The event feed (no --transcript) never needs the config at all: parseRoleScope reads it only
  // when the flag is present.
  const role = parseRoleScope(root, feed.rest, "--transcript", LOGS_TRANSCRIPT_VALUE_ERROR);
  const showPrompts = feed.rest.includes("--prompt");
  if (showPrompts && role === null) fail("logs --prompt needs --transcript <id>");
  if (role !== null) {
    await cmdLogsTranscript(root, role, limit, feed.follow, showPrompts, feed.grepLower, feed.grepPattern, seams);
    return;
  }
  await sayLogsTail(root, feed, limit, seams);
}

interface LogsFeed {
  rest: string[];
  grepPattern: string | null;
  grepLower: string | null;
  type: string | null;
  typePieces: string[];
  roles: string[] | null;
  roleEmpty: string;
  notable: boolean;
  json: boolean;
  count: boolean;
  follow: boolean;
  filtersGrepOrType: boolean;
  filter: (e: HarnessEvent) => boolean;
}

/** Scan the one-shot flag vocabulary (`--grep`, `--type`, `--role`, `--notable`, `--json`,
 * `--count`, `-f`) and compose it into the single `filter` rule plus the locals every feed view
 * shares. One scan (and one home for each rival check), so no flag rule lives in a view and a
 * `--since`/`--count`/`-f` rule is found here by name. */
function parseLogsFeed(root: string, args: string[]): LogsFeed {
  // `--grep <text>` filters the event feed (the -n view and its follow) and, with --transcript,
  // the transcript's entries (see cmdLogsTranscript): case-insensitive
  // substring against `${e.type} ${formatEvent(e)}` — the rendered line is what the operator
  // would otherwise read (WYSIWYG), and prefixing the raw type id lets stable ids
  // (review_rejected, merge_failed) be filtered even where the rendering paraphrases them.
  // --grep filters the --since window like --type and --role do. The flag scan itself
  // (the value lookup, the `rest` construction that keeps a flag-shaped pattern from
  // impersonating a rival flag, and the empty-value fail) is cli/cli-args.ts's parseGrepFlag,
  // the one home shared with history's identical preamble.
  const { rest: grepped, pattern: grepPattern } = parseGrepFlag(args, GREP_VALUE_ERROR);
  // `--type <eventType>` filters the event feed by EXACT event type (e.type === value):
  // deterministic where --grep substrings — a merge_failed whose rendered line quotes
  // "merge_failed" matches --grep but not --type. It composes with --since
  // (the window it filters) as well as -n, -f, --json, and --grep; like --json
  // it is a rival only of the --transcript/--prompt transcript view. A comma list matches any
  // of its types. The value scan (keeping a
  // flag-shaped value like --since as text, the empty-value fail) mirrors parseGrepFlag via
  // parseTypeFlag, so the two cannot drift; `rest` here has both flags' value tokens removed.
  const { rest, type } = parseTypeFlag(grepped, TYPE_VALUE_ERROR);
  const grepLower = grepPattern === null ? null : grepPattern.toLowerCase();
  // An older event name matches its current one; the empty-match prose still names what was typed.
  const typePieces = type === null ? [] : splitCommaList(type);
  if (type !== null && typePieces.length === 0) fail(TYPE_VALUE_ERROR);
  const wantedTypes = new Set(typePieces.map(canonicalEventType));
  const typeFilter = type === null ? null : (e: HarnessEvent) => wantedTypes.has(e.type);
  // The composed feed rule every emit site threads through: an event passes when it is
  // absent-or-matches the --grep substring AND absent-or-equals the --type id AND (for --role)
  // is filed under a listed role AND (for --notable) is not routine, held in one place so the
  // --since window, the -n tally, and the follow cannot drift on what an event must satisfy.
  // `--role <id>[,<id>...]` joins them: an event passes when the role it was filed under, or
  // that role's base id (so `--role feature` takes `feature-2` too), is listed. It
  // composes with --since. The value scan reads `rest`, which holds no --grep/--type value tokens.
  const roles = parseRoleListScope(root, rest);
  const roleFilter = roles === null
    ? null
    : (e: HarnessEvent) => roleInScope(eventRole(e), roles);
  if (roles !== null) rejectTranscriptViewRival(rest, "--role", true);
  // `--notable` culls routine bookkeeping events the way the dashboard Activity feed's Notable
  // choice does (src/ui/tone.ts eventKind): only non-routine rows pass the feed. One harness-side
  // rule (isNotableEvent) shared with the TUI Activity pane, so the CLI feed and the pane cannot
  // disagree about what a notable filter hides. It composes with --since, --grep, --type, --role,
  // -n, -f, --count and --json, and — like --json/--count/--type/--since — is a rival only of the
  // --transcript transcript view.
  const notable = rest.includes("--notable");
  rejectTranscriptViewRival(rest, "--notable", notable);
  const filter = (e: HarnessEvent) =>
    (grepLower === null || eventMatchesGrep(e, grepLower)) &&
    (typeFilter === null || typeFilter(e)) &&
    (roleFilter === null || roleFilter(e)) &&
    (!notable || isNotableEvent(e.type, eventResult(e)));
  // Empty-match prose: grep/type keep their wording when given; a role-only filter names the roles.
  const roleEmpty = roles === null ? "" : `no events from ${roles.join(", ")}`;
  const filtersGrepOrType = grepPattern !== null || type !== null;
  const follow = hasFollowFlag(rest);
  // `--json` switches the feed from formatEvent rendering to one JSON.stringify(e) per line —
  // the raw HarnessEvent objects exactly as stored in the log — so scripts read the canonical
  // schema instead of parsing a rendering that changes shape whenever the formatter evolves.
  // It composes with -n, --grep, --since and -f (the grep filter applies before serialization,
  // the follow streams JSON lines as events land), but not with --transcript: that view is a pi
  // transcript of human-oriented prose, not the event log (--prompt requires --transcript, so it is
  // excluded with it).
  const json = rest.includes("--json");
  rejectTranscriptViewRival(rest, "--json", json);
  // `--count` tallies the window's present event types instead of printing the rows. Rival
  // shapes stay exclusive: counting implies a bounded window (so -f/--follow is rejected)
  // and the --transcript view is the role's agent transcript rather than the event log.
  const count = rest.includes("--count");
  rejectTranscriptViewRival(rest, "--count", count);
  if (count && follow)
    failRivalShapes("logs --count", "-f/--follow", "counting implies a bounded window; -f follows from now on");
  if (type !== null) rejectTranscriptViewRival(rest, "--type", true);
  return { rest, grepPattern, grepLower, type, typePieces, roles, roleEmpty, notable, json, count, follow, filtersGrepOrType, filter };
}

/** The `--since`/`--until` bounded-window view: its three rival checks (`-f`, `-n`,
 * `--transcript`), the `readEventsSince` read and the `untilMs` filter, then the empty-window
 * prose, the `--count` tally, the per-event print and the sparse-window note. */
function sayLogsWindow(root: string, feed: LogsFeed, ms: number, untilMs: number | null): void {
  if (feed.follow)
    failRivalShapes("logs --since", "-f/--follow", 'follow means "from now on"; --since shows a bounded past window');
  if (feed.rest.includes("-n")) failRivalShapes("logs --since", "-n", "a count and a window are rival shapes");
  rejectTranscriptViewRival(feed.rest, "--since", true);
  // covered is only consulted below when the window has rows (an empty window returns
  // earlier), so the helper's vacuous empty-log branch never reaches the note here.
  const { cutoff, events: windowEvents, covered } = readEventsSince(root, ms);
  const events = untilMs === null ? windowEvents : windowEvents.filter((e) => e.ts < cutoff + ms - untilMs);
  const windowPhrase =
    untilMs === null ? `in ${durationLabel(ms)}` : betweenWindow(ms, untilMs);
  // `--grep`, `--type` and `--role` all filter the window through feed.filter: only the
  // window events that pass are printed, and an all-filtered window answers with the
  // no-match prose (the filter's own line) instead of the generic empty-window one —
  // "which merge_failed in the last hour" filters the same as it would the -n view.
  const filtered = events.filter(feed.filter);
  if (filtered.length === 0) {
    // In JSON mode an empty result answers silently — an empty output IS the machine-readable
    // answer, and prose would corrupt a consumer's NDJSON stream.
    if (!feed.json) sayLogsWindowNoMatch(feed, windowPhrase);
    return;
  }
  // `--count` composes with the window: the tally covers exactly the filtered window rows
  // the plain view would print (and answers the empty window with the plain view's own
  // prose above), so the two cannot disagree on which events count. Never printed with the
  // sparse-window note below: the note rides rows, and a count has none.
  if (feed.count) {
    sayTally(filtered, feed.json);
    return;
  }
  for (const e of filtered) sayEventLine(e, feed.json);
  // A sparse window is never mistaken for a quiet team — but the note only ever rides rows:
  // with no rows at all (a fresh install's missing log among them) there is nothing sparse to
  // explain, and a flat "rotated out" claim would be false for a log that never had events.
  // The hedged phrasing stays true whenever it prints: the oldest retained event being inside
  // the window is exactly the unproven case, whether the cause is rotation or idleness.
  if (!covered && !feed.json) say(SPARSE_WINDOW_NOTE);
}

/** The `--since` window's empty-match prose (the `no notable events <window>`,
 * `no events matching … or …`, typeEmpty, grep and role branches), kept byte-identical and
 * still skipped in JSON mode. */
function sayLogsWindowNoMatch(feed: LogsFeed, windowPhrase: string): void {
  if (feed.notable && feed.grepPattern === null && feed.type === null && feed.roles === null)
    say(`no notable events ${windowPhrase}`);
  else if (feed.grepPattern !== null && feed.type !== null)
    say(`no events matching "${feed.grepPattern}" or ${typeEmpty(feed.type, feed.typePieces)}`);
  else if (feed.type !== null) say(typeEmpty(feed.type, feed.typePieces));
  else if (feed.grepPattern !== null) say(`no events matching "${feed.grepPattern}" ${windowPhrase}`);
  else say(feed.roles !== null ? `${feed.roleEmpty} ${windowPhrase}` : `no events ${windowPhrase}`);
}

/** The `-n` tail view and its follow: `readEventsTailWithEnd`, the `shown` filter, the
 * `--count` branch and its empty-match prose, the per-event print, the `!follow` return, and
 * `followUntilParentGone` seeded from `tail.coveredEnd`. It owns the follow-loop locals. */
async function sayLogsTail(root: string, feed: LogsFeed, limit: number, seams: FollowSeams): Promise<void> {
  // -n bounds the scan, not the print: the matched subset of the last `limit` events is what
  // appears, so `-n 200 --grep merge_failed` may print 3 rows from 200 scanned. The read is
  // the tail-with-end shape (not the per-poll cached readEvents) so the follow below can seed
  // from the byte end this very read covered instead of a later stat of the file.
  const tail = readEventsTailWithEnd(root, limit);
  const shown = feed.grepLower !== null || feed.type !== null || feed.roles !== null || feed.notable ? tail.events.filter(feed.filter) : tail.events;
  // `--count` over the -n view answers with the tally of exactly the filtered rows the plain
  // view would print, and carries over the plain view's empty-match prose below (a `--type`
  // or `--grep` that matches nothing names its value; an empty unfiltered -n view prints
  // nothing, as the plain view does). In JSON mode the empty output is the answer.
  if (feed.count) {
    if (shown.length !== 0) sayTally(shown, feed.json);
    else if (!feed.json && (feed.filtersGrepOrType || feed.roles !== null || feed.notable)) sayLogsTailNoMatch(feed);
    return;
  }
  for (const e of shown) sayEventLine(e, feed.json);
  if (!feed.follow) {
    // The empty-match line is prose: in JSON mode the empty output is the answer. It fires
    // for either filter, naming the flag's value(s) whose match came up empty so the operator
    // knows what to loosen.
    if (shown.length === 0 && !feed.json && (feed.filtersGrepOrType || feed.roles !== null || feed.notable)) sayLogsTailNoMatch(feed);
    return;
  }
  const file = eventsLogPath(root);
  // Seed the follow from the byte end the initial read covered (tail.coveredEnd), mirroring
  // cmdLogsTranscript's tail.end seed: an event appended between the read and the follow's
  // start lies past the printed window but at or above this offset, so the follow's first
  // poll delivers it — seeding from a fresh statOrNull(file).size instead would start past
  // it and silently drop exactly the event an operator watching a failure needs. A missing
  // log scans to coveredEnd 0, and followFile tolerates a missing file (its poll re-stats
  // every interval), so a read-only command never leaves a harness state file behind — the
  // module contract above promises writes to stdout only.
  await followUntilParentGone(file, tail.coveredEnd, (lines) => {
    for (const line of lines.filter(Boolean)) {
      const e = parseEventLine(line);
      // The filter holds across rotation: every event the follow callback sees goes through
      // the same match rule as the seeded window.
      if (e && feed.filter(e)) sayEventLine(e, feed.json);
    }
  }, seams);
}

/** The `-n` view's empty-match prose, shared by the `--count` tally branch and the plain
 * branch (the two byte-identical blocks become two calls) so they cannot drift. */
function sayLogsTailNoMatch(feed: LogsFeed): void {
  if (feed.notable && feed.grepPattern === null && feed.type === null && feed.roles === null)
    say("no notable events");
  else if (feed.grepPattern !== null && feed.type !== null)
    say(`no events matching "${feed.grepPattern}" or ${typeEmpty(feed.type, feed.typePieces)}`);
  // Type-empty gets the hint (only the type branch); a grep-only empty stays the bare
  // no-match line, because a free-text pattern is not an event type to suggest against.
  else if (!feed.filtersGrepOrType) say(feed.roleEmpty);
  else say(feed.type !== null ? typeEmpty(feed.type, feed.typePieces) : `no events matching "${feed.grepPattern ?? ""}"`);
}

/** `tumwater logs --transcript <id>`: print (and optionally follow) one role's agent transcript —
 * run separators, abbreviated thinking, assistant text, and tool calls; with `--prompt` also
 * each run's exact prompt text. Read-only; the raw log is pi's streaming event stream, so only
 * complete renderable events are shown. With `--grep`, only entries with a rendered line
 * containing the text (case-insensitively) print, each under its run's separator; `-n` still
 * bounds the entries scanned, not printed. */
async function cmdLogsTranscript(
  root: string,
  role: string,
  limit: number,
  follow: boolean,
  showPrompts: boolean,
  needle: string | null,
  pattern: string | null,
  seams: FollowSeams,
): Promise<void> {
  const file = piLogPath(root, role);
  const opts = { includePrompts: showPrompts };

  const filter = needle === null ? null : createTranscriptFilter(needle);
  let matched = 0;
  const printEntry = (lines: string[]) => {
    if (lines.length === 0) return;
    if (filter === null) {
      say(lines.join("\n"));
      return;
    }
    const out = filter(lines);
    if (out === null) return;
    matched++;
    say(out.join("\n"));
  };

  // Initial window: the last `limit` entries of what is on disk. readTranscriptTail scans back
  // from EOF only as far as needed instead of re-reading the whole (up to logMaxBytes) file,
  // and its offset stops at the last complete newline, so a torn trailing line is re-read once
  // it completes instead of lost.
  let offset = 0;
  const tail = readTranscriptTail(file, limit, opts); // null when there's no log yet (or it's empty).
  if (!tail) {
    say(`no transcript yet for ${role}`);
  } else {
    for (const entry of tail.entries) printEntry(entry);
    offset = tail.end;
    if (needle !== null && matched === 0) say(`no transcript entries matching "${pattern ?? ""}" for ${role}`);
  }
  if (!follow) return;

  // Follow from where the initial window stopped, so each turn prints exactly once when its
  // message_end lands (torn trailing lines are held back by followFile). A fresh renderer:
  // readTranscriptTail's formatTranscript already flushed any pending separator for what
  // was on disk.
  const renderer = createTranscriptRenderer(opts);
  await followUntilParentGone(file, offset, (lines) => {
    for (const line of lines) printEntry(renderer.feed(line));
  }, seams);
}
