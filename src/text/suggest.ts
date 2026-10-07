/** The shared did-you-mean layer: the closest candidate for a mistyped token (command
 * names, config keys, role ids) and the wording every unknown-X error attaches. Purely
 * presentational — depends on node built-ins alone — and home to the Levenshtein distance,
 * the suggestion threshold, and the " — did you mean `x`?" annotation in exactly one place
 * instead of drifting per consumer. (Generic string shaping — collapse, truncate, parse —
 * lives in text.ts.) */

/** Levenshtein edit distance between two short tokens (command names, config keys — a
 * handful of chars, so the two-row DP table is trivially cheap). */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(
        Math.min(
          prev[j]! + 1, // Deletion.
          row[j - 1]! + 1, // Insertion.
          prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1), // Substitution.
        ),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** The candidate closest to a mistyped `input` by case-insensitive edit distance, or null
 * when nothing is close enough to suggest: the "did you mean" behind typo'd command names
 * (help.ts) and config keys (config-write.ts, config-commands.ts). Capped at `maxDistance`
 * (two edits by default — a typo's distance, not a different word's), so only a near miss
 * gets a hint and the suggestion can never fire as an auto-correction; the caller still
 * prints the full valid list, so a suggestion only annotates it. */
export function suggestClosest(
  input: string,
  candidates: readonly string[],
  maxDistance = 2,
): string | null {
  const needle = input.toLowerCase();
  let best: { candidate: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (best === null || distance < best.distance) best = { candidate, distance };
  }
  return best !== null && best.distance <= maxDistance ? best.candidate : null;
}

/** The " — did you mean \`<suggestion>\`?" annotation for a suggestion suggestClosest (or a
 * caller's own suggestion) returned — the empty string when there is none. One home for the
 * wording so every unknown-role, unknown-command, unknown-config-key, and unknown-help-topic
 * message spells the hint the same way, and its tests can pin it once. */
export function didYouMean(suggestion: string | null): string {
  return suggestion ? ` — did you mean \`${suggestion}\`?` : "";
}

/** suggestClosest and didYouMean composed: the " — did you mean `x`?" suffix for a mistyped
 * `input` against `candidates`, the empty string when nothing is close enough to suggest. The
 * four unknown-X error sites (roles.ts's unknownRoleMessage, config-write.ts's
 * unknownConfigKeyError and its role-field error, gui/gui-args.ts's rejectBadRole) render the hint
 * through this one composition so the two-step pairing cannot drift; callers still print the
 * full valid list themselves — a suggestion only annotates it. (cli.ts's unknown-command and
 * no-help-topic errors stay on the bare halves: their suggestion arrives from help.ts's
 * suggestCommand, which derives the candidate list from the help text.) */
export function typoSuffix(input: string, candidates: readonly string[]): string {
  return didYouMean(suggestClosest(input, candidates));
}
