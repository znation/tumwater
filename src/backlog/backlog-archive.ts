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
 * Neither archives an entry twice: one whose heading the archive already holds is dropped from
 * the live section when its text matches, and left there when it does not (archiveFinishedText).
 * Readers of finished entries read the live section first, then the archive (backlog.ts). */

import fs from "node:fs";
import path from "node:path";
import { withLock, withPrimaryWorktreeLockAsync } from "../concurrency/lock.js";
import { loadConfigSafe } from "../config/config.js";
import { logEventBestEffort, TUMWATER_SOURCE, warnEventBestEffort } from "../events/events.js";
import { readTextOrNull, writeTextAtomic } from "../files/files.js";
import { changeBaseRev, currentBranch, fileContentAt, headOf, targetBranch } from "../git/git.js";
import { stampedSubject } from "../git/commit-message.js";
import { commitAuthorArgs, committerIdentArgs, git, gitTry } from "../git/git-run.js";
import { mergeLockDir } from "../paths.js";
import { plural } from "../text/phrases.js";
import { collapseWhitespace, errorFirstLine, errorMessage } from "../text/text.js";
import { FINISHED_ARCHIVES, fenceTracker, fencedHeadingTitle, parseEntryDetails, type FinishedArchive } from "./backlog-md.js";
import { actionableEntryRanges, type ActionableEntryRange } from "./backlog-structure.js";
import { appendBugEntryLocked } from "./backlog-write.js";
import { formatDate } from "../text/datetime.js";

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

/** One file's move: the live and archive texts after it, the headings that moved, and the
 * headings dropped from the live section because the archive already held them verbatim. */
interface ArchiveMove {
  live: string;
  archive: string;
  titles: string[];
  dropped: string[];
}

/** Which part of the live finished section moves: the entries whose keys the change's base did
 * not hold there (`baseKeys`, the commit-time sweep), or the whole body after the newest `keep`
 * entries (the bulk archive; `keep` 0 moves everything). */
type ArchiveSelection = { baseKeys: ReadonlySet<string> } | { keep: number };

/** An entry's text for the already-archived comparison: its lines without the blank lines around
 * them, each without trailing whitespace. */
function entryText(lines: readonly string[], e: ActionableEntryRange): string {
  return trimBlank(lines.slice(e.start - 1, e.end)).map((l) => l.trimEnd()).join("\n");
}

/** What happens to one selected live entry, judged against the archive by its heading key:
 * `move` when the archive lacks the heading; `drop` when the archive holds the same heading and
 * text — an old entry pasted back (a conflict hand-back of a change written before the archive
 * re-pasted 383 + 310 of them on 2026-10-19), which moving would duplicate; `stay` when the
 * archive holds the heading with other text — an edit to an archived entry, left in the live
 * section where the author and the reviewer see it. */
type EntryFate = "move" | "drop" | "stay";

/** The fate of each of `selected` (entries of `lines`), in order, against the archive's entries:
 * every text the archive holds under each heading key. */
function entryFates(
  lines: readonly string[],
  selected: readonly ActionableEntryRange[],
  archiveMd: string,
  archiveSpan: { heading: number; end: number },
  section: string,
): EntryFate[] {
  if (selected.length === 0) return [];
  const wanted = new Set(selected.map((e) => archiveKey(e.title)));
  const archiveLines = archiveMd.split("\n");
  const archived = new Map<string, string[]>();
  for (const e of entriesIn(archiveMd, archiveSpan, section)) {
    const key = archiveKey(e.title);
    if (wanted.has(key)) archived.set(key, [...(archived.get(key) ?? []), entryText(archiveLines, e)]);
  }
  return selected.map((e) => {
    const held = archived.get(archiveKey(e.title));
    if (held === undefined) return "move";
    return held.includes(entryText(lines, e)) ? "drop" : "stay";
  });
}

/** The trimmed lines of `entries`, one blank line between entries. */
function entryBlocks(lines: readonly string[], entries: readonly ActionableEntryRange[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (out.length > 0) out.push("");
    out.push(...trimBlank(lines.slice(e.start - 1, e.end)));
  }
  return out;
}

/** Move the selected part of `liveMd`'s finished section to the top of `archiveMd`'s (a new
 * archive starts from archiveTemplate), keeping the moved lines' order. A selected entry whose
 * heading the archive already holds never moves (EntryFate): with the same text it is dropped
 * from the live section, with other text it stays there. null when nothing moves or drops, when
 * either file lacks the section heading, or — for the commit-time sweep — when there is no
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
  const selected =
    "keep" in select
      ? entries.slice(Math.max(0, select.keep))
      : entries.filter((e) => !select.baseKeys.has(archiveKey(e.title)));
  if (!("keep" in select) && selected.length === 0) return null;
  const archiveText = archiveMd ?? archiveTemplate(spec);
  const archiveLines = archiveText.split("\n");
  const archiveSpan = sectionSpan(archiveLines, spec.section);
  if (archiveSpan === null) return null;
  const fates = entryFates(lines, selected, archiveText, archiveSpan, spec.section);
  const withFate = (fate: EntryFate): ActionableEntryRange[] => selected.filter((_, i) => fates[i] === fate);
  // The 0-based live lines of the entries that leave the live section without moving.
  const droppedLine = new Set<number>();
  for (const e of withFate("drop")) for (let i = e.start - 1; i < e.end; i++) droppedLine.add(i);
  let moved: string[];
  let kept: string[];
  if ("keep" in select) {
    const from = select.keep <= 0 ? span.heading + 1 : (entries[select.keep]?.start ?? 0) - 1;
    if (from < 0) return null; // no entry past the kept ones
    // The tail moves but for the dropped and staying entries; a `_None yet._` placeholder stays
    // in the live section, never in the archive. Staying entries follow the kept ones.
    const stayLine = new Set<number>();
    for (const e of withFate("stay")) for (let i = e.start - 1; i < e.end; i++) stayLine.add(i);
    const tail: string[] = [];
    for (let i = from; i < span.end; i++) if (!droppedLine.has(i) && !stayLine.has(i)) tail.push(lines[i] ?? "");
    moved = trimBlank(tail.filter((l) => !PLACEHOLDER.test(l.trim())));
    const staying = entryBlocks(lines, withFate("stay"));
    const head = select.keep <= 0 ? [] : trimBlank(lines.slice(span.heading + 1, from));
    kept = head.length > 0 && staying.length > 0 ? [...head, "", ...staying] : [...head, ...staying];
    if (kept.length === 0) kept = tail.filter((l) => PLACEHOLDER.test(l.trim())).slice(0, 1);
  } else {
    const leaves = new Set(droppedLine);
    for (const e of withFate("move")) for (let i = e.start - 1; i < e.end; i++) leaves.add(i);
    kept = [];
    for (let i = span.heading + 1; i < span.end; i++) if (!leaves.has(i)) kept.push(lines[i] ?? "");
    kept = trimBlank(kept);
    if (archiveMd === null && kept.some((l) => l.trim() !== "" && !PLACEHOLDER.test(l.trim()))) return null;
    moved = entryBlocks(lines, withFate("move"));
  }
  const dropped = withFate("drop").map((e) => e.title);
  if (moved.length === 0 && dropped.length === 0) return null;
  const existing = trimBlank(archiveLines.slice(archiveSpan.heading + 1, archiveSpan.end));
  return {
    live: withSectionBody(lines, span, kept),
    archive:
      moved.length === 0
        ? archiveText
        : withSectionBody(archiveLines, archiveSpan, existing.length > 0 ? [...moved, "", ...existing] : moved),
    titles: withFate("move").map((e) => e.title),
    dropped,
  };
}

/** One archived file: the live file, its archive, the headings that moved, and the ones dropped
 * because the archive already held them (ArchiveMove). */
interface ArchivedFile {
  file: string;
  archive: string;
  titles: string[];
  dropped: string[];
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
 * commit, the review and the merge see the archived form. An added entry the archive already
 * holds is dropped or left in place instead (archiveFinishedText), never archived twice. Returns
 * what moved; a file whose section is missing, or a repository not yet archived, moves nothing. */
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
    out.push({ file: spec.file, archive: spec.archive, titles: move.titles, dropped: move.dropped });
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
      entries: move.titles.length + move.dropped.length,
      bytes: Buffer.byteLength(live) - Buffer.byteLength(move.live),
    });
  }
  return out;
}

/** The bulk archive's commit subject after its `tumwater(operator):` prefix: how many entries
 * moved to which archives, and how many already-archived ones left the live files (ArchiveMove). */
function archiveCommitWhat(plan: readonly { spec: FinishedArchive; move: ArchiveMove }[]): string {
  const count = plan.reduce((n, { move }) => n + move.titles.length, 0);
  const dropped = plan.reduce((n, { move }) => n + move.dropped.length, 0);
  const drop = plural(dropped, "already-archived entry", "already-archived entries");
  if (count === 0 && dropped > 0) return `Drop ${drop} from ${plan.map(({ spec }) => spec.file).join(" and ")}`;
  // A file that only dropped entries left its archive untouched.
  const archives = plan.filter(({ move }) => move.titles.length > 0 || move.dropped.length === 0).map(({ spec }) => spec.archive);
  const archived = `Archive ${plural(count, "finished entry", "finished entries")} to ${archives.join(" and ")}`;
  return dropped > 0 ? `${archived}; drop ${drop}` : archived;
}

/** One archived file as a line of `tumwater archive`'s output and the team-start event: what
 * moved where, and what was dropped because the archive already held it. */
export function describeArchivedFile(f: ArchivedFile): string {
  const dropped = f.dropped.length > 0 ? ` (${plural(f.dropped.length, "already-archived entry", "already-archived entries")} dropped)` : "";
  return `${f.file} → ${f.archive}: ${plural(f.titles.length, "entry", "entries")}${dropped}`;
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
 * a failed write or commit restores the files. `tumwater archive` and team start call it. */
export async function archiveFinishedOnMain(
  root: string,
  opts: { keep?: number; lockTimeoutMs?: number } = {},
): Promise<ArchiveOnMainOutcome> {
  const keep = opts.keep ?? 0;
  if (planArchiveAll(root, keep).length === 0) return { status: "nothing" };
  return withLock(
    mergeLockDir(root),
    () =>
      withPrimaryWorktreeLockAsync(root, async (): Promise<ArchiveOnMainOutcome> => {
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
        const subject = stampedSubject(
          "operator", // vocabulary-ok: the tumwater(operator): commit prefix is a machine string
          archiveCommitWhat(plan),
        );
        try {
          for (const { spec, move } of plan) writeMove(root, spec, move);
          await git(root, "add", "--", ...touched);
          await git(root, ...(await committerIdentArgs(root)), "commit", ...commitAuthorArgs(), "--only", "-m", subject, "--", ...touched);
        } catch (err) {
          await gitTry(root, "reset", "-q", "--", ...touched);
          const tracked = touched.filter((f) => !created.includes(f));
          await gitTry(root, "checkout", "--", ...tracked);
          for (const f of created) fs.rmSync(path.join(root, f), { force: true });
          return { status: "skipped", reason: `the move could not be written or committed: ${errorFirstLine(err)}` };
        }
        return {
          status: "archived",
          commit: await headOf(root, "HEAD"),
          moved: plan.map(({ spec, move }) => ({ file: spec.file, archive: spec.archive, titles: move.titles, dropped: move.dropped })),
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
        detail: outcome.moved.map(describeArchivedFile).join("; "),
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

/** What fileQuarantineBugsOnMain did: the headings filed, or why nothing was. */
type QuarantineFilingOutcome =
  | { status: "filed"; bugs: Map<string, string> }
  | { status: "skipped"; reason: string };

/** The start of a quarantine entry's title for `test`, up to the date. appendBugEntryLocked
 * collapses whitespace in the title, so the test part is collapsed the same way; collapsing the
 * whole prefix would trim its trailing space. */
function quarantineTitlePrefix(test: string): string {
  return collapseWhitespace(`\`${test}\` failed, then passed on the same tree`) + " (quarantined by tumwater ";
}

/** Output fenced into a bug body: a fence of its own length cannot be closed by the quoted text. */
function fencedTail(tail: string): string {
  return ["~~~~", ...tail.replaceAll("~~~~", "~~~").split("\n").slice(-30), "~~~~"].join("\n");
}

/** File one BUGS.md `## Open` entry per newly quarantined test and commit BUGS.md on the base
 * branch as one `tumwater(operator):` commit, under the merge lock and the primary-worktree lock
 * exactly as archiveFinishedOnMain does. Skipped, writing nothing, when the primary checkout is
 * off the base branch or BUGS.md has uncommitted changes; a failed append or commit restores
 * BUGS.md. A test whose quarantine entry is already under `## Open` (a filing whose
 * markQuarantineFiled failed after the commit) gets that heading back and is not filed again. */
export async function fileQuarantineBugsOnMain(
  root: string,
  tests: readonly { test: string; tail?: string }[],
  opts: { lockTimeoutMs?: number } = {},
): Promise<QuarantineFilingOutcome> {
  return withLock(
    mergeLockDir(root),
    () =>
      withPrimaryWorktreeLockAsync(root, async (): Promise<QuarantineFilingOutcome> => {
        const primary = await currentBranch(root);
        const base = targetBranch(loadConfigSafe(root).config?.baseBranch, primary);
        if (primary !== base) {
          return { status: "skipped", reason: `your checkout is on ${primary ?? "a detached HEAD"}, not ${base}` };
        }
        const status = await gitTry(root, "status", "--porcelain", "--", "BUGS.md");
        if (status === null) return { status: "skipped", reason: "could not read git status" };
        if (status.trim() !== "" && !status.startsWith("??")) {
          return { status: "skipped", reason: "BUGS.md has uncommitted changes" };
        }
        const file = path.join(root, "BUGS.md");
        const before = readTextOrNull(file);
        const date = formatDate(new Date());
        const open = before === null ? [] : parseEntryDetails(before, "Open").map((e) => e.title);
        const bugs = new Map<string, string>();
        let appended = 0;
        const restoreBugs = async (): Promise<void> => {
          await gitTry(root, "reset", "-q", "--", "BUGS.md");
          if (before === null) fs.rmSync(file, { force: true });
          else writeTextAtomic(file, before);
        };
        try {
          for (const { test, tail } of tests) {
            const existing = open.find((t) => t.startsWith(quarantineTitlePrefix(test)));
            if (existing !== undefined) {
              bugs.set(test, existing);
              continue;
            }
            const body = [
              `The check failed on this test and then passed on a re-run of the same tree, so tumwater quarantined it: it counts as a known failure until this entry leaves \`## Open\`. Find why it is unstable and fix it.`,
              ...(tail ? ["", fencedTail(tail)] : []),
            ].join("\n");
            bugs.set(test, appendBugEntryLocked(root, `${quarantineTitlePrefix(test)}${date})`, body));
            appended++;
          }
        } catch (err) {
          await restoreBugs();
          return { status: "skipped", reason: `a BUGS.md entry could not be written: ${errorFirstLine(err)}` };
        }
        if (appended === 0) return { status: "filed", bugs };
        const subject = stampedSubject(
          "operator", // vocabulary-ok: the tumwater(operator): commit prefix is a machine string
          `File ${plural(appended, "quarantined flaky test", "quarantined flaky tests")} in BUGS.md`,
        );
        try {
          await git(root, "add", "--", "BUGS.md");
          await git(root, ...(await committerIdentArgs(root)), "commit", ...commitAuthorArgs(), "--only", "-m", subject, "--", "BUGS.md");
        } catch (err) {
          await restoreBugs();
          return { status: "skipped", reason: `the commit failed: ${errorFirstLine(err)}` };
        }
        return { status: "filed", bugs };
      }),
    opts.lockTimeoutMs,
  );
}
