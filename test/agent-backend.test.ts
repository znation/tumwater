import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  backendById,
  registerAgentBackend,
  type AgentBackend,
} from "../src/agent/agent-backend.js";
import { runAgent, MAX_NATIVE_LINE_CHARS } from "../src/agent/run-agent.js";
import { defaultConfig } from "../src/config/config.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { patchFsMethod } from "./helpers/fs-faults.js";

// The agent seam (plans/agent-backends.md "The seam"): a registry keyed by id, and a runner
// that lets a backend deliver the prompt on stdin. src/agent/run-agent.ts registers the pi and
// claude adapters; these tests use a fake backend so the neutral runner's stdin path is
// exercised without a real agent.

test("the registry returns the registered pi adapter and undefined for an unknown id", () => {
  const pi = backendById("pi");
  assert.ok(pi, "pi is registered by src/agent/run-agent.ts");
  assert.equal(pi.label, "pi");
  assert.equal(backendById("no-such-agent"), undefined);
});

test("a backend that returns stdin gets its prompt written to the child and echoed to the raw log", async () => {
  const dir = tmpdir();
  const rawLogFile = path.join(dir, "raw.jsonl");
  const fake: AgentBackend = {
    id: "fake-stdin",
    label: "fake",
    defaultBin: "fake",
    binEnv: "TUMWATER_FAKE_BIN",
    resolveBin: () => ({ bin: "/bin/sh", source: "config" }),
    // `cat` echoes the prompt the runner writes and ends, proving stdio[0] was a live pipe.
    invocation: () => ({ args: ["-c", "cat"], stdin: "stdin-delivered\n", env: process.env }),
    translator: () => ({ translate: (line) => [line] }),
    classifyExit: () => ({}),
  };
  registerAgentBackend(fake);
  await runAgent({
    cwd: dir,
    prompt: "argv prompt",
    config: { ...defaultConfig(), agent: "fake-stdin" },
    sessionDir: path.join(dir, "sessions"),
    sessionName: "t",
    rawLogFile,
    nativeLogFile: path.join(dir, "native.jsonl"),
    kind: "author",
  });
  const content = fs.readFileSync(rawLogFile, "utf8").replace(/,"ts":\d+/, "");
  assert.equal(content, `{"type":"tumwater_run","kind":"author","agent":"fake-stdin"}\nstdin-delivered\n`);
});

test("an over-long native line with no newline is dropped, not buffered without bound", async () => {
  // A backend that streams bytes without a newline (a runaway tool call dumping binary) would
  // otherwise grow the native line buffer until the run timeout — four hours by default — and
  // can OOM the harness, while every byte resets the quiet watchdog. The cap drops the
  // never-terminated line and resynchronizes on the next newline: the line after it must still
  // be translated, no line reaching the translator may exceed the cap, and the drop is warned
  // about once.
  const dir = tmpdir();
  const rawLogFile = path.join(dir, "raw.jsonl");
  const seen: string[] = [];
  const warnings: string[] = [];
  const fake: AgentBackend = {
    id: "fake-overlong",
    label: "fake",
    defaultBin: "fake",
    binEnv: "TUMWATER_FAKE_BIN",
    resolveBin: () => ({ bin: "/bin/sh", source: "config" }),
    invocation: () => ({
      args: ["-c", `head -c 17000000 /dev/zero | tr '\\0' a; printf '\\nvalid\\n'`],
      env: process.env,
    }),
    translator: () => ({
      translate: (line) => {
        seen.push(line);
        return [line];
      },
    }),
    classifyExit: () => ({}),
  };
  registerAgentBackend(fake);
  await runAgent({
    cwd: dir,
    prompt: "p",
    config: { ...defaultConfig(), agent: "fake-overlong" },
    sessionDir: path.join(dir, "sessions"),
    sessionName: "t",
    rawLogFile,
    nativeLogFile: path.join(dir, "native.jsonl"),
    kind: "author",
    onAgentWarning: (warning) => warnings.push(warning),
  });
  assert.ok(seen.includes("valid"), "the line after the over-long one still reaches the translator");
  assert.ok(
    seen.every((line) => line.length <= MAX_NATIVE_LINE_CHARS),
    "no line at or beyond the cap is buffered or translated",
  );
  assert.equal(warnings.length, 1, "the discarded line is warned about exactly once");
});

test("a backend whose prepare throws still spawns its run and warns once", async () => {
  // The optional async `prepare` seam (plans/codex-write-guard.md "Trust (parts 4–5)"): its
  // work is warm-up the synchronous invocation needs, so a throw must never fail a run — the
  // runner warns on the run's own root and proceeds. The run must still spawn its child.
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  const root = dir;
  const sessionDir = path.join(root, ".tumwater", "sessions", "t");
  const rawLogFile = path.join(dir, "raw.jsonl");
  const fake: AgentBackend = {
    id: "fake-prepare-throw",
    label: "fake",
    defaultBin: "fake",
    binEnv: "TUMWATER_FAKE_BIN",
    resolveBin: () => ({ bin: "/bin/sh", source: "config" }),
    invocation: () => ({ args: ["-c", "cat"], stdin: "ran\n", env: process.env }),
    prepare: async () => {
      throw new Error("prepare boom");
    },
    translator: () => ({ translate: (line) => [line] }),
    classifyExit: () => ({}),
  };
  registerAgentBackend(fake);
  const result = await runAgent({
    cwd: dir,
    prompt: "p",
    config: { ...defaultConfig(), agent: "fake-prepare-throw" },
    sessionDir,
    sessionName: "t",
    rawLogFile,
    nativeLogFile: path.join(dir, "native.jsonl"),
    kind: "author",
  });
  assert.equal(result.ok, true, "a prepare throw never fails the run");
  // The run's child ran despite the throw, and the warning reached the root's event feed.
  const events = fs.readFileSync(path.join(root, ".tumwater", "log", "events.jsonl"), "utf8");
  const lines = events.trim().split("\n").filter((l) => l !== "");
  assert.equal(lines.length, 1, "the prepare failure is warned exactly once");
  const event = JSON.parse(lines[0]!);
  assert.equal(event.source, "tumwater");
  assert.equal(event.type, "warning");
  assert.match(event.message, /agent prepare failed, run continues: prepare boom/);
});

test("a failed spawn never calls a backend's afterRun", async () => {
  // The afterRun seam hook (part 5/7) must not spend a reconciling export on a session that
  // was never created. The spawn `error` handler calls finish(), which sets settled, before
  // `close` fires; the close handler's `!settled` guard skips afterRun. The counter — not the
  // translator's warnings — is the assertion: finish() drains the translator's warnings in the
  // error handler, so a partial-usage check would pass even with the guard removed.
  const dir = tmpdir();
  const rawLogFile = path.join(dir, "raw.jsonl");
  let afterCalls = 0;
  const fake: AgentBackend = {
    id: "fake-spawn-fail",
    label: "fake",
    defaultBin: "fake",
    binEnv: "TUMWATER_FAKE_BIN",
    resolveBin: () => ({ bin: "/nonexistent/bin/qwerty", source: "config" }),
    invocation: () => ({ args: [], env: process.env }),
    translator: () => ({ translate: (line) => [line] }),
    classifyExit: () => ({}),
    afterRun: () => {
      afterCalls += 1;
      return [];
    },
  };
  registerAgentBackend(fake);
  const result = await runAgent({
    cwd: dir,
    prompt: "p",
    config: { ...defaultConfig(), agent: "fake-spawn-fail" },
    sessionDir: path.join(dir, "sessions"),
    sessionName: "t",
    rawLogFile,
    nativeLogFile: path.join(dir, "native.jsonl"),
    kind: "author",
  });
  assert.equal(result.ok, false, "a failed spawn is a failure");
  assert.equal(afterCalls, 0, "a binary that never started spends no afterRun");
});

test("a synchronous backend invocation throw does not leak the run's private temp dir", async () => {
  // runAgent creates a private TMPDIR (`tumwater-run-*` under os.tmpdir) before it builds the
  // spawn, and only the stream's finish() removes it on the settle paths. A backend whose
  // invocation() throws synchronously (claude rejecting a run with no model) throws inside
  // buildAndSpawn before any child exists, so no `error`/`close` fires and finish() never runs;
  // runAgent's catch rejects without cleaning the temp dir up. This pins that the catch removes
  // it best-effort, so a broken run leaves no `tumwater-run-*` behind to accumulate.
  const dir = tmpdir();
  const sandbox = tmpdir(); // a per-run-root dir; TMPDIR is redirected onto it so runTmp lands inside
  const oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = sandbox; // os.tmpdir() re-reads the env on each call, so runTmp lands here
  const fake: AgentBackend = {
    id: "fake-invocation-throw",
    label: "fake",
    defaultBin: "fake",
    binEnv: "TUMWATER_FAKE_BIN",
    resolveBin: () => ({ bin: "/bin/sh", source: "config" }),
    invocation: () => {
      throw new Error("no model configured");
    },
    translator: () => ({ translate: (line) => [line] }),
    classifyExit: () => ({}),
  };
  registerAgentBackend(fake);
  try {
    await assert.rejects(
      runAgent({
        cwd: dir,
        prompt: "p",
        config: { ...defaultConfig(), agent: "fake-invocation-throw" },
        sessionDir: path.join(dir, "sessions"),
        sessionName: "t",
        rawLogFile: path.join(dir, "raw.jsonl"),
        nativeLogFile: path.join(dir, "native.jsonl"),
        kind: "author",
      }),
      /no model configured/,
    );
  } finally {
    process.env.TMPDIR = oldTmp;
  }
  const leftovers = fs.readdirSync(sandbox).filter((n) => n.startsWith("tumwater-run-"));
  assert.deepEqual(leftovers, [], "the failed run must remove its private temp dir");
});

test("a synchronous backend invocation throw ends the append-log streams (no descriptor leak)", async () => {
  // runAgent opens a raw and a native append-log WriteStream before it builds the spawn, and
  // only a settle/finish path ends them. A backend whose invocation() throws synchronously
  // (claude rejecting a run with no model) throws before any child exists, so no finish() runs
  // and nothing else would ever end the two streams — each rejected run must not leave their
  // descriptors to the transcript files open and accumulate in the long-lived orchestrator.
  //
  // The assertion is synchronous and deterministic: capture the two streams runAgent opened
  // through the createWriteStream seam and check the `writableEnded` flag, which `.end()` flips
  // the moment it is called. Reading an fd table from outside is not a reliable proxy — a lazy
  // WriteStream's fd opens on its own schedule (or, un-referenced after the rejection, may never
  // open), so an un-ended stream can look closed just because its fd has not opened yet, and the
  // test would pass with the leak present. `writableEnded` is true only when the cleanup ran, so
  // this test fails before the fix and passes after it.
  const dir = tmpdir();
  const raw = path.join(dir, "raw.jsonl");
  const native = path.join(dir, "native.jsonl");
  const streams: fs.WriteStream[] = [];
  const restoreStream = patchFsMethod("createWriteStream", (orig) => (file, flags) => {
    const stream = orig(file, flags) as fs.WriteStream;
    if (String(file) === raw || String(file) === native) streams.push(stream);
    return stream;
  });
  const fake: AgentBackend = {
    id: "fake-invocation-throw-fd",
    label: "fake",
    defaultBin: "fake",
    binEnv: "TUMWATER_FAKE_BIN",
    resolveBin: () => ({ bin: "/bin/sh", source: "config" }),
    invocation: () => {
      throw new Error("no model configured");
    },
    translator: () => ({ translate: (line) => [line] }),
    classifyExit: () => ({}),
  };
  registerAgentBackend(fake);
  try {
    await assert.rejects(
      runAgent({
        cwd: dir,
        prompt: "p",
        config: { ...defaultConfig(), agent: "fake-invocation-throw-fd" },
        sessionDir: path.join(dir, "sessions"),
        sessionName: "t",
        rawLogFile: raw,
        nativeLogFile: native,
        kind: "author",
      }),
      /no model configured/,
    );
    assert.equal(streams.length, 2, "the raw and native append-log streams both opened before the throw");
    for (const stream of streams) {
      assert.equal(stream.writableEnded, true, "a stream opened before the synchronous throw is ended by the cleanup");
    }
  } finally {
    restoreStream();
  }
});
