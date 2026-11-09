// The stream pipeline the agent runner folds (src/agent/agent-stream.ts): the edge branches of
// `createAgentStream` that the end-to-end claude/codex/opencode replay-driven runs do not reach —
// the over-long native line discard and resync, the stderr warning matched across two chunks and
// the stderr window slide, and the settle-once guard. The coordinator tests (claude-run.test.ts,
// codex-run.test.ts) drive the same module with well-formed complete lines, so these cases pin the
// branches that only a malformed or chatty stream hits.
import test from "node:test";
import assert from "node:assert/strict";
import { StringDecoder } from "node:string_decoder";
import type { ResolvedModelConfig } from "../src/config/config-views.js";
import type { PiRunResult } from "../src/pi/pi-run-result.js";
import type { AgentBackend } from "../src/agent/agent-backend.js";
import type { PiRunOptions } from "../src/agent/agent-run.js";
import type { AppendLog } from "../src/agent/agent-spawn.js";
import {
  createAgentStream,
  MAX_NATIVE_LINE_CHARS,
  type AgentStream,
} from "../src/agent/agent-stream.js";

/** A minimal fs.WriteStream-shaped fake: `write` records the text and returns true, `end(cb)`
 * records the call and fires its callback synchronously (so a not-broken log settles the run's
 * promise without a real fd; a real stream fires it asynchronously on 'finish'), and `on`/`emit`
 * carry the error listener finish() registers. */
function fakeWriteStream(writes: string[] = [], ends = { count: 0 }) {
  const listeners = new Map<string, () => void>();
  const stream = {
    write: (text: string) => {
      writes.push(text);
      return true;
    },
    on: (name: string, cb: () => void) => {
      listeners.set(name, cb);
      return stream;
    },
    emit: (name: string) => {
      listeners.get(name)?.();
    },
    end: (cb?: () => void) => {
      ends.count += 1;
      cb?.();
      stream.emit("finish");
    },
  };
  return stream;
}

interface Built {
  stream: AgentStream;
  fed: string[];
  resolved: PiRunResult[];
  warnings: string[];
  rawWrites: string[];
  nativeWrites: string[];
  rawEnds: { count: number };
  nativeEnds: { count: number };
}

/** Build a pipeline wired to fakes that record what the module does, so each test asserts the
 * surface rather than the plumbing. `translator` defaults to the identity; `backend`/`stderrMatch`
 * supply the backend and its stderr-warning matcher for the stderr case. */
function build(over: {
  backend?: AgentBackend;
  preSpawnSessionId?: string;
  stderrMatch?: (chunk: string, tail: string) => string | undefined;
  rawFinished?: boolean;
  nativeFinished?: boolean;
} = {}): Built {
  const fed: string[] = [];
  const resolved: PiRunResult[] = [];
  const warnings: string[] = [];
  const parser = {
    imageBlind: undefined as undefined,
    feed: (text: string) => {
      fed.push(text);
    },
  };
  const translator = {
    translate: (line: string) => [line],
  };
  const backend = over.backend ?? ({
    id: "fake",
    matchStderrWarning: over.stderrMatch,
  } as AgentBackend);

  const rawWrites: string[] = [];
  const nativeWrites: string[] = [];
  const rawEnds = { count: 0 };
  const nativeEnds = { count: 0 };
  const rawLog = {
    stream: fakeWriteStream(rawWrites, rawEnds),
    broken: false,
    finished: over.rawFinished ?? false,
  } as AppendLog;
  const nativeLog = {
    stream: fakeWriteStream(nativeWrites, nativeEnds),
    broken: false,
    finished: over.nativeFinished ?? false,
  } as AppendLog;

  const opts = {
    cwd: "/tmp",
    prompt: "p",
    config: {} as ResolvedModelConfig,
    sessionDir: "/tmp/sess",
    sessionName: "t",
    rawLogFile: "/tmp/raw.jsonl",
    nativeLogFile: "/tmp/native.jsonl",
    kind: "author",
    onAgentWarning: (w: string) => warnings.push(w),
  } as PiRunOptions;

  const stream = createAgentStream({
    opts,
    backend,
    spawned: {
      parser: parser as any,
      translator: translator as any,
      decoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      preSpawnSessionId: over.preSpawnSessionId ?? "",
    } as any,
    wd: {
      noteByte: () => {},
      noteStderr: () => {},
      stop: () => {},
    } as any,
    onAbort: () => {},
    rawLog,
    nativeLog,
    runTmp: "/tmp/nonexistent-stream-run-tmp",
    resolve: (r: PiRunResult) => resolved.push(r),
  });

  return { stream, fed, resolved, warnings, rawWrites, nativeWrites, rawEnds, nativeEnds };
}

test("an over-long native line without a newline is discarded and the stream resyncs on the next real line", () => {
  const { stream, fed, warnings } = build();
  // A complete native line this long is already past the whole-log cap, so continuing to buffer
  // it can only be a malformed stream: the pipeline must drop it and warn, never accumulate it
  // until the run timeout exhausts memory.
  stream.feedCanonical("x".repeat(MAX_NATIVE_LINE_CHARS + 1));
  assert.equal(warnings.length, 1, "the discard is surfaced to the caller exactly once");
  assert.match(warnings[0]!, /exceeded \d+ MiB without a newline and was discarded/);
  assert.equal(fed.length, 0, "the overflowing line is never emitted");

  // The garbage line's remainder up to (and including) its newline is skipped, so the next well
  // formed event is still translated and parsed rather than swallowed or truncated.
  stream.feedCanonical("\nreal event\n");
  assert.equal(fed.length, 1, "the next real line is emitted after the discard");
  assert.equal(fed[0], "real event\n");
});

test("a stderr warning split across two chunks is matched, and the window slides past 64 KiB", () => {
  const marker = "WARN: clone-id-42";
  const { stream } = build({
    stderrMatch: (chunk, tail) =>
      (tail + chunk).includes(marker) ? "clone-id-42" : undefined,
  });

  // The warning spans the boundary between the two chunks; the carried tail (STDERR_MATCH_TAIL)
  // lets the second match see the first chunk's portion.
  stream.feedStderr(Buffer.from("noisy prefix " + marker.slice(0, 8)));
  assert.equal(stream.fallbackClone(), undefined, "the warning is not complete yet");

  stream.feedStderr(Buffer.from(marker.slice(8) + " trailing"));
  assert.equal(stream.fallbackClone(), "clone-id-42", "the straddled warning is surfaced once");

  // stderr keeps only the last 64 KiB, so a chatty stream cannot grow the window without bound.
  const big = "e".repeat(70 * 1024);
  stream.feedStderr(Buffer.from(big));
  assert.equal(stream.stderr().length, 64 * 1024, "the window is capped at 64 KiB");
});

test("finish settles once and resolves only the first result", () => {
  const { stream, resolved } = build();
  const first = { ok: true } as PiRunResult;
  const second = { ok: false } as PiRunResult;
  stream.finish(first);
  stream.finish(second);
  assert.equal(stream.settled(), true, "the run is settled after the first finish");
  assert.equal(resolved.length, 1, "the run's promise resolves exactly once");
  assert.equal(resolved[0], first, "the first finish's result wins, the second is ignored");
});

test("a finished append log is neither written nor ended again at settle", () => {
  const { stream, rawWrites, nativeWrites, rawEnds, nativeEnds, resolved } = build({
    rawFinished: true,
    nativeFinished: true,
  });
  // The flags openAppendLog sets once a stream ends (openAppendLog's 'finish'/'close'
  // listeners): a later data event or the settle flush must not touch the dead streams — a
  // write fails on a destroyed stream and a write to a closed one throws.
  stream.feedCanonical("line one\nline two\n");
  // The fake parser never invokes the raw-log callback, so feed a canonical line to it directly:
  // this is the write site the finished guard protects.
  stream.onLine("raw line");
  assert.deepEqual(rawWrites, [], "a finished raw log gets no record");
  assert.deepEqual(nativeWrites, [], "a finished native log gets no line");

  const result = { ok: true } as PiRunResult;
  stream.finish(result);
  assert.equal(rawEnds.count, 0, "a finished raw log is not ended again");
  assert.equal(nativeEnds.count, 0, "a finished native log is not ended again");
  assert.deepEqual(resolved, [result], "the run settles without waiting on a dead stream's finish");
});
