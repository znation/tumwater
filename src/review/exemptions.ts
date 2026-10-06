/** Review-exemption path matching (the config's review.exemptPaths): decides whether a
 * diff is doc-only enough to skip the model reviewer. Split out of review.ts — which keeps
 * the adversarial review gate itself — because this is pure string/path logic with its own
 * data model (glob patterns whose `**` crosses segments, `*` stays within one segment, and
 * slash-free patterns match basenames at any depth) and a large dedicated test surface; the
 * gate consumes only isExemptDiff for its exempt-diff early return. */

/** Convert one exemption glob pattern to an anchored regex: `**` crosses path segments, `*`
 * stays within one segment, everything else is literal. A leading or embedded double-star
 * followed by a slash matches ZERO or more complete segments (standard glob semantics), so
 * such patterns also exempt files at the repository root, not only nested ones. */
function globToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          // `**/` — zero or more complete path segments (each ending in /).
          re += "(?:.*/)?";
          i += 2; // skip both * and the /
        } else {
          re += ".*";
          i++; // skip second *
        }
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|+?()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when the repo-relative path matches one exemption pattern. A pattern containing no
 * "/" matches the file's BASENAME at any depth (`*.md` exempts `docs/notes.md` too); a
 * pattern containing "/" matches the full repo-relative path, where `*` stays within one
 * segment and `**` crosses segments (`docs/**` = everything under docs/). */
export function isExemptPath(relPath: string, patterns: string[]): boolean {
  const norm = relPath.replace(/\\/g, "/");
  for (const p of patterns) {
    if (!p) continue;
    const target = p.includes("/") ? norm : (norm.split("/").pop() ?? norm);
    if (globToRegex(p).test(target)) return true;
  }
  return false;
}

/** True when EVERY changed file in the diff matches some exemption pattern — doc-only diffs
 * stay cheap by construction. An empty diff is vacuously exempt: there is nothing to review. */
export function isExemptDiff(files: string[], patterns: string[]): boolean {
  return files.every((f) => isExemptPath(f, patterns));
}
