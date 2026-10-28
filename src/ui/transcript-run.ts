import fs from "node:fs";
import { createTranscriptFilter, formatTranscript } from "./transcript.js";
import { parsePiEventLine } from "../pi/pi-event-line.js";

/** One past run's agent transcript for `tumwater history <role> <n> --transcript`: the raw pi
 * log (and its one rotated generation) is split into segments at each harness `tumwater_run`
 * marker, a segment's start time is the marker's `ts` — or, for a marker written before it
 * carried one, the `timestamp` of the segment's first user `message_end` (the field the
 * renderer stamps its separator from). A segment with neither is skipped. */

const MARKER_ONLY = new Set(["tumwater_run"]);
const MESSAGE_ONLY = new Set(["message_end"]);

function segmentsInText(text: string): string[][] {
  const segments: string[][] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.includes('"tumwater_run"') && parsePiEventLine(line, MARKER_ONLY)) segments.push([line]);
    else segments.at(-1)?.push(line);
  }
  return segments;
}

function keepInWindow(segments: string[][], fromTs: number, toTs: number | null): string[] {
  const kept: string[] = [];
  for (const seg of segments) {
    const start = segmentStart(seg);
    if (start !== null && start >= fromTs && start <= (toTs ?? Infinity)) kept.push(...seg);
  }
  return kept;
}

function applyTranscriptGrep(entries: string[][], grep: string): string[] {
  const keep = createTranscriptFilter(grep);
  return entries.flatMap((e) => keep(e) ?? []);
}

function segmentStart(lines: string[]): number | null {
  const marker = parsePiEventLine<{ ts?: unknown }>(lines[0] as string, MARKER_ONLY);
  if (typeof marker?.ts === "number") return marker.ts;
  for (const line of lines) {
    if (!line.includes('"user"')) continue;
    const ev = parsePiEventLine<{ message?: { role?: unknown; timestamp?: unknown } }>(line, MESSAGE_ONLY);
    if (ev?.message?.role === "user" && typeof ev.message.timestamp === "number") return ev.message.timestamp;
  }
  return null;
}

/** Rendered lines of every agent run in `file` (+ ".1", oldest first) whose start is within
 * [fromTs, toTs] (toTs null = open-ended). A missing file contributes nothing. `includePrompts`
 * renders each run's prompt (`--prompt`). `grep` (already lowercased) keeps only the entries
 * containing it, through the filter `logs --transcript --grep` uses. */
export function readRunTranscript(
  file: string,
  fromTs: number,
  toTs: number | null,
  opts: { includePrompts?: boolean; grep?: string } = {},
): string[] {
  const kept: string[] = [];
  for (const f of [file + ".1", file]) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    kept.push(...keepInWindow(segmentsInText(text), fromTs, toTs));
  }
  const entries = formatTranscript(kept, opts);
  if (opts.grep === undefined) return entries.flat();
  return applyTranscriptGrep(entries, opts.grep);
}
