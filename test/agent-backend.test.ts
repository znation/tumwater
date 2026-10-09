import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  agentBackend,
  registerAgentBackend,
  type AgentBackend,
} from "../src/agent/agent-backend.js";
import { runAgent } from "../src/agent/run-agent.js";
import { defaultConfig } from "../src/config/config.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// The agent seam (plans/agent-backends.md "The seam"): a registry keyed by id, and a runner
// that lets a backend deliver the prompt on stdin. Part 1/7 registers only pi; these tests use
// a fake backend so the neutral runner's stdin path is exercised without a real agent.

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
    kind: "author",
  });
  const content = fs.readFileSync(rawLogFile, "utf8");
  assert.equal(content, `{"type":"tumwater_run","kind":"author","agent":"fake-stdin"}\nstdin-delivered\n`);
});
