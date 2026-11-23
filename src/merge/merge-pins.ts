import { gitLines, refSha, refsUnder } from "../git/git.js";
import { gitTry } from "../git/git-run.js";
import { commitRunOf, commitSubject } from "../run/commit-message.js";
import { mergeRefName } from "../paths.js";

/** The ref prefix every merge pin lives under (paths.ts `mergeRefName` joins it to a role id).
 * Listing it recovers every live pin in one `for-each-ref` read, for callers that do not know
 * the team's role ids. */
const MERGE_REF_PREFIX = "refs/tumwater/merge/";

/** The separator between the commit date and the message in the reader's single `git log` call
 * (the ASCII unit separator): a character that never appears in a unix-timestamp or a commit
 * subject, so `out.split(SEP)` recovers both halves unambiguously. */
const SEP = "\u001f";

/** The reader's entry shape, in the `readMergeQueue` shape (merge-queue.ts): one waiting
 * change per live pin, with the role, the pinned sha, the run number the commit's trailer
 * carries (0 when it has none), the commit subject as the summary, and the commit's committer
 * date as the wait's start. */
interface MergePinEntry {
  role: string;
  sha: string;
  run: number;
  summary: string;
  enqueuedAt: number;
}

/** Read the waiting changes as a view — the live merge pins, not the queue directory.
 *
 * `roleIds` selects the roles to scan. Given, the reader resolves each role's own `mergeRefName`
 * with `refSha`: a role with no ref contributes nothing, a role whose ref resolves to a present
 * commit contributes one entry, and a role whose ref resolves to a missing commit is `unreadable`.
 * Omitting `roleIds` (or passing none) instead lists every live pin under the merge-ref prefix
 * and derives each pin's role id from its ref name, so a caller that does not know the team's
 * roles — the doctor, which must not read a config it already reports on — still sees every pin.
 * Each resolved pin is read with one `git log` call (its committer date and its message), and the
 * entry takes its `summary` from the commit's subject and its `run` from the commit's `Run:`
 * trailer. That one call also settles whether the pinned object is a commit the repository
 * holds: the rev is passed as `<sha>^{commit}`, which fails for a dangling ref exactly as
 * `git cat-file -e <sha>^{commit}` does, so no separate existence probe rides along.
 * Returns `{ entries, unreadable }` in the `readMergeQueue` shape. */
export async function readMergePins(
  root: string,
  roleIds?: readonly string[],
): Promise<{ entries: MergePinEntry[]; unreadable: number }> {
  const pins = await livePins(root, roleIds);
  const entries: MergePinEntry[] = [];
  let unreadable = 0;
  for (const { role, sha } of pins) {
    // A dangling pin — the ref names a commit the repository no longer holds — cannot build an
    // entry and cannot merge: count it `unreadable`, the pin analog of the queue's skipped file.
    // The pin's one `git log` read decides this (it peels to a commit and fails otherwise), so
    // the probe costs no extra spawn.
    const { date, message, readable } = await commitDateOrMessage(root, sha);
    if (!readable) {
      unreadable++;
      continue;
    }
    const subject = message === null ? undefined : commitSubject(message);
    const entry: MergePinEntry = {
      role,
      sha,
      run: message === null ? 0 : commitRunOf(message) ?? 0,
      summary: subject ?? `tumwater(${role})`,
      // Anchor the wait's age to the commit's committer date: a pin is set the instant its commit
      // lands, so the commit date is when this waiting work began, and a reader that aged the pin
      // by its own read time would always read it as just arrived (never stale). `pinnedMergeEntry`
      // stamps `Date.now()` for the merge engine, which does not age by it, so this is the honest
      // age. A date that cannot be read leaves the stamp, which the doctor ages from `now`.
      enqueuedAt: date ?? Date.now(),
    };
    entries.push(entry);
  }
  return { entries, unreadable };
}

/** The pinned commit's committer date (epoch ms, `git %ct` is unix seconds) and its full message
 * (`git %B`) in one `git log` call. `readable` is whether the rev resolves to a commit the
 * repository holds: `^{commit}` peels the pinned object and git exits nonzero when it is missing
 * or is not a commit, the same verdict `commitExists` gives with its `cat-file -e` probe — the
 * check this reader used to pay a second spawn for. `date` is null when the commit or its date
 * cannot be read; `message` is null when the commit has no readable message. */
async function commitDateOrMessage(
  root: string,
  sha: string,
): Promise<{ date: number | null; message: string | null; readable: boolean }> {
  const out = await gitTry(root, "log", "-1", `--format=%ct${SEP}%B`, `${sha}^{commit}`).catch(() => null);
  if (out === null) return { date: null, message: null, readable: false };
  const [dateStr = "", ...rest] = out.split(SEP);
  const message = rest.join(SEP).trim();
  const secs = Number(dateStr.trim());
  return {
    date: Number.isFinite(secs) ? secs * 1000 : null,
    message: message === "" ? null : message,
    readable: true,
  };
}

/** Each live pin's committer date (epoch ms) keyed by role id, in ONE `for-each-ref` read over
 * the merge-ref prefix — the same date readMergePins ages a waiting change by (a pin is set the
 * instant its commit lands). The merge drain orders its candidates by it, oldest first. A pin
 * whose date cannot be read is left out, and a failed read returns an empty map: callers treat a
 * missing role as the newest. */
export async function pinCommitDates(root: string): Promise<Map<string, number>> {
  const format = `--format=%(refname)${SEP}%(committerdate:unix)`;
  const out = await gitTry(root, "for-each-ref", format, MERGE_REF_PREFIX);
  const dates = new Map<string, number>();
  for (const line of gitLines(out)) {
    const [ref = "", secs = ""] = line.split(SEP);
    const n = Number(secs);
    if (ref.startsWith(MERGE_REF_PREFIX) && secs !== "" && Number.isFinite(n)) {
      dates.set(ref.slice(MERGE_REF_PREFIX.length), n * 1000);
    }
  }
  return dates;
}

/** A role's merge pin sha, or null when the role holds no pin or the ref could not be read. The
 * one home of the `refSha(root, mergeRefName(role))` read that the pin reader, the scheduler's
 * pin checks, the leftover recovery and the director's owed-run check all make, so they agree
 * on what a pin is and how an unreadable ref is treated. */
export async function mergePinSha(root: string, role: string): Promise<string | null> {
  return refSha(root, mergeRefName(role)).catch(() => null);
}

/** The live pins to build, as `{ role, sha }` pairs: the given roles' resolved refs, or every
 * ref under the merge prefix when no roles are named. A role whose ref is absent is left out
 * (it contributes nothing); `refSha` settles that absence from the ref files without a spawn. */
async function livePins(root: string, roleIds?: readonly string[]): Promise<Array<{ role: string; sha: string }>> {
  if (roleIds && roleIds.length > 0) {
    const pins: Array<{ role: string; sha: string }> = [];
    for (const role of roleIds) {
      const sha = await mergePinSha(root, role);
      if (sha !== null) pins.push({ role, sha });
    }
    return pins;
  }
  // No roles named: recover every live pin by listing the merge-ref prefix. A ref under the
  // prefix is a pin for the role id that is its suffix (instance ids like `feature-2` are
  // carried verbatim, so `mergeRefName` and this derivation always agree).
  const refs = await refsUnder(root, MERGE_REF_PREFIX).catch(() => []);
  return refs
    .filter((r) => r.ref.startsWith(MERGE_REF_PREFIX))
    .map((r) => ({ role: r.ref.slice(MERGE_REF_PREFIX.length), sha: r.sha }));
}
