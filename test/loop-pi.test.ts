import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LoopPi } from "../src/loop-pi.js";
import { sessionDir } from "../src/paths.js";
import { defaultConfig } from "../src/config.js";
import type { PiRunResult } from "../src/pi.js";
import { tmpdir } from "./repo-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { assistantLine, errorLine } from "./pi-events.js";

// LoopPi (src/loop-pi.ts) is the pi-invocation plumbing of one role loop: the shared
// per-loop wiring, the landing slot's shutdown-only signal, and the SUMMARY follow-up.
// (The shared transient-failure retry's policy is pinned end to end in loop-2.test.ts
// through the whole tick; these tests cover the surface that file cannot reach and the
// rate-limit branch of the retry, whose Retry-After wait lives only here.) Tested through
// runPi with a fake pi on PATH, so real spawning and parsing are in the loop.

interface Recording {
  warns: string[];
  usage: PiRunResult[];
  /** Wall-clock ms of each foldUsage call, parallel to `usage`. */
  foldTimes: number[];
  /** ms passed to the retry's injected sleep, in call order. */
  sleeps: number[];
  /** Wall-clock ms of each injected sleep call, parallel to `sleeps`. */
  sleepAts: number[];
  abortRunSignal(): void;
}

function makeHost(
  root: string,
  config = defaultConfig(),
): Recording & { loopPi: LoopPi; config: typeof config } {
  const warns: string[] = [];
  const usage: PiRunResult[] = [];
  const foldTimes: number[] = [];
  const sleeps: number[] = [];
  const sleepAts: number[] = [];
  const ctl = new AbortController();
  const host = {
    root,
    role: "feature",
    config: () => config,
    signal: undefined as AbortSignal | undefined,
    runSignal: () => ctl.signal,
    warn: (message: string) => warns.push(message),
    foldUsage: (run: PiRunResult) => {
      usage.push(run);
      foldTimes.push(Date.now());
    },
    tickNumber: () => 1,
    // The retry's wait, recorded instead of lived through: a hint-less 429 now defaults to
    // a real minute (BUGS.md 2026-09-25), and no rate-limit test may spend wall clock on it.
    sleep: async (ms: number) => {
      sleeps.push(ms);
      sleepAts.push(Date.now());
    },
    abortRunSignal: () => ctl.abort(),
  };
  const loopPi = new LoopPi(host as unknown as ConstructorParameters<typeof LoopPi>[0]);
  return { loopPi, warns, usage, foldTimes, sleeps, sleepAts, abortRunSignal: ctl.abort.bind(ctl), config };
}

/** A fake pi that records each invocation's argv. `firstRun` runs only on the first
 * invocation (a transient failure of the world); every later invocation prints the success
 * line the retry should observe. */
function recordingFakePi(
  argsFile: string,
  opts: { firstRun?: string } = {},
): () => void {
  const lines = [`printf '%s\\n' "$*" >> "${argsFile}"`];
  if (opts.firstRun) {
    lines.push(
      `if [ ! -f "${argsFile}.ran-once" ]; then touch "${argsFile}.ran-once"; ${opts.firstRun}; exit 0; fi`,
      `printf '%s\\n' '${assistantLine("done\\nSUMMARY: tidied src")}'`,
    );
  }
  return fakePi(lines.join("\n"));
}

function runArgs(argsFile: string): string[] {
  return fs.readFileSync(argsFile, "utf8").trimEnd().split("\n");
}

test("runRolePi runs a fresh named session and folds one usage into the tick", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args);
  try {
    const { loopPi, usage } = makeHost(root);
    const result = await loopPi.runRolePi(root, "work the backlog", "tumwater-feature-1-author");
    assert.equal(result.ok, true);
    const line = runArgs(args)[0]!;
    assert.match(line, /-n tumwater-feature-1-author/, "fresh session is named, not resumed");
    assert.ok(!line.includes("--continue"), "a fresh session must not pass --continue");
    assert.ok(line.endsWith("work the backlog"), "the prompt is pi's last argument");
    assert.equal(usage.length, 1, "one run, one foldUsage");
    assert.equal(usage[0], result, "the foldUsage'd run IS the returned run");
  } finally {
    restore();
  }
});

test("runRolePi with resume passes --continue so a shutdown-interrupted tick resumes its session", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args);
  try {
    const { loopPi } = makeHost(root);
    const result = await loopPi.runRolePi(root, "keep working", "tumwater-feature-2-author", true);
    assert.equal(result.ok, true);
    const line = runArgs(args)[0]!;
    assert.ok(line.includes("--continue"), "resume continues the role's session");
    assert.ok(!/-n /.test(line), "no -n when resuming");
  } finally {
    restore();
  }
});

test("a rate-limited run earns exactly one retry that waits out the Retry-After hint and continues the session", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    // The provider's 429 with its Retry-After hint, rendered as pi shows it.
    firstRun: `printf '%s\\n' '${errorLine('429 "Rate limit exceeded" — retry after 3s')}'`,
  });
  try {
    const { loopPi, warns, usage, foldTimes, sleeps, sleepAts } = makeHost(root);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-3-author");
    assert.equal(result.ok, true, "the retry succeeds");
    assert.match(result.finalText, /^done/);
    assert.equal(usage.length, 2, "BOTH attempts are folded into the tick's spend");
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /rate-limited the request \(429, retry after 3s\)/);

    const [firstArgs, retryArgs] = runArgs(args);
    assert.match(firstArgs!, /-n tumwater-feature-3-author/, "the first attempt starts fresh");
    assert.match(retryArgs!, /--continue/, "the retry resumes the first attempt's session");
    assert.ok(!/-n /.test(retryArgs!), "the retry does not re-name the session");

    assert.deepEqual(sleeps, [3000], "the 3s hint is waited out before the retry");
    // The failed attempt folds BEFORE the wait and the retry, so the 429 it ended on reaches
    // the orchestrator's fleet-wide hold (LoopRunner.lastRateLimit) while the retry waits — not
    // after a retry that may run for an hour (BUGS.md 2026-09-21 "A 429 storm still has no
    // fleet-wide hold").
    assert.ok(foldTimes[0]! <= sleepAts[0]!, "the rate-limited attempt is folded before the wait starts");
  } finally {
    restore();
  }
});

test("a rate-limited run with no Retry-After hint waits the minute-scale refill pause, not 0", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    firstRun: `printf '%s\\n' '${errorLine('429 "Rate limit exceeded"')}'`,
  });
  try {
    const { loopPi, warns, usage, sleeps } = makeHost(root);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-4-author");
    assert.equal(result.ok, true);
    assert.equal(usage.length, 2);
    // The provider sent no hint, so the wait defaults to the fleet's own refill physics — the
    // minute-scale base hold (BUGS.md 2026-09-25: an immediate retry lands in the same
    // exhausted per-minute bucket and burns the tick's only retry) — and the warning says so.
    assert.deepEqual(sleeps, [60_000], "no hint means the minute-scale refill pause, not 0");
    assert.match(warns[0]!, /\(429, no hint — waiting 60s\) — retrying/);
  } finally {
    restore();
  }
});

test("a Retry-After hint of 0 counts as no hint and waits the minute-scale refill pause", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    // A provider can legitimately echo "Retry-After: 0" — which is no usable hint at all.
    firstRun: `printf '%s\\n' '${errorLine('429 "Rate limit exceeded" — retry after 0s')}'`,
  });
  try {
    const { loopPi, warns, sleeps } = makeHost(root);
    await loopPi.runRolePi(root, "work", "tumwater-feature-6-author");
    // A zero-second hint must not sneak the fixed 2026-09-25 bug back in through the side
    // door: a hint that asks for no wait is treated as no hint, so the refill pause applies.
    assert.deepEqual(sleeps, [60_000], "a 0-second hint waits the refill pause, not 0");
    assert.match(warns[0]!, /\(429, no hint — waiting 60s\) — retrying/);
  } finally {
    restore();
  }
});

test("a Retry-After hint larger than the cap is waited out only to the cap", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    firstRun: `printf '%s\\n' '${errorLine('429 "Rate limit exceeded" — retry after 300s')}'`,
  });
  try {
    const { loopPi, sleeps } = makeHost(root);
    await loopPi.runRolePi(root, "work", "tumwater-feature-5-author");
    assert.deepEqual(sleeps, [120_000], "one generous hint cannot eat the tick's own run budget");
  } finally {
    restore();
  }
});

test("a backend-kind failure the retry does not cover warns once and earns no retry", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    // pi's fetch-level rendering of a dead provider endpoint — the connection kind of
    // BUGS.md 2026-09-29's silent storm.
    firstRun: `printf '%s\\n' '${errorLine("Connection error.")}'`,
  });
  try {
    const { loopPi, warns, usage } = makeHost(root);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-7-author");
    assert.equal(result.ok, false, "the run fails — a dead backend is not retried");
    assert.equal(result.transientBackend, true);
    assert.equal(result.backendKind, "connection");
    // The per-run floor (BUGS.md 2026-09-29): the episode is visible from the feed alone —
    // one warning naming the kind — where before it left only a per-tick error event.
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /provider backend failure \(connection error\)/);
    assert.equal(usage.length, 1, "one attempt, one foldUsage — no retry for this kind");
    assert.equal(runArgs(args).length, 1, "exactly one pi invocation");
  } finally {
    restore();
  }
});

test("a successful run that merely saw a backend error mid-stream stays silent", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    // A provider blip that pi recovered from: the error line rides mid-stream and the run
    // still completes — nothing failed, so there is nothing to warn about.
    firstRun: `printf '%s\\n' '${errorLine("Connection error.")}' '${assistantLine("done\\nSUMMARY: tidied src")}'`,
  });
  try {
    const { loopPi, warns, usage } = makeHost(root);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-8-author");
    assert.equal(result.ok, true);
    assert.equal(warns.length, 0, "a recovered run raises no alarm");
    assert.equal(usage.length, 1);
  } finally {
    restore();
  }
});

test("runLandingPi ignores the tick's per-tick runSignal — an aborted tick must not abort a queued landing", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args);
  try {
    const { loopPi, usage, abortRunSignal } = makeHost(root);
    abortRunSignal(); // the stale per-tick controller of a finished (or aborted) tick
    const result = await loopPi.runLandingPi(root, "resolve the conflict", "tumwater-feature-review");
    assert.equal(result.ok, true, "the landing runs to completion");
    assert.equal(usage.length, 1);
    assert.match(runArgs(args)[0]!, /resolve the conflict/);
  } finally {
    restore();
  }
});

test("runLandingPi still honors the harness shutdown signal", async () => {
  const root = tmpdir();
  const restore = fakePi(`sleep 30`);
  try {
    // Point the host's shutdown signal at a real controller and fire it mid-run.
    const shutdown = new AbortController();
    const loopPi = new LoopPi({
      root,
      role: "feature",
      config: () => defaultConfig(),
      signal: shutdown.signal,
      runSignal: () => new AbortController().signal,
      warn: () => {},
      foldUsage: () => {},
      tickNumber: () => 1,
    } as unknown as ConstructorParameters<typeof LoopPi>[0]);
    const pending = loopPi.runLandingPi(root, "land", "t");
    shutdown.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.aborted, true);
    assert.match(result.errorMessage ?? "", /aborted by harness shutdown/);
  } finally {
    restore();
  }
});

test("requestSummary returns null when the role has no resumable session", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args);
  try {
    const { loopPi } = makeHost(root);
    const result = await loopPi.requestSummary(root);
    assert.equal(result, null);
    assert.ok(!fs.existsSync(args), "no pi run is spawned when there is no session to continue");
  } finally {
    restore();
  }
});

test("requestSummary resumes the tick's session and folds its usage", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    firstRun: `printf '%s\\n' '${assistantLine("SUMMARY: tidied the parser")}'`,
  });
  try {
    fs.mkdirSync(sessionDir(root, "feature"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(root, "feature"), "session.jsonl"), "{}\n");
    const { loopPi, usage } = makeHost(root);
    const result = await loopPi.requestSummary(root);
    assert.ok(result, "a resumable session produces a run");
    assert.equal(result!.ok, true);
    assert.match(result!.finalText, /tidied the parser/);
    assert.equal(usage.length, 1);
    assert.match(runArgs(args)[0]!, /--continue/, "the follow-up continues the authoring session");
  } finally {
    restore();
  }
});
