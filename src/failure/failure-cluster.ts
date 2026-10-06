/** The cluster-key rules shared by everything that groups failure messages into causes: the
 * failure digest's collection (failure-data.ts) and the error-storm reducer (error-storm.ts)
 * both count by these keys, so the normalization, the two tick-timeout shapes and their
 * pooling, and the grouping engine live here rather than inside either consumer. Pure string
 * and grouping logic — no event reads, no clock. */
import { rankByCount } from "./rank.js";

/** The verbatim example's trim bound, shared by the normalized key and each cluster's example.
 * The digest's other caps (top-N counts, summary width) live beside their consumers in
 * failure-data.ts. */
export const EXAMPLE_MAX = 120;

/** Render a message as a display example of at most `max` chars, marking any cut. A bare
 * slice leaves the reader unable to tell a complete message from a truncated one — and an
 * example's tail is often the repro (the failing assertion's file, the recovery action, a
 * rejection's distinguishing clause), so a cut example always carries `… (+N chars)` naming
 * what was dropped (BUGS.md 2026-09-30). The body is cut at the last whitespace inside the
 * budget when one exists, so the cut never lands mid-word where a boundary is available.
 * The final string may exceed `max` by the marker's width; the cap governs the body. Cluster
 * keys keep their bare slice (normalizeClusterKey) because grouping wants byte-stable
 * prefixes, not marked display text. */
export function truncateExample(message: string, max: number = EXAMPLE_MAX): string {
  const trimmed = message.trim();
  if (trimmed.length <= max) return trimmed;
  const head = trimmed.slice(0, max);
  const boundary = head.lastIndexOf(" ");
  const kept = boundary > 0 ? head.slice(0, boundary) : head;
  return `${kept.trimEnd()} … (+${trimmed.length - kept.length} chars)`;
}

/** A cause's member roles as the payload field every cluster-shaped surface emits: a fresh
 * array in ascending localeCompare order, so equal inputs always render identically no matter
 * the Set's insertion order. One home for the rule the failure digest's clusters
 * (clusterMessages) and loss causes (failure-data.ts) and the error-storm warning
 * (error-storm.ts) all share — an inline `.sort()` without the comparator would silently pick
 * code-unit order instead and let the two rules drift. */
export function sortedRoles(roles: Iterable<string>): string[] {
  return [...roles].sort((a, b) => a.localeCompare(b));
}

/** A normalized cluster of like error/warning/rejection strings. */
export interface Cluster {
  key: string; // the normalized form, the grouping key
  count: number;
  roles: string[]; // unique, sorted
  firstSeen: number; // epoch ms
  lastSeen: number;
  example: string; // the newest verbatim occurrence (at lastSeen), trimmed for display
}

/** A cluster key is the message with the volatile parts replaced, rules applied in this order:
 *
 * - hex git SHAs (7–40 chars) → `<sha>`
 * - slash-delimited paths → `<path>`
 * - timestamps (`YYYY-MM-DD`, optionally with time and zone) → `<ts>`
 * - durations (`12ms`, `3s`, `5m`) → `<dur>`
 * - every remaining bare integer → `<n>`; this last rule carries a negative lookbehind so the
 *   exit status after `exited ` survives — `pi exited 1` and `pi exited null` must stay
 *   distinct; the code is semantic.
 *
 * The result is trimmed to 120 chars. Deliberately conservative: over-clustering hides a real
 * second failure mode, while under-clustering merely costs a row. Exported for its own unit
 * tests. */
export function normalizeClusterKey(message: string): string {
  const normalized = message
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\/(?:[\w.@+-]+\/)+[\w.@+-]+/g, "<path>")
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, "<ts>")
    .replace(/\d+(?:\.\d+)?(?:ms|s|m)\b/g, "<dur>")
    .replace(/(?<!exited\s)\b\d+\b/g, "<n>");
  return normalized.trim().slice(0, EXAMPLE_MAX);
}

/** normalizeClusterKey's rendering of the two tick-timeout errors src/pi/pi.ts emits — the plain
 * kill and the still-making-progress variant (session and worktree edits preserved for
 * resume, BUGS.md 2026-09-29). Both are one cause pointing at one knob (tickTimeoutSeconds),
 * so every consumer that counts by cluster key pools them under the plain one. */
export const TICK_TIMEOUT_KEY = "timed out after <dur>";
const TICK_TIMEOUT_PROGRESSING_KEY =
  "timed out after <dur> while still making progress — session and worktree edits preserved for resume";
// The review run's rewording of the same cause (BUGS.md 2026-09-30): the reviewer never
// resumes, so its timeout names what actually happens — the commit is kept, the next
// attempt re-reviews from scratch. Same cause, same knob (review.timeoutSeconds), one row.
const TICK_TIMEOUT_PROGRESSING_REVIEW_KEY =
  "timed out after <dur> while still making progress — the commit is kept; the next attempt reviews it from scratch";

/** The cluster key a normalized error clusters under: the two tick-timeout shapes pool into
 * the plain one (a mixed fleet of plain and progressing kills is one cause's agent-hours on
 * one knob, not two half-size rows the top-N cut can drop — the same pooling the error-storm
 * reducer applies, src/failure/error-storm.ts), and every other cause stands as normalizeClusterKey
 * rendered it. */
export function poolTimeoutKey(key: string): string {
  return key === TICK_TIMEOUT_PROGRESSING_KEY || key === TICK_TIMEOUT_PROGRESSING_REVIEW_KEY
    ? TICK_TIMEOUT_KEY
    : key;
}

/** A live cluster while collecting; `roles` is a set until the final sort. */
interface ClusterDraft {
  key: string;
  count: number;
  roles: Set<string>;
  firstSeen: number;
  lastSeen: number;
  example: string;
}

/** Group messages by their normalized key, newest/oldest tracked per cluster. The example
 * rides lastSeen: a cluster that outlived a config change labels itself with the message as
 * it happens now, not the retired value it first emitted (BUGS.md 2026-09-30). `keyPrefix`
 * scopes a cluster to something the message itself omits (rejections key on role too) without
 * polluting the verbatim example. Returns the top-N clusters plus how many fell past the cut,
 * so the render can mark the truncation instead of presenting the survivors as the whole. */
export function clusterMessages(
  messages: Array<{ message: string; role: string; ts: number; keyPrefix?: string }>,
  top: number,
): { clusters: Cluster[]; hiddenClusters: number } {
  const drafts = new Map<string, ClusterDraft>();
  for (const { message, role, ts, keyPrefix } of messages) {
    const key = `${keyPrefix ?? ""}${poolTimeoutKey(normalizeClusterKey(message))}`;
    const draft = drafts.get(key);
    if (draft) {
      draft.count++;
      draft.roles.add(role);
      if (ts < draft.firstSeen) draft.firstSeen = ts;
      if (ts >= draft.lastSeen) {
        draft.lastSeen = ts;
        draft.example = truncateExample(message);
      }
    } else {
      drafts.set(key, {
        key,
        count: 1,
        roles: new Set([role]),
        firstSeen: ts,
        lastSeen: ts,
        example: truncateExample(message),
      });
    }
  }
  const sorted = rankByCount(drafts.values(), (d) => d.count, (d) => d.key);
  return {
    clusters: sorted.slice(0, top).map((d) => ({
      key: d.key,
      count: d.count,
      roles: sortedRoles(d.roles),
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      example: d.example,
    })),
    hiddenClusters: Math.max(0, sorted.length - top),
  };
}
