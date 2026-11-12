/** The doctor's checks that inspect the project's own on-disk state, disk and build,
 * split out of doctor-checks.ts (whose environment/repo file still holds the toolchain and
 * setup checks — the node/git/exec binaries, the repo/init/config/brief/bootstrap setup, the
 * agent backends' CLI versions and the operator pi-extension/funes coordination). This module
 * holds the checks that look at the project itself: a writable .tumwater (checkStateDir), a
 * readable event feed (checkEventLog), a root free of leaked zero-byte files
 * (checkEmptyRootFiles), enough free disk (checkDiskSpace), a declared project
 * check (checkBuildCheck), the review gate's flake memory (checkFlakyChecks) and build
 * provenance (checkBuild). Read-only like every doctor check; the private helpers each cluster
 * uses (sweepStaleProbes, eventLogHistoryPhrase, firstEventLine, diskReclaimPhrase,
 * checkDurationPhrase, currentHead) live here beside the checks that use them. doctor.ts stays
 * the composition layer that calls each check in fixed order. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { CheckConfigSlice, TumwaterConfig } from "../config/config-schema.js";
import { detectBuildCheck, mergeCommandOf } from "../build/build-check-detect.js";
import { isPassingFullCheck } from "../build/build-check-events.js";
import { type BuildInfo, type BuildStatus, buildStaleness, isSelfHosted, readBuildInfo, STALE_INPUTS_LABEL } from "../build/build-info.js";
import { dirEntryNames, statOrNull } from "../files/files.js";
import { refSha } from "../git/git.js";
import { resolvedGitBin } from "../git/git-run.js";
import { errCode } from "../errno.js";
import { STATE_DIR, eventsArchivePath, eventsLogPath } from "../paths.js";
import { BYTES_PER_GB, diskVolumePath, sampleFreeBytes } from "../gates/disk-gates.js";
import { DAY_MS, dayKey, humanAgo, humanSince } from "../text/datetime.js";
import { errorMessage } from "../text/text.js";
import { medianAndMax } from "../collections.js";
import { formatGB, shortSha } from "../text/format.js";
import { eventLogState, readEventsSince, type EventLogState } from "../events/event-window.js";
import { EVENTS_KEEP, type HarnessEvent } from "../events/events.js";
import { finiteNumber } from "../files/json-object.js";
import { agree, plural, restartHoldPhrase, shortSpanPhrase, trailingDayMedianPhrase } from "../text/phrases.js";
import { andMore } from "./doctor-backlog.js";
import { KNOWN_FLAKE_WINDOW_MS, loadQuarantine, repeatedFlakeCounts } from "../review/known-flakes.js";
import { POST_MERGE_REJECT_WINDOW_MS, postMergeChurn } from "../review/post-merge-review.js";
import { roleLabel } from "../roles/role-labels.js";
import { quarantineWarning } from "../baseline/main-guardrails.js";
import { readCiParity, currentCiParityState, parityIsCurrent, ciParityStalled, CI_PARITY_STALE_MS } from "../observer/ci-parity.js";
import { readRemoteCi, type RemoteCiEntry, remoteCiStalled, remoteCiTarget } from "../observer/remote-ci.js";
import { readQaCoverage, qaCoverageStalled, QA_COVERAGE_STALE_MS } from "../observer/qa-coverage.js";
import { failOutcome, okOutcome, warnOutcome, type CheckOutcome } from "./doctor-outcome.js";

/** .tumwater writable — absent is fine (created on first run); present, prove it by writing
 * and deleting a temp file inside. The probe leaves the dir's listing unchanged after the run.
 * The write is the property under test: only a write that fails is "not writable", so the
 * cleanup below — deleting the probe, sweeping stales — never vetoes a dir the write just
 * proved writable, and a probe left over is swept rather than accumulated. */
export function checkStateDir(root: string): CheckOutcome {
  const dir = path.join(root, STATE_DIR);
  if (!fs.existsSync(dir)) return okOutcome("absent — created on first run");
  const probe = path.join(dir, `.doctor-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
  } catch (err) {
    // A partial write may already have created the file — sweep it like any other leftover.
    sweepStaleProbes(dir);
    return failOutcome(`not writable: ${errorMessage(err)}`);
  }
  // The write proved writability. Deleting the probe is cleanup, not measurement: a removal
  // failure must not turn a succeeded write into a false alarm, and the stray is collected by
  // the sweep below (or a later pass's sweep).
  try {
    fs.rmSync(probe);
  } catch {
    // Best-effort — the stray is swept in a moment.
  }
  sweepStaleProbes(dir);
  return okOutcome("writable");
}

/** Best-effort removal of every `.doctor-probe-*` file in `dir` — the only artifact
 * checkStateDir creates, so any present probe is a leftover: a prior run killed between its
 * write and delete, a partial write above, or a removal that failed. Removed one at a time so
 * a single unremovable probe cannot stop the sweep. */
function sweepStaleProbes(dir: string): void {
  for (const name of dirEntryNames(dir)) {
    if (!name.startsWith(".doctor-probe-")) continue;
    try {
      fs.rmSync(path.join(dir, name));
    } catch {
      // Best-effort — leave it for the next pass.
    }
  }
}

/** Event log readable — open and parse events.jsonl (and its rotated archive) so the one
 * failure the selfcheck role is chartered to catch — a feed that hid itself — is named by the
 * pre-flight too. An absent or empty log is fine: a young project writes its first event on the
 * first run. A present-but-unparseable log (a directory at the path, a permission failure, or
 * every complete line corrupt) fails, because every observer — selfcheck, the TUI/GUI feeds,
 * `logs`, `report` — reads that one feed. Read-only. */
export function checkEventLog(root: string): CheckOutcome {
  let state: EventLogState;
  try {
    state = eventLogState(root);
  } catch (err) {
    return failOutcome(`could not read ${eventsLogPath(root)}: ${errorMessage(err)}`);
  }
  if (state === "unreadable")
    return failOutcome(`unreadable: ${eventsLogPath(root)} — the team's event feed cannot be read`);
  if (state === "empty") return okOutcome("no events yet");
  const history = eventLogHistoryPhrase(root);
  return okOutcome(history ? `readable: ${eventsLogPath(root)} — ${history}` : `readable: ${eventsLogPath(root)}`);
}

/** Wall-clock bound on the probe: the listing is local and cheap (ms); a git that takes this
 * long is wedged and would otherwise freeze the sync call with nothing able to interrupt it. A
 * doctor is a diagnostic the operator runs by hand — it must return, not hang the terminal. */
const EMPTY_ROOT_FILES_TIMEOUT_MS = 10_000;
/** The doctor's `empty files` row. A tracked repo-root file with no content is a leaked shell
 * artifact, never intentional: one `clean` run word-split unquoted command prose and redirected
 * each word to an empty path, and the harness's `git add -A` swept the 37 into main (BUGS.md
 * 2026-11-11, commit a0d6b4713). `git ls-files -z` lists the tracked paths, the slashless ones
 * are the root, and each is stat'ed for size. Root-scoped only — an empty file in a
 * subdirectory (a `.gitkeep`, an intentionally-empty marker) is legitimate, so those are
 * ignored. A directory that is not a git checkout holds no tracked files, so it reads ok (the
 * `repo` row already fails a non-repo; this row must not double-count it). A git checkout whose
 * file listing cannot be read fails naming the read error, matching checkEventLog's unreadable
 * branch. The `git ls-files -z` probe is a synchronous spawnSync, so a wedged git (an unmounted
 * volume, a locked index) blocks the whole event loop — no timer or watchdog can run until it
 * returns (the same hazard git-run's xcrun probe, session-ledger's session delete, and the
 * `pi list` probe all bound); the wall-clock bound kills the child with SIGKILL and the row
 * then fails loudly naming the deadline. Read-only. */
export function checkEmptyRootFiles(root: string, seams: { timeoutMs?: number; gitBin?: () => string } = {}): CheckOutcome {
  if (!fs.existsSync(path.join(root, ".git")))
    return okOutcome("not a git checkout — no tracked root files to scan");
  const timeoutMs = seams.timeoutMs ?? EMPTY_ROOT_FILES_TIMEOUT_MS;
  const gitBin = seams.gitBin ? seams.gitBin() : resolvedGitBin();
  const res = spawnSync(gitBin, ["ls-files", "-z"], {
    cwd: root,
    encoding: "buffer",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (res.status !== 0) {
    // res.error carries the spawn's failure: an unkillable child on the timeout (ETIMEDOUT),
    // a binary that could not be started (ENOENT), or the child's own nonzero exit stderr.
    const err = res.error ?? (res.stderr?.toString("utf8") || `exit ${res.status}`);
    const detail =
      errCode(res.error) === "ETIMEDOUT"
        ? `git ls-files did not finish within ${timeoutMs / 1000} s`
        : err;
    return failOutcome(`could not read the tracked root file list: ${detail}`);
  }
  // -z lists NUL-separated, unquoted paths: a non-ASCII name (the ay—andp fragment) is raw
  // bytes, so split on NUL — newline-splitting would glue two names together.
  const paths = (res.stdout?.toString("utf8") ?? "").split("\u0000").filter((p) => p !== "");
  const empty = paths.filter((p) => !p.includes("/") && statOrNull(path.join(root, p))?.size === 0);
  if (empty.length === 0) return okOutcome("no empty tracked root file");
  const listed = empty.slice(0, 8);
  const more = empty.length - listed.length;
  return failOutcome(`${plural(empty.length, "empty tracked root file")}: ${listed.join(", ")}` +
    (more > 0 ? ` (and ${more} more)` : "") +
    " — leaked shell artifacts (a redirected word, not real content); remove them with `git rm <path>`");
}
/** The `history from <date>, <n> files` phrase for checkEventLog's ok detail (G4): the first
 * complete line of the oldest event-log generation present names how far back the kept history
 * reaches, and the count is how many generations (live file plus archives) exist. Undefined
 * when no generation parses an event, so a readable-but-shapeless log still reads as readable. */
function eventLogHistoryPhrase(root: string): string | undefined {
  const present: string[] = [];
  const livePath = eventsLogPath(root);
  if (statOrNull(livePath)) present.push(livePath);
  for (let gen = 1; gen <= EVENTS_KEEP; gen++) {
    const archive = eventsArchivePath(root, gen);
    if (statOrNull(archive)) present.push(archive);
  }
  if (present.length === 0) return undefined;
  const oldest = present[present.length - 1]!;
  const ev = firstEventLine(oldest);
  if (!ev || typeof ev.ts !== "number") return undefined;
  const noun = plural(present.length, "file", "files");
  return `history from ${dayKey(ev.ts)}, ${noun}`;
}


/** Parse the first complete line of an append-only JSONL `file`, or null when it is unreadable
 * or does not parse. Reads only the first chunk — the event log is up to 16 MB a generation,
 * and a doctor pre-flight should not slurp the oldest archive just to name its first day. */
function firstEventLine(file: string): HarnessEvent | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const line = buf.toString("utf8", 0, n).split("\n")[0] ?? "";
      if (!line) return null;
      try {
        return JSON.parse(line) as HarnessEvent;
      } catch {
        return null;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Disk floor (plans/disk-floor.md, parts 1/4 and 2/4) — is there room on the volume the
 * worktrees live on? Fail below `diskHoldGB`, the same floor the running team holds new work
 * at, so doctor and the gate agree on when the disk is a problem. Warn in the band between
 * `diskHoldGB` and `diskReclaimGB`: pressure reclaim will delete ignored build outputs from
 * idle worktrees but the team still runs. Ok at or above `diskReclaimGB` (or when reclaim is
 * disabled and free space is above the hold). A statfs failure is a warning, not a failure: an
 * unmeasurable volume never holds the team, so it must not fail a scripted pre-flight. The
 * detail names the measured path, the free GB to one decimal, and the floor. `holdGB` 0
 * disables the hold, so a free space above `reclaimGB`'s own band (or `reclaimGB` 0) passes.
 * After a successful sample the detail also carries `diskReclaimPhrase` (what `disk_reclaim`
 * passes freed over the last 24 h); it is informational and never changes the level. */
export function checkDiskSpace(
  root: string,
  holdGB: number,
  reclaimGB: number,
  sample: (root: string) => number | null = sampleFreeBytes,
): CheckOutcome {
  const where = diskVolumePath(root);
  const free = sample(root);
  if (free === null)
    return warnOutcome(`cannot measure free space at ${where} (statfs failed) — the disk hold is off for this process`);
  const freeGB = free / BYTES_PER_GB;
  const freeText = `${formatGB(freeGB)} free at ${where}`;
  const phrase = diskReclaimPhrase(readEventsSince(root, DAY_MS).events);
  const withReclaim = (detail: string) => (phrase ? `${detail} · ${phrase}` : detail);
  if (holdGB > 0 && freeGB < holdGB)
    return failOutcome(withReclaim(`${freeText} — below the ${holdGB} GB diskHoldGB floor; the team waits to start new work until space recovers`));
  if (reclaimGB > 0 && freeGB < reclaimGB)
    return warnOutcome(withReclaim(`${freeText} — below the ${reclaimGB} GB diskReclaimGB threshold; a pressure reclaim pass deletes ignored build outputs from idle worktrees`));
  const floor = holdGB > 0 ? `above the ${holdGB} GB floor` : "diskHoldGB is 0 (hold disabled)";
  return okOutcome(withReclaim(`${freeText}, ${floor}`));
}

/** The `reclaim in the last 24h freed …` phrase for the `disk space` row: the summed
 * `freedGB` of the `disk_reclaim` passes, their count, and how many ran under pressure (an
 * event without a `mode` counts as pressure, like its feed line). Each pass is a point event,
 * so summing cannot straddle the window edge. Undefined when no pass ran. */
export function diskReclaimPhrase(events: readonly HarnessEvent[]): string | undefined {
  const passes = events.filter((e) => e.type === "disk_reclaim");
  if (passes.length === 0) return undefined;
  const freed = passes.reduce((sum, e) => sum + finiteNumber(e.freedGB, 0), 0);
  const pressure = passes.filter((e) => (typeof e.mode === "string" && e.mode ? e.mode : "pressure") === "pressure").length;
  const base = `reclaim in the last 24h freed ${formatGB(freed)} over ${plural(passes.length, "pass", "passes")}`;
  return pressure > 0 ? `${base}, ${pressure} under pressure` : base;
}

/** The `passing merge checks …` phrase for the `check` row: median and slowest wall clock of
 * the passed full-suite runs (`merge`, `batch`, `baseline` scopes — a `gate` check can run a
 * subset, and failed or skipped runs do not measure a full pass). The lower median keeps the
 * figure a run that happened. Undefined when no event qualifies. */
export function checkDurationPhrase(events: readonly HarnessEvent[]): string | undefined {
  const durations = events
    .filter(isPassingFullCheck)
    .map((e) => finiteNumber(e.durationMs, 0))
    .filter((ms) => ms > 0);
  const pair = medianAndMax(durations);
  if (pair === null) return undefined;
  return `passing merge checks in the last 24h took ${trailingDayMedianPhrase(pair.median, pair.max, "slowest", durations.length, "run")}`;
}

/** Declared project check — names what the review gate's deterministic pre-check, the
 * red-main baseline, and redeploy's green check will run, without running it: a configured
 * `check.command` (plans/portability.md §6/7), else the npm auto-detection. None declared is
 * a warn, not informational (the 2026-09-05 stance predates non-npm targets being supported,
 * when a warn would have been noise no operator could act on — with `check.command` available
 * the warning is actionable): the three gates degrade to "no check" and a silently absent
 * safety layer is the failure this check exists to surface. Warn does not fail the exit code
 * (the fallback check's precedent, doctor-fallback-checks.ts's checkFallbackModel). */
export function checkBuildCheck(
  root: string,
  config?: CheckConfigSlice | null,
): CheckOutcome {
  const check = detectBuildCheck(root, config ?? undefined);
  if (!check)
    return warnOutcome("none declared — the review gate's build pre-check, the red-main baseline, and redeploy's green check are all off (set `check.command` in tumwater.json for a non-npm repo); the plan role will plan this project's check and the feature role declare it, a test/typecheck/build npm script or check.command");
  // The in-lock command from mergeCommandOf (absent mergeCommand falls back to the gate
  // command): the row names which command the merge lock runs and where the full check lands,
  // facts a reader cannot get from detectBuildCheck alone. The after-merge roles are not named
  // here — they live under `review`, which this slice does not hold, and the `review` row in
  // docs/config.md documents them.
  const lockPhrase = (() => {
    const mc = mergeCommandOf(config ?? undefined);
    return mc !== undefined
      ? `merge lock runs ${mc}, full check after merging`
      : "full check in the merge lock";
  })();
  const phrase = checkDurationPhrase(readEventsSince(root, DAY_MS).events);
  const withTiming = (detail: string) =>
    okOutcome(`${detail} · ${lockPhrase}${phrase ? ` · ${phrase}` : ""}`);
  if (check.kind === "command") {
    const where = path.relative(root, check.cwd);
    return withTiming(where ? `${check.command} (cwd ${where})` : check.command);
  }
  const where = path.relative(root, check.rootDir);
  return withTiming(where ? `npm ${check.script} in ${where}` : `npm ${check.script}`);
}

/** The review gate's flake memory surfaced read-only: names which checks the gate kept excusing as
 * flakes over its own KNOWN_FLAKE_WINDOW_MS window. The gate logs `gate check failed then passed on
 * retry — flaky: <headline>` for each failure that passed on its one immediate re-run; the in-lock
 * merge check logged the same under MERGE_FLAKY_WARNING_PREFIX when its kept-pin retry passed
 * until parts 4l/3 and 4m/3 removed it (src/review/known-flakes.ts); that record is internal to
 * the gate's matching, so a genuinely
 * flaky check silently burns a re-run per merge and hides real instability — exactly the
 * information that explains intermittent rejections. This check reads the same window and folds the
 * same normalized headline the gate matches with (repeatedFlakeCounts over flakeCounts, so the
 * prefix slice-offset and
 * cluster normalization cannot drift), and warns only when a normalized check flapped more than
 * once, so a routine one-off flake stays quiet. ok/warn only — never a fail — so a flaky suite
 * cannot fail a scripted doctor pre-flight (the checkStalledEntries precedent; the exit-code
 * rule is
 * doctor-outcome.ts's). */
export function checkFlakyChecks(root: string, now: number = Date.now()): CheckOutcome {
  const { events } = readEventsSince(root, KNOWN_FLAKE_WINDOW_MS);
  const flapped = repeatedFlakeCounts(events);
  const phrases: string[] = [];
  const flappedPhrase = flappedChecksPhrase(flapped);
  if (flappedPhrase !== null) phrases.push(flappedPhrase);
  const q = quarantineWarning(loadQuarantine(root), now);
  if (q !== null) phrases.push(`${q} — see \`tumwater quarantine\``);
  if (phrases.length === 0)
    return okOutcome("no check flapped more than once in the last 24h");
  return warnOutcome(phrases.join("; "));
}

/** A trailing day of at least `POST_MERGE_REJECT_WARN` post-merge `review_rejected` events — the
 * audit of a day that must not read as a clean main: each rejection is an already-landed commit
 * the reviewer turned back, so it stays on main with the reviewer's reasons. Reads the
 * `POST_MERGE_REJECT_WINDOW_MS` window and
 * threshold through `postMergeChurn`. ok/warn only — a churn burst does not stop the team. */
export function checkPostMergeChurn(root: string): CheckOutcome {
  const { events } = readEventsSince(root, POST_MERGE_REJECT_WINDOW_MS);
  const churn = postMergeChurn(events);
  if (churn === null) return okOutcome("no post-merge rejection burst in the last day");
  return warnOutcome(
    `${plural(churn.count, "post-merge review rejection")} in the last day (${churn.roles
      .map((r) => `${roleLabel(r.role)} ×${r.count}`)
      .join(", ")}) — each commit had already reached main and stays there with the reviewer's reasons; raise the authoring bar`,
  );
}

/** The one home of the doctor's `flaky checks` sentence: names each check that flapped more than
 * once, most frequent first, with how many times it flapped — the one sentence the doctor's
 * `flaky checks` row shows. null when `flapped`
 * is empty (nothing crossed the bar). */
function flappedChecksPhrase(flapped: readonly [string, number][]): string | null {
  if (flapped.length === 0) return null;
  const render = ([k, n]: [string, number]) => `"${k}" ×${n}`;
  const [first, ...rest] = flapped;
  const more = andMore(rest, render);
  return `${agree(flapped.length, "check", "checks")} flapped more than once in the last 24h: ${render(first!)}${more}`;
}

/** Build provenance — is the harness about to run (this process's dist/) the code main
 * describes? Only meaningful when this project IS the harness (isSelfHosted); elsewhere the
 * stamp is reported as-is. A stale build is a warning, not a failure: the team runs, just not
 * the newest code, and auto-restart (or a rebuild + restart) resolves it. `info`, `head` and
 * `running` are injectable so tests can exercise every branch without compiling anything. */
export async function checkBuild(
  root: string,
  info: BuildInfo | null = readBuildInfo(),
  head: string | null | undefined = undefined,
  /** What the running orchestrator published about this build (orchestrator.json), when one is
   * up. A stale build whose restart was REFUSED must not be reported with the boilerplate
   * "auto-restart does this for a running team": nothing will happen until main moves, and
   * doctor is where an operator goes to find out why. */
  running: BuildStatus | null = null,
): Promise<CheckOutcome> {
  if (!info) return okOutcome("no build stamp — dist/ compiled without `npm run build`");
  const sha = shortSha(info.sha);
  if (!(await isSelfHosted(root, info)))
    // Not "dist/ from …": in someone else's project that names a dist/ directory the project
    // does not have — the stamp read here is the running harness install's own, so say that.
    return okOutcome(`tumwater version ${sha} (this project is not tumwater itself)`);
  const mainHead = head === undefined ? await currentHead(root) : head;
  if (!mainHead) return okOutcome(`dist/ from ${sha}`);
  const stale = await buildStaleness(root, info.sha, mainHead);
  if (!stale) return okOutcome(`dist/ from ${sha}`);
  if (stale.stale) {
    return warnOutcome(`dist/ from ${sha} is stale — main has ${plural(stale.aheadCommits, "later commit")} touching ${STALE_INPUTS_LABEL}${staleBuildRestartPhrase(running, info)}`);
  }
  return okOutcome(`dist/ from ${sha}, matches main`);
}

/** The stale-arm restart-state wording for the `build` row: why auto-restart is not bringing a
 * running team up to date, read from one list instead of the chain checkBuild used to bury in
 * its stale branch. Returns the `next` suffix (a leading `;` plus the applicable wording); a
 * polled-restart hold's ` — …` tail is embedded in the under-way arm. */
function staleBuildRestartPhrase(running: BuildStatus | null, info: BuildInfo): string {
  // The step a hold is in, so an operator asking doctor why every role is idle reads it too.
  const hold = running?.restartHold;
  const held = hold
    ? ` — ${restartHoldPhrase(hold.stage, running?.checkedHead, hold.runs, humanSince(hold.since, Date.now()))}`
    : "";
  return running?.restartBlocked
    ? `; auto-restart is BLOCKED (${running.restartBlocked}) and will not retry until main moves or the block clears`
    : running?.restartPending
      ? `; auto-restart is under way${held}`
      : running?.waitingForCheck
        ? `; auto-restart waits for a commit that passes main's check — none newer than ` +
          `${shortSha(running.checkedHead ?? info.sha)} has yet (the main's check row says why)`
        : "; run `npm run build` and restart `tumwater start` (auto-restart does this for a running team)";
}
/** The primary checkout's HEAD sha, or null when it cannot be resolved (no repo) —
 * git/git.ts's refSha, the one home of the rev-parse probe. */
function currentHead(root: string): Promise<string | null> {
  return refSha(root, "HEAD");
}

/** `shortSha(tip) @ lock shortSha(lockHash)` — the covered-tip naming the `ci parity` row
 * repeats in every verdict wording (failed, current, stale, stale-and-stalled), each spelling the
 * same `@ lock` fragment by hand. One home so the fragment cannot drift across the row's four
 * renderings. */
function tipLockPhrase(tip: string, lockHash: string): string {
  return `${shortSha(tip)} @ lock ${shortSha(lockHash)}`;
}

/** The doctor's `ci parity` row: does the full suite cover main's current tip? Reads the
 * CI-parity ledger (src/observer/ci-parity.ts) — the operator surface answering whether main
 * is verified by CI — and reports whether the last run covered the current main tip @ lock.
 * Missing ledger reads "no CI parity recorded yet" (ok); a failed record is a `warn` naming the
 * tip/lock (the ci role's contract is to fix or file what it finds, so a lingering failed record
 * is actionable until the next green run); the `current`/`stale` split is `parityIsCurrent`'s
 * one home, so the row and the ci prompt block cannot drift. Stale is normally `ok` — main moves
 * on every merge and the ci role runs on its own clock, so a post-merge gap is normal and must
 * not turn the Health card or the exit code red. A stale verdict that stays stale past
 * `CI_PARITY_STALE_MS` (ciParityStalled) is a stall — the full suite has silently stopped
 * covering new tips — and warns. Read-only against
 * .tumwater/. */
export function checkCiParity(
  root: string,
  config?: { baseBranch?: string } | null,
  now: number = Date.now(),
): CheckOutcome {
  const entry = readCiParity(root);
  if (!entry)
    return okOutcome("no CI parity recorded yet — the ci role has not completed a workflow run");
  const { tip, lockHash } = currentCiParityState(root, config ?? undefined);
  const age = shortSpanPhrase(Math.max(0, now - entry.lastRunAt));
  if (entry.result === "failed") {
    return warnOutcome(
      `the last CI run failed covering ${tipLockPhrase(entry.tip, entry.lockHash)} ${age} ago — the ci role must fix or file what it found before the next green run`,
    );
  }
  if (parityIsCurrent(entry, tip, lockHash)) {
    return okOutcome(
      `current — CI covered main at ${tipLockPhrase(tip, lockHash)}, passed ${age} ago`,
    );
  }
  // A stale verdict is normal right after a merge (main moves and the ci role runs on its own
  // clock), but one that stays stale past CI_PARITY_STALE_MS is a stall: the full suite has
  // silently stopped covering new tips. This warn is the one place ciParityStalled is applied —
  // the row is the standing signal. Inside the window the existing friendly stale wording
  // stands.
  if (ciParityStalled({ state: "stale", lastRunAt: entry.lastRunAt }, now)) {
    return warnOutcome(
      `stale and stalled — the last run covered ${tipLockPhrase(entry.tip, entry.lockHash)} ${age} ago (${entry.result}); main is now ${tipLockPhrase(tip, lockHash)} — no full-suite run has covered a tip in over ${CI_PARITY_STALE_MS / DAY_MS} days, so the ci role is disabled, paused, or unable to record`,
    );
  }
  return okOutcome(
    `stale — the last run covered ${tipLockPhrase(entry.tip, entry.lockHash)} (${entry.result}, ${age} ago); main is now ${tipLockPhrase(tip, lockHash)}, so the ci role has not yet covered this tip`,
  );
}

/** The commit a remote-CI record names — `entry.sha` shortened when present, `"?"` when
 * absent (only an `unavailable` record omits it, where `reason` explains why GitHub could
 * not be read). The one place the label ternary lives, so every verdict wording that names
 * the commit reads it from the name. */
function remoteCiCommitLabel(entry: RemoteCiEntry): string {
  return entry.sha ? shortSha(entry.sha) : "?";
}

/** What a recorded remote-CI verdict reports, resolved after `remoteCiStalled` has already
 * had its say in `checkRemoteCi`: `failed` is a warn naming the commit (via
 * remoteCiCommitLabel), the repo and the age; `pending` and the default (`passed`) are the
 * ok lines naming the commit and repo; `unavailable` is the ok line naming `entry.reason`
 * — decision 3 in plans/remote-ci.md: the operator never opted in, so a missing `gh` is
 * information, not a fault. Level and wording are lifted verbatim from the four-arm switch
 * this replaces. */
function remoteCiResultOutcome(entry: RemoteCiEntry, now: number): CheckOutcome {
  const age = humanAgo(entry.checkedAt, now);
  switch (entry.result) {
    case "failed":
      return warnOutcome(
        `GitHub CI failed at ${remoteCiCommitLabel(entry)} on ${entry.repo} (checked ${age}) — the ci role fixes or files it; it stays failed until a newer push passes`,
      );
    case "pending":
      return okOutcome(
        `GitHub CI was still running on ${remoteCiCommitLabel(entry)} (checked ${age})`,
      );
    case "unavailable":
      return okOutcome(
        `the ci role could not read GitHub Actions: ${entry.reason ?? "no reason recorded"} — run gh auth login, or set roles.ci.remote to false`,
      );
    default:
      return okOutcome(
        `GitHub CI passed at ${remoteCiCommitLabel(entry)} on ${entry.repo} (checked ${age})`,
      );
  }
}

/** The doctor's `remote CI` row: is GitHub Actions green on what the operator pushed? Reads
 * the remote-CI ledger (src/observer/remote-ci.ts) — the operator surface beside `ci parity`
 * answering "is GitHub CI green on what I pushed?". Omitted (null) when the ci role is
 * disabled or `remoteCiTarget` is null (no GitHub remote, no workflow file, or opted out with
 * `roles.ci.remote: false`), the way checkFeedbackFiling omits its row. No record reads ok;
 * a record older than the stall window (remoteCiStalled — checked before the result, so it
 * applies to every record) is a warn; `failed` is a warn naming the commit; `pending` and
 * `passed` are ok; `unavailable` is ok — decision 3 in plans/remote-ci.md: the operator never
 * opted in, so a missing `gh` is information, not a fault. Read-only against .tumwater/ and
 * the git config. */
export async function checkRemoteCi(
  root: string,
  config: TumwaterConfig | undefined,
  now: number = Date.now(),
): Promise<CheckOutcome | null> {
  if (!config) return null;
  if (!config.roles?.ci?.enabled) return null;
  const target = await remoteCiTarget(root, config);
  if (target === null) return null;
  const entry = readRemoteCi(root);
  if (entry === null)
    return okOutcome(
      `no remote CI result recorded yet — the ci role reads GitHub Actions on ${target.repo} on its next run`,
    );
  if (remoteCiStalled(entry, now))
    return warnOutcome(
      `no remote CI check recorded in over ${CI_PARITY_STALE_MS / DAY_MS} days — the ci role is disabled, paused, or not reporting its REMOTE line`,
    );
  return remoteCiResultOutcome(entry, now);
}

/** The doctor's `qa coverage` row: has the `qa` observer — the team's only flow-level
 * observer — stopped exercising any of the product's own flows? Reads the flow-coverage ledger
 * (src/observer/qa-coverage.ts), the operator surface answering "is qa still recording what it
 * exercises?". A missing ledger reads "no qa flow coverage recorded yet" (ok — no record yet
 * is not a stall); a fresh ledger reads ok naming the newest exercised flow and its age. A
 * ledger whose newest exercise is older than `QA_COVERAGE_STALE_MS` (qaCoverageStalled) is a
 * `warn` naming that flow and its age — the role is disabled, paused, or unable to record —
 * via the one `qaCoverageStalled` predicate, this row the standing signal. Read-only against
 * .tumwater/. */
export function checkQaCoverage(root: string, now: number = Date.now()): CheckOutcome {
  const coverage = readQaCoverage(root);
  const entries = Object.entries(coverage);
  if (entries.length === 0)
    return okOutcome("no qa flow coverage recorded yet — the qa role has not completed a flow");
  let newestFlow = entries[0]![0];
  let newestAt = entries[0]![1].lastRunAt;
  for (const [name, entry] of entries) {
    if (entry.lastRunAt > newestAt) {
      newestAt = entry.lastRunAt;
      newestFlow = name;
    }
  }
  const age = shortSpanPhrase(Math.max(0, now - newestAt));
  if (qaCoverageStalled(coverage, now)) {
    return warnOutcome(
      `the newest exercised flow ${newestFlow} ran ${age} ago — no qa flow has been exercised in over ${QA_COVERAGE_STALE_MS / DAY_MS} days, so the qa role is disabled, paused, or unable to record`,
    );
  }
  return okOutcome(`newest flow coverage: ${newestFlow} exercised ${age} ago`);
}

/** How far back the `main diff rules` row looks — one day, the same 24 h trailing-day convention
 * every event-reading doctor row uses, so a diff-rule failure the main watch logged stays a
 * standing warn until a day passes. Owned here (the check that reads it). */
const MAIN_RULE_FAILURE_WINDOW_MS = DAY_MS;
/** The exact substring src/baseline/main-watch.ts's `rulesPass` logs in its warning, so this
 * check matches a real rule failure and cannot drift from the wording the watch writes. */
const MAIN_RULE_FAILURE_MARKER = "fails the diff rules";
/** The doctor's `main diff rules` row: a `warning` the main watch logged when the review gate's
 * diff rules rejected main's tip in the trailing day. The gate judges one change; the watch
 * judges each first-parent commit's own diff, so a conflict marker, a protected edit, a leaked
 * secret, a phantom fix claim or a broken backlog structure that reached main through a gate
 * blind spot sits on main with only this event log to say so. Reads only the `warning` event
 * the watch already writes, so the row cannot drift from the watch's wording; the most recent
 * hit names the tip and the rule. ok/warn only — it never fails a scripted pre-flight. */

/** The `warning` events whose message contains `marker` — the read both marker-driven
 * project rows (checkMainDiffRules and checkDroppedPostMergeReviews) ask for, so their
 * filter predicate cannot drift: a warning whose message is absent (an older event) is
 * never a hit, and the marker match is a plain substring like the watch's wording.
 * `e.type === "warning"` gates on the literal type, mirroring the warn shape warnEvent
 * writes. Since every hit is a `warning`, `String` on its message downstream reads safely
 * for the events this returns. */
function warningEventsWithMarker(events: readonly HarnessEvent[], marker: string): HarnessEvent[] {
  return events.filter((e) => e.type === "warning" && typeof e.message === "string" && e.message.includes(marker));
}

export function checkMainDiffRules(root: string): CheckOutcome {
  const { events } = readEventsSince(root, MAIN_RULE_FAILURE_WINDOW_MS);
  const hits = warningEventsWithMarker(events, MAIN_RULE_FAILURE_MARKER);
  if (hits.length === 0) return okOutcome("no diff-rule failure on main in the last day");
  const latest = hits[hits.length - 1]!;
  return warnOutcome(
    `${plural(hits.length, "diff-rule failure on main", "diff-rule failures on main")} in the last day — most recently ${String(
      latest.message,
    )} — the gate approved a diff the watch's rules reject; repair the tip or revert it with \`tumwater revert <sha>\``,
  );
}

/** The exact prefix src/merge/merge-post-review-drain.ts logs when it drops a post-merge
 * review at POST_REVIEW_FAILURE_LIMIT. The drain drops in two ways and logs each with its own
 * tail — "it stays on main unreviewed" after failed runs (the commit never got a review) and
 * "the fix stays unreviewed" after failed fix merges (the fix ref is deleted, main unmoved) —
 * so this check matches the shared "dropping the post-merge review of" prefix both share, not
 * either tail. The drain also files the drop in BUGS.md as best-effort ordinary backlog work
 * (fileDroppedReview), but a skipped filing (off-base checkout or a dirty BUGS.md) leaves only
 * this event log standing, so this check matches the drain's own wording. */
const DROPPED_REVIEW_MARKER = "dropping the post-merge review of";
/** How far back the `dropped post-merge reviews` row looks — one day, the same 24 h trailing-day
 * convention every event-reading doctor row uses. Owned here (the check that reads it). */
const DROPPED_REVIEW_WINDOW_MS = DAY_MS;
/** The doctor's `dropped post-merge reviews` row: a `warning` the post-merge-review drain
 * (src/merge/merge-post-review-drain.ts) wrote when it dropped a review at
 * POST_REVIEW_FAILURE_LIMIT — after failed runs its commit stays on main unreviewed, and
 * after failed fix merges the fix ref is deleted (main unmoved) so the commit stays
 * unreviewed; either way the review is gone and no longer in the queue the `post-merge
 * reviews` row reads. The drain files the dropped review in BUGS.md as best-effort ordinary
 * backlog work, so when that filing is skipped this row is the standing signal naming the
 * dropped review. Reads only the `warning` event the drain already writes, so it cannot drift
 * from the drain's wording; the most recent hit names the commit. ok/warn only — an
 * unreviewed commit is operator signal, not a broken environment. */
export function checkDroppedPostMergeReviews(root: string): CheckOutcome {
  const { events } = readEventsSince(root, DROPPED_REVIEW_WINDOW_MS);
  const hits = warningEventsWithMarker(events, DROPPED_REVIEW_MARKER);
  if (hits.length === 0) return okOutcome("no post-merge review was dropped in the last day");
  const latest = hits[hits.length - 1]!;
  return warnOutcome(
    `${plural(hits.length, "post-merge review was dropped", "post-merge reviews were dropped")} in the last day — the dropped review is gone and its commit stays unreviewed; most recently ${String(latest.message)}`,
  );
}
