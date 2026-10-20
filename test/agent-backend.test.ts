import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  agentBackend,
  registerAgentBackend,
  type AgentBackend,
} from "../src/agent/agent-backend.js";
import { runAgent, MAX_NATIVE_LINE_CHARS } from "../src/agent/run-agent.js";
import { defaultConfig } from "../src/config/config.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// The agent seam (plans/agent-backends.md "The seam"): a registry keyed by id, and a runner
// that lets a backend deliver the prompt on stdin. src/agent/run-agent.ts registers the pi and
// claude adapters; these tests use a fake backend so the neutral runner's stdin path is
// exercised without a real agent.

test("the registry returns the registered pi adapter and undefined for an unknown id", () => {
  const pi = agentBackend("pi");
  assert.ok(pi, "pi is registered by src/agent/run-agent.ts");
  assert.equal(pi.label, "pi");
  assert.equal(agentBackend("no-such-agent"), undefined);
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
