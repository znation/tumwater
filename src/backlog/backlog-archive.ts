// vocabulary: plain
/** The backlog archive (plans/backlog-archive.md): finished entries leave the live backlog files.
 *
 * Every role run reads PLANS.md and BUGS.md to find work, and by 2026-10-18 nine tenths of both
 * files was finished history (1.88 MB of PLANS.md's 2.09 MB sat under `## Done`), re-read on
 * every run. Finished entries therefore live in an archive file per backlog file —
 * FINISHED_ARCHIVES in backlog-md.ts: PLANS-DONE.md and BUGS-FIXED.md — under the same `## `
 * heading, newest first, so every section parser reads both files alike. The live file keeps
 * its finished heading, empty.
 *
 * Roles keep the move step they already follow (paste the finished entry under `## Done` or
 * `## Fixed`); the harness does the rest, two ways:
 * - archiveNewFinishedEntries, right before a run's commit: the entries THIS change added to a
 *   live finished section move to the top of the archive, so the commit, the review and the
 *   merge all see the archived form, and a role's diff never carries anyone else's move.
 * - archiveFinishedOnMain, at team start and from `tumwater archive`: the whole live section —
 *   legacy entries, compressed one-line records, a hand commit's move — goes to the archive in
 *   one commit on main.
 * Readers of finished entries read the live section first, then the archive (backlog.ts). */

import fs from "node:fs";
import path from "node:path";
import { withLock, withStateLockAsync } from "../concurrency/lock.js";
import { loadConfigSafe } from "../config/config.js";
import { logEventBestEffort, TUMWATER_SOURCE, warnEventBestEffort } from "../events/events.js";
import { readTextOrNull, writeTextAtomic } from "../files/files.js";
import { changeBaseRev, currentBranch, fileContentAt, headOf, targetBranch } from "../git/git.js";
import { stampedSubject } from "../git/commit-message.js";
import { COMMIT_IDENT, git, gitTry } from "../git/git-run.js";
import { mergeLockDir, primaryWorktreeLockPath } from "../paths.js";
import { plural } from "../text/phrases.js";
import { collapseWhitespace, errorMessage } from "../text/text.js";
import { FINISHED_ARCHIVES, fenceTracker, fencedHeadingTitle, type FinishedArchive } from "./backlog-md.js";
import { actionableEntryRanges, type ActionableEntryRange } from "./backlog-structure.js";

/** The placeholder a role leaves under an emptied section: never archived content. */
const PLACEHOLDER = /^_None yet\._$/;

/** The text a new archive file starts with: a title, how to read the file, and the section
 * heading its entries sit under. */
export function archiveTemplate(spec: FinishedArchive): string {
  const [title, what] = spec.file === "PLANS.md" ? ["Done plans", "Finished plans"] : ["Fixed bugs", "Fixed bugs"];
  return [
    `# ${title}`,
    "",
    `${what}, newest first, moved here by tumwater from ${spec.file}'s \`## ${spec.section}\`. This file`,
    "only grows: search it with grep, or read one entry by its line range. Never read it whole.",
    "",
    `## ${spec.section}`,
    "",
  ].join("\n");
}

/** An entry's identity across the change's base and head: its heading, whitespace-collapsed. */
function archiveKey(title: string): string {
  return collapseWhitespace(title);
}

/** The 0-based span of the first `## <title>` section in `lines`: its heading line, and the
 * index of the next `## ` heading (or `lines.length`). Fence-aware through backlog-md.ts's
 * shared guard, so a quoted `## ` line is body text. null when the section is absent. */
function sectionSpan(lines: readonly string[], title: string): { heading: number; end: number } | null {
  const fenced = fenceTracker();
  let heading = -1;
  for (let i = 0; i < lines.length; i++) {
    const found = fencedHeadingTitle(lines[i] ?? "", fenced, "## ");
    if (found === null) continue;
    if (heading >= 0) return { heading, end: i };
    if (found === title) heading = i;
  }
  return heading >= 0 ? { heading, end: lines.length } : null;
}

/** `lines` without its leading and trailing blank lines. */
function trimBlank(lines: readonly string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && (lines[a] ?? "").trim() === "") a++;
  while (b > a && (lines[b - 1] ?? "").trim() === "") b--;
  return lines.slice(a, b);
}

/** `lines` rejoined with the section at `span` holding `body` (already trimmed): the heading, a
 * blank line and the body, then one blank line before the next section. An empty body leaves the
 * bare heading. A document this section ends closes with exactly one newline. */
function withSectionBody(
  lines: readonly string[],
  span: { heading: number; end: number },
  body: readonly string[],
): string {
  const out = lines.slice(0, span.heading + 1);
  if (body.length > 0) out.push("", ...body);
  const tail = lines.slice(span.end);
  if (tail.length === 0) return `${out.join("\n")}\n`;
  return [...out, "", ...tail].join("\n");
}

/** The section's entries with their ranges, limited to the span's first section of that name. */
function entriesIn(md: string, span: { heading: number; end: number }, section: string): ActionableEntryRange[] {
  return actionableEntryRanges(md, section).filter((e) => e.start - 1 > span.heading && e.start - 1 < span.end);
}

/** One file's move: the live and archive texts after it, and the headings that moved. */
interface ArchiveMove {
  live: string;
  archive: string;
  titles: string[];
}

/** Which part of the live finished section moves: the entries whose keys the change's base did
 * not hold there (`baseKeys`, the commit-time sweep), or the whole body after the newest `keep`
 * entries (the bulk archive; `keep` 0 moves everything). */
type ArchiveSelection = { baseKeys: ReadonlySet<string> } | { keep: number };

/** Move the selected part of `liveMd`'s finished section to the top of `archiveMd`'s (a new
 * archive starts from archiveTemplate), keeping the moved lines' order. null when nothing moves,
 * when either file lacks the section heading, or — for the commit-time sweep — when there is no
 * archive yet and the live section holds other content: a repository that has not been archived
 * keeps today's layout until `tumwater archive` (or the next team start) moves its history, so an
 * archive never sits above older live entries. Pure. */
export function archiveFinishedText(
  liveMd: string,
  archiveMd: string | null,
  spec: FinishedArchive,
  select: ArchiveSelection,
): ArchiveMove | null {
  const lines = liveMd.split("\n");
  const span = sectionSpan(lines, spec.section);
  if (span === null) return null;
  const entries = entriesIn(liveMd, span, spec.section);
  let moved: string[];
  let kept: string[];
  let titles: string[];
  if ("keep" in select) {
    const from = select.keep <= 0 ? span.heading + 1 : (entries[select.keep]?.start ?? 0) - 1;
    if (from < 0) return null; // no entry past the kept ones
    // A `_None yet._` placeholder stays in the live section, never in the archive.
    const tail = lines.slice(from, span.end);
    moved = trimBlank(tail.filter((l) => !PLACEHOLDER.test(l.trim())));
    kept = select.keep <= 0 ? [] : trimBlank(lines.slice(span.heading + 1, from));
    if (kept.length === 0) kept = tail.filter((l) => PLACEHOLDER.test(l.trim())).slice(0, 1);
    titles = entries.slice(Math.max(0, select.keep)).map((e) => e.title);
  } else {
    const fresh = entries.filter((e) => !select.baseKeys.has(archiveKey(e.title)));
    if (fresh.length === 0) return null;
    const inFresh = (i: number): boolean => fresh.some((e) => i >= e.start - 1 && i < e.end);
    kept = [];
    for (let i = span.heading + 1; i < span.end; i++) if (!inFresh(i)) kept.push(lines[i] ?? "");
    kept = trimBlank(kept);
    if (archiveMd === null && kept.some((l) => l.trim() !== "" && !PLACEHOLDER.test(l.trim()))) return null;
    moved = [];
    for (const e of fresh) {
      if (moved.length > 0) moved.push("");
      moved.push(...trimBlank(lines.slice(e.start - 1, e.end)));
    }
    titles = fresh.map((e) => e.title);
  }
  if (moved.length === 0) return null;
  const archiveLines = (archiveMd ?? archiveTemplate(spec)).split("\n");
  const archiveSpan = sectionSpan(archiveLines, spec.section);
  if (archiveSpan === null) return null;
  const existing = trimBlank(archiveLines.slice(archiveSpan.heading + 1, archiveSpan.end));
  return {
    live: withSectionBody(lines, span, kept),
    archive: withSectionBody(archiveLines, archiveSpan, existing.length > 0 ? [...moved, "", ...existing] : moved),
    titles,
  };
}

/** One archived file: the live file, its archive, and the headings that moved. */
interface ArchivedFile {
  file: string;
  archive: string;
  titles: string[];
}

/** Write one move: the archive first, so a crash in between leaves the entries in both files —
 * a duplicate a reader shows twice — and never in neither. */
function writeMove(root: string, spec: FinishedArchive, move: ArchiveMove): void {
  writeTextAtomic(path.join(root, spec.archive), move.archive);
  writeTextAtomic(path.join(root, spec.file), move.live);
}

/** The commit-time sweep: move the entries this change added to a live finished section of the
 * worktree `wt` — those whose heading its merge-base with `mainBranch` did not hold there — to
 * the top of the archive file, writing both files. Runs right before a run's commit, so the
 * commit, the review and the merge see the archived form. Returns what moved; a file whose
 * section is missing, or a repository not yet archived (archiveFinishedText), moves nothing. */
export async function archiveNewFinishedEntries(wt: string, mainBranch: string): Promise<ArchivedFile[]> {
  const baseRev = await changeBaseRev(wt, mainBranch);
  const out: ArchivedFile[] = [];
  for (const spec of FINISHED_ARCHIVES) {
    const live = readTextOrNull(path.join(wt, spec.file));
    if (live === null) continue;
    const base = await fileContentAt(wt, baseRev, spec.file);
    const baseKeys = new Set(actionableEntryRanges(base, spec.section).map((e) => archiveKey(e.title)));
    const move = archiveFinishedText(live, readTextOrNull(path.join(wt, spec.archive)), spec, { baseKeys });
    if (move === null) continue;
    writeMove(wt, spec, move);
    out.push({ file: spec.file, archive: spec.archive, titles: move.titles });
  }
  return out;
}

/** The bulk moves for the checkout at `root`, computed in memory: each live finished section's
 * body past its newest `keep` entries. Nothing is written. */
function planArchiveAll(root: string, keep: number): { spec: FinishedArchive; move: ArchiveMove }[] {
  const plan: { spec: FinishedArchive; move: ArchiveMove }[] = [];
  for (const spec of FINISHED_ARCHIVES) {
    const live = readTextOrNull(path.join(root, spec.file));
    if (live === null) continue;
    const move = archiveFinishedText(live, readTextOrNull(path.join(root, spec.archive)), spec, { keep });
    if (move !== null) plan.push({ spec, move });
  }
  return plan;
}

/** How much finished history each live file of `root` still carries: the `### ` entries under
 * its finished section and the section's size in bytes. Files with an empty section are left
 * out — doctor warns about the rest. */
export function liveFinishedHistory(root: string): { file: string; section: string; archive: string; entries: number; bytes: number }[] {
  const out: { file: string; section: string; archive: string; entries: number; bytes: number }[] = [];
  for (const { spec, move } of planArchiveAll(root, 0)) {
    const live = readTextOrNull(path.join(root, spec.file)) ?? "";
    out.push({
      file: spec.file,
      section: spec.section,
      archive: spec.archive,
      entries: move.titles.length,
      bytes: Buffer.byteLength(live) - Buffer.byteLength(move.live),
    });
  }
  return out;
}

/** What archiveFinishedOnMain did. `skipped` names why nothing was written. */
type ArchiveOnMainOutcome =
  | { status: "nothing" }
  | { status: "archived"; commit: string; moved: ArchivedFile[] }
  | { status: "skipped"; reason: string };

/** The bulk archive, committed: move every live finished section of the primary checkout at
 * `root` (past its newest `keep` entries) to its archive file and commit the touched files on the
 * base branch as one `tumwater(operator):` commit. Holds the team's merge lock, so a merge
 * cannot lose its fast-forward to this commit, and the primary-worktree lock the CLI backlog
 * writers and the fast-forward share. Writes nothing when there is nothing to move, when the
 * primary checkout is not on the base branch, or when any of the files has uncommitted changes;
 * a failed commit restores the files. `tumwater archive` and team start call it. */
export async function archiveFinishedOnMain(
  root: string,
  opts: { keep?: number; lockTimeoutMs?: number } = {},
): Promise<ArchiveOnMainOutcome> {
  const keep = opts.keep ?? 0;
  if (planArchiveAll(root, keep).length === 0) return { status: "nothing" };
  return withLock(
    mergeLockDir(root),
    () =>
      withStateLockAsync(primaryWorktreeLockPath(root), async (): Promise<ArchiveOnMainOutcome> => {
        const primary = await currentBranch(root);
        const base = targetBranch(loadConfigSafe(root).config?.baseBranch, primary);
        if (primary !== base) {
          return { status: "skipped", reason: `your checkout is on ${primary ?? "a detached HEAD"}, not ${base}` };
        }
        const files = FINISHED_ARCHIVES.flatMap((a) => [a.file, a.archive]);
        const status = await gitTry(root, "status", "--porcelain", "--", ...files);
        if (status === null) return { status: "skipped", reason: "could not read git status" };
        const dirty = status.split("\n").filter((l) => l.length > 3).map((l) => l.slice(3));
        if (dirty.length > 0) {
          return { status: "skipped", reason: `${dirty.join(", ")} ${dirty.length > 1 ? "have" : "has"} uncommitted changes` };
        }
        // Re-planned under the locks: a merge may have moved main since the pre-check.
        const plan = planArchiveAll(root, keep);
        if (plan.length === 0) return { status: "nothing" };
        const touched: string[] = plan.flatMap(({ spec }) => [spec.file, spec.archive]);
        const created: string[] = plan.map(({ spec }) => spec.archive).filter((f) => !fs.existsSync(path.join(root, f)));
        for (const { spec, move } of plan) writeMove(root, spec, move);
        const count = plan.reduce((n, { move }) => n + move.titles.length, 0);
        const subject = stampedSubject(
          "operator", // vocabulary-ok: the tumwater(operator): commit prefix is a machine string
          `Archive ${plural(count, "finished entry", "finished entries")} to ${plan.map(({ spec }) => spec.archive).join(" and ")}`,
        );
        try {
          await git(root, "add", "--", ...touched);
          await git(root, ...COMMIT_IDENT, "commit", "--only", "-m", subject, "--", ...touched);
        } catch (err) {
          await gitTry(root, "reset", "-q", "--", ...touched);
          const tracked = touched.filter((f) => !created.includes(f));
          await gitTry(root, "checkout", "--", ...tracked);
          for (const f of created) fs.rmSync(path.join(root, f), { force: true });
          return { status: "skipped", reason: `the commit failed: ${errorMessage(err).trim().split("\n")[0]}` };
        }
        return {
          status: "archived",
          commit: await headOf(root, "HEAD"),
          moved: plan.map(({ spec, move }) => ({ file: spec.file, archive: spec.archive, titles: move.titles })),
        };
      }),
    opts.lockTimeoutMs,
  );
}

/** The team-start archive: before any run starts — no merge is in progress and no run is in
 * flight — move whatever finished history the live files still carry into the archives, in one
 * commit on main. That migrates a repository on its first start with this build and sweeps
 * entries a hand commit moved into a live finished section. A move logs one `state_migrated`
 * event; a skipped one (a dirty file, a checkout off the base branch) or a failure warns, and
 * the team starts either way. */
export async function archiveAtTeamStart(root: string): Promise<void> {
  try {
    const outcome = await archiveFinishedOnMain(root);
    if (outcome.status === "archived") {
      logEventBestEffort(root, {
        source: TUMWATER_SOURCE,
        type: "state_migrated",
        step: "backlogArchive",
        moved: outcome.moved.reduce((n, f) => n + f.titles.length, 0),
        detail: outcome.moved.map((f) => `${f.file} → ${f.archive}: ${plural(f.titles.length, "entry", "entries")}`).join("; "),
      });
    } else if (outcome.status === "skipped") {
      warnEventBestEffort(
        root,
        TUMWATER_SOURCE,
        `finished backlog entries were not archived: ${outcome.reason} — fix that, then run \`tumwater archive\``,
      );
    }
  } catch (err) {
    warnEventBestEffort(root, TUMWATER_SOURCE, `finished backlog entries were not archived: ${errorMessage(err)}`);
  }
}
