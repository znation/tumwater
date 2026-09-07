import test from "node:test";
import assert from "node:assert/strict";
import { isExemptDiff, isExemptPath } from "../src/exemptions.js";

// Pins the exemption glob semantics (moved here with the logic when it split out of
// review.ts into src/exemptions.ts): pattern shape decides what a diff exempts from the
// model reviewer, so every case below guards the gate's exempt-diff early return.

test("isExemptPath matches a slash-free pattern against the basename at any depth", () => {
  assert.ok(isExemptPath("README.md", ["*.md"]));
  assert.ok(isExemptPath("docs/plans/deep/notes.md", ["*.md"]));
  assert.ok(!isExemptPath("src/foo.ts", ["*.md"]));
});

test("isExemptPath matches a slash-bearing pattern against the full path, * within one segment and ** across segments", () => {
  assert.ok(isExemptPath("docs/a.md", ["docs/*.md"]));
  assert.ok(!isExemptPath("docs/sub/a.md", ["docs/*.md"])); // * does not cross /
  assert.ok(isExemptPath("docs/sub/deep/a.md", ["docs/**"])); // ** crosses segments
  assert.ok(!isExemptPath("other/a.md", ["docs/**"]));
});

test("isExemptPath: **/ matches zero or more segments (root-level files included)", () => {
  // Leading **/ — root-level and nested both match.
  assert.ok(isExemptPath("notes.md", ["**/*.md"])); // zero directories
  assert.ok(isExemptPath("docs/notes.md", ["**/*.md"])); // one directory
  assert.ok(isExemptPath("a/b/c/notes.md", ["**/*.md"])); // many directories
  assert.ok(!isExemptPath("src/foo.ts", ["**/*.md"])); // wrong extension
  // Embedded **/ — zero intermediate segments matches.
  assert.ok(isExemptPath("docs/archive.md", ["docs/**/archive.md"]));
  assert.ok(isExemptPath("docs/sub/archive.md", ["docs/**/archive.md"]));
  assert.ok(!isExemptPath("other/archive.md", ["docs/**/archive.md"])); // wrong prefix
});

test("isExemptPath ignores empty patterns and never matches with none left", () => {
  assert.ok(!isExemptPath("anything.ts", []));
  assert.ok(!isExemptPath("anything.ts", ["", "   "])); // "" is skipped; "   " is a literal that matches nothing here
});

test("isExemptPath treats regex metacharacters in patterns as literal text", () => {
  // globToRegex escapes every regex metacharacter except * — the exemption decision must
  // depend on the pattern's literal shape, never its regex interpretation. The stakes are
  // the review gate: an unescaped [ ] pair becomes a character class (docs/[drafts].md would
  // exempt docs/d.md, docs/r.md, …), an unbalanced one or a bare ( ) throws from new RegExp
  // and crashes every tick's gate, and | + ? $ reinterpret the pattern into something that
  // matches files its author never meant to exempt. Only "." has been exercised so far,
  // via the default *.md — pin the rest of the escape set here.

  // Brackets: literal, not a character class (and an unbalanced one must not throw).
  assert.ok(isExemptPath("docs/[drafts].md", ["docs/[drafts].md"]));
  for (const c of "drafts") {
    assert.ok(!isExemptPath(`docs/${c}.md`, ["docs/[drafts].md"]), `no char-class leak to docs/${c}.md`);
  }
  assert.ok(isExemptPath("docs/[(.md", ["docs/[(.md"])); // unbalanced: literal, no invalid-regex throw
  assert.ok(!isExemptPath("docs/x.md", ["docs/[(.md"]));

  // Parens: literal (unescaped "(+)" is an invalid quantifier — new RegExp would throw).
  assert.ok(isExemptPath("src/legacy(+v2).ts", ["src/legacy(+v2).ts"]));
  assert.ok(!isExemptPath("src/legacy.ts", ["src/legacy(+v2).ts"]));

  // Quantifiers: + and ? are literal characters, not "one or more" / "optional".
  assert.ok(isExemptPath("a+b.md", ["a+b.md"]));
  assert.ok(!isExemptPath("aaab.md", ["a+b.md"]));
  assert.ok(isExemptPath("x?y.md", ["x?y.md"]));
  assert.ok(!isExemptPath("xy.md", ["x?y.md"]));

  // Anchors: ^ and $ are literal characters, not start/end assertions.
  assert.ok(isExemptPath("^foo.md", ["^foo.md"])); // slash-free pattern matches the literal basename
  assert.ok(!isExemptPath("foo.md", ["^foo.md"]));
  assert.ok(isExemptPath("a$b.md", ["a$b.md"]));
  assert.ok(!isExemptPath("ab.md", ["a$b.md"])); // unescaped $ would anchor mid-pattern and match nothing

  // Pipe: literal, not alternation (unescaped "a|b.md" matches anything starting with "a").
  assert.ok(isExemptPath("a|b.md", ["a|b.md"]));
  assert.ok(!isExemptPath("anything-else-a.md", ["a|b.md"]));
  assert.ok(!isExemptPath("zzz-b.md", ["a|b.md"]));
});

test("isExemptDiff requires EVERY file to be exempt and treats an empty diff as vacuously exempt", () => {
  assert.ok(isExemptDiff([], ["*.md"]));
  assert.ok(isExemptDiff(["a.md", "docs/b.md"], ["*.md"]));
  assert.ok(!isExemptDiff(["a.md", "src/b.ts"], ["*.md"])); // one non-exempt file defeats it
});
