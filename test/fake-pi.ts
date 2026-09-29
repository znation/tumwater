import type { PiRunResult } from "../src/pi.js";
import { assistantLine } from "./pi-events.js";
import { pathPrepend, writeScript } from "./fake-commands.js";
import { tmpdir } from "./repo-fixtures.js";
import path from "node:path";

// --- The fake pi shim (fakePi/fakePiIdle/recordingFakePi/piRunResult), split out of the old util.ts grab-bag ---
// Every helper here installs or models a fake `pi` executable: tests run offline against these
// shims on PATH, never a real model (see PRINCIPLES.md). The generic install machinery they
// sit on — writeScript/pathPrepend, the fake-command-on-PATH technique — lives in
// fake-commands.ts; loop-fixtures.ts builds on it too (buildCheckFixture).

// A shim on PATH runs only when nothing outranks PATH in resolveAgentBin, and TUMWATER_PI_BIN
// does: an inherited one (an operator's wrapper around the real pi, which a fleet's pi tool
// calls and build checks all inherit) would replace every fake here with the real agent
// (BUGS.md 2026-09-28). The test runner already drops it (suiteEnv in test/test-runner.ts); this
// covers a test file run directly with `node --test`. Tests of the variable set it themselves.
delete process.env.TUMWATER_PI_BIN;

/** A shell fragment for fake-pi scripts: create a session file in the --session-dir pi was
 * given, so the harness's resume/continue guard (hasResumableSession) sees a session to
 * continue. The loop tests repeated this fragment verbatim; shared here so a change to how
 * the session dir must be seeded cannot drift between the copies. */
export const TOUCH_SESSION = `prev=""; for a in "$@"; do if [ "$prev" = "--session-dir" ]; then mkdir -p "$a"; touch "$a/s.jsonl"; fi; prev="$a"; done`;

/** A shell fragment for fake-pi scripts: record which session-resume flags pi was invoked
 * with (`--continue`/`-n`), appending one `run:<flags>` line per run to `file`. The loop and
 * pi tests repeated this fragment verbatim (seven copies across four files); shared here so
 * a change to how the resume flags are observed cannot drift between the copies. */
export function logFlagsTo(file: string): string {
  return `flags=""; for a in "$@"; do case "$a" in --continue|-n) flags="$flags $a";; esac; done; echo "run:$flags" >> "${file}"`;
}

/** Install a fake `pi` executable at the front of PATH for the duration of a test.
 * The script runs with the worktree as cwd. Returns a restore function. */
export function fakePi(script: string): () => void {
  const dir = tmpdir("fake-pi-");
  writeScript(path.join(dir, "pi"), script);
  return pathPrepend(dir);
}

/** A fake pi whose only action is emitting one compliant TUMWATER_NOTHING_TO_DO assistant
 * line — the standard fixture for a tick that finds nothing to do. The single home of the
 * printf + assistantLine idiom the orchestrator and loop tests repeated verbatim, so the
 * sentinel's spelling cannot drift per fixture. `opts` passes through to assistantLine when
 * a test pins tokens or cost. */
export function fakePiIdle(opts: { cost?: number } = {}): () => void {
  return fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO", opts)}'`);
}

/** A fake pi that records each run's --provider/--model flags — and its session name, which
 * carries the role — to argsFile and declares nothing-to-do (so no commit happens). `cost`
 * makes each run report that many dollars of spend, for tests that drive the daily budget
 * gate while watching which model each run used. */
export function recordingFakePi(argsFile: string, opts: { cost?: number } = {}): () => void {
  return fakePi(
    [
      `m=""; p=""; n=""`,
      `while [ $# -gt 0 ]; do case "$1" in --model) m="$2";; --provider) p="$2";; -n) n="$2";; esac; shift; done`,
      `echo "run: model=$m provider=$p session=$n" >> "${argsFile}"`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO", { cost: opts.cost ?? 0 })}'`,
    ].join("\n"),
  );
}

/** A fully-neutral successful PiRunResult: every field the harness reads at its inert value,
 * overridden by whatever the test exercises (`piRunResult({ refused: true })`). One home for
 * the neutral defaults — six test modules each hand-rolled the full 17-field literal and had
 * already drifted (turns 1 vs 3, three different finalTexts), so a new PiRunResult field had
 * to be added to every copy. */
export function piRunResult(over: Partial<PiRunResult> = {}): PiRunResult {
  return {
    ok: true,
    finalText: "",
    nothingToDo: false,
    refused: false,
    outputTokens: 0,
    peakContextTokens: 0,
    turns: 1,
    costUsd: 0,
    timedOut: false,
    timedOutProgressing: false,
    quietKilled: false,
    aborted: false,
    contextExceeded: false,
    transientServerTimeout: false,
    transientRateLimit: false,
    transientBackend: false,
    transientPiCrash: false,
    finalMessageContentless: false,
    compacted: false,
    ...over,
  };
}
