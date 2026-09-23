/** Parsing and shaping of git's textual output — the layer between the subprocess plumbing
 * in git.ts and its callers: porcelain-status path decoding, worktree change listing, and
 * ahead-of-main diff extraction (including its oversized-diff truncation). Everything here
 * interprets git output; spawning git stays in git.ts. */
import { gitTry } from "./git.js";

/** Decode a path from `git status --porcelain` output. Git C-quotes paths containing special
 * characters (control characters, quotes, non-ASCII under core.quotePath) and escapes them —
 * the decoded form is what callers pass back to git as a real path. Unquoted paths pass through.
 * Control characters git short-escapes (its `sq_lookup` table) all must be decoded: `\n`, `\t`,
 * `\r`, and the less common `\a` (BEL), `\b` (BS), `\f` (FF), `\v` (VT) — every other control
 * byte arrives as an octal escape.
 * Non-ASCII arrives one octal escape per UTF-8 byte, so the escapes are first collected into
 * a latin1 byte string and only then reassembled as UTF-8 (decoding each escape to a character
 * on its own yields mojibake — `héllo.md` would come back as `hÃ©llo.md`). Used by
 * conflictedFiles in merge.ts; changedFiles reads git's NUL-terminated `-z` format, which
 * emits paths verbatim (no quoting), so it has no encoded path to decode. */
export function unquotePorcelainPath(p: string): string {
  if (!p.startsWith('"')) return p;
  const end = p.lastIndexOf('"');
  if (end < 1) return p; // Malformed — keep as-is rather than drop the entry.
  let bytes = "";
  for (let i = 1; i < end; i++) {
    const c = p.charAt(i);
    if (c !== "\\") {
      bytes += c; // Raw characters in a quoted path are always safe ASCII.
      continue;
    }
    i++;
    const e = p.charAt(i);
    switch (e) {
      case "n":
        bytes += "\n";
        break;
      case "t":
        bytes += "\t";
        break;
      case "r":
        bytes += "\r";
        break;
      case "a":
        bytes += "\x07";
        break;
      case "b":
        bytes += "\x08";
        break;
      case "f":
        bytes += "\x0c";
        break;
      case "v":
        bytes += "\x0b";
        break;
      case "\\":
        bytes += "\\";
        break;
      case '"':
        bytes += '"';
        break;
      default:
        // Octal escape \NNN (the remaining control characters); anything else is kept literally.
        if (e >= "0" && e <= "7") {
          const chunk = p.slice(i, i + 3);
          if (/^[0-7]{3}$/.test(chunk)) {
            bytes += String.fromCharCode(parseInt(chunk, 8));
            i += 2;
          } else {
            bytes += e;
          }
        } else {
          bytes += e;
        }
    }
  }
  return Buffer.from(bytes, "latin1").toString("utf8");
}

/** Repo-relative paths of every change in the worktree — modified, untracked, and deleted,
 * parsed from `git status --porcelain -z` (paths only). The refusal path uses this to classify
 * what a refusing run left behind: markdown notes may land, everything else is discarded.
 *
 * The `-z` format is what git recommends for machine parsing: records are NUL-terminated and
 * paths are emitted verbatim, never C-quoted, so a path with whitespace, a quote, a control
 * byte, or non-ASCII survives byte-for-byte without the decode `unquotePorcelainPath` would
 * need. It also settles rename/copy entries, which the line format renders as
 * `XY <from> -> "<to>"`: a path containing ` -> ` made that ambiguous, and decoding the whole
 * `from -> to` field produced one path that exists nowhere (e.g. `old.txt -> new.txt`). With
 * `-z` a rename/copy is two records — `XY <to>\0<from>\0`, destination first — so this reads
 * the destination (the path that exists now) and skips the extra origin record. */
export async function changedFiles(wt: string): Promise<string[]> {
  const out = await gitTry(wt, "status", "--porcelain", "-z");
  if (!out) return [];
  const files: string[] = [];
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    // Porcelain v1 records are `XY <path>` — two status chars, a space, then the verbatim path.
    const record = records[i];
    if (record === undefined || record.length < 4) continue;
    const p = record.slice(3);
    if (p) files.push(p);
    // A rename/copy is followed by one extra record holding the origin path (no status
    // prefix); consume it so its raw text is never mistaken for a status line.
    if (record[0] === "R" || record[0] === "C") i++;
  }
  return files;
}

/** Repo-relative paths changed between the branch's fork point from main and its HEAD —
 * everything a merge of this branch would land (the three-dot range diffs against the
 * merge-base, so commits main gained during the tick are not included). */
export async function aheadOfMainFiles(wt: string, mainBranch: string): Promise<string[]> {
  const out = await gitTry(wt, "diff", "--name-only", `${mainBranch}...HEAD`);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Split a unified diff into one section per file, each starting at its own
 * `diff --git ` header line. Only real headers match: added lines start with "+" and context
 * lines with a space, so file content can never fake a boundary at column 0. Each section is
 * byte-identical to what `git diff <range> -- <file>` prints for that file — the per-file
 * spawn exists only for callers that need one file without fetching the rest. */
function splitDiffByFile(diff: string): string[] {
  const sections: string[] = [];
  let cur: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") && cur.length > 0) {
      sections.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length > 0) sections.push(cur.join("\n"));
  return sections;
}

/** The combined ahead-of-main diff — everything a merge of this branch would land. Capped:
 * over `maxBytes`, the result is a truncation note plus `--stat` and the largest files' full
 * diffs (an oversized diff is itself reviewable information, and the reviewer can read any
 * file in the worktree directly). The per-file sections are split out of the one full diff
 * already fetched — spawning a diff per file would re-diff the entire range once per file for
 * text we already hold in memory (measured ~0.5 s of redundant git work on a 530 KB / 39-file
 * tick). Section byte length ranks files at least as well as numstat's added+deleted: it is
 * exactly what the reviewer will see, and a binary file's short "Binary files differ" stub
 * naturally ranks below any real text change. */
export async function aheadOfMainDiff(
  wt: string,
  mainBranch: string,
  maxBytes = 200_000,
): Promise<string> {
  const range = `${mainBranch}...HEAD`;
  const full = (await gitTry(wt, "diff", range)) ?? "";
  if (full.length <= maxBytes) return full;
  // Over the cap: rank files by change size and include the largest while budget allows.
  const ranked = splitDiffByFile(full).sort((a, b) => b.length - a.length);
  let out =
    `[diff truncated: the full ahead-of-main diff is ${full.length} bytes; ` +
    `showing --stat plus the largest files]\n\n` + ((await gitTry(wt, "diff", "--stat", range)) ?? "") + "\n";
  for (const d of ranked) {
    // Account for the surrounding newlines in the budget check so the output never exceeds
    // maxBytes even when a section lands exactly on the boundary.
    if (out.length + d.length + 2 > maxBytes) break;
    out += `\n${d}\n`;
  }
  return out;
}
