/** List the paths an `apply_patch` text writes, from the patch text alone (plans/
 * codex-write-guard.md "The hook (parts 1–2)"; PLANS.md "Write guard on Codex, part 1/9").
 * Pure: no filesystem, no imports beyond node built-ins, so a later part can call it from the
 * hook without dragging in a registry or subprocess.
 *
 * Codex's PreToolUse payload carries the patch text, not a path, and a patch is applied even
 * when it is truncated or its `*** Begin Patch` / `*** End Patch` markers are missing — so this
 * scans every line, marker or not, and trusts only lines that begin at column 0 with a header.
 * A hunk line (`+`, `-`, a space, `@@`) never counts as a header even when its text reads like
 * one, because a hunk prefix shifts `*** ` off column 0. Paths are kept as written; the caller
 * resolves relative ones against the run's directory. */

/** Headers that name a path the patch writes, in the order a line may spell them. */
const HEADERS: readonly string[] = [
  "*** Add File: ",
  "*** Delete File: ",
  "*** Update File: ",
  "*** Move to: ",
];

/** The paths an `apply_patch` text writes, in first-appearance order, without duplicates. */
export function patchWritePaths(patch: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    for (const header of HEADERS) {
      if (line.startsWith(header)) {
        const path = line.slice(header.length).replace(/[\s\r]+$/, "");
        if (path !== "" && !seen.has(path)) {
          seen.add(path);
          paths.push(path);
        }
        break;
      }
    }
  }
  return paths;
}
