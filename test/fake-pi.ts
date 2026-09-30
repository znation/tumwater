import type { PiRunResult } from "../src/pi.js";
import fs from "node:fs";
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

/** A shell fragment for fake-pi scripts: append the run's full argv (the prompt is pi's last
 * argument) to `file` as one `===RUN===`-delimited block per run. The loop, requeue, and
 * review-precheck tests repeated this fragment verbatim — with two drifting spellings of the
 * printf newline — so the prompt-capture technique is shared here, like logFlagsTo, and a
 * change to how prompts are observed cannot drift between the copies. Pair with
 * readPromptRuns to read the log back. */
export function logPromptsTo(file: string): string {
  return `{ printf '%s\\n' "$@"; echo "===RUN==="; } >> "${file}"`;
}

/** Read back a prompt log written by logPromptsTo: one string per recorded pi run (its argv,
 * newline-separated), blank blocks dropped. The loop, requeue, and review-precheck tests
 * repeated this split-and-filter verbatim; shared with logPromptsTo so the capture format's
 * single home covers both its writer and its reader. */
export function readPromptRuns(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("===RUN===").filter((b) => b.trim());
}

/** Install a fake `pi` executable at the front of PATH for the duration of a test.
 * The script runs with the worktree as cwd. Returns a restore function. */
export function fakePi(script: string): () => void {
  const dir = tmpdir("fake-pi-");
  writeScript(path.join(dir, "pi"), script);
  return pathPrepend(dir);
}

/** The script fakePiIdle installs: one compliant TUMWATER_NOTHING_TO_DO assistant line — the
 * standard fixture for a tick that finds nothing to do. The single home of the printf +
 * assistantLine idiom the orchestrator and loop tests repeated verbatim, so the sentinel's
 * spelling cannot drift per fixture. `opts` passes through to assistantLine when a test pins
 * tokens or cost. */
function idlePiScript(opts: { cost?: number } = {}): string {
  return `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO", opts)}'`;
}

/** A fake pi whose only action is emitting one compliant TUMWATER_NOTHING_TO_DO assistant
 * line. `opts` passes through to assistantLine when a test pins tokens or cost. */
export function fakePiIdle(opts: { cost?: number } = {}): () => void {
  return fakePi(idlePiScript(opts));
}

/** Run one async block with fakePi's script on PATH, restoring PATH afterwards even when the
 * block throws — the async form of the `const restore = fakePi(...); try { ... } finally {
 * restore(); }` boilerplate the loop tests repeated verbatim, so a test only writes its script
 * and its body and the save/restore pairing cannot be forgotten or double-restore. */
export async function withPi<T>(script: string, fn: () => Promise<T>): Promise<T> {
  const restore = fakePi(script);
  try {
    return await fn();
  } finally {
    restore();
  }
}

/** Run one async block with fakePiIdle's script on PATH — the withPi form of fakePiIdle, so a
 * nothing-to-do test writes only its body and the same save/restore pairing rules it. */
export async function withIdlePi<T>(fn: () => Promise<T>): Promise<T> {
  return withPi(idlePiScript(), fn);
}

/** The review tests' standard reviewer stub: a fake-pi script that creates `marker` (when
 * given — the test's proof the review run actually happened, asserted with existsSync) and
 * prints "VERDICT: approve" as the review run's one assistant turn. The single home of the
 * touch+printf script review.test.ts hand-rolled at nineteen call sites, so the marker
 * idiom and the printf wrapper cannot drift per test; tests pinning a different verdict or
 * usage numbers still hand their own reply to pi-events.ts's assistantLine directly. */
export function reviewerStub(marker?: string): string {
  const reply = `printf '%s\\n' '${assistantLine("VERDICT: approve")}'`;
  return marker === undefined ? reply : `touch '${marker}'\n${reply}`;
}

/** A shell fragment list for fake-pi scripts: the phase gate the loop tests use to make a
 * fake pi do real work on its first run and idle on every later one — create `marker`, run
 * the `firstRun` lines, and on every later invocation emit the standard
 * TUMWATER_NOTHING_TO_DO line. Eight loop tests hand-rolled this if/then/else skeleton (with
 * two drifting spellings of the printf newline); shared here so the gate's shape — and the
 * idle line it re-emits — cannot drift between the copies. Pass `firstRun` lines unindented;
 * they are indented two spaces to sit inside the if-branch. */
export function firstRunThenIdle(marker: string, firstRun: readonly string[]): string[] {
  return [
    `if [ ! -f "${marker}" ]; then`,
    `  touch "${marker}"`,
    ...firstRun.map((line) => (line === "" ? line : `  ${line}`)),
    `else`,
    `  printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    `fi`,
  ];
}

/** A shell fragment list for fake-pi scripts: the merge-conflict fixtures' authoring run —
 * pi prints its `ok` reply (SUMMARY: branch edit of seed) and writes `branch change` to
 * seed.txt on the branch. Seven copies across the merge-conflict and leftover-recovery
 * tests (one drifted to a double-escaped printf newline); shared here so the reply's shape
 * and the seed edit cannot drift between the copies. Pair with conflictingMainEdit for the
 * full "branch edit + conflicting main advance" scenario. */
export function seedBranchEdit(): string[] {
  return [
    `printf '%s\\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
    `echo branch change > seed.txt`,
  ];
}

/** A shell fragment list for fake-pi scripts: the merge-conflict fixtures' other half —
 * advance main in the primary checkout with a conflicting seed.txt edit, committed directly
 * in that checkout (the way a user's own work would arrive). Five copies across the
 * merge-conflict and leftover-recovery tests; shared with seedBranchEdit so the scenario's
 * two halves have one home each and the conflicting commit's shape cannot drift. */
export function conflictingMainEdit(repo: string): string[] {
  return [
    `echo main change > "${repo}/seed.txt"`,
    `git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main edit"`,
  ];
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

/** The `run: …` lines a fake pi has recorded so far — recordingFakePi appends one per pi
 * invocation (hand-rolled recorder scripts write the same prefix), so this is what the pi
 * process actually saw. Returns [] before pi's first run creates the file, so a caller can
 * poll it from before the fleet starts. One home for the read/split/filter idiom five test
 * modules hand-rolled. */
export function readRunLines(argsFile: string): string[] {
  try {
    return fs.readFileSync(argsFile, "utf8").split("\n").filter((l) => l.startsWith("run:"));
  } catch {
    return [];
  }
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
