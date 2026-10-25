import type { PiRunResult } from "../../src/pi/pi-run-result.js";
import fs from "node:fs";
import { APPROVE_PI, assistantLine } from "../fixtures/pi-events.js";
import { pathPrepend, readRunBlocks, RUN_MARKER, writeScript } from "./fake-commands.js";
import { tmpdir } from "../fixtures/repo-fixtures.js";
import path from "node:path";

// --- The fake pi shim (fakePi/fakePiIdle/recordingFakePi/piRunResult), split out of the old
// util.ts grab-bag ---
// Every helper here installs or models a fake `pi` executable: tests run offline against these
// shims on PATH, never a real model (see PRINCIPLES.md). The generic install machinery they
// sit on — writeScript/pathPrepend, the fake-command-on-PATH technique — lives in
// fake-commands.ts; runner-fixtures.ts builds on it too (buildCheckFixture).

// A shim on PATH runs only when nothing outranks PATH in resolveBackendBin, and TUMWATER_PI_BIN
// does: an inherited one (an operator's wrapper around the real pi, which a team's pi tool
// calls and build checks all inherit) would replace every fake here with the real agent
// (BUGS.md 2026-09-28). The test runner already drops it (suiteEnv in test/test-runner.ts); this
// covers a test file run directly with `node --test`. Tests of the variable set it themselves.
delete process.env.TUMWATER_PI_BIN;

/** A shell fragment for fake-pi scripts: create a session file in the --session-dir pi was
 * given, so the harness's resume/continue guard (hasResumableSession) sees a session to
 * continue. The runner tests repeated this fragment verbatim; shared here so a change to how
 * the session dir must be seeded cannot drift between the copies. */
export const TOUCH_SESSION = `prev=""; for a in "$@"; do if [ "$prev" = "--session-dir" ]; then mkdir -p "$a"; touch "$a/s.jsonl"; fi; prev="$a"; done`;

/** A shell fragment for fake-pi scripts: record which session-resume flags pi was invoked
 * with (`--continue`/`-n`), appending one `run:<flags>` line per run to `file`. The runner and
 * pi tests repeated this fragment verbatim (seven copies across four files); shared here so
 * a change to how the resume flags are observed cannot drift between the copies. */
export function logFlagsTo(file: string): string {
  return `flags=""; for a in "$@"; do case "$a" in --continue|-n) flags="$flags $a";; esac; done; echo "run:$flags" >> "${file}"`;
}

/** The shell fragment every fake pi starts with: a `--print` run reads its piped stdin — the
 * prompt, which the pi backend delivers there and never in argv (BUGS.md 2026-10-18) — and
 * appends it to the positional args, so a fake matches or records the prompt as its last
 * argument (`for a in "$@"; do case "$a" in *"VERDICT:"*)`, logPromptsTo) exactly as it did
 * when the prompt rode argv. Real pi trims the piped text; `$(cat)` drops trailing newlines.
 * `cat` when PATH has it (one spawn; a builtin read loop spends ~25 ms of CPU on a 37 KB
 * prompt, measured 2026-10-18), else the read loop, so a fake under a restricted PATH still
 * sees its prompt. An empty stdin (the image probe's `ignore`) adds no argument. */
export const PROMPT_FROM_STDIN = [
  `for __pi_a in "$@"; do`,
  `  if [ "$__pi_a" = --print ] && [ ! -t 0 ]; then`,
  `    if command -v cat >/dev/null 2>&1; then __pi_prompt=$(cat); else`,
  `      __pi_prompt=""; __pi_nl="$(printf '\\n_')"; __pi_nl="\${__pi_nl%_}"`,
  `      while IFS= read -r __pi_l || [ -n "$__pi_l" ]; do __pi_prompt="$__pi_prompt\${__pi_prompt:+$__pi_nl}$__pi_l"; done`,
  `    fi`,
  `    if [ -n "$__pi_prompt" ]; then set -- "$@" "$__pi_prompt"; fi`,
  `    break`,
  `  fi`,
  `done`,
].join("\n");

/** Install a fake pi at `file` (writeScript) whose body runs after PROMPT_FROM_STDIN — the
 * one way a test writes a pi script, so every fake sees its prompt the same way. Now used only
 * inside fakePi below. */
function writePiScript(file: string, body: string): void {
  writeScript(file, `${PROMPT_FROM_STDIN}\n${body}`);
}

/** A shell fragment for fake-pi scripts: append the run's full argv (the prompt is its last
 * argument once PROMPT_FROM_STDIN has run) to `file` as one `RUN_MARKER`-delimited block per
 * run. The runner, requeue, and review-precheck tests repeated this fragment verbatim — with two
 * drifting spellings of the printf newline — so the prompt-capture technique is shared here,
 * like logFlagsTo, and a change to how prompts are observed cannot drift between the copies.
 * Pair with readRunBlocks to read the log back. */
export function logPromptsTo(file: string): string {
  return `{ printf '%s\\n' "$@"; echo "${RUN_MARKER}"; } >> "${file}"`;
}

/** The run-block reader the pi tests import beside logPromptsTo, their writer: fake-commands'
 * readRunBlocks, the single home of the `RUN_MARKER` split shared with the fake-claude replay.
 * Re-exported rather than redefined so the format has one implementation. */
export { readRunBlocks };

/** Install a fake `pi` executable at the front of PATH for the duration of a test.
 * The script runs with the worktree as cwd. Returns a restore function. */
export function fakePi(script: string): () => void {
  const dir = tmpdir("fake-pi-");
  writePiScript(path.join(dir, "pi"), script);
  return pathPrepend(dir);
}

/** The script fakePiIdle installs: one compliant TUMWATER_NOTHING_TO_DO assistant line — the
 * standard fixture for a run that finds nothing to do. The single home of the printf +
 * assistantLine idiom the orchestrator and runner tests repeated verbatim, so the sentinel's
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
 * restore(); }` boilerplate the tests repeated verbatim across the suite, so a test only writes
 * its script and its body and the save/restore pairing cannot be forgotten or double-restore. */
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

/** Run one async block under the reviewers' approve pi (pi-events.ts's APPROVE_PI) — the withPi
 * form of `const restore = fakePi(APPROVE_PI); try { … } finally { restore(); }`, which the
 * merger tests (merger/merger-bisect/merger-restack/merger-errors) each hand-rolled at every
 * runBatch/verifyAndMerge site. A test writes only its body and the save/restore pairing cannot be
 * forgotten or double-restore; tests pinning a different reviewer reply keep withPi directly. */
export async function withApprovePi<T>(fn: () => Promise<T>): Promise<T> {
  return withPi(APPROVE_PI, fn);
}

/** Run one async block under the review tests' standard approving reviewer stub — the withPi
 * form of `withPi(reviewerStub(marker), fn)`, which review-precheck.test.ts hand-rolled at
 * eighteen sites. A test writes only its marker (the proof its review run happened, or
 * undefined when it does not assert that) and its body, and the save/restore pairing cannot be
 * forgotten or double-restore; tests composing a different reviewer reply (a logPromptsTo
 * fragment or a custom verdict) keep withPi/reviewerStub directly, exactly as the merger tests
 * reach past withApprovePi when they pin a distinct script. */
export async function withReviewerStub<T>(
  marker: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return withPi(reviewerStub(marker), fn);
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

/** The marker-file convention for "proof this fake pi actually ran": a fresh path under the
 * system temp that the test's fake-pi script `touch`es (reviewerStub builds that line in; a
 * hand-rolled script spells `touch '<marker>'`) and the test asserts with existsSync — present
 * means pi ran, absent means the harness stopped short of it. Twenty sites across four test
 * files spelled `path.join(tmpdir(), "pi-ran")` inline; shared here so the marker's home and
 * name cannot drift per file. */
export function piRanMarker(): string {
  return path.join(tmpdir(), "pi-ran");
}

/** A shell fragment list for fake-pi scripts: the phase gate the runner tests use to make a
 * fake pi do real work on its first run and idle on every later one — create `marker`, run
 * the `firstRun` lines, and on every later invocation emit the standard
 * TUMWATER_NOTHING_TO_DO line. Eight runner tests hand-rolled this if/then/else skeleton (with
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
 * poll it from before the team starts. One home for the read/split/filter idiom five test
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
    promptTokens: 0,
    cacheReadTokens: 0,
    preEditPromptTokens: 0,
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
    configError: false,
    transientPiCrash: false,
    finalMessageContentless: false,
    producedAssistantContent: false,
    compacted: false,
    ...over,
  };
}
