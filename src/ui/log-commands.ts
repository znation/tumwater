import fs from "node:fs";
import { knownRoleIds, loadConfig } from "../config.js";
import { fail, parseCountFlag, parseRoleFlag } from "../cli-args.js";
import { parseEventLine, readEvents } from "../events.js";
import { formatEvent } from "./event-format.js";
import { ensureParentDir } from "../files.js";
import { followFile } from "./tail.js";
import { createTranscriptRenderer } from "./transcript.js";
import { readTranscriptTail } from "./transcript-tail.js";
import { eventsLogPath, piLogPath } from "../paths.js";

/** The read-only observing half of the CLI's non-dispatch commands: `tumwater logs` and its
 * `--role` transcript view, split out of cli.ts so the entry point stays a dispatch table.
 * Unlike operator-commands.ts these write nothing but stdout — they only read the event log
 * and each loop's pi transcript. It lives in ui/ with the rendering layer it drives: it imports
 * the event formatter, the transcript renderer, and the file-following helpers, so placing it
 * here keeps the documented rule that src/ui/ is imported only by itself and cli.ts. */

/** `tumwater logs [-f] [-n <count>] [--role <id>] [--prompt]`: follow or dump the harness event
 * log, or with `--role` one loop's pi transcript (see cmdLogsTranscript). */
export async function cmdLogs(root: string, args: string[]): Promise<void> {
  const follow = args.includes("-f") || args.includes("--follow");
  const nFlag = args.indexOf("-n");
  const limit = nFlag >= 0 ? parseCountFlag("-n", args[nFlag + 1]) : 50;
  // The config is needed only to validate --role against built-ins PLUS user-defined loops —
  // loading it unconditionally would make a broken tumwater.json break the read-only event
  // feed too, which never needs it.
  const role = args.includes("--role") ? parseRoleFlag(args, knownRoleIds(loadConfig(root))) : null;
  const showPrompts = args.includes("--prompt");
  if (showPrompts && role === null) fail("logs --prompt needs --role <id>");
  if (role !== null) {
    await cmdLogsTranscript(root, role, limit, follow, showPrompts);
    return;
  }
  for (const e of readEvents(root, limit)) process.stdout.write(formatEvent(e) + "\n");
  if (!follow) return;
  const file = eventsLogPath(root);
  ensureParentDir(file);
  if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  followFile(file, fs.statSync(file).size, (lines) => {
    for (const line of lines.filter(Boolean)) {
      const e = parseEventLine(line);
      if (e) process.stdout.write(formatEvent(e) + "\n");
    }
  });
  await new Promise(() => {}); // Follow until Ctrl+C.
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
    if (lines.length > 0) process.stdout.write(lines.join("\n") + "\n");
  };

  // Initial window: the last `limit` entries of what is on disk. readTranscriptTail scans back
  // from EOF only as far as needed instead of re-reading the whole (up to logMaxBytes) file,
  // and its offset stops at the last complete newline, so a torn trailing line is re-read once
  // it completes instead of lost.
  let offset = 0;
  const tail = readTranscriptTail(file, limit, opts); // null when there's no log yet (or it's empty).
  if (!tail) {
    process.stdout.write(`no transcript yet for ${role}\n`);
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
