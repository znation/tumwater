/** The bugfix role's waits for a recurrence, settled by tumwater itself. A bug the bugfix role
 * cannot reproduce is parked with a `**Needs review <date> by bugfix: …**` note naming what the
 * next failure's message will show (role-catalog.ts bugfix step 2, the last resort after the
 * director handoff). No role can act on it until the failure comes back, so the wait ends on its
 * own, two ways:
 * - when the flake quarantine sees the bug's test fail and pass again, the occurrence is recorded
 *   under the entry and the wait note lifted, so the bugfix role takes it back with the new
 *   failure in hand (recordRecurrence, backlog-file-bugs.ts);
 * - when a wait sees no recurrence for BUGFIX_WAIT_QUIET_DAYS, the bug closes
 *   (closeQuietBugWaitsOnMain, here); a later failure is quarantined again and files a new bug.
 * Before both, only selfcheck could lift a wait, on spotting the failure in its 24-hour digest,
 * and that digest never shows a flake the main watch's re-run settled. On 2026-11-03 every open bug
 * had sat `[blocked: needs review]` for 8–18 days with nothing able to clear it. */

import fs from "node:fs";
import path from "node:path";
import { withLock, withPrimaryWorktreeLockAsync } from "../concurrency/lock.js";
import { readTextIfExists, writeTextAtomic } from "../files/files.js";
import { commitAuthorArgs, committerIdentArgs, git, gitTry } from "../git/git-run.js";
import { stampedSubject } from "../git/commit-message.js";
import { mergeLockDir } from "../paths.js";
import { plural } from "../text/phrases.js";
import { errorFirstLine } from "../text/text.js";
import { formatDate } from "../text/datetime.js";
import { ageInDays, openBugEntries } from "./backlog.js";
import { finishedArchiveOf, parseEntryDetails, type BacklogEntry } from "./backlog-md.js";
import { actionableEntryRanges } from "./backlog-index-data.js";
import { archiveFinishedText, primaryOffBaseBranchReason } from "./backlog-archive.js";
import { bugfixWaitDate, entryHoldAgainst } from "./backlog-eligibility.js";
import { BUGFIX_WAIT_QUIET_DAYS } from "../roles/role-guidance.js";

/** One open bug whose wait has gone quiet: its heading and the day its newest wait began. */
interface QuietWait {
  title: string;
  since: string;
}

/** The entries of `open` held only by a bugfix wait (entryHoldAgainst's awaiting-recurrence)
 * whose newest wait note is at least BUGFIX_WAIT_QUIET_DAYS old at `now`. Pure. */
function quietWaitsOf(open: readonly BacklogEntry[], now: number): QuietWait[] {
  return open.flatMap((entry) => {
    if (entryHoldAgainst(entry, new Set()) !== "awaiting-recurrence") return [];
    const since = bugfixWaitDate(entry.body);
    return since !== null && ageInDays(since, now) >= BUGFIX_WAIT_QUIET_DAYS ? [{ title: entry.title, since }] : [];
  });
}

/** The closing text a quietly closed bug gains under its body: a Fix paragraph naming no code (the
 * false-fix rule reads only this paragraph, fix-claim.ts fixSymbols) and the validation-gap line
 * every Fixed entry carries. */
function closingLines(wait: QuietWait, now: number): string[] {
  return [
    `**Fix:** closed by tumwater: the bugfix role's wait for a recurrence, begun ${wait.since}, saw none in ` +
      `${ageInDays(wait.since, now)} days. If it happens again it is filed again — a flaky test by the flake ` +
      `quarantine, anything else by the role that sees it.`,
    "",
    "**Validation gap:** no-repro — the failure never came back to show its cause, so the bug closes unexplained.",
  ];
}

/** BUGS.md and BUGS-FIXED.md with every quiet wait of `bugsMd` closed: each leaves `## Open` and
 * lands, newest first, at the top of the archive's `## Fixed` (a missing archive starts from its
 * template) under `<heading> — closed <today> by tumwater` with closingLines. null when no wait
 * is quiet, or when the archive cannot take every one (no `## Fixed` heading, or one already
 * archived under the same heading). Pure. */
export function closeQuietWaitsText(
  bugsMd: string,
  archiveMd: string | null,
  open: readonly BacklogEntry[],
  now: number,
): { bugs: string; archive: string; titles: string[] } | null {
  const quiet = quietWaitsOf(open, now);
  if (quiet.length === 0) return null;
  const lines = bugsMd.split("\n");
  const ranges = actionableEntryRanges(bugsMd, "Open");
  const today = formatDate(new Date(now));
  const blocks: string[] = [];
  const closing = quiet.flatMap((wait) => {
    const range = ranges.find((r) => r.title === wait.title);
    if (range === undefined) return [];
    const body = lines.slice(range.start, range.end);
    while (body.length > 0 && (body.at(-1) as string).trim() === "") body.pop();
    while (body.length > 0 && (body[0] as string).trim() === "") body.shift();
    if (blocks.length > 0) blocks.push("");
    blocks.push(`### ${wait.title} — closed ${today} by tumwater`, "", ...body, "", ...closingLines(wait, now));
    return [range];
  });
  if (closing.length === 0) return null;
  const move = archiveFinishedText(["## Fixed", "", ...blocks, ""].join("\n"), archiveMd, finishedArchiveOf("BUGS.md"), { keep: 0 });
  if (move?.titles.length !== closing.length) return null;
  for (const range of [...closing].sort((a, b) => b.start - a.start)) lines.splice(range.start - 1, range.end - range.start + 1);
  return { bugs: lines.join("\n"), archive: move.archive, titles: closing.map((r) => r.title) };
}

/** What closeQuietBugWaitsOnMain did: the headings it closed, or why nothing was. */
type QuietCloseOutcome =
  | { status: "nothing" }
  | { status: "closed"; titles: string[] }
  | { status: "skipped"; reason: string };

/** Close every bug of the primary checkout at `root` whose bugfix wait has seen no recurrence for
 * BUGFIX_WAIT_QUIET_DAYS (closeQuietWaitsText), committing BUGS.md and BUGS-FIXED.md on the base
 * branch as one `tumwater(operator):` commit under the merge lock and the primary-worktree lock,
 * exactly as fileBugsOnMain does. The steady state — no quiet wait — reads only the stat-cached
 * open bugs and takes no lock. Skipped, writing nothing, when the primary checkout is off the base
 * branch, either file has uncommitted changes, or one cannot be read; a failed write or commit
 * restores both files. */
export async function closeQuietBugWaitsOnMain(
  root: string,
  opts: { now?: number; lockTimeoutMs?: number } = {},
): Promise<QuietCloseOutcome> {
  const now = opts.now ?? Date.now();
  if (quietWaitsOf(openBugEntries(root), now).length === 0) return { status: "nothing" };
  const spec = finishedArchiveOf("BUGS.md");
  return withLock(
    mergeLockDir(root),
    () =>
      withPrimaryWorktreeLockAsync(root, async (): Promise<QuietCloseOutcome> => {
        const offBase = await primaryOffBaseBranchReason(root);
        if (offBase !== null) return { status: "skipped", reason: offBase };
        const files = [spec.file, spec.archive];
        const status = await gitTry(root, "status", "--porcelain", "--", ...files);
        if (status === null) return { status: "skipped", reason: "could not read git status" };
        const dirty = status.split("\n").filter((l) => l.length > 3 && !l.startsWith("??")).map((l) => l.slice(3));
        if (dirty.length > 0) {
          return { status: "skipped", reason: `${dirty.join(", ")} ${dirty.length > 1 ? "have" : "has"} uncommitted changes` };
        }
        let bugsMd: string | null;
        let archiveMd: string | null;
        try {
          bugsMd = readTextIfExists(path.join(root, spec.file));
          archiveMd = readTextIfExists(path.join(root, spec.archive));
        } catch (err) {
          return { status: "skipped", reason: `a backlog file could not be read: ${errorFirstLine(err)}` };
        }
        // Re-judged under the locks from the files themselves: a merge may have moved main since.
        const closed = bugsMd === null ? null : closeQuietWaitsText(bugsMd, archiveMd, parseEntryDetails(bugsMd, "Open"), now);
        if (bugsMd === null || closed === null) return { status: "nothing" };
        const restore = async (): Promise<void> => {
          await gitTry(root, "reset", "-q", "--", ...files);
          writeTextAtomic(path.join(root, spec.file), bugsMd);
          if (archiveMd === null) fs.rmSync(path.join(root, spec.archive), { force: true });
          else writeTextAtomic(path.join(root, spec.archive), archiveMd);
        };
        const subject = stampedSubject(
          "operator", // vocabulary-ok: the tumwater(operator): commit prefix is a machine string
          `Close ${plural(closed.titles.length, "bug")} whose bugfix wait saw no recurrence in ${BUGFIX_WAIT_QUIET_DAYS} days`,
        );
        try {
          // The archive first, so a crash in between leaves a bug in both files, never in neither.
          writeTextAtomic(path.join(root, spec.archive), closed.archive);
          writeTextAtomic(path.join(root, spec.file), closed.bugs);
          await git(root, "add", "--", ...files);
          await git(root, ...(await committerIdentArgs(root)), "commit", ...commitAuthorArgs(), "--only", "-m", subject, "--", ...files);
        } catch (err) {
          await restore();
          return { status: "skipped", reason: `the close could not be written or committed: ${errorFirstLine(err)}` };
        }
        return { status: "closed", titles: closed.titles };
      }),
    opts.lockTimeoutMs,
  );
}
