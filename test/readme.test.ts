import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PROMPT_END, PROMPT_START, readmeTemplate, readInitialPrompt } from "../src/readme.js";
import { tmpdir } from "./util.js";

function writeReadme(root: string, text: string): void {
  fs.writeFileSync(path.join(root, "README.md"), text);
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
