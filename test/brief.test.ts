import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  BRIEF_TEXT_MAX_CHARS,
  PROMPT_END,
  PROMPT_START,
  STATUS_END,
  STATUS_START,
  briefBlockMissing,
  briefFile,
  briefTemplate,
  readmeTemplate,
  replaceBriefText,
  readBriefText,
} from "../src/brief/brief.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

function writeReadme(root: string, text: string): void {
  fs.writeFileSync(path.join(root, "README.md"), text);
}

function writeBrief(root: string, text: string): void {
  fs.writeFileSync(path.join(root, "TUMWATER.md"), text);
}

test("readmeTemplate wraps the trimmed prompt in managed markers and seeds an empty status", () => {
  const t = readmeTemplate("myproj", "  Build a thing.\n\nMore detail.\n");
  assert.ok(t.startsWith("# myproj\n"));
  assert.ok(t.includes("## Brief"), "has an brief text heading");
  assert.ok(t.includes("## Status"), "has a status heading");
  const start = t.indexOf(PROMPT_START);
  const end = t.indexOf(PROMPT_END, start + PROMPT_START.length);
  assert.ok(start >= 0 && end > start, "prompt markers present in order");
  assert.equal(t.slice(start + PROMPT_START.length, end).trim(), "Build a thing.\n\nMore detail.");
});

test("readBriefText round-trips the prompt from a fresh template", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "README.md"), readmeTemplate("myproj", "Build a thing."));
  assert.equal(readBriefText(root), "Build a thing.");
});

test("briefTemplate wraps the trimmed prompt in the same two managed sections as the README template", () => {
  const t = briefTemplate("myproj", "  Build a thing.\n");
  assert.ok(t.startsWith("# myproj"));
  assert.ok(t.includes("## Brief"), "has an brief text heading");
  assert.ok(t.includes("## Status"), "has a status heading");
  const start = t.indexOf(PROMPT_START);
  const end = t.indexOf(PROMPT_END, start + PROMPT_START.length);
  assert.ok(start >= 0 && end > start, "prompt markers present in order");
  assert.equal(t.slice(start + PROMPT_START.length, end).trim(), "Build a thing.");
  const statusStart = t.indexOf(STATUS_START);
  const statusEnd = t.indexOf(STATUS_END, statusStart + STATUS_START.length);
  assert.ok(statusStart >= 0 && statusEnd > statusStart, "status markers present in order");
  // Round-trips through the reader: the brief template is the resolved home, not a second format.
  const root = tmpdir();
  writeBrief(root, t);
  assert.equal(readBriefText(root), "Build a thing.");
});

// Resolution order (plans/portability.md §7a/7): TUMWATER.md first, README.md as the
// compatibility path.

test("readBriefText prefers a marked TUMWATER.md over a marked README.md", () => {
  const root = tmpdir();
  writeReadme(root, `# p\n\n${PROMPT_START}\nFrom README.\n${PROMPT_END}\n`);
  writeBrief(root, `# p\n\n${PROMPT_START}\nFrom TUMWATER.\n${PROMPT_END}\n`);
  assert.equal(readBriefText(root), "From TUMWATER.");
  assert.equal(briefFile(root), "TUMWATER.md");
});

test("readBriefText falls back to README.md when TUMWATER.md is absent or unmarked", () => {
  const root = tmpdir();
  writeReadme(root, `# p\n\n${PROMPT_START}\nFrom README.\n${PROMPT_END}\n`);
  assert.equal(readBriefText(root), "From README.");
  assert.equal(briefFile(root), "README.md");

  // A TUMWATER.md without markers does not own the brief: README.md keeps ownership.
  writeBrief(root, "# p — no managed sections\n");
  assert.equal(readBriefText(root), "From README.");
  assert.equal(briefFile(root), "README.md");
});

test("readBriefText reads a TUMWATER.md-only repo", () => {
  const root = tmpdir();
  writeBrief(root, `# p\n\n${PROMPT_START}\nFrom TUMWATER.\n${PROMPT_END}\n`);
  assert.equal(readBriefText(root), "From TUMWATER.");
  assert.equal(briefFile(root), "TUMWATER.md");
});

test("briefFile is null when neither candidate owns the brief", () => {
  const root = tmpdir();
  assert.equal(briefFile(root), null, "no files at all");
  writeReadme(root, "# p\n");
  writeBrief(root, "# p\n");
  assert.equal(briefFile(root), null, "both files, no markers");
  assert.equal(readBriefText(root), "");
});

test("readBriefText returns empty string when README.md is missing", () => {
  const root = tmpdir();
  assert.equal(readBriefText(root), "");
});

test("readBriefText returns empty string when the opening marker is absent", () => {
  const root = tmpdir();
  writeReadme(root, "# myproj\n\nNo managed sections here.\n");
  assert.equal(readBriefText(root), "");
});

// The README is edited live (readme role, users) and read on every run: a torn or
// hand-edited file that keeps only one marker must degrade to no prompt, not leak the
// rest of the file into every run's prompt.

test("readBriefText returns empty string when only the closing marker exists", () => {
  const root = tmpdir();
  // Padding before the end marker keeps this observable — a dropped start-marker guard
  // would slice out the body text instead of returning empty.
  writeReadme(root, `# myproj\n\n${"LEAKED ".repeat(5)}${PROMPT_END}\n`);
  assert.equal(readBriefText(root), "");
});

test("readBriefText returns empty string when the opening marker has no closing one after it", () => {
  const root = tmpdir();
  writeReadme(root, `# myproj\n\n${PROMPT_START}\nBuild a thing.\n`);
  assert.equal(readBriefText(root), "");
});

// An end marker mentioned in prose BEFORE the managed block (e.g. README docs explaining how
// to edit the prompt) must not shadow the real section: pre-fix, indexOf(PROMPT_END) found the
// prose mention first, `end < start` bailed out, and every role ran without its project prompt.
test("an end marker in prose before the real block does not hide the prompt", () => {
  const root = tmpdir();
  writeReadme(
    root,
    `# myproj\n\nDocs: the section ends at ${PROMPT_END} — edit above it.\n\n` +
      `${PROMPT_START}\nThe real prompt.\n${PROMPT_END}\n`,
  );
  assert.equal(readBriefText(root), "The real prompt.");
});

test("a closing marker before the opening one is ignored", () => {
  const root = tmpdir();
  writeReadme(
    root,
    `# myproj\n\n${PROMPT_END}\n\n${PROMPT_START}\nThe real prompt.\n${PROMPT_END}\n`,
  );
  assert.equal(readBriefText(root), "The real prompt.");
});

test("surrounding whitespace around the prompt is trimmed", () => {
  const root = tmpdir();
  writeReadme(
    root,
    `# myproj\n\n${PROMPT_START}\n   \n  The real prompt.  \n\t\n${PROMPT_END}\n`,
  );
  assert.equal(readBriefText(root), "The real prompt.");
});

test("an unreadable brief candidate throws naming the file, not a raw errno", () => {
  const root = tmpdir();
  // A present-but-unreadable candidate: a directory at the README.md path makes
  // existsSync true and readFileSync fail with EISDIR, user-independently.
  fs.mkdirSync(path.join(root, "README.md"));
  assert.throws(
    () => readBriefText(root),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(message.includes('"README.md"'), `names the brief file: ${message}`);
      assert.ok(message.includes("EISDIR"), `carries the underlying errno: ${message}`);
      assert.ok(
        message.includes(PROMPT_START),
        `names the markers the fix needs: ${message}`,
      );
      return true;
    },
  );
  // briefFile (the doctor and prompt-builder path) reports the same problem.
  assert.throws(() => briefFile(root), /cannot read the project brief/);
});

test("readBriefText truncates a hand-edited over-long prompt", () => {
  const root = tmpdir();
  const long = "x".repeat(BRIEF_TEXT_MAX_CHARS + 50);
  writeReadme(root, `# myproj\n\n${PROMPT_START}\n${long}\n${PROMPT_END}\n`);
  const got = readBriefText(root);
  assert.ok(got.length < long.length, "shorter than the raw prompt");
  assert.ok(got.startsWith("x".repeat(BRIEF_TEXT_MAX_CHARS)), "keeps the first cap chars");
  assert.match(got, /truncated at 4096 chars/);
});

test("replaceBriefText keeps every byte outside the markers and matches readBriefText's block", () => {
  const text = `intro ${PROMPT_END} prose\n${PROMPT_START}\nold\n${PROMPT_END}\ntail\n`;
  assert.equal(
    replaceBriefText(text, "  new  "),
    `intro ${PROMPT_END} prose\n${PROMPT_START}\nnew\n${PROMPT_END}\ntail\n`,
  );
  assert.equal(replaceBriefText("no markers", "x"), null);
  assert.equal(replaceBriefText(`${PROMPT_END}\n${PROMPT_START}`, "x"), null);
});

test("briefBlockMissing is true only when a candidate exists without a resolvable block", () => {
  const root = tmpdir();
  assert.equal(briefBlockMissing(root), false, "no candidates at all");
  writeReadme(root, "# p\n\nNo markers here.\n");
  assert.equal(briefBlockMissing(root), true, "a marker-less candidate");
  writeReadme(root, `# p\n\n${PROMPT_START}${PROMPT_END}\n`);
  assert.equal(briefBlockMissing(root), true, "an empty marked block");
  writeReadme(root, `# p\n\n${PROMPT_START}\n   \n\t\n${PROMPT_END}\n`);
  assert.equal(briefBlockMissing(root), true, "a whitespace-only marked block");
  writeReadme(root, `# p\n\n${PROMPT_START}\nFrom README.\n${PROMPT_END}\n`);
  assert.equal(briefBlockMissing(root), false, "candidate carries the block");
  try {
    fs.chmodSync(path.join(root, "README.md"), 0o000);
    assert.equal(briefBlockMissing(root), true, "an unreadable candidate");
  } finally {
    fs.chmodSync(path.join(root, "README.md"), 0o644);
  }
});
