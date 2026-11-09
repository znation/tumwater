/** The build-and-spawn stage of the agent runner (plans/agent-backends.md "The seam"): the
 * part of a run before the stream pipeline — the `tumwater_run` raw-log marker, the stream
 * parser, the run marker, backend-bin resolution, the notes shim, the run spec, the backend's
 * optional `prepare`, the session-ledger record, the native-to-canonical translator, the two
 * incremental decoders, and the child spawn. It returns the `SpawnedRun` bundle the coordinator
 * (src/agent/agent-run.ts) binds its watchdogs and settlement wiring to, and passes to
 * createAgentStream (src/agent/agent-stream.ts).
 * Part 1/2 of the runAgent split: the streaming pipeline (part 2/2) lives in agent-stream.ts.
 * This module imports only agent-run's type surface, so
 * there is no runtime import cycle. */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ensureParentDir, rotateIfLarge, statOrNull, terminateTornTail } from "../files/files.js";
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
import { runGitConfigEnv } from "./run-git-config.js";
import { nearestTumwaterRoot } from "../paths.js";
import { piModelsPath, readPiProviders } from "../pi/pi-models.js";
import type { PiRunOptions } from "./agent-run.js";

/** A best-effort append log: its parent is created and it is rotated when oversized before the
 * stream opens, an 'error' event (EACCES, ENOSPC) flips `broken`, and an early end — the
 * stream destroyed or a write failure closing it (a SIGKILLed run, a torn append) — flips
 * `finished`, so the caller can skip writes to a dead stream and can skip waiting on a
 * 'finish' that will never come. A broken or finished log degrades to a lost log, never an
 * unhandled 'error' or a stuck run. Both the raw transcript and the backend-native debug log
 * use one. */
export interface AppendLog {
  stream: fs.WriteStream;
  broken: boolean;
  /** True once the stream ended by ANY path (normal end, destroy, or a write failure's
   * implicit close). From then on the agent-stream writes are skipped and its settle flush
   * skips end() — the end handlers (finish's flush wait, openAppendLog's held count) have all
   * fired once, so this is the one flag that means "this stream is closed" as opposed to
   * `broken`, which is the 'error' subset of it. */
  finished: boolean;
}

/** The append logs this process still has open, keyed by resolved path, with their count. The
 * orchestrator runs a role's agent and post-merge reviews in the same process, and they share a
 * role's pi log path; rotateIfLarge's rename would move the file out from under a live run's
 * open descriptor (its later output lands in the .1 archive and the dashboard reads the fresh
 * file), so the count tells openAppendLog when a path is still held. */
const openAppendLogs = new Map<string, number>();

export function openAppendLog(file: string, maxBytes: number): AppendLog {
  ensureParentDir(file);
  // Skip the rename while another run in this process still writes the file (its descriptor
  // keeps writing the .1 the rename leaves behind); the first open after the last writer's
  // stream closes rotates it. Held counts also keep a later rotation from deleting the .1 a
  // live run writes to.
  const key = path.resolve(file);
  const priorWriters = openAppendLogs.get(key) ?? 0;
  if (priorWriters === 0) {
    rotateIfLarge(file, maxBytes);
    // A run killed before its final newline (the SIGTERM → SIGKILL group sweep, a write
    // failure, a power loss) leaves the log's last line torn. Without this repair the next
    // run's first record would glue onto the fragment into one unparseable line that every
    // reader of the pi log drops (readCompleteLines and readTranscriptTail both hold back a
    // line without its newline) — the run's output silently lost. Repair here, synchronously,
    // not in an 'open' handler: the stream's open is asynchronous, so a path-keyed repair in
    // that handler could fire after an unrelated append or after a later rotation renamed the
    // path, appending a newline into the wrong file. Here, the file is the one this stream
    // will open, and a just-rotated file is empty (terminateTornTail's no-op) and an
    // already-newline-terminated file needs nothing. Swallowed: a failed repair degrades to
    // the torn tail every append-log reader already tolerates; a throw here would kill the
    // orchestrator, and a live run still holds the path (priorWriters > 0) means its bytes,
    // not ours, own the tail, so the held branch must never touch the file.
    try {
      terminateTornTail(file, statOrNull(file));
    } catch {
      // Best-effort; see the comment above.
    }
  }
  const log: AppendLog = { stream: fs.createWriteStream(file, { flags: "a" }), broken: false, finished: false };
  openAppendLogs.set(key, priorWriters + 1);
  log.stream.on("error", () => {
    log.broken = true;
  });
  log.stream.on("finish", () => {
    log.finished = true;
  });
  log.stream.on("close", () => {
    // 'close' fires for every terminal path, an un-ended destroy included, so it — not
    // 'finish' — is the authoritative "the stream is dead" signal.
    log.finished = true;
    const left = (openAppendLogs.get(key) ?? 1) - 1;
    if (left <= 0) openAppendLogs.delete(key);
    else openAppendLogs.set(key, left);
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
    // keeps the outer run's. GIT_CONFIG_GLOBAL points at the run's own global git config
    // (run-git-config.ts), so a tool call's `git config --global` cannot rewrite the user's.
    env: { ...invocation.env, TMPDIR: runTmp, ...runGitConfigEnv(runTmp, invocation.env) },
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

/** Warn on a run's own root that a backend's optional `prepare` step failed, then let the run
 * go on without it — the shared tail of the synchronous-throw and async-rejection prepare guards
 * below, so both warn the same way. `warnRoot` is undefined when the session dir has no team
 * root; the warning is then skipped because there is no tumwater event log to write to. */
function warnPrepareFailed(warnRoot: string | undefined, error: unknown): void {
  if (warnRoot !== undefined) {
    warnEventBestEffort(warnRoot, TUMWATER_SOURCE, `agent prepare failed, run continues: ${errorMessage(error)}`);
  }
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
  // it and the exit sweep can name it. When the session sits under a team root, the mark is
  // stamped with that root's token so a dead-marked orphan can be attributed to this checkout
  // and never reaped as another team's (BUGS.md, "Reap the doctor's orphans, part 1/3"); a
  // session with no team root (a lab script, a smoke run, a prompt-lab replay) stays rootless.
  const markerRoot = nearestTumwaterRoot(opts.sessionDir);
  const runMarker = makeRunMarker(process.pid, markerRoot);
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
    warnPrepareFailed(warnRoot, error);
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
      warnPrepareFailed(warnRoot, error);
    }
    return buildAndSpawn(backend, opts, { runSpec, parser, runMarker, resolved, blind, runTmp });
  })();
}
