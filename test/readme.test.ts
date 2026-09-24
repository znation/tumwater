import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  INITIAL_PROMPT_MAX_CHARS,
  PROMPT_END,
  PROMPT_START,
  STATUS_END,
  STATUS_START,
  briefFile,
  briefTemplate,
  readmeTemplate,
  readInitialPrompt,
} from "../src/readme.js";
import { tmpdir } from "./util.js";

function writeReadme(root: string, text: string): void {
  fs.writeFileSync(path.join(root, "README.md"), text);
}

function writeBrief(root: string, text: string): void {
  fs.writeFileSync(path.join(root, "TUMWATER.md"), text);
}

test("readmeTemplate wraps the trimmed prompt in managed markers and seeds an empty status", () => {
  const t = readmeTemplate("myproj", "  Build a thing.\n\nMore detail.\n");
  assert.ok(t.startsWith("# myproj\n"));
  assert.ok(t.includes("## Initial prompt"), "has an initial-prompt heading");
  assert.ok(t.includes("## Status"), "has a status heading");
  const start = t.indexOf(PROMPT_START);
  const end = t.indexOf(PROMPT_END, start + PROMPT_START.length);
  assert.ok(start >= 0 && end > start, "prompt markers present in order");
  assert.equal(t.slice(start + PROMPT_START.length, end).trim(), "Build a thing.\n\nMore detail.");
});

test("readInitialPrompt round-trips the prompt from a fresh template", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "README.md"), readmeTemplate("myproj", "Build a thing."));
  assert.equal(readInitialPrompt(root), "Build a thing.");
});

test("briefTemplate wraps the trimmed prompt in the same two managed sections as the README template", () => {
  const t = briefTemplate("myproj", "  Build a thing.\n");
  assert.ok(t.startsWith("# myproj"));
  assert.ok(t.includes("## Initial prompt"), "has an initial-prompt heading");
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
  assert.equal(readInitialPrompt(root), "Build a thing.");
});

// Resolution order (plans/portability.md §7a/7): TUMWATER.md first, README.md as the
// compatibility path.

test("readInitialPrompt prefers a marked TUMWATER.md over a marked README.md", () => {
  const root = tmpdir();
  writeReadme(root, `# p\n\n${PROMPT_START}\nFrom README.\n${PROMPT_END}\n`);
  writeBrief(root, `# p\n\n${PROMPT_START}\nFrom TUMWATER.\n${PROMPT_END}\n`);
  assert.equal(readInitialPrompt(root), "From TUMWATER.");
  assert.equal(briefFile(root), "TUMWATER.md");
});

test("readInitialPrompt falls back to README.md when TUMWATER.md is absent or unmarked", () => {
  const root = tmpdir();
  writeReadme(root, `# p\n\n${PROMPT_START}\nFrom README.\n${PROMPT_END}\n`);
  assert.equal(readInitialPrompt(root), "From README.");
  assert.equal(briefFile(root), "README.md");

  // A TUMWATER.md without markers does not own the brief: README.md keeps ownership.
  writeBrief(root, "# p — no managed sections\n");
  assert.equal(readInitialPrompt(root), "From README.");
  assert.equal(briefFile(root), "README.md");
});

test("readInitialPrompt reads a TUMWATER.md-only repo", () => {
  const root = tmpdir();
  writeBrief(root, `# p\n\n${PROMPT_START}\nFrom TUMWATER.\n${PROMPT_END}\n`);
  assert.equal(readInitialPrompt(root), "From TUMWATER.");
  assert.equal(briefFile(root), "TUMWATER.md");
});

test("briefFile is null when neither candidate owns the brief", () => {
  const root = tmpdir();
  assert.equal(briefFile(root), null, "no files at all");
  writeReadme(root, "# p\n");
  writeBrief(root, "# p\n");
  assert.equal(briefFile(root), null, "both files, no markers");
  assert.equal(readInitialPrompt(root), "");
});

test("readInitialPrompt returns empty string when README.md is missing", () => {
  const root = tmpdir();
  assert.equal(readInitialPrompt(root), "");
});

test("readInitialPrompt returns empty string when the opening marker is absent", () => {
  const root = tmpdir();
  writeReadme(root, "# myproj\n\nNo managed sections here.\n");
  assert.equal(readInitialPrompt(root), "");
});

test("readInitialPrompt returns empty string when only the closing marker exists", () => {
  const root = tmpdir();
  writeReadme(root, `# myproj\n\n${PROMPT_END}\n`);
  assert.equal(readInitialPrompt(root), "");
});

test("readInitialPrompt returns empty string when the opening marker has no closing one after it", () => {
  const root = tmpdir();
  writeReadme(root, `# myproj\n\n${PROMPT_START}\nBuild a thing.\n`);
  assert.equal(readInitialPrompt(root), "");
});

test("an end marker in prose before the real block does not hide the prompt", () => {
  const root = tmpdir();
  writeReadme(
    root,
    `# myproj\n\nDocs: the section ends at ${PROMPT_END} — edit above it.\n\n` +
      `${PROMPT_START}\nThe real prompt.\n${PROMPT_END}\n`,
  );
  assert.equal(readInitialPrompt(root), "The real prompt.");
});

test("a closing marker before the opening one is ignored", () => {
  const root = tmpdir();
  writeReadme(
    root,
    `# myproj\n\n${PROMPT_END}\n\n${PROMPT_START}\nThe real prompt.\n${PROMPT_END}\n`,
  );
  assert.equal(readInitialPrompt(root), "The real prompt.");
});

test("surrounding whitespace around the prompt is trimmed", () => {
  const root = tmpdir();
  writeReadme(
    root,
    `# myproj\n\n${PROMPT_START}\n   \n  The real prompt.  \n\t\n${PROMPT_END}\n`,
  );
  assert.equal(readInitialPrompt(root), "The real prompt.");
});

test("readInitialPrompt truncates a hand-edited over-long prompt", () => {
  const root = tmpdir();
  const long = "x".repeat(INITIAL_PROMPT_MAX_CHARS + 50);
  writeReadme(root, `# myproj\n\n${PROMPT_START}\n${long}\n${PROMPT_END}\n`);
  const got = readInitialPrompt(root);
  assert.ok(got.length < long.length, "shorter than the raw prompt");
  assert.ok(got.startsWith("x".repeat(INITIAL_PROMPT_MAX_CHARS)), "keeps the first cap chars");
  assert.match(got, /truncated at 4096 chars/);
});
