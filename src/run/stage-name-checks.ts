/** The identifier-reference findings of the dormant staging self-check: the JS/TS identifiers a
 * change removes or moves out of a file that a comment or doc still names. Split from
 * stage-path-checks.ts, the module that gathers the whole git-level finding family under
 * `gitLevelFindings`; this module holds the two name checks (`staleNameFindings`,
 * `movedNameFindings`) and their source-declaration helpers (`declaredNames`, `isCompoundName`,
 * `insideStringLiteral`), sharing the staged diff/index reading helpers and `isRecordProse`
 * with the path and prose sibling check modules. Both checks skip record prose. The gate does
 * not run any of them. */

import path from "node:path";
import { gitTry } from "../git/git-run.js";
import {
  JS_FILE,
  MAX_STALE_HITS,
  MAX_STALE_PATHS,
  cappedList,
  gitGrepHits,
  isRecordProse,
  standalonePathIndexes,
} from "./stage-checks-shared.js";

/** How many removed identifiers one stale-name check looks up. */
const MAX_STALE_NAMES = 40;
/** The most characters between a moved name and its old file's name for a line to count as
 * placing it there. */
const MOVED_NAME_GAP_MAX = 40;

/** The identifiers a source line declares: keyword declarations (`function`, `const`, `let`,
 * `var`, `class`, `interface`, `type`, `enum`) and a property or field signature at the start of
 * the line. A call line declares nothing. */
export function declaredNames(line: string): string[] {
  const names: string[] = [];
  const keyword = /\b(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of line.matchAll(keyword)) names.push(m[1]!);
  const field = /^\s*(?:(?:readonly|public|private|protected|static)\s+)*([A-Za-z_$][\w$]*)\??\s*:/.exec(line);
  if (field) names.push(field[1]!);
  return names;
}

/** True for a name worth looking up: camelCase/PascalCase (a lowercase letter then an uppercase
 * one) or UPPER_SNAKE with an underscore, so common words never count. */
function isCompoundName(name: string): boolean {
  return /[a-z][A-Z]/.test(name) || /^[A-Z0-9_]+$/.test(name) && name.includes("_");
}

/** True when the occurrence starting at `index` sits inside a closed `"…"` or `'…'` literal on
 * `line`. An unclosed quote (an apostrophe in prose) does not count. */
function insideStringLiteral(line: string, index: number): boolean {
  let open: string | null = null;
  let openAt = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (open === null) {
      if (c === '"' || c === "'") {
        open = c;
        openAt = i;
      }
    } else if (c === "\\") {
      i++;
    } else if (c === open) {
      if (openAt < index && index < i) return true;
      open = null;
    }
  }
  return false;
}

/** (d) Compound identifiers the change removed from JS/TS source that a comment or doc still
 * names. Candidates come from removed `-U0` lines; one `git grep -w --cached` covers them all. */
export async function staleNameFindings(wt: string, diff: string): Promise<string[]> {
  const removed: string[] = [];
  const added = new Set<string>();
  let jsFile = false;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (header) {
      jsFile = JS_FILE.test(header[1]!);
      continue;
    }
    if (!jsFile) continue;
    if (line.startsWith("-") && !line.startsWith("---")) {
      removed.push(...declaredNames(line.slice(1)));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      for (const n of declaredNames(line.slice(1))) added.add(n);
    }
  }
  const candidates = [...new Set(removed)]
    .filter((n) => isCompoundName(n) && !added.has(n))
    .slice(0, MAX_STALE_NAMES);
  if (candidates.length === 0) return [];
  const out = await gitTry(wt, "grep", "-n", "-w", "-I", "--cached", ...candidates.flatMap((n) => ["-e", n]));
  if (!out) return [];
  const lines = gitGrepHits(out);
  const findings: string[] = [];
  for (const name of candidates) {
    if (findings.length >= MAX_STALE_PATHS) break;
    const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
    const mine = lines.filter((l) => [...l.text.matchAll(word)].length > 0);
    // Another module may still own the name.
    if (mine.some((l) => JS_FILE.test(l.file) && declaredNames(l.text).includes(name))) continue;
    const hits: string[] = [];
    for (const l of mine) {
      if (isRecordProse(l.file) || l.text.includes("retired-name-ok")) continue;
      if ([...l.text.matchAll(word)].some((m) => !insideStringLiteral(l.text, m.index))) {
        hits.push(`${l.file}:${l.no}`);
      }
    }
    if (hits.length === 0) continue;
    findings.push(
      `\`${name}\` was removed by this change but is still named at: ${cappedList(hits, MAX_STALE_HITS)}`,
    );
  }
  return findings;
}

/** (g) A compound name the change moved out of one JS/TS file into another that a comment or doc
 * still places in the old file: the line has the name within MOVED_NAME_GAP_MAX characters of the
 * old file's name (full path or basename), with no `,` or `;` between them. An old file that
 * still names the moved name (a re-export or import) and record prose are skipped. */
export async function movedNameFindings(wt: string, diff: string): Promise<string[]> {
  const { removedIn, addedIn } = declaredNameDeltas(diff);
  const picked = movedNames(removedIn, addedIn);
  if (picked.length === 0) return [];
  const out = await gitTry(wt, "grep", "-n", "-w", "-I", "--cached", ...picked.flatMap((m) => ["-e", m.name]));
  if (!out) return [];
  const lines = gitGrepHits(out);
  const findings: string[] = [];
  for (const move of picked) {
    if (findings.length >= MAX_STALE_PATHS) break;
    const hits = movedNameHits(move, lines);
    if (hits.length === 0) continue;
    findings.push(
      `\`${move.name}\` moved from ${move.from} to ${cappedList(move.to, MAX_STALE_PATHS)}, but ${hits.join(", ")} ` +
        `still place it in ${path.basename(move.from)} — point each at its new file`,
    );
  }
  return findings;
}

/** A compound name the change moved out of one JS/TS file into another. */
interface MovedName { name: string; from: string; to: string[] }

/** One `git grep` hit line: file path, line number and text. */
interface GrepHit { file: string; no: string; text: string }

/** Record that `file` declares `name` into the per-name file set of `map`. */
function noteDeclaredName(map: Map<string, Set<string>>, name: string, f: string): void {
  const set = map.get(name) ?? new Set<string>();
  set.add(f);
  map.set(name, set);
}

/** Split a `-U0` diff into the compound names each JS/TS file removed and added. */
function declaredNameDeltas(diff: string): { removedIn: Map<string, Set<string>>; addedIn: Map<string, Set<string>> } {
  const removedIn = new Map<string, Set<string>>();
  const addedIn = new Map<string, Set<string>>();
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (header) {
      file = JS_FILE.test(header[1]!) ? header[1]! : null;
      continue;
    }
    // The `---`/`+++` old/new path lines carry no declaration, and no keyword or leading-field
    // match begins with `-` or `+`, so no guard against them is needed here.
    if (file === null) continue;
    if (line.startsWith("-")) {
      for (const n of declaredNames(line.slice(1)).filter(isCompoundName)) {
        noteDeclaredName(removedIn, n, file);
      }
    } else if (line.startsWith("+")) {
      for (const n of declaredNames(line.slice(1)).filter(isCompoundName)) {
        noteDeclaredName(addedIn, n, file);
      }
    }
  }
  return { removedIn, addedIn };
}

/** The names removed from one JS/TS file that the change moved into another, capped. */
function movedNames(removedIn: Map<string, Set<string>>, addedIn: Map<string, Set<string>>): MovedName[] {
  const moves: MovedName[] = [];
  for (const [name, froms] of removedIn) {
    const added = addedIn.get(name);
    if (!added) continue;
    for (const from of froms) {
      if (added.has(from)) continue;
      moves.push({ name, from, to: [...added] });
      break;
    }
  }
  return moves.slice(0, MAX_STALE_NAMES);
}

/** True when `text` sits near a standalone occurrence of the old file's basename `base`. */
function placesMovedNameInOldFile(text: string, word: RegExp, name: string, base: string): boolean {
  const names = [...text.matchAll(word)].map((m) => m.index);
  const bases = standalonePathIndexes(text, base);
  return names.some((i) =>
    bases.some((j) => {
      const gap = j >= i + name.length ? text.slice(i + name.length, j) : text.slice(j + base.length, i);
      const overlaps = j < i + name.length && i < j + base.length;
      return !overlaps && gap.length <= MOVED_NAME_GAP_MAX && !/[,;]/.test(gap);
    }),
  );
}

/** The staged-index hits that still place `move.name` in its old file, capped. */
function movedNameHits(move: MovedName, lines: GrepHit[]): string[] {
  const word = new RegExp(`(?<![\\w$])${move.name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
  const mine = lines.filter((l) => l.text.search(word) !== -1);
  if (mine.some((l) => l.file === move.from)) return [];
  const base = path.basename(move.from);
  const hits: string[] = [];
  for (const l of mine) {
    if (isRecordProse(l.file)) continue;
    const text = l.text.split(move.from).join(base);
    if (!placesMovedNameInOldFile(text, word, move.name, base)) continue;
    hits.push(`${l.file}:${l.no}`);
    if (hits.length >= MAX_STALE_HITS) break;
  }
  return hits;
}
