/** What unmerged changes do to PLANS.md's `## Planned`, read from the refs that outlive the
 * merge queue: the merge pins (`refs/tumwater/merge/<role>`) and the role branches
 * (`refs/heads/tumwater/<role>`) — never the queue itself (plans/duplicate-plans.md "Decision"
 * 1: Subtract parts 3e/7 and 3f/7 remove the queue, pins and branches remain). The plan role's
 * stop count and its Needs-review check read `## Planned` with every such change applied
 * (projectedPlannedEntries), so a plan already waiting to merge — or a split that removes a
 * `Needs review` entry — stops the plan role instead of being re-planned. renderPendingPlansBlock
 * renders the same snapshot as the plan role's `<pending-plans>` prompt block (part 3/6). */

import { gitTry } from "../git/git-run.js";
import { gitLines } from "../git/git.js";
import { plural } from "../text/phrases.js";
import type { BacklogEntry } from "./backlog-md.js";
import { parseEntryDetails } from "./backlog-md.js";
import { entryKey } from "./backlog-parts.js";
import { stripEntryStamp } from "./backlog-structure.js";
import { plannedPlanEntries } from "./backlog.js";

/** One unmerged change's effect on `## Planned`, judged against the merge-base of `sha` with
 * main: the entries the change adds, the keys of entries it removes, and the entries it
 * rewrites (a lifted `Needs review` note, a done stamp). */
export interface PendingPlanChange {
  /** The ref naming the change — a merge pin or a role branch. */
  ref: string;
  /** The role the ref belongs to; a pin and a branch of one role on one sha count once. */
  role: string;
  /** The tip commit the ref names. */
  sha: string;
  /** The tip commit's subject, so a surface can name the waiting change. */
  subject: string;
  /** Entries `## Planned` gains at `sha` relative to its merge-base with main. */
  added: BacklogEntry[];
  /** `## Planned` entries the change removes, kept whole so a surface can name the removed
   * titles, not just their keys. */
  removed: BacklogEntry[];
  /** Entries the change rewrites (title or body differs from the merge-base's). */
  changed: BacklogEntry[];
}

/** The git runner refreshPendingPlans calls through — injectable so a test can count calls:
 * the memo's observable win is that a repeat refresh with unchanged refs runs only the one
 * for-each-ref. */
export type PendingGitRunner = (cwd: string, ...args: string[]) => Promise<string | null>;

/** Per-root snapshot: what the last refreshPendingPlans found, in ref order. Empty until the
 * first refresh, so a surface that reads before any poll projects main alone. */
const snapshots = new Map<string, PendingPlanChange[]>();

/** The diff payload one sha computes, or the sentinels below. Memoized by sha alone: commits
 * never change, so a repeat refresh with an unchanged ref re-reads no commit. Bounded like the
 * other keyed caches so a long-lived process cannot grow it. */
interface PendingPlanDiff {
  subject: string;
  added: BacklogEntry[];
  removed: BacklogEntry[];
  changed: BacklogEntry[];
}

/** The diff's outcome: the payload, `"unchanged"` when PLANS.md's `## Planned` is identical at
 * the merge-base and the sha (a definitive no-contribution), or `null` when the read failed
 * (an unreadable file, a gone ref) — which contributes nothing but leaves the role's earlier
 * snapshot entry in place, as a failed git read must not erase what a good read found. */
type PendingPlanDiffResult = PendingPlanDiff | "unchanged" | null;

const DIFF_MEMO_MAX = 512;
const diffMemo = new Map<string, PendingPlanDiffResult>();

/** renderPendingPlansBlock lists at most this many of its lines (change headers and effect
 * lines alike); the rest is counted, not named. 40 keeps the block inside the prompt's
 * standing evidence size while one long-running series of splits still shows its latest parts. */
const PENDING_PLANS_LINE_CAP = 40;

/** The role a pending ref belongs to: the refname's suffix after the pin or branch prefix. */
function roleOfRef(ref: string): string {
  if (ref.startsWith("refs/tumwater/merge/")) return ref.slice("refs/tumwater/merge/".length);
  return ref.slice("refs/heads/tumwater/".length);
}

/** The `## Planned` diff one `sha` computes, judged against the merge-base with `mainBranch`
 * (main's tip when the merge-base fails, as changeBaseRev does). A failed read — no PLANS.md
 * at either side, a gone ref — returns `null` (failure, not no-change); a PLANS.md that did
 * not change returns `"unchanged"`. Both are memoized; neither throws into the poll. */
async function diffAt(
  root: string,
  mainBranch: string,
  sha: string,
  run: PendingGitRunner,
): Promise<PendingPlanDiffResult> {
  const base = (await run(root, "merge-base", sha, mainBranch))?.trim() || mainBranch;
  const changedFiles = gitLines(await run(root, "diff", "--name-only", base, sha));
  if (!changedFiles.includes("PLANS.md")) return "unchanged";
  const baseMd = await run(root, "show", `${base}:PLANS.md`);
  const headMd = await run(root, "show", `${sha}:PLANS.md`);
  if (baseMd === null || headMd === null) return null;
  const baseEntries = parseEntryDetails(baseMd, "Planned");
  const headEntries = parseEntryDetails(headMd, "Planned");
  const baseByKey = new Map(baseEntries.map((e) => [entryKey(e.title), e] as const));
  const headKeys = new Set(headEntries.map((e) => entryKey(e.title)));
  const added = headEntries.filter((e) => !baseByKey.has(entryKey(e.title))).map((e) => ({ ...e }));
  const removed = [...baseByKey.values()].filter((e) => !headKeys.has(entryKey(e.title))).map((e) => ({ ...e }));
  const changed = headEntries
    .filter((e) => {
      const b = baseByKey.get(entryKey(e.title));
      return b !== undefined && (b.title !== e.title || b.body !== e.body);
    })
    .map((e) => ({ ...e }));
  const subject = (await run(root, "log", "-1", "--format=%s", sha))?.trim() ?? "";
  return { subject, added, removed, changed };
}

/** True when a diff payload contributes nothing to the projection: no additions, removals or
 * rewrites. */
function diffIsEmpty(diff: PendingPlanDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/** Rebuild `root`'s snapshot from the refs that outlive the merge queue: one for-each-ref
 * over the merge pins and the role branches, unmerged against `mainBranch` only. A ref whose
 * sha the memo already knows re-reads no commit; a pin and a branch of one role on one sha
 * count once (for-each-ref's refname order lists the branch first, so the pin's ref name
 * wins the record). A failed for-each-ref leaves the previous snapshot in place and never
 * throws into the poll. */
export async function refreshPendingPlans(
  root: string,
  mainBranch: string,
  run: PendingGitRunner = gitTry,
): Promise<void> {
  let refs: { ref: string; sha: string }[];
  try {
    refs = gitLines(
      await run(
        root,
        "for-each-ref",
        `--no-merged=${mainBranch}`,
        "--format=%(refname) %(objectname)",
        "refs/tumwater/merge/",
        "refs/heads/tumwater/",
      ),
    ).map((line) => {
      const [ref, sha] = line.split(" ") as [string, string];
      return { ref, sha };
    });
  } catch {
    return;
  }
  const byRoleSha = new Map<string, { ref: string; sha: string }>();
  for (const { ref, sha } of refs) {
    if (sha === undefined) continue;
    byRoleSha.set(`${roleOfRef(ref)}\u0000${sha}`, { ref, sha });
  }
  const previousByRole = new Map(
    (snapshots.get(root) ?? []).map((c) => [c.role, c] as const),
  );
  const changes: PendingPlanChange[] = [];
  for (const { ref, sha } of byRoleSha.values()) {
    let diff = diffMemo.get(sha);
    if (diff === undefined) {
      diff = await diffAt(root, mainBranch, sha, run);
      if (diffMemo.size >= DIFF_MEMO_MAX) diffMemo.clear();
      diffMemo.set(sha, diff);
    }
    if (diff === "unchanged") continue;
    if (diff === null) {
      // A read failure contributes nothing, and the role's earlier entry (its last good
      // read) stays in the snapshot: a failed git read must not erase what a good read found.
      const previous = previousByRole.get(roleOfRef(ref));
      if (previous !== undefined) changes.push(previous);
      continue;
    }
    if (diffIsEmpty(diff)) continue;
    changes.push({
      ref,
      role: roleOfRef(ref),
      sha,
      subject: diff.subject,
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
    });
  }
  snapshots.set(root, changes);
}

/** `root`'s current snapshot: what the last refreshPendingPlans found, in ref order. Empty
 * before the first refresh, so the projection reads main alone. */
export function pendingPlanChanges(root: string): PendingPlanChange[] {
  return snapshots.get(root) ?? [];
}

/** The plan role's `<pending-plans>` prompt block: what each unmerged change does to
 * `## Planned`, one line per change naming its role, short SHA and subject, then the entries it
 * adds, removes and edits by stamp-free title — so the plan role's dedupe step (charter step 3)
 * checks entries main does not hold yet, and the charter's pending-plans rule (part 3/6) has a
 * block to point at. `undefined` when the snapshot is empty, so a plan prompt with nothing
 * unmerged is byte-identical to the pre-block prompt. The listed lines are capped at
 * PENDING_PLANS_LINE_CAP; anything past the cap is counted, not named. */
export function renderPendingPlansBlock(root: string): string | undefined {
  const changes = pendingPlanChanges(root);
  if (changes.length === 0) return undefined;
  const all: string[] = [];
  for (const change of changes) {
    all.push(`${change.role} ${change.sha.slice(0, 7)}: ${change.subject}`);
    for (const entry of change.added) all.push(`  adds "${stripEntryStamp(entry.title)}"`);
    for (const entry of change.removed) all.push(`  removes "${stripEntryStamp(entry.title)}"`);
    for (const entry of change.changed) all.push(`  edits "${stripEntryStamp(entry.title)}"`);
  }
  const listed = all.slice(0, PENDING_PLANS_LINE_CAP);
  const omitted = all.length - listed.length;
  if (omitted > 0) listed.push(`and ${plural(omitted, "line")} omitted`);
  return (
    "What the unmerged changes (a merge pin or a role branch) do to PLANS.md `## Planned`, one\n" +
    "line per change with the entries it adds, removes and edits by stamp-free title.\n" +
    `<pending-plans>\n${listed.join("\n")}\n</pending-plans>`
  );
}

/** PLANS.md's `## Planned` as it will be once every unmerged change merges: main's entries
 * with each pending change applied in ref order — its removed entries dropped, `changed` bodies
 * replaced, `added` entries appended unless already present by key. A key several changes
 * touch resolves to the last change's version, the order a sequential merge would apply
 * them. Returns copies: callers may treat the result as their own. */
export function projectedPlannedEntries(root: string): BacklogEntry[] {
  const entries = plannedPlanEntries(root).map((e) => ({ ...e }));
  const byKey = new Map(entries.map((e) => [entryKey(e.title), e] as const));
  for (const change of pendingPlanChanges(root)) {
    const removedKeys = new Set(change.removed.map((e) => entryKey(e.title)));
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (removedKeys.has(entryKey(entry.title))) {
        byKey.delete(entryKey(entry.title));
        entries.splice(i, 1);
      }
    }
    for (const entry of change.changed) {
      const existing = byKey.get(entryKey(entry.title));
      if (existing !== undefined) {
        existing.title = entry.title;
        existing.body = entry.body;
      } else {
        const copy = { ...entry };
        entries.push(copy);
        byKey.set(entryKey(copy.title), copy);
      }
    }
    for (const entry of change.added) {
      if (byKey.has(entryKey(entry.title))) continue;
      const copy = { ...entry };
      entries.push(copy);
      byKey.set(entryKey(copy.title), copy);
    }
  }
  return entries;
}
