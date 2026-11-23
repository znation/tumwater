import test from "node:test";
import assert from "node:assert/strict";
import { jsonSlipSuffix, stripJsonc } from "../src/files/json-syntax.js";

// src/files/json-syntax.ts is the one home of JSON-vs-JSONC syntax knowledge: the comment and
// trailing-comma conveniences a hand-edited config file carries. `jsonSlipSuffix` is what turns a
// bare `JSON.parse` SyntaxError into a sentence naming the spelling that broke, so these tests pin
// the two slips it names, the line/column it reports, and — the part a string-blind scanner gets
// wrong — the `//` and `,}` that sit INSIDE a string value and must never be named. `stripJsonc`
// is the same scanner on the other side (the operator's OpenCode .jsonc reader); its end-to-end
// behavior is pinned in test/opencode-config.test.ts, so only the strip's own contract is here.

/** The hint's whole contract: it is either empty or a leading-space em dash and one clause. */
function assertSlip(text: string, expected: string): void {
  assert.equal(jsonSlipSuffix(text), expected, JSON.stringify(text));
}

test("a line comment in otherwise valid JSON names the rule and the position", () => {
  // The shape an operator actually writes: a note above a key. The parser's own report gives a
  // position and no reason; the clause supplies the reason and repeats the same position.
  assertSlip('{\n  // enable qa\n  "model": "opus"\n}', " — strict JSON allows no comments: one starts at line 2 column 3");
});

test("a block comment is named as a comment too, at its opening", () => {
  // Column 19 is the `/` of `/*`: 16 characters of `{`, newline, two spaces and the quoted
  // key/value precede it, so the clause points at the opener, not the closer.
  assertSlip('{\n  "model": "opus" /* on */\n}', " — strict JSON allows no comments: one starts at line 2 column 19");
  // A block comment spanning lines reports where it opens, since that is what the operator deletes.
  assertSlip('{\n  /*\n   "a": 1,\n  */\n  "b": 2\n}', " — strict JSON allows no comments: one starts at line 2 column 3");
});

test("a trailing comma names the closer it precedes, not the comma", () => {
  // Naming the CLOSER is what makes the clause actionable at a glance on a long file, and it is
  // where a strict parser stops as well: `}` on its own line, line 3 column 1.
  assertSlip('{\n  "model": "opus",\n}', " — strict JSON allows no trailing comma before the closing } at line 3 column 1");
  assertSlip('{"model": "opus",}', " — strict JSON allows no trailing comma before the closing } at line 1 column 18");
  assertSlip('{"roles": ["feature", "bugfix",]}', " — strict JSON allows no trailing comma before the closing ] at line 1 column 32");
  // A nested container's closer, several levels in: the innermost one wins, because the comma
  // belongs to it.
  assertSlip('{\n  "roles": {\n    "qa": {},\n  }\n}', " — strict JSON allows no trailing comma before the closing } at line 4 column 3");
});

test("a trailing comma then a comment before the closer is still a trailing comma", () => {
  // The comma is the first slip in the text, so it is named — at the closer, past the comment.
  assertSlip('{\n  "a": 1,\n  // and that is all\n}', " — strict JSON allows no trailing comma before the closing } at line 4 column 1");
});

test("a slip inside a string value is never named", () => {
  // The whole reason the scan tracks strings: a notify command holding a URL, or a note holding
  // `,}`, is valid JSON, and naming it would send the operator to the wrong line. A file whose
  // only such text is present gets no clause at all.
  assertSlip('{"notify": "curl https://x.example/a//b", "note": "keep,} this"}', "");
  // An escaped quote does not end the string, so the `//` after it stays inside.
  assertSlip('{"note": "say \\"hi//there\\"", "model": "opus"}', "");
});

test("a file with neither slip keeps the parser's bare report", () => {
  // Every other syntax error must not gain a clause claiming a comment or comma it does not hold.
  assertSlip("{ not json", "");
  assertSlip('{ "a": 1 "b": 2 }', ""); // a missing comma between pairs, not a trailing one
  assertSlip('{ model: "opus" }', ""); // an unquoted key
  assertSlip("", "");
  assertSlip("{", "");
  assertSlip("[1, 2,]", " — strict JSON allows no trailing comma before the closing ] at line 1 column 7");
});

test("the named position counts lines and columns as the parser does", () => {
  // Hand-computed against the multi-line fixture: the comment opens on line 4 (three newlines
  // before it), column 3 (two spaces).
  const text = '{\n  "a": 1,\n  "b": [\n    // keep\n    2\n  ]\n}';
  assertSlip(text, " — strict JSON allows no comments: one starts at line 4 column 5");
  // The same text minus the comment parses, which is what makes the named position the only
  // defect in it.
  assert.deepEqual(JSON.parse(stripJsonc(text)), { a: 1, b: [2] });
}

);

test("stripJsonc removes both comment styles and trailing commas, keeping string content", () => {
  const src = '{\n  // one\n  "a": "https://x//y", /* two */ "b": [1, 2,],\n}';
  assert.deepEqual(JSON.parse(stripJsonc(src)), { a: "https://x//y", b: [1, 2] });
  // Valid JSON passes through unchanged: an empty slip scan must not reformat or drop bytes.
  const valid = '{"a": 1, "b": [2, 3]}';
  assert.equal(stripJsonc(valid), valid);
  // An unterminated block comment takes the rest of the text with it, leaving an object the
  // reader still fails to parse — the kept behavior of the scanner this module absorbed.
  assert.equal(stripJsonc('{"a": 1 /* unterminated'), '{"a": 1 ');
});
