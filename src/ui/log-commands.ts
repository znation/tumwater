import { durationLabel, fail, failOverDurationCap, flagValue, parseCountFlag, parseDurationFlag, parseRoleScope, say } from "../cli-args.js";
import { dayKey } from "../datetime.js";
import { eventWindowCovers, LOGS_SINCE_MAX_MS, readWindowEvents } from "../event-window.js";
import { parseEventLine, readEvents, type HarnessEvent } from "../events.js";
import { formatEvent } from "../event-format.js";
import { statOrNull } from "../files.js";
import { followFile } from "../tail.js";
import { createTranscriptRenderer } from "./transcript.js";
import { readTranscriptTail } from "./transcript-tail.js";
import { eventsLogPath, piLogPath } from "../paths.js";

/** The read-only observing half of the CLI's non-dispatch commands: `tumwater logs` and its
 * `--role` transcript view, split out of cli.ts so the entry point stays a dispatch table.
 * Unlike operator-commands.ts these write nothing but stdout — they only read the event log
 * and each loop's pi transcript. It lives in ui/ with the rendering layer it drives: it imports
 * the event formatter, the transcript renderer, and the file-following helpers, so placing it
 * here keeps the documented rule that src/ui/ is imported only by itself and cli.ts. */

/** The shared rival-shape guard for logs flags that only apply to the event-log feed:
 * `--role` swaps in a pi transcript rather than the event log (--prompt requires --role, so
 * it is excluded with it), so each such flag fails naming both. One wording for all of them —
 * the --json, --grep, and --since checks cannot drift apart in what they say or why. `active`
 * is the flag's own presence — --json alone composes with nothing here but --role, while
 * --grep and --since call from inside their own presence guards. */
function rejectRoleViewRival(rest: string[], flag: string, active: boolean): void {
  if (active && (rest.includes("--role") || rest.includes("--prompt")))
    fail(`logs ${flag} cannot be combined with --role (the --role view is a pi transcript, not the event log; --prompt requires --role)`);
}

/** `tumwater logs [-f] [-n <count>] [--since <duration>] [--role <id>] [--prompt]`: follow or
 * dump the harness event log, with `--since` a bounded past window of it, or with `--role` one
 * loop's pi transcript (see cmdLogsTranscript). */
/** The missing-pattern error cmdLogs prints for a valueless `--grep`, exported so cli.ts's
 * rejectUnknownArgs spec for --grep can fail a trailing `logs --grep` with the same wording
 * (the gate runs before the ready-repo gate and this parser, so the wordings must not drift). */
export const GREP_VALUE_ERROR = "logs --grep needs a pattern";

export async function cmdLogs(root: string, args: string[]): Promise<void> {
  // `--grep <text>` filters the event feed (the -n view and its follow): case-insensitive
  // substring against `${e.type} ${formatEvent(e)}` — the rendered line is what the operator
  // would otherwise read (WYSIWYG), and prefixing the raw type id lets stable ids
  // (review_rejected, land_failed) be filtered even where the rendering paraphrases them.
  // Rival shapes stay exclusive — --role swaps in a pi transcript rather than this event log
  // (--prompt requires --role, so it is excluded with it), and --since is a filter of its own
  // rather than a window to filter — and each failure names both flags.
  const grepFlag = args.indexOf("--grep");
  const grepRaw = flagValue(args, "--grep");
  let grepPattern: string | null = null;
  let grepLower: string | null = null;
  // A flag-shaped token sitting at the --grep value's position IS the pattern, not the flag it
  // spells: `logs --grep -f` greps for the text "-f", and `--grep --since` greps for "--since".
  // Every flag scan below therefore runs over `rest` — args with that one position removed — so
  // the pattern cannot impersonate a rival flag (entering follow mode under `-f`) and a rival
  // check cannot misfire on the pattern (rejecting a legitimate grep). With no --grep, rest is
  // args unchanged and every scan behaves exactly as before. flagValue keeps doing the value
  // lookup, but over `rest` from --since on: a pattern spelling a rival flag must not be read
  // as that flag's value any more than it may be counted as the flag.
  const rest = grepFlag >= 0 ? args.filter((_, i) => i !== grepFlag + 1) : args;
  const follow = rest.includes("-f") || rest.includes("--follow");
  // `--json` switches the feed from formatEvent rendering to one JSON.stringify(e) per line —
  // the raw HarnessEvent objects exactly as stored in the log — so scripts read the canonical
  // schema instead of parsing a rendering that changes shape whenever the formatter evolves.
  // It composes with -n, --grep, --since and -f (the grep filter applies before serialization,
  // the follow streams JSON lines as events land), but not with --role: that view is a pi
  // transcript of human-oriented prose, not the event log (--prompt requires --role, so it is
  // excluded with it).
  const json = rest.includes("--json");
  rejectRoleViewRival(rest, "--json", json);
  if (grepRaw !== null) {
    rejectRoleViewRival(rest, "--grep", true);
    if (rest.includes("--since"))
      fail("logs --grep cannot be combined with --since (--since is a filter of its own; --grep filters the -n view and its follow)");
    if (grepRaw === undefined || grepRaw === "") fail(GREP_VALUE_ERROR);
    grepPattern = grepRaw;
    grepLower = grepRaw.toLowerCase();
  }
  // `--since <duration>` is the window-shaped view over the same event log the -n view dumps:
  // it reads a bounded past window (event-window.ts's day-keyed backwards scan) and prints the
  // survivors oldest-first, so an operator can ask for "the hour around that 429 storm" without
  // guessing a count. Rival shapes stay exclusive — follow means "from now on", -n means "last
  // N", and --role swaps in a pi transcript rather than this event log — and each failure names
  // both flags. (--prompt requires --role, so it is excluded with it.)
  const sinceRaw = flagValue(rest, "--since");
  if (sinceRaw !== null) {
    if (follow)
      fail('logs --since cannot be combined with -f/--follow (follow means "from now on"; --since shows a bounded past window)');
    if (rest.includes("-n")) fail("logs --since cannot be combined with -n (a count and a window are rival shapes)");
    rejectRoleViewRival(rest, "--since", true);
    const ms = parseDurationFlag("--since", sinceRaw);
    failOverDurationCap("logs --since", ms, LOGS_SINCE_MAX_MS);
    // The window key is the cutoff's local calendar day, from the shared dayKey helper
    // eventDayKey buckets events with, so the read's day keys cannot disagree with the ts
    // filter below; the day-keyed read may include earlier hours of that day, which the
    // ts filter removes (over-read is at most one day's events).
    const cutoff = Date.now() - ms;
    const window = readWindowEvents(root, dayKey(cutoff));
    const events = window.events.filter((e) => typeof e.ts === "number" && e.ts >= cutoff);
    // covered is only consulted below when the window has rows (an empty window returns
    // earlier), so the helper's vacuous empty-log branch never reaches the note here.
    const covered = eventWindowCovers(window, cutoff);
    if (events.length === 0) {
      // In JSON mode an empty window answers silently — an empty output IS the machine-readable
      // answer, and prose would corrupt a consumer's NDJSON stream.
      if (!json) say(`no events in ${durationLabel(ms)}`);
      return;
    }
    for (const e of events) say(json ? JSON.stringify(e) : formatEvent(e));
    // A sparse window is never mistaken for a quiet fleet — but the note only ever rides rows:
    // with no rows at all (a fresh install's missing log among them) there is nothing sparse to
    // explain, and a flat "rotated out" claim would be false for a log that never had events.
    // The hedged phrasing stays true whenever it prints: the oldest retained event being inside
    // the window is exactly the unproven case, whether the cause is rotation or idleness.
    if (!covered && !json)
      say("note: the log's oldest retained event lies inside this window; older events may have rotated out");
    return;
  }
  const nRaw = flagValue(rest, "-n");
  const limit = nRaw !== null ? parseCountFlag("-n", nRaw) : 50;
  // The event feed (no --role) never needs the config at all: parseRoleScope reads it only
  // when the flag is present.
  const role = parseRoleScope(root, rest);
  const showPrompts = rest.includes("--prompt");
  if (showPrompts && role === null) fail("logs --prompt needs --role <id>");
  if (role !== null) {
    await cmdLogsTranscript(root, role, limit, follow, showPrompts);
    return;
  }
  // -n bounds the scan, not the print: the matched subset of the last `limit` events is what
  // appears, so `-n 200 --grep land_failed` may print 3 rows from 200 scanned.
  const shown = grepLower
    ? readEvents(root, limit).filter((e) => matchesGrep(e, grepLower))
    : readEvents(root, limit);
  for (const e of shown) say(json ? JSON.stringify(e) : formatEvent(e));
  if (!follow) {
    // The empty-match line is prose: in JSON mode the empty output is the answer.
    if (grepPattern !== null && shown.length === 0 && !json)
      say(`no events matching "${grepPattern}"`);
    return;
  }
  const file = eventsLogPath(root);
  // Seed the offset from what is on disk without creating anything: followFile tolerates a
  // missing file (its poll re-stats every interval), so a read-only command never leaves a
  // harness state file behind — the module contract above promises writes to stdout only.
  followFile(file, statOrNull(file)?.size ?? 0, (lines) => {
    for (const line of lines.filter(Boolean)) {
      const e = parseEventLine(line);
      // The filter holds across rotation: every event the follow callback sees goes through
      // the same match rule as the seeded window.
      if (e && (grepLower === null || matchesGrep(e, grepLower)))
        say(json ? JSON.stringify(e) : formatEvent(e));
    }
  });
  await new Promise(() => {}); // Follow until Ctrl+C.
}

/** The --grep match rule: case-insensitive substring over the raw event type prefixed to the
 * rendered line — exactly the haystack the operator would otherwise read. */
function matchesGrep(e: HarnessEvent, patternLower: string): boolean {
  return `${e.type} ${formatEvent(e)}`.toLowerCase().includes(patternLower);
}

/** `tumwater logs --role <id>`: print (and optionally follow) one loop's pi transcript —
 * run separators, abbreviated thinking, assistant text, and tool calls; with `--prompt` also
 * each run's exact prompt text. Read-only; the raw log is pi's streaming event stream, so only
 * complete renderable events are shown. */
async function cmdLogsTranscript(
  root: string,
  role: string,
  limit: number,
  follow: boolean,
  showPrompts: boolean,
): Promise<void> {
  const file = piLogPath(root, role);
  const opts = { includePrompts: showPrompts };

  const printEntry = (lines: string[]) => {
    if (lines.length > 0) say(lines.join("\n"));
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
  }
  if (!follow) return;

  // Follow from where the initial window stopped, so each turn prints exactly once when its
  // message_end lands (torn trailing lines are held back by followFile). A fresh renderer:
  // readTranscriptTail's formatTranscript already flushed any pending separator for what was on disk.
  const renderer = createTranscriptRenderer(opts);
  followFile(file, offset, (lines) => {
    for (const line of lines) printEntry(renderer.feed(line));
  });
  await new Promise(() => {}); // Follow until Ctrl+C.
}
