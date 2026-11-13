import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { TumwaterConfig } from "../config/config-schema.js";
import type { RunnerState } from "../runner/runner-state.js";
import { resolvedGitBin } from "../git/git-run.js";
import { currentBranchFromHeadFile, targetBranch } from "../git/git.js";
import { readTextOrNull } from "../files/files.js";
import { entryKey } from "../backlog/backlog-parts.js";
import { humanSince } from "../text/datetime.js";

/** The block's hard size ceiling, in characters (plans/since-last-run.md "Size"): about 1k
 * tokens, well under a quarter of a run's first prompt. Truncation cuts the file list before
 * the subjects, then drops whole subjects from the oldest end, so the header and the newest
 * commits always survive a very wide range. */
const MAX_CHARS = 4000;
/** How many commit subjects the block lists before its "+N older" line. */
const MAX_SUBJECTS = 30;
/** How many changed files the block lists before its "+N more" line. */
const MAX_FILES = 20;
/** The one git spawn's wall-clock bound: a wedged git (a locked index, an unmounted volume)
 * must not hold the prompt assembly open — the doctor's own sync git probe binds the same way. */
const GIT_TIMEOUT_MS = 15_000;

/** One commit's parsed shape: its short id, its subject, and the files it changed. */
interface ParsedCommit {
  sha: string;
  subject: string;
  files: string[];
}

/** A line that is exactly a commit header: `<sha>\t<subject>`, where the prefix is a hex sha of
 * at least 8 characters. This prefix is the discriminator the whole parse hangs on — a path
 * line never carries one, so a subject that is itself a file path is still read as a path. */
function splitHeader(line: string): { sha: string; subject: string } | null {
  const tab = line.indexOf("\t");
  if (tab <= 0) return null;
  const prefix = line.slice(0, tab);
  if (!/^[0-9a-f]{8,}$/i.test(prefix)) return null;
  return { sha: prefix.slice(0, 8), subject: line.slice(tab + 1) };
}

/** Parse one `git log --no-merges --format=%H%x09%s --name-status <a>..<b>` run. A commit is a
 * `<sha>\t<subject>` header line (a hex sha of at least 8 characters before the tab — the one
 * thing a file line never is, so a path that looks like a sha is still read as a path); its
 * changed files are the `<status>\t<path>` lines that follow, up to the next header. git puts a
 * blank line after each header, which the parser skips rather than treating as a boundary — the
 * header itself is the boundary, so the file list always stays with its own commit. A rename
 * (`R100\told\tnew`) yields the destination, read as the line's last tab field. Newest commit
 * first, as git prints them. */
function parseLog(output: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  let current: ParsedCommit | null = null;
  for (const line of output.split("\n")) {
    if (line === "") continue; // The blank line a header's file block follows — not a boundary.
    const header = splitHeader(line);
    if (header !== null) {
      current = { ...header, files: [] };
      commits.push(current);
    } else if (current !== null) {
      const path = line.split("\t").filter((s) => s !== "").pop();
      if (path) current.files.push(path);
    }
    // A path line before any header (git prints none) is dropped.
  }
  return commits;
}

/** The branch the team targets, read from the checkout without spawning: a configured
 * `baseBranch` wins, else the primary checkout's checked-out branch, else "main" — the same
 * precedence the read-only surfaces apply (git.ts `targetBranch`). A `run --branch` is
 * per-invocation and invisible to a later run, so the checkout is the right default here. */
function mainBranchOf(root: string, config: TumwaterConfig): string {
  return targetBranch(config.baseBranch, currentBranchFromHeadFile(root));
}

/** Run git once and return its stdout, or `null` on any failure — a nonzero exit, a spawn error,
 * or the bound killing a wedged child. The block must never fail a run over a git that cannot
 * read the range; `null` from here reads as "omit the block". */
function gitOnce(root: string, args: string[]): string | null {
  const res = spawnSync(resolvedGitBin(), args, {
    cwd: root,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (res.error !== undefined || res.status !== 0) return null;
  return res.stdout ?? "";
}

/** True when `ancestor` is an ancestor of `main` (or equal to it): the block's anchor must sit
 * on the path to main's head. A `null` from gitOnce is read as "not an ancestor" — a git that
 * cannot start answers nothing, so the block is omitted rather than trusted. */
function isAncestor(root: string, ancestor: string, main: string): boolean {
  return gitOnce(root, ["merge-base", "--is-ancestor", ancestor, main]) !== null;
}

/** The changed files a run's claimed entry names: the repo-relative path tokens its
 * **Files touched.** line carries, read from the entry's own backlog markdown. Each token is a
 * bare path — `src/prompt/prompt.ts` or `PLANS.md`. Empty for an unassigned run, a claim whose
 * entry has already moved, or an entry whose line names no path. */
function entryTouchedPaths(root: string, claim: RunnerState["claim"] | undefined): string[] {
  if (claim === undefined) return [];
  const md = readTextOrNull(path.join(root, claim.file));
  if (md === null) return [];
  const key = entryKey(claim.title);
  const lines = md.split("\n");
  const headingIdx = lines.findIndex((l) => l.startsWith("### ") && entryKey(l.slice(4)) === key);
  if (headingIdx === -1) return [];
  // The entry runs from its heading to the next `### `/`## ` heading (or end of file).
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l !== undefined && (l.startsWith("### ") || l.startsWith("## "))) {
      end = i;
      break;
    }
  }
  // The marker line holds the paths; they never contain a space, so a colon-then-whitespace
  // split is exact. A path token is a single segment (a.md) or slash-separated ending in a
  // dotted extension — the backlog entry's own `Files touched.` convention.
  const markerLine = lines
    .slice(headingIdx, end)
    .find((l) => /files touched/i.test(l));
  if (markerLine === undefined) return [];
  // The marker is `**Files touched.**` and the paths follow it on the same logical line; each
  // path never contains a space, so take everything after the marker's closing `**` (or the
  // end of the marker text when it is unmarked) and whitespace-split.
  const m = /files touched\.?\*{0,2}\s*/i.exec(markerLine);
  const after = m === null ? "" : markerLine.slice(m.index + m[0].length);
  return after
    .split(/\s+/)
    .map((t) => t.replace(/^[`'(]+/, "").replace(/[`')]+$/, ""))
    .filter((t) => /^[A-Za-z0-9_.-]+$/.test(t) || /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+$/.test(t));
}

/** Rank every changed file by how many of the range's commits touched it, most-touched first;
 * ties keep their first-seen order so the list is stable. */
function rankedFiles(commits: ParsedCommit[]): string[] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const c of commits)
    for (const f of c.files) {
      if (!counts.has(f)) order.push(f);
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

/** The one header line: how long ago the role's last run ended, its result and summary, and how
 * many commits merged to main since the anchor. */
function headerLine(state: RunnerState, commitCount: number, main: string, now: number): string {
  const since =
    state.lastRunEndedAt !== undefined ? `last run ${humanSince(state.lastRunEndedAt, now)} ago` : "no recorded end time";
  const result = state.lastResult ? `it ended as \`${state.lastResult}\`` : "no result was recorded";
  const summary = state.lastSummary ? ` (${state.lastSummary})` : "";
  return `Since your last run (${since}) — ${result}${summary}; ${commitCount} commit${
    commitCount === 1 ? "" : "s"
  } merged to ${main} since ${state.lastMainHead.slice(0, 8)}.`;
}

/** Assemble and cap the block. The file list is capped at MAX_FILES before the subjects, the
 * subjects at MAX_SUBJECTS, then the whole text is capped at MAX_CHARS by dropping whole
 * subjects from the oldest end (the newest — most relevant — survive). */
function renderBlock(
  role: string,
  state: RunnerState,
  commits: ParsedCommit[],
  entryFiles: string[],
  main: string,
  now: number,
): string {
  if (commits.length === 0) {
    return `Nothing has changed on main since your last run — every file you read last time is still the current one.`;
  }
  const ownPrefix = `tumwater(${role}):`;
  const allSubjects = commits.map((c) => {
    const own = c.subject.startsWith(ownPrefix) ? " (your own merge)" : "";
    return `- ${c.sha} ${c.subject}${own}`;
  });
  const ranked = rankedFiles(commits);
  const entrySet = new Set(entryFiles);
  const allFiles = [...ranked.filter((f) => entrySet.has(f)), ...ranked.filter((f) => !entrySet.has(f))];

  const header = headerLine(state, commits.length, main, now);
  const lead = `Generated by tumwater from git, current as of this run (unlike your role notes, which are a prior session's recollection). Use it to skip re-reading what you already know; re-read any file you plan to edit that appears below.`;

  const capFiles = (list: string[]): string[] => {
    const shown = list.slice(0, MAX_FILES);
    return list.length > MAX_FILES ? [...shown, `+${list.length - MAX_FILES} more`] : [...shown];
  };
  const capSubjects = (list: string[]): string[] => {
    const shown = list.slice(0, MAX_SUBJECTS);
    return list.length > MAX_SUBJECTS ? [...shown, `+${list.length - MAX_SUBJECTS} older`] : [...shown];
  };

  let subjects = capSubjects(allSubjects);
  const files = capFiles(allFiles);
  let text = render(header, lead, subjects, files, main);
  // Cap the whole block by dropping whole subjects from the oldest end first.
  while (text.length > MAX_CHARS && subjects.length > 1) {
    subjects = subjects.slice(0, -1);
    text = render(header, lead, subjects, files, main);
  }
  // A still-oversized block (a huge file list) drops whole files from its tail.
  if (text.length > MAX_CHARS && files.length > 0) {
    const f = [...files];
    while (render(header, lead, subjects, f, main).length > MAX_CHARS && f.length > 1) f.pop();
    return render(header, lead, subjects, f, main);
  }
  return text;
}

function render(header: string, lead: string, subjects: string[], files: string[], main: string): string {
  return [header, lead, `Commits on ${main} since your last run, newest first:`, ...subjects, "Files changed, most-touched first:", ...files].join("\n");
}

/** Build the since-last-run prompt block for one role run, or `undefined` when it must be
 * omitted: the anchor is empty (a first run), the anchor is not an ancestor of main, or the git
 * call fails. It reads the range with one git spawn and renders the header, the commit subjects
 * and the changed files described in plans/since-last-run.md.
 *
 * Synchronous on purpose: the prompt assembly (run-prompt.ts `assembleRunPrompt`) is called from
 * a synchronous callback and a synchronous role-view path, neither of which may await, so the
 * git read is a bounded `spawnSync` like the doctor's, not an awaited spawn. `nowMs` is
 * injected so tests pin the header's age deterministically. */
export function collectSinceLastRun(
  root: string,
  role: string,
  config: TumwaterConfig,
  state: RunnerState,
  nowMs: number = Date.now(),
): string | undefined {
  const anchor = state.lastMainHead;
  if (anchor === "") return undefined;
  const main = mainBranchOf(root, config);
  if (!isAncestor(root, anchor, main)) return undefined;
  const out = gitOnce(root, ["log", "--no-merges", "--name-status", "--format=%H%x09%s", `${anchor}..${main}`]);
  if (out === null) return undefined;
  const commits = parseLog(out);
  return renderBlock(role, state, commits, entryTouchedPaths(root, state.claim), main, nowMs);
}
