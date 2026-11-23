/** The one home of JSON-vs-JSONC SYNTAX knowledge: the two conveniences a hand-edited config
 * file commonly carries that strict JSON refuses — line and block comments, and a trailing comma
 * before a closing brace or bracket. `stripJsonc` removes them so a JSONC reader (the operator's
 * OpenCode config) parses; `jsonSlipSuffix` spots which one a strict-JSON reader choked on, so a
 * broken `tumwater.json` says what the operator wrote, not just that it broke.
 *
 * Both walks track double-quoted strings (escapes included), so a `//` in a URL or a `,}` in a
 * note never counts — a reader that ignored strings would eat the rest of that line and answer
 * with a wrong file. The primitives (comment start, whitespace, the three skips) are private here
 * so both walks decide "is this a comment?" the same way. */

/** True at `i` when a `//` line comment or a `/*`-style block comment starts there. */
function isCommentStart(src: string, i: number): boolean {
  return src[i] === "/" && (src[i + 1] === "/" || src[i + 1] === "*");
}

/** True when `c` is a JSONC whitespace character. */
function isWhitespace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

/** Advance `j` past a `//` line comment (a caller-supplied position where `src[j] === "/"`
 * and `src[j + 1] === "/"`), not past the terminating newline. */
function skipLineComment(src: string, j: number): number {
  while (j < src.length && src[j] !== "\n") j += 1;
  return j;
}

/** Advance `j` past a `/*`-style block comment (a caller-supplied position where `src[j] ===
 * "/"` and `src[j + 1] === "*"`), ending after its closing two characters. An unterminated
 * comment leaves `j` at `src.length + 2`, overshooting past the end — today's behaviour, kept. */
function skipBlockComment(src: string, j: number): number {
  j += 2;
  while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j += 1;
  j += 2;
  return j;
}

/** Advance `j` past one comment, dispatching on the second character: `//` to the line-comment
 * scan, `/*` to the block-comment scan (a caller-supplied position where `isCommentStart`
 * holds). */
function skipComment(src: string, j: number): number {
  return src[j + 1] === "/" ? skipLineComment(src, j) : skipBlockComment(src, j);
}

/** Advance `j` past any whitespace and comments, for a position that is never inside a string.
 * Returns the index of the next significant (non-comment, non-whitespace) character, or
 * `src.length` when the input ends in comments/whitespace. */
function skipWhitespaceAndComments(src: string, j: number): number {
  while (j < src.length) {
    if (isWhitespace(src[j])) {
      j += 1;
    } else if (isCommentStart(src, j)) {
      j = skipComment(src, j);
    } else {
      break;
    }
  }
  return j;
}

/** Strip comments and trailing commas from a JSONC string so a strict JSON parse succeeds.
 * Walks the string so a `//` or a block-comment opener, and `,}` / `,]`, inside a normal
 * double-quoted string value survive (escape sequences included); comments and trailing
 * commas are removed only outside strings, where they are legal JSONC but not JSON. A
 * trailing comma is dropped when the next significant character — past any whitespace AND
 * any comment — is a closing brace or bracket, so a comma then a comment then `}` strips
 * correctly. */
export function stripJsonc(src: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (c === "\\" && next !== undefined) {
        out += next;
        i += 2;
      } else {
        if (c === '"') inString = false;
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (isCommentStart(src, i)) {
      i = skipWhitespaceAndComments(src, i);
      continue;
    }
    if (c === ",") {
      // A trailing comma may be followed by whitespace and comments before the closing
      // brace/bracket (`,\n  // c\n }`); look past all of it to decide, without touching a
      // comma inside a string value.
      const j = skipWhitespaceAndComments(src, i + 1);
      if (src[j] === "}" || src[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The first strict-JSON slip a JSONC-flavoured text holds, as its kind, the position to name,
 * and (for a trailing comma) the closer it precedes; `null` when the text holds neither, which
 * is the common case for any other syntax error. Scans the whole text, so a file whose real
 * error is elsewhere still gets a TRUE statement about what it also contains — the hint never
 * claims to be the parser's reason. */
function findJsonSlip(src: string): { kind: "comment" | "comma"; index: number; closer?: string } | null {
  let inString = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      if (c === "\\") i += 2;
      else {
        if (c === '"') inString = false;
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (isCommentStart(src, i)) return { kind: "comment", index: i };
    if (c === ",") {
      const j = skipWhitespaceAndComments(src, i + 1);
      if (src[j] === "}" || src[j] === "]") {
        // The closer's position is named, because that is where a strict parser stops too —
        // the two halves of the message then agree on line and column.
        return { kind: "comma", index: j, closer: src[j] };
      }
    }
    i += 1;
  }
  return null;
}

/** The 1-based line and column of `index` in `src`, counted the way the parser's own
 * "(line N column M)" report counts them. */
function lineColumn(src: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index; i += 1) {
    if (src[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

/** The suffix a strict-JSON parse failure carries when the text holds a JSONC slip: ` — strict
 * JSON allows no comments: one starts at line 2 column 3`, or the same shape naming a trailing
 * comma and the closer it precedes. Empty when the text holds neither slip, so every other syntax
 * error keeps the parser's bare report. The clause states the rule, so the fix reads off it — and
 * the caller's message already names the file at its head, so this half stays file-free. */
export function jsonSlipSuffix(text: string): string {
  const slip = findJsonSlip(text);
  if (slip === null) return "";
  const { line, column } = lineColumn(text, slip.index);
  if (slip.kind === "comment") return ` — strict JSON allows no comments: one starts at line ${line} column ${column}`;
  return ` — strict JSON allows no trailing comma before the closing ${slip.closer} at line ${line} column ${column}`;
}
