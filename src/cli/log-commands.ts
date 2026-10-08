import { fail, say, sayJsonLine } from "./cli-output.js";
import { durationLabel, failRivalShapes, flagValue, parseCountFlag, parseGrepFlag, parseRoleScope, parseSinceFlag } from "./cli-args.js";
import {
  LOGS_SINCE_MAX_MS,
  readEventsSince,
  SPARSE_WINDOW_NOTE,
} from "../events/event-window.js";
import { parseEventLine, readEventsTailWithEnd } from "../events/event-read.js";
import type { HarnessEvent } from "../events/events.js";
import { formatEvent } from "../events/event-format.js";
import { followFile } from "../files/tail.js";
import { createTranscriptRenderer } from "../ui/transcript.js";
import { readTranscriptTail } from "../ui/transcript-tail.js";
import { eventsLogPath, piLogPath } from "../paths.js";

/** The read-only observing half of the CLI's non-dispatch commands: `tumwater logs` and its
 * `--role` transcript view, split out of cli.ts so the entry point stays a dispatch table.
 * Unlike operator/operator-commands.ts these write nothing but stdout — they only read the event log
 * and each loop's pi transcript. It lives beside the other CLI command bodies (history.ts,
 * cli/cli-query-commands.ts, operator/operator-commands.ts), which may import the ui/ rendering layer they
 * drive — here the event formatter and the transcript renderer — while src/ui/ itself stays
 * off src/ module boundaries it does not own. */

/** Print one event as the feed line: formatEvent's rendered line, or — in `--json` mode — the
 * raw HarnessEvent serialized exactly as stored in the log. The one home of the
 * render-or-serialize choice the -n dump, the --since window, and the follow stream share, so
 * the three cannot drift on what `logs --json` emits (the sayJson precedent: one place decides
 * what the machine-readable form looks like). */
function sayEventLine(e: HarnessEvent, json: boolean): void {
  if (json) sayJsonLine(e); // Raw event JSON, not the operator-facing formatEvent line.
  else say(formatEvent(e));
}

/** The shared rival-shape guard for logs flags that only apply to the event-log feed:
 * `--role` swaps in a pi transcript rather than the event log (--prompt requires --role, so
 * it is excluded with it), so each such flag fails naming both. One wording for all of them —
 * the --json, --grep, and --since checks cannot drift apart in what they say or why. `active`
 * is the flag's own presence — --json alone composes with nothing here but --role, while
 * --grep and --since call from inside their own presence guards. */
function rejectRoleViewRival(rest: string[], flag: string, active: boolean): void {
  if (active && (rest.includes("--role") || rest.includes("--prompt")))
    failRivalShapes(`logs ${flag}`, "--role", "the --role view is a pi transcript, not the event log; --prompt requires --role");
}

/** The missing-pattern error cmdLogs prints for a valueless `--grep`, exported so cli.ts's
 * rejectUnknownArgs spec for --grep can fail a trailing `logs --grep` with the same wording
 * (the gate runs before the ready-repo gate and this parser, so the wordings must not drift). */
export const GREP_VALUE_ERROR = "logs --grep needs a pattern";

/** `tumwater logs [-f] [-n <count>] [--since <duration>] [--role <id>] [--prompt]`: follow or
 * dump the harness event log, with `--since` a bounded past window of it, or with `--role` one
 * loop's pi transcript (see cmdLogsTranscript). */
export async function cmdLogs(root: string, args: string[]): Promise<void> {
  // `--grep <text>` filters the event feed (the -n view and its follow): case-insensitive
  // substring against `${e.type} ${formatEvent(e)}` — the rendered line is what the operator
  // would otherwise read (WYSIWYG), and prefixing the raw type id lets stable ids
  // (review_rejected, land_failed) be filtered even where the rendering paraphrases them.
  // Rival shapes stay exclusive — --role swaps in a pi transcript rather than this event log
  // (--prompt requires --role, so it is excluded with it), and --since is a filter of its own
  // rather than a window to filter — and each failure names both flags. The flag scan itself
  // (the value lookup, the `rest` construction that keeps a flag-shaped pattern from
  // impersonating a rival flag, and the empty-value fail) is cli/cli-args.ts's parseGrepFlag,
  // the one home shared with history's identical preamble.
  const { rest, pattern: grepPattern } = parseGrepFlag(args, GREP_VALUE_ERROR);
  const grepLower = grepPattern === null ? null : grepPattern.toLowerCase();
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
  if (grepPattern !== null) {
    rejectRoleViewRival(rest, "--grep", true);
    if (rest.includes("--since"))
      failRivalShapes("logs --grep", "--since", "--since is a filter of its own; --grep filters the -n view and its follow");
  }
  // `--since <duration>` is the window-shaped view over the same event log the -n view dumps:
  // it reads a bounded past window (event-window.ts's day-keyed backwards scan) and prints the
  // survivors oldest-first, so an operator can ask for "the hour around that 429 storm" without
  // guessing a count. Rival shapes stay exclusive — follow means "from now on", -n means "last
  // N", and --role swaps in a pi transcript rather than this event log — and each failure names
  // both flags. (--prompt requires --role, so it is excluded with it.)
  const ms = parseSinceFlag(rest, "logs --since", LOGS_SINCE_MAX_MS);
  if (ms !== null) {
    if (follow)
      failRivalShapes("logs --since", "-f/--follow", 'follow means "from now on"; --since shows a bounded past window');
    if (rest.includes("-n")) failRivalShapes("logs --since", "-n", "a count and a window are rival shapes");
    rejectRoleViewRival(rest, "--since", true);
    // covered is only consulted below when the window has rows (an empty window returns
    // earlier), so the helper's vacuous empty-log branch never reaches the note here.
    const { events, covered } = readEventsSince(root, ms);
    if (events.length === 0) {
      // In JSON mode an empty window answers silently — an empty output IS the machine-readable
      // answer, and prose would corrupt a consumer's NDJSON stream.
      if (!json) say(`no events in ${durationLabel(ms)}`);
      return;
    }
    for (const e of events) sayEventLine(e, json);
    // A sparse window is never mistaken for a quiet fleet — but the note only ever rides rows:
    // with no rows at all (a fresh install's missing log among them) there is nothing sparse to
    // explain, and a flat "rotated out" claim would be false for a log that never had events.
    // The hedged phrasing stays true whenever it prints: the oldest retained event being inside
    // the window is exactly the unproven case, whether the cause is rotation or idleness.
    if (!covered && !json) say(SPARSE_WINDOW_NOTE);
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
  // appears, so `-n 200 --grep land_failed` may print 3 rows from 200 scanned. The read is
  // the tail-with-end shape (not the per-poll cached readEvents) so the follow below can seed
  // from the byte end this very read covered instead of a later stat of the file.
  const tail = readEventsTailWithEnd(root, limit);
  const shown = grepLower ? tail.events.filter((e) => matchesGrep(e, grepLower)) : tail.events;
  for (const e of shown) sayEventLine(e, json);
  if (!follow) {
    // The empty-match line is prose: in JSON mode the empty output is the answer.
    if (grepPattern !== null && shown.length === 0 && !json)
      say(`no events matching "${grepPattern}"`);
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
  followFile(file, tail.coveredEnd, (lines) => {
    for (const line of lines.filter(Boolean)) {
      const e = parseEventLine(line);
      // The filter holds across rotation: every event the follow callback sees goes through
      // the same match rule as the seeded window.
      if (e && (grepLower === null || matchesGrep(e, grepLower)))
        sayEventLine(e, json);
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
