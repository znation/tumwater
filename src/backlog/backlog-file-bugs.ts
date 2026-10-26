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
import { collapseWhitespace, errorFirstLine } from "../text/text.js";
import { formatDate } from "../text/datetime.js";
import { parseEntryDetails } from "./backlog-md.js";
import { appendBugEntryLocked } from "./backlog-write.js";
import { primaryOffBaseBranchReason } from "./backlog-archive.js";

/** What fileQuarantineBugsOnMain did: the headings filed, or why nothing was. */
type QuarantineFilingOutcome =
  | { status: "filed"; bugs: Map<string, string> }
  | { status: "skipped"; reason: string };

/** What fileBugsOnMain did: the appended headings in order, or why nothing was. */
type BugsFilingOutcome =
  | { status: "filed"; headings: string[] }
  | { status: "skipped"; reason: string };

/** One BUGS.md `## Open` entry to file: a heading title and body, plus an optional quarantine
 * dedupe against the `## Open` headings already present. The headings are read under the merge
 * lock, so two concurrent quarantine filings cannot both append a duplicate entry. */
interface BugEntry {
  title: string;
  body: string;
  /** When given, called with the `## Open` headings already present (read under the merge lock);
   * a returned string reuses that heading instead of appending a duplicate. */
  ifOpen?: (open: string[]) => string | undefined;
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

/** File one BUGS.md `## Open` entry per given entry and commit BUGS.md on the base branch as one
 * `tumwater(operator):` commit (the subject built from the number of entries actually appended is
 * stamped under the operator role), under the merge lock and the primary-worktree lock exactly as
 * archiveFinishedOnMain does. Skipped,
 * writing nothing, when the primary checkout is off the base branch, BUGS.md has uncommitted
 * changes, or BUGS.md exists but cannot be read; a failed append or commit restores BUGS.md.
 * Every entry is appended verbatim as its own `## Open` heading — unless its `ifOpen` dedupe
 * matches an existing heading, which is reused instead — and the returned headings are the
 * entry headings in input order. */
export async function fileBugsOnMain(
  root: string,
  entries: readonly BugEntry[],
  subject: (appended: number) => string,
  opts: { lockTimeoutMs?: number } = {},
): Promise<BugsFilingOutcome> {
  return withLock(
    mergeLockDir(root),
    () =>
      withPrimaryWorktreeLockAsync(root, async (): Promise<BugsFilingOutcome> => {
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
        const headings: string[] = [];
        let appended = 0;
        const restoreBugs = async (): Promise<void> => {
          await gitTry(root, "reset", "-q", "--", "BUGS.md");
          if (before === null) fs.rmSync(file, { force: true });
          else writeTextAtomic(file, before);
        };
        try {
          for (const entry of entries) {
            if (entry.ifOpen !== undefined) {
              const existing = entry.ifOpen(open);
              if (existing !== undefined) {
                headings.push(existing);
                continue;
              }
            }
            headings.push(appendBugEntryLocked(root, entry.title, entry.body));
            appended++;
          }
        } catch (err) {
          await restoreBugs();
          return { status: "skipped", reason: `a BUGS.md entry could not be written: ${errorFirstLine(err)}` };
        }
        if (appended === 0) return { status: "filed", headings };
        const commitSubject = stampedSubject(
          "operator", // vocabulary-ok: the tumwater(operator): commit prefix is a machine string
          subject(appended),
        );
        try {
          await git(root, "add", "--", "BUGS.md");
          await git(root, ...(await committerIdentArgs(root)), "commit", ...commitAuthorArgs(), "--only", "-m", commitSubject, "--", "BUGS.md");
        } catch (err) {
          await restoreBugs();
          return { status: "skipped", reason: `the commit failed: ${errorFirstLine(err)}` };
        }
        return { status: "filed", headings };
      }),
    opts.lockTimeoutMs,
  );
}

/** File one BUGS.md `## Open` entry per newly quarantined test and commit BUGS.md on the base
 * branch as one `tumwater(operator):` commit, delegating the locked write/commit to
 * fileBugsOnMain and preserving the existing subject. A test whose quarantine entry is already
 * under `## Open` (a filing whose markQuarantineFiled failed after the commit) gets that heading
 * back and is not filed again — the dedupe runs inside fileBugsOnMain under the merge lock (via
 * each entry's `ifOpen`), so concurrent quarantine filings cannot both append a duplicate, and
 * the real skip on a dirty or off-base BUGS.md is enforced under the same lock. */
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
      ifOpen: (open: string[]) => open.find((t) => t.startsWith(prefix)),
    });
  }
  const outcome = await fileBugsOnMain(
    root,
    toFile,
    // Size the subject by what was actually appended: tests whose `## Open` entry was already
    // present are reused, not filed, so a mixed batch keeps the original "File N …" wording
    // with N the count of new entries only.
    (appended) => `File ${plural(appended, "quarantined flaky test", "quarantined flaky tests")} in BUGS.md`,
    opts,
  );
  if (outcome.status === "skipped") return { status: "skipped", reason: outcome.reason };
  // fileBugsOnMain's headings align with `tests` in order (reused headings or appended titles).
  const bugs = new Map<string, string>();
  outcome.headings.forEach((heading, i) => bugs.set(tests[i]!.test, heading));
  return { status: "filed", bugs };
}
