// The settlement half of a backend agent run (src/agent/agent-settle.ts): what happens after
// the run's live feed — the spawn-`error` result, the `exit` orphan sweep, and the `close`-time
// flush/reconcile/classify that builds the PiRunResult. agent-run.ts constructs the live
// RunSettleState and delegates its `error`/`exit`/`close` listeners here; these tests pin the
// settlement contract in isolation — the spawn-error wording for a default vs a configured
// binary, and the close-time error-message priority and ok/failed/flags derivation — so a change
// to a rule shared across every backend (say, a timeout message losing its progress caveat, or a
// transient failure set when the run was a kill) is caught here rather than once per backend.
import test from "node:test";
import assert from "node:assert/strict";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";
import type { PiRunResult } from "../src/pi/pi-run-result.js";
import {
  setupFailureResult,
  settleError,
  settleClose,
} from "../src/agent/agent-settle.js";
import type { RunSettleState } from "../src/agent/agent-run.js";
import type { AgentBackend, AgentRunSpec } from "../src/agent/agent-backend.js";
import type { ResolvedBackendBin } from "../src/pi/pi-bin.js";
import { PiStreamParser } from "../src/pi/pi-stream.js";
import type { ResolvedModelConfig } from "../src/config/config-views.js";
import { defaultConfig } from "../src/config/config.js";

/** A minimal but real RunSettleState wired to a real parser and a configurable fake backend,
 * so the settlement handlers run against the same shapes agent-run.ts hands them. `finish`
 * captures whatever result the handler settles with; the abort/kill/blind-read flags and the
 * watchdog state are configurable through the overrides. */
function makeState(overrides: {
  backend?: Partial<AgentBackend>;
  resolved?: ResolvedBackendBin;
  parser?: PiStreamParser;
  aborted?: () => boolean;
  wasKilled?: () => boolean;
  blindRead?: () => string | undefined;
  config?: Partial<ResolvedModelConfig>;
  wd?: RunSettleState["wd"];
  stderr?: () => string;
  settled?: () => boolean;
} = {}): { state: RunSettleState; results: PiRunResult[]; parser: PiStreamParser } {
  const parser = overrides.parser ?? new PiStreamParser();
  const results: PiRunResult[] = [];
  const backend: AgentBackend = {
    id: "fake",
    label: "fake",
    defaultBin: "pi",
    binEnv: "TUMWATER_FAKE_BIN",
    resolveBin: () => ({ bin: "pi", source: "default" }),
    invocation: () => ({ args: [], stdin: "", env: {} }),
    translator: () => ({ translate: (line) => [line] }),
    classifyExit: () => ({}),
    ...overrides.backend,
  };
  return {
    parser,
    results,
    state: {
      child: {} as ChildProcess,
      resolved: overrides.resolved ?? { bin: "pi", source: "default" },
      backend,
      runMarker: "run-marker",
      parser,
      translator: { translate: (line: string) => [line] },
      decoder: new StringDecoder("utf8"),
      wd:
        overrides.wd ??
        ({
          timedOut: false,
          timedOutProgressing: false,
          quietKilled: false,
          timeoutBudgetMs: 30000,
          noteByte: () => {},
          noteStderr: () => {},
          stop: () => {},
          sawOutput: false,
        } as RunSettleState["wd"]),
      finish: (r: PiRunResult) => results.push(r),
      feedCanonical: () => {},
      onLine: () => {},
      runSpec: {} as AgentRunSpec,
      invocation: { args: [], stdin: "", env: {} },
      stderr: overrides.stderr ?? (() => ""),
      fallbackClone: () => undefined,
      settled: overrides.settled ?? (() => false),
      blindRead: overrides.blindRead ?? (() => undefined),
      aborted: overrides.aborted ?? (() => false),
      wasKilled: overrides.wasKilled ?? (() => false),
      kind: "author",
      config: { ...defaultConfig(), ...overrides.config },
    },
  };
}

/** The one result a settle handler produced, or fail the test if it settled none. */
function single(results: PiRunResult[]): PiRunResult {
  assert.equal(results.length, 1);
  return results[0] as PiRunResult;
}

test("setupFailureResult is a zeroed, failed result with the message and agent", () => {
  const r = setupFailureResult("author", "boom");
  assert.equal(r.ok, false);
  assert.equal(r.agent, "author");
  assert.equal(r.errorMessage, "boom");
  assert.equal(r.finalText, "");
  assert.equal(r.turns, 0);
  assert.equal(r.costUsd, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.quietKilled, false);
  assert.equal(r.configError, false);
});

test("settleError names a default-binary spawn failure as pi, with no source suffix", () => {
  const { state, results } = makeState();
  settleError(state, new Error("ENOENT"));
  const r = single(results);
  assert.equal(r.ok, false);
  assert.equal(r.errorMessage, "failed to spawn pi: ENOENT");
});

test("settleError names a configured binary's spawn failure with its env source", () => {
  const { state, results } = makeState({
    resolved: { bin: "/usr/bin/custom-pi", source: "env" },
    backend: { binEnv: "TUMWATER_CUSTOM_BIN" },
  });
  settleError(state, new Error("permission denied"));
  assert.equal(
    single(results).errorMessage,
    "failed to spawn /usr/bin/custom-pi (resolved from TUMWATER_CUSTOM_BIN): permission denied",
  );
});

test("settleClose reports an ok result for a clean zero-code exit with a message", () => {
  const parser = new PiStreamParser();
  parser.feed('{"type":"message_end","text":"all good"}\n', () => {});
  const { state, results } = makeState({ parser });
  settleClose(state, 0);
  const r = single(results);
  assert.equal(r.ok, true);
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.timedOut, false);
  assert.equal(r.quietKilled, false);
});

test("settleClose reports a quiet-killed run as failed with the husk message", () => {
  const wd = {
    timedOut: false,
    timedOutProgressing: false,
    quietKilled: true,
    timeoutBudgetMs: 30000,
    noteByte: () => {},
    noteStderr: () => {},
    stop: () => {},
    sawOutput: false,
  } as unknown as RunSettleState["wd"];
  const { state, results } = makeState({
    wd,
    config: { quietTimeoutSeconds: 1800 },
    wasKilled: () => true,
  });
  settleClose(state, 0);
  const r = single(results);
  assert.equal(r.ok, false);
  assert.equal(r.quietKilled, true);
  assert.equal(r.errorMessage, "killed as hung: no agent progress for over 1800s");
});

test("settleClose reports a timed-out-but-progressing run with the preserve-for-resume caveat", () => {
  const wd = {
    timedOut: true,
    timedOutProgressing: true,
    quietKilled: false,
    timeoutBudgetMs: 300000,
    noteByte: () => {},
    noteStderr: () => {},
    stop: () => {},
    sawOutput: false,
  } as unknown as RunSettleState["wd"];
  const { state, results } = makeState({ wd, wasKilled: () => true });
  settleClose(state, 0);
  const r = single(results);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.timedOutProgressing, true);
  assert.equal(
    r.errorMessage,
    "timed out after 300s while still making progress — session and worktree edits preserved for resume",
  );
});

test("settleClose reads a blind image read as the error, naming the model", () => {
  const { state, results } = makeState({
    blindRead: () => "screenshot.png",
    config: { model: "claude-3" },
    wasKilled: () => true,
  });
  settleClose(state, 0);
  const r = single(results);
  assert.equal(r.ok, false);
  assert.equal(r.errorMessage, "read screenshot.png, but claude-3 cannot read images");
});

test("settleClose merges the backend's transient crash classification at exit", () => {
  const { state, results } = makeState({
    backend: {
      classifyExit: () => ({
        transientPiCrash: true,
        transientBackend: false,
        backendKind: undefined,
        configError: false,
      }),
    },
  });
  settleClose(state, 1);
  const r = single(results);
  assert.equal(r.ok, false);
  assert.equal(r.transientPiCrash, true);
  assert.equal(r.transientBackend, false);
});

test("settleClose treats a non-zero exit with no final text as failed with the stderr tail", () => {
  const { state, results } = makeState({
    stderr: () => "  boom\ntrace line\n",
  });
  settleClose(state, 1);
  const r = single(results);
  assert.equal(r.ok, false);
  assert.equal(r.errorMessage, "boom\ntrace line");
});
