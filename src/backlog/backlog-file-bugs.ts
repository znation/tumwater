/** File brand-new BUGS.md `## Open` entries (operator bug reports, quarantined flaky tests) on
 * the base branch as one `tumwater(operator):` commit, under the merge lock and the
 * primary-worktree lock. Split out of backlog-archive.ts, whose name and doc cover archiving
 * finished entries to the archive files, not appending new open entries. */
import fs from "node:fs";
import path from "node:path";
import { withLock, withPrimaryWorktreeLockAsync } from "../concurrency/lock.js";
import { readTextIfExists, writeTextAtomic } from "../files/files.js";
import { commitAuthorArgs, committerIdentArgs, git, gitTry } from "../git/git-run.js";
import { stampedSubject } from "../git/commit-message.js";
import { mergeLockDir } from "../paths.js";
import { plural } from "../text/phrases.js";
import { collapseWhitespace, errorFirstLine, trimTrailingBlankLines } from "../text/text.js";
import { formatDate } from "../text/datetime.js";
import { parseEntryDetails } from "./backlog-md.js";
import { appendBugEntryLocked } from "./backlog-write.js";
import { primaryOffBaseBranchReason } from "./backlog-archive.js";
import { actionableEntryRanges } from "./backlog-index-data.js";
import { withoutBugfixWaitNotes } from "./backlog-eligibility.js";

/** What fileQuarantineBugsOnMain did: the headings filed, or why nothing was. */
type QuarantineFilingOutcome =
  | { status: "filed"; bugs: Map<string, string> }
  | { status: "skipped"; reason: string };

/** What fileBugsOnMain did: the appended headings in order, or why nothing was. */
type BugsFilingOutcome =
  | { status: "filed"; headings: string[] }
  | { status: "skipped"; reason: string };

/** filingPreflight's result: the lock held and BUGS.md read — its prior text (null when absent)
 * and its current `## Open` headings — or the skip reason that ends the filing before a write. */
type FilingPreflight = { status: "ok"; file: string; before: string | null; open: string[] } | { status: "skipped"; reason: string };

/** One BUGS.md `## Open` entry to file: a heading title and body, plus an optional quarantine
 * dedupe against the `## Open` headings already present. The headings are read under the merge
 * lock, so two concurrent quarantine filings cannot both append a duplicate entry. */
interface BugEntry {
  title: string;
  body: string;
  /** When given, called with the `## Open` headings already present (read under the merge lock);
   * a returned string reuses that heading instead of appending a duplicate. */
  ifOpen?: (open: string[]) => string | undefined;
  /** When given and `ifOpen` reused a heading, called with BUGS.md's current text and that
   * heading; a returned text replaces BUGS.md (an occurrence recorded under the existing entry),
   * null leaves it as it is. */
  amend?: (md: string, heading: string) => string | null;
}

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

/** `md` with a recurrence of `test` recorded under the `## Open` entry headed `heading` when that
 * entry waits for one — it carries a bugfix wait note (`**Needs review … by bugfix: …**`, the
 * backlog-bug-waits.ts park): the wait notes go and a dated occurrence, with the failing output
 * when there is one, closes the body, so the bugfix role takes the bug again with the failure it
 * was waiting for. null, leaving BUGS.md as it is, when the entry is gone or waits for nothing —
 * a bug some role is already working on needs no commit per flake. Pure. */
export function recordRecurrence(md: string, heading: string, test: string, date: string, tail?: string): string | null {
  const entry = actionableEntryRanges(md, "Open").find((e) => e.title === heading);
  if (entry === undefined) return null;
  const lines = md.split("\n");
  const slice = lines.slice(entry.start - 1, entry.end);
  const lifted = withoutBugfixWaitNotes(slice);
  if (lifted.length === slice.length) return null;
  const hadGap = (slice.at(-1) ?? "").trim() === "";
  trimTrailingBlankLines(lifted);
  lifted.push(
    "",
    `**Failed again ${date} (tumwater):** \`${test}\` failed, then passed on a re-run of the same tree, so the ` +
      `wait for a recurrence is lifted and the bugfix role takes this bug again.`,
    ...(tail ? ["", fencedTail(tail)] : []),
    ...(hadGap ? [""] : []),
  );
  lines.splice(entry.start - 1, slice.length, ...lifted);
  return lines.join("\n");
}

/** fileBugsLocked's first step, under the merge and primary-worktree locks: the primary must be
 * on the base branch, git status must be readable and show no tracked changes to BUGS.md (an
 * untracked BUGS.md is a fresh file the filing may create), and BUGS.md must read. Returns the
 * same skip reasons in the same order as before the split. */
async function filingPreflight(root: string): Promise<FilingPreflight> {
  const offBase = await primaryOffBaseBranchReason(root);
  if (offBase !== null) return { status: "skipped", reason: offBase };
  const status = await gitTry(root, "status", "--porcelain", "--", "BUGS.md");
  if (status === null) return { status: "skipped", reason: "could not read git status" };
  if (status.trim() !== "" && !status.startsWith("??")) {
    return { status: "skipped", reason: "BUGS.md has uncommitted changes" };
  }
  const file = path.join(root, "BUGS.md");
  let before: string | null;
  try {
    before = readTextIfExists(file);
  } catch (err) {
    return { status: "skipped", reason: `BUGS.md could not be read: ${errorFirstLine(err)}` };
  }
  const open = before === null ? [] : parseEntryDetails(before, "Open").map((e) => e.title);
  return { status: "ok", file, before, open };
}

/** Undo a failed filing: unstage BUGS.md, then put it back — remove it when it was absent,
 * otherwise rewrite its prior text. */
async function restoreBugsFile(root: string, file: string, before: string | null): Promise<void> {
  await gitTry(root, "reset", "-q", "--", "BUGS.md");
  if (before === null) fs.rmSync(file, { force: true });
  else writeTextAtomic(file, before);
}

/** fileBugsLocked's write step: append or amend each entry in order (an `ifOpen` match reuses
 * the existing heading and may `amend` it in place), returning the headings in input order and
 * the append/amend counts; a write failure restores BUGS.md and ends the filing. */
async function applyFilingEntries(
  root: string,
  file: string,
  before: string | null,
  open: string[],
  entries: readonly BugEntry[],
): Promise<{ headings: string[]; appended: number; amended: number } | { status: "skipped"; reason: string }> {
  const headings: string[] = [];
  let appended = 0;
  let amended = 0;
  try {
    for (const entry of entries) {
      if (entry.ifOpen !== undefined) {
        const existing = entry.ifOpen(open);
        if (existing !== undefined) {
          headings.push(existing);
          const next = entry.amend?.(readTextIfExists(file) ?? "", existing) ?? null;
          if (next !== null) {
            writeTextAtomic(file, next);
            amended++;
          }
          continue;
        }
      }
      headings.push(appendBugEntryLocked(root, entry.title, entry.body));
      appended++;
    }
  } catch (err) {
    await restoreBugsFile(root, file, before);
    return { status: "skipped", reason: `a BUGS.md entry could not be written: ${errorFirstLine(err)}` };
  }
  return { headings, appended, amended };
}

/** fileBugsLocked's commit step: commit BUGS.md once, under the operator role, with the subject
 * sized by the entries appended and amended (with neither, nothing is committed); a failure
 * restores BUGS.md. */
async function commitFiling(
  root: string,
  file: string,
  before: string | null,
  appended: number,
  amended: number,
  subject: (appended: number, amended: number) => string,
): Promise<{ status: "filed" } | { status: "skipped"; reason: string }> {
  if (appended === 0 && amended === 0) return { status: "filed" };
  const commitSubject = stampedSubject(
    "operator", // vocabulary-ok: the tumwater(operator): commit prefix is a machine string
    subject(appended, amended),
  );
  try {
    await git(root, "add", "--", "BUGS.md");
    await git(root, ...(await committerIdentArgs(root)), "commit", ...commitAuthorArgs(), "--only", "-m", commitSubject, "--", "BUGS.md");
  } catch (err) {
    await restoreBugsFile(root, file, before);
    return { status: "skipped", reason: `the commit failed: ${errorFirstLine(err)}` };
  }
  return { status: "filed" };
}

/** What fileBugsOnMain does under the merge lock and the primary-worktree lock, in order:
 * preflight, write the entries, commit them, restore BUGS.md on a failed write or commit. */
async function fileBugsLocked(root: string, entries: readonly BugEntry[], subject: (appended: number, amended: number) => string): Promise<BugsFilingOutcome> {
  const preflight = await filingPreflight(root);
  if (preflight.status === "skipped") return preflight;
  const applied = await applyFilingEntries(root, preflight.file, preflight.before, preflight.open, entries);
  if ("status" in applied) return applied;
  const committed = await commitFiling(root, preflight.file, preflight.before, applied.appended, applied.amended, subject);
  if (committed.status === "skipped") return committed;
  return { status: "filed", headings: applied.headings };
}

/** File one BUGS.md `## Open` entry per given entry and commit BUGS.md on the base branch as one
 * `tumwater(operator):` commit (the subject built from the number of entries actually appended is
 * stamped under the operator role), under the merge lock and the primary-worktree lock exactly as
 * archiveFinishedOnMain does. Skipped,
 * writing nothing, when the primary checkout is off the base branch, BUGS.md has uncommitted
 * changes, or BUGS.md exists but cannot be read; a failed append or commit restores BUGS.md.
 * Every entry is appended verbatim as its own `## Open` heading — unless its `ifOpen` dedupe
 * matches an existing heading, which is reused instead and may be amended in place (`amend`) —
 * and the returned headings are the entry headings in input order. `subject` sizes the commit by
 * the entries appended and amended; with neither, nothing is committed. */
export async function fileBugsOnMain(
  root: string,
  entries: readonly BugEntry[],
  subject: (appended: number, amended: number) => string,
  opts: { lockTimeoutMs?: number } = {},
): Promise<BugsFilingOutcome> {
  return withLock(
    mergeLockDir(root),
    () => withPrimaryWorktreeLockAsync(root, () => fileBugsLocked(root, entries, subject)),
    opts.lockTimeoutMs,
  );
}

/** File one BUGS.md `## Open` entry per newly quarantined test and commit BUGS.md on the base
 * branch as one `tumwater(operator):` commit, delegating the locked write/commit to
 * fileBugsOnMain and preserving the existing subject. A test an open bug already covers — its
 * quarantine entry (a filing whose markQuarantineFiled failed after the commit, a flake of a test
 * released or quarantined again), or a bug whose heading quotes the test name — gets that heading
 * back and is not filed again; when that bug waits for a recurrence, the flake is recorded under
 * it and the wait lifted (recordRecurrence). The dedupe runs inside fileBugsOnMain under the
 * merge lock (via each entry's `ifOpen`), so concurrent quarantine filings cannot both append a
 * duplicate, and the real skip on a dirty or off-base BUGS.md is enforced under the same lock. */
export async function fileQuarantineBugsOnMain(
  root: string,
  tests: readonly { test: string; tail?: string }[],
  opts: { lockTimeoutMs?: number } = {},
): Promise<QuarantineFilingOutcome> {
  const date = formatDate(new Date());
  const toFile: BugEntry[] = [];
  for (const { test, tail } of tests) {
    const prefix = quarantineTitlePrefix(test);
    const body = [
      `The check failed on this test and then passed on a re-run of the same tree, so tumwater quarantined it: it counts as a known failure until this entry leaves \`## Open\`. Find why it is unstable and fix it.`,
      ...(tail ? ["", fencedTail(tail)] : []),
    ].join("\n");
    toFile.push({
      title: `${prefix}${date})`,
      body,
      // Dedupe under the lock, against the headings fileBugsOnMain reads: the reused heading
      // (not a duplicate) is returned in headings and zipped back to this test below.
      ifOpen: (open: string[]) =>
        open.find((t) => t.startsWith(prefix)) ?? open.find((t) => t.includes(`"${test}"`) || t.includes(`\`${test}\``)),
      amend: (md: string, heading: string) => recordRecurrence(md, heading, test, date, tail),
    });
  }
  const outcome = await fileBugsOnMain(
    root,
    toFile,
    // Size the subject by what was actually written: tests whose `## Open` entry was already
    // present are reused, not filed, so a mixed batch keeps the original "File N …" wording
    // with N the count of new entries only, and names the recurrences it recorded.
    (appended, amended) => {
      const filed = appended > 0 ? `File ${plural(appended, "quarantined flaky test", "quarantined flaky tests")}` : "";
      const recurred = amended > 0 ? `${filed === "" ? "Record" : "record"} ${plural(amended, "recurrence of a waiting bug", "recurrences of waiting bugs")}` : "";
      return `${[filed, recurred].filter((p) => p !== "").join(" and ")} in BUGS.md`;
    },
    opts,
  );
  if (outcome.status === "skipped") return { status: "skipped", reason: outcome.reason };
  // fileBugsOnMain's headings align with `tests` in order (reused headings or appended titles).
  const bugs = new Map<string, string>();
  outcome.headings.forEach((heading, i) => bugs.set(tests[i]!.test, heading));
  return { status: "filed", bugs };
}
