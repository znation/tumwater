/** Fixtures for the files tests write and assert on: events.jsonl under a fixture root, the
 * marker/request files that simulate CLI/operator side effects, and synthetic pi session logs.
 * Plus the two assertions over the event log every topic's tests repeat (eventsOfType,
 * harnessWarnings). The pure time/text oracles assertions compare against live in oracles.ts;
 * the fake-pi line builders these logs are assembled from live in pi-events.ts. */
import fs from "node:fs";
import path from "node:path";
import type { HarnessEvent } from "../src/types.js";
import { readEvents } from "../src/events.js";
import { piLogPath } from "../src/paths.js";
import { tmpdir } from "./repo-fixtures.js";
import { FIXED_TS, agentStart, assistantBlocks, userLine } from "./pi-events.js";

/** Stamp a marker/request file the way tests simulate CLI/operator side effects: create the
 * parent directories, then write `value` as compact JSON directly to `file` with a plain
 * writeFileSync (not the CLI's tmp+rename pretty-printed writeJsonFile path). The only
 * contract that matters is that the orchestrator's readers can parse the bytes. */
export function writeMarker(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** Write events.jsonl under a fixture root's .tumwater/log/ (strings pass through verbatim —
 * for malformed lines; objects are JSON-encoded like logEvent writes them). */
export function writeEvents(root: string, lines: unknown[]): void {
  const file = path.join(root, ".tumwater", "log", "events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
}

/** Write a synthetic pi session log of `turns` complete runs — the fixture most transcript
 * and tail tests need: run i is agentStart, userLine(`prompt ${i}`) at FIXED_TS + i·60s, and
 * assistantBlocks with text `turn ${i}`. Creates the log's directory and returns the temp root
 * and log file path. Callers that need a shape past the standard turns (a pending separator, a
 * stale marker, per-run noise) append extra lines with fs.appendFileSync instead of hand-rolling
 * the whole loop, and turn-count variants pass a different `turns`. */
export function writeTurnLog(turns: number): { root: string; file: string } {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= turns; i++) {
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, FIXED_TS + i * 60_000));
    lines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { root, file };
}

/** Every event of one type in the repo's harness event log. This was the dominant way tests
 * consumed the log — `readEvents(x).filter((e) => e.type === "...")` appeared well over a hundred
 * times — so the filter lives here once and each call site names just the type it wants. */
export function eventsOfType(root: string, type: HarnessEvent["type"]): HarnessEvent[] {
  return readEvents(root).filter((e) => e.type === type);
}

/** The harness's own warnings (loop "harness") — the events tests assert on when pinning that a
 * misbehavior was reported instead of silently swallowed. */
export function harnessWarnings(root: string): HarnessEvent[] {
  return eventsOfType(root, "warning").filter((e) => e.loop === "harness");
}
