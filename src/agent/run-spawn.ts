/** The build-and-spawn stage of the agent runner (plans/agent-backends.md "The seam"): the
 * part of a run before the stream pipeline — the `tumwater_run` raw-log marker, the stream
 * parser, the run marker, backend-bin resolution, the notes shim, the run spec, the backend's
 * optional `prepare`, the session-ledger record, the native-to-canonical translator, the two
 * incremental decoders, and the child spawn. It returns the `SpawnedRun` bundle the coordinator
 * (src/agent/run-agent.ts) binds its watchdogs and settlement wiring to, and passes to
 * createAgentStream (src/agent/run-stream.ts).
 * Part 1/2 of the runAgent split: the streaming pipeline (part 2/2) lives in run-stream.ts.
 * This module imports only run-agent's type surface, so
 * there is no runtime import cycle. */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { ensureParentDir, rotateIfLarge } from "../files/files.js";
import type { ResolvedBackendBin } from "../pi/pi-bin.js";
import { terminateChild } from "../process/process.js";
import { makeRunMarker } from "../process/run-marker.js";
import type { PiRunKind } from "../pi/pi-event-line.js";
import { PiStreamParser } from "../pi/pi-stream.js";
import type { AgentBackend, AgentInvocation, AgentRunSpec, StreamTranslator } from "./agent-backend.js";
import { recordSession, sessionRecordFor } from "./session-ledger.js";
import { errorMessage } from "../text/text.js";
import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { seamImageInput } from "./image-input.js";
import { ensureNotesShim } from "./notes-shim.js";
import { nearestTumwaterRoot } from "../paths.js";
import { piModelsPath, readPiProviders } from "../pi/pi-models.js";
import type { PiRunOptions } from "./run-agent.js";

/** A best-effort append log: its parent is created and it is rotated when oversized before the
 * stream opens, and an 'error' event (EACCES, ENOSPC) flips `broken` so the caller can skip
 * waiting on a 'finish' that will never come. A broken log degrades to a lost log, never an
 * unhandled 'error' or a stuck run. Both the raw transcript and the backend-native debug log
 * use one. */
export interface AppendLog {
  stream: fs.WriteStream;
  broken: boolean;
}

export function openAppendLog(file: string, maxBytes: number): AppendLog {
  ensureParentDir(file);
  rotateIfLarge(file, maxBytes);
  const log: AppendLog = { stream: fs.createWriteStream(file, { flags: "a" }), broken: false };
  log.stream.on("error", () => {
    log.broken = true;
  });
  return log;
}

/** Everything the coordinator binds after `spawnPiRun`: the child, the run's attribution marks
 * and spec, the stream-side objects (parser, translator, decoders), and the blind-read getter
 * the settlement wiring uses to name a killed run's image. The two logs and the run's TMPDIR are
 * the caller's own setup locals, so they stay out of the bundle. */
export interface SpawnedRun {
  child: ChildProcess;
  resolved: ResolvedBackendBin;
  runSpec: AgentRunSpec;
  invocation: AgentInvocation;
  parser: PiStreamParser;
  translator: StreamTranslator;
  decoder: StringDecoder;
  stderrDecoder: StringDecoder;
  runMarker: string;
  preSpawnSessionId: string;
  blindRead: () => string | undefined;
}

/** The pre-spawn pieces `spawnPiRun` builds before the backend's optional `prepare`, shared by
 * its synchronous (no `prepare`) and asynchronous (`prepare`) completion paths. */
interface SpawnInput {
  runSpec: AgentRunSpec;
  parser: PiStreamParser;
  runMarker: string;
  resolved: ResolvedBackendBin;
  blind: { read?: string; terminate?: () => void };
  runTmp: string;
}

/** Invoke the backend and spawn the child from the pre-spawn pieces, returning the bundle. */
function buildAndSpawn(backend: AgentBackend, opts: PiRunOptions, pre: SpawnInput): SpawnedRun {
  const { runSpec, parser, runMarker, resolved, blind, runTmp } = pre;
  const invocation = backend.invocation(runSpec);
  // The id the pre-spawn ledger record carries: a backend that mints one ahead of the run
  // (claude, a codex resume), else the session name (pi, a fresh codex run — its id is born in
  // the stream). The stream-mint pass later compares against it so a codex run appends its
  // streamed thread id exactly once, and only when it differs from this.
  const preSpawnSessionId = invocation.sessionId ?? opts.sessionName;
  // Record the run in the session ledger before its spawn, so a later resume can pick the newest
  // session of its own kind instead of whatever file is newest in the dir. The id is the backend's
  // own when it mints one ahead of the run (claude's UUID, or the resumed record's id); pi mints
  // none and keeps the session name.
  recordSession(opts.sessionDir, sessionRecordFor(backend.id, preSpawnSessionId, opts));
  const translator = backend.translator();
  // Decode stdout incrementally instead of per chunk: a raw Buffer.toString("utf8") replaces any
  // multi-byte character whose bytes straddle two 'data' events with U+FFFD, corrupting that
  // line's text (commit subjects, summaries, transcripts). StringDecoder holds back the incomplete
  // trailing bytes until the next chunk completes them.
  const decoder = new StringDecoder("utf8");
  // stderr gets its own incremental decoder for the same reason: the failure message and the
  // stderr-keyed matchers (crash, stream-severed, config) read this buffer, so a character whose
  // bytes straddle two 'data' events must not become U+FFFD.
  const stderrDecoder = new StringDecoder("utf8");

  const child = spawn(resolved.bin, invocation.args, {
    cwd: opts.cwd,
    // A backend that feeds the prompt on stdin (every registered one) gets a pipe the runner
    // writes and ends below; one that returns no stdin keeps stdio[0] "ignore".
    stdio: [invocation.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    // pi sets its process title at startup, and so does every npm its tool calls run: on macOS
    // each would register with LaunchServices and leak a launchservicesd port. Detached so pi
    // leads its own process group: terminateChild signals the group, so a run's tool-call
    // grandchildren — killed or finished — die with it instead of leaking to launchd.
    detached: true,
    // The run's mark, inherited by every tool call and its descendants: pi 0.87.1's bash tool
    // spawns each command detached in its OWN group, so the group sweep below cannot reach what
    // a tool call backgrounds (BUGS.md 2026-09-30) — the mark is the only attribution that
    // follows a reparented orphan. Appended to any inherited mark so a nested harness under test
    // keeps the outer run's.
    env: { ...invocation.env, TMPDIR: runTmp },
  });
  if (invocation.stdin !== undefined) {
    // A backend that dies before draining its stdin — an immediately-failing startup such as an
    // unknown flag, an unresumable session, or a not-logged-in exit — leaves this write nothing
    // to feed. Once the prompt exceeds the OS pipe buffer the write then fails EPIPE, and an
    // unhandled 'error' event on the stdin stream is thrown from the event loop and takes the
    // whole process (the whole team) down. The child's own exit status and stderr already report
    // why the run died, so swallowing the failed write adds no silence the caller needs to break;
    // git.ts's patchId carries the same guard for a patch-id that dies before reading its input.
    child.stdin?.on("error", () => {});
    child.stdin?.end(invocation.stdin);
  }
  // Armed now that the child exists, so the parser's parse-time onBlindRead (fires during feed,
  // always after spawn) can reach it.
  blind.terminate = () => terminateChild(child);

  return {
    child,
    resolved,
    runSpec,
    invocation,
    parser,
    translator,
    decoder,
    stderrDecoder,
    runMarker,
    preSpawnSessionId,
    blindRead: () => blind.read,
  };
}

/** Build and spawn one non-interactive agent run, from the marker write through the child spawn,
 * and return the bundle the run's stream pipeline, watchdogs and settlement wiring consume. The
 * caller's setup (opened logs, the run's private TMPDIR) is passed in; a synchronous throw here
 * propagates to the caller, which rejects the run's promise. The backend's optional `prepare` is
 * awaited here and warned about (never thrown away) exactly as the coordinator once did.
 *
 * The return type is a union on purpose: a backend without a `prepare` step (pi, claude,
 * opencode) builds and spawns synchronously and returns the bundle DIRECTLY, so the coordinator
 * does not `await` it and its watchdogs (a setInterval registration) start in the same
 * synchronous step — the ordering the logical-clock watchdog tests pin, which advance the fake
 * clock immediately after the run promise is created. A backend WITH a `prepare` (codex)
 * resolves its trust first and returns a promise that resolves to the bundle after the await. */
export function spawnPiRun(
  backend: AgentBackend,
  logs: { raw: AppendLog },
  runTmp: string,
  opts: PiRunOptions,
): SpawnedRun | Promise<SpawnedRun> {
  const rawLog = logs.raw;
  // The first blind image read an authoring run made (plans/image-input.md "Detecting a blind
  // read"): the path, plus an indirection to the child so the parser's parse-time callback
  // (which fires during feed, after spawn) can kill it. Unset for a gate run, which only records
  // the read. Declared before the parser so its onBlindRead closure (which assigns them at parse
  // time, after spawn) can reference them.
  const blind: { read?: string; terminate?: () => void } = {};
  // The marker precedes this run's first event in file order — written to the same stream
  // stdout lines flow through, before spawn, so ordering is exact by construction; on a failed
  // spawn finish() still ends the stream and flushes it. Exactly one per run: the kind, agent
  // and start time are always there, the label only when the caller set one (`history
  // <role> <n> --transcript` selects a run's segments by this ts).
  {
    const marker: { type: "tumwater_run"; kind: PiRunKind; agent: string; ts: number; label?: string } = {
      type: "tumwater_run",
      kind: opts.kind,
      agent: backend.id,
      ts: Date.now(),
    };
    if (opts.label) marker.label = opts.label;
    rawLog.stream.write(JSON.stringify(marker) + "\n");
  }
  const parser = new PiStreamParser(opts.onToolCallStart, {
    // The seam's effective image input (src/agent/image-input.ts): a text-only seam makes every
    // image read blind even when pi adds no note — the parser checks against its own note rule.
    imageInput: seamImageInput(opts.config, readPiProviders(piModelsPath())),
    onBlindRead: (path) => {
      // Kill an authoring run at once, before the agent goes on working from a picture it never
      // saw (terminateChild is what the watchdogs use). Gate runs (reviewer, resolver) only
      // record the read and keep going.
      if (opts.kind === "author") {
        blind.read = path;
        blind.terminate?.();
      }
    },
  });
  // The run's cross-group attribution mark, minted before the spawn so the environment can carry
  // it and the exit sweep can name it.
  const runMarker = makeRunMarker();
  const resolved = backend.resolveBin(opts.config);
  // Install the notes shim under the team root's `.tumwater/bin` so every backend's run finds
  // `tumwater-notes` first on PATH (notes-shim.ts). A failure to write it logs one warning and
  // the run goes on without it — notes would then be unwritable by the command, but the run
  // itself is not blocked.
  let binDir: string | undefined;
  try {
    // Install the shim only under a real team root — the nearest ancestor holding a `.tumwater`.
    // A session dir with no such ancestor (a lab script, a smoke run, a prompt-lab replay) must
    // never mint one: nearestTumwaterRoot is undefined then, and the run goes on without the
    // shim, exactly as if the install had failed — writing `<fallback>/.tumwater` from a run
    // created a phantom harness root in a shared directory and broke every other suite on the
    // host (BUGS.md 2026-10-18).
    const root = nearestTumwaterRoot(opts.sessionDir);
    if (root !== undefined) binDir = ensureNotesShim(root);
  } catch {
    opts.onAgentWarning?.("could not install the tumwater-notes shim; this run will not find tumwater-notes on PATH");
  }
  const runSpec: AgentRunSpec = {
    cwd: opts.cwd,
    prompt: opts.prompt,
    config: opts.config,
    sessionDir: opts.sessionDir,
    sessionName: opts.sessionName,
    continueSession: opts.continueSession,
    kind: opts.kind,
    agentBin: resolved.bin,
    runMarker,
    notesPath: opts.notesPath,
    ...(binDir !== undefined ? { binDir } : {}),
    ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
  };
  // A backend's asynchronous pre-run work (the codex write guard resolving its trust by spawning
  // `app-server`, plans/codex-write-guard.md "Trust (parts 4–5)"): awaited just before the
  // synchronous invocation, so trust is settled before invocation reads it. It never throws a run
  // away — a throw is a warm-up failure, warned about on the run's own root (skipped with no root)
  // and the run goes on; a codex trust lookup failure already records `off` and warns from prepare
  // itself, so this catch is the guard for a backend whose prepare throws unexpectedly. The call
  // itself is also guarded: a synchronous `prepare` throw would otherwise escape and (on the
  // asynchronous path) leave the run's promise pending, so it is warned-and-continued like an
  // async rejection.
  const warnRoot = nearestTumwaterRoot(opts.sessionDir);
  let prepared: Promise<void> | undefined;
  try {
    prepared = backend.prepare?.(runSpec);
  } catch (error) {
    if (warnRoot !== undefined) {
      warnEventBestEffort(warnRoot, TUMWATER_SOURCE, `agent prepare failed, run continues: ${errorMessage(error)}`);
    }
  }
  if (prepared === undefined) {
    // No `prepare` step: build and spawn synchronously and hand the bundle straight back, so
    // the coordinator's watchdog start lands in the same synchronous step (see the doc comment).
    return buildAndSpawn(backend, opts, { runSpec, parser, runMarker, resolved, blind, runTmp });
  }
  // Only a backend with a `prepare` step (codex) awaits it, then builds and spawns.
  return (async () => {
    try {
      await prepared;
    } catch (error) {
      if (warnRoot !== undefined) {
        warnEventBestEffort(warnRoot, TUMWATER_SOURCE, `agent prepare failed, run continues: ${errorMessage(error)}`);
      }
    }
    return buildAndSpawn(backend, opts, { runSpec, parser, runMarker, resolved, blind, runTmp });
  })();
}
