/** Fixtures for the files tests write and assert on: events.jsonl under a fixture root, the
 * marker/request files that simulate CLI/operator side effects, and synthetic pi session logs.
 * Plus the two assertions over the event log every topic's tests repeat (eventsOfType,
 * harnessWarnings). The pure time/text oracles assertions compare against live in oracles.ts;
 * the fake-pi line builders these logs are assembled from live in pi-events.ts. */
import fs from "node:fs";
import path from "node:path";
import { readEvents } from "../src/event-read.js";
import type { HarnessEvent } from "../src/events.js";
import { orchestratorStatePath, piLogPath } from "../src/paths.js";
import { tmpdir } from "./repo-fixtures.js";
import { FIXED_TS, agentStart, assistantBlocks, runMarker, userLine } from "./pi-events.js";
import { ensureParentDir } from "../src/files.js";

/** Stamp a marker/request file the way tests simulate CLI/operator side effects: create the
 * parent directories, then write `value` as compact JSON directly to `file` with a plain
 * writeFileSync (not the CLI's tmp+rename pretty-printed writeJsonFile path). The only
 * contract that matters is that the orchestrator's readers can parse the bytes. */
export function writeMarker(file: string, value: unknown): void {
  ensureParentDir(file);
  fs.writeFileSync(file, JSON.stringify(value));
}

/** Simulate the orchestrator state marker the harness writes at startup — the
 * {pid, startedAt, roles} payload src/orchestrator.ts stamps (plus an optional redeploy build
 * record), written through writeMarker so every test agrees on where the file lives and how the
 * payload is spelled. `pid` defaults to this test process, which the alive-check reads as a live
 * harness; tests simulating a dead or foreign orchestrator pass an explicit pid. */
export function writeOrchestratorMarker(
  root: string,
  roles: readonly string[],
  opts: { pid?: number; build?: unknown; budget?: { spentUsd: number; capUsd: number } } = {},
): void {
  writeMarker(orchestratorStatePath(root), {
    pid: opts.pid ?? process.pid,
    startedAt: Date.now(),
    roles: [...roles],
    ...(opts.build !== undefined ? { build: opts.build } : {}),
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
  });
}

/** Write a fixture log file (a pi session log or the harness's events.jsonl) the way the real
 * writers stamp them: create the parent directories, then emit `lines` as newline-joined JSONL
 * with a trailing newline. Strings pass through verbatim (for malformed or blank lines); any
 * other value is JSON-encoded like logEvent writes it. The single place tests stamp raw log
 * bytes — writeEvents, writePiLog, and writeTurnLog build on it, and tests that need a shape
 * the named helpers don't cover call it directly instead of hand-rolling the write. */
export function writeLogLines(file: string, lines: readonly unknown[]): void {
  ensureParentDir(file);
  fs.writeFileSync(
    file,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
}

/** Write events.jsonl under a fixture root's .tumwater/log/ (strings pass through verbatim —
 * for malformed lines; objects are JSON-encoded like logEvent writes them). */
export function writeEvents(root: string, lines: unknown[]): void {
  writeLogLines(path.join(root, ".tumwater", "log", "events.jsonl"), lines);
}

/** Write a synthetic pi session log of `turns` complete runs — the fixture most transcript
 * and tail tests need: run i is agentStart, userLine(`prompt ${i}`) at FIXED_TS + i·60s, and
 * assistantBlocks with text `turn ${i}`. Creates the log's directory and returns the temp root
 * and log file path. `reviewMarkerAt` labels runs: when it returns true for turn i, the
 * harness-written tumwater_run marker line precedes that run — every interleaved-label shape
 * (every run, every other run, one stale marker) is a predicate, not a hand-rolled loop.
 * Callers that need a shape past the standard turns (a pending separator, a truncated orphan
 * tail, per-run noise) append extra lines with fs.appendFileSync instead of hand-rolling the
 * whole loop, and turn-count variants pass a different `turns`. */
export function writeTurnLog(
  turns: number,
  opts: { reviewMarkerAt?: (turn: number) => boolean } = {},
): { root: string; file: string } {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  ensureParentDir(file);
  const lines: string[] = [];
  for (let i = 1; i <= turns; i++) {
    if (opts.reviewMarkerAt?.(i)) lines.push(runMarker());
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, FIXED_TS + i * 60_000));
    lines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
  }
  writeLogLines(file, lines);
  return { root, file };
}

/** Every event of one type in the repo's harness event log. This was the dominant way tests
 * consumed the log — `readEvents(x).filter((e) => e.type === "...")` appeared well over a hundred
 * times — so the filter lives here once and each call site names just the type it wants. */
export function eventsOfType(root: string, type: HarnessEvent["type"]): HarnessEvent[] {
  return readEvents(root).filter((e) => e.type === type);
}

/** Every warning event's message, coerced to string (the schema leaves message unknown). This
 * was the dominant way tests read the warnings — `eventsOfType(x, "warning").map((e) =>
 * String(e.message))` appeared fifteen times across nine files — so the type+coercion pair lives
 * here once and each call site names just the warnings it wants. */
export function warningMessages(root: string): string[] {
  return eventsOfType(root, "warning").map((e) => String(e.message));
}

/** The harness's own warnings (loop "harness") — the events tests assert on when pinning that a
 * misbehavior was reported instead of silently swallowed. */
export function harnessWarnings(root: string): HarnessEvent[] {
  return eventsOfType(root, "warning").filter((e) => e.loop === "harness");
}
