import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { NOTIFY_EVENT_TYPES } from "../src/events/event-notify.js";
import { ROLE_ENTRY_KEYS, TOP_LEVEL_KEYS } from "../src/config/config-schema.js";

/** docs/config.md's "Every setting" and "Notify events" tables — the guard that keeps the
 * reference in step with the source. A key added to `TOP_LEVEL_KEYS` (or `ROLE_ENTRY_KEYS`, or
 * `NOTIFY_EVENT_TYPES` for the notify table) must be documented in the same change: a missing
 * row, an extra row, a renamed row and a reordering all fail with the array diff. Tests only;
 * no source change. */

const DOC = fileURLToPath(new URL("../../docs/config.md", import.meta.url));

const ROW_RE = /^\| `([A-Za-z]+)` \|/;

/** The section's table rows split at the `roles.<id>` caption: [top-level, role-entry]. */
function settingRows(): [string[], string[]] {
  const doc = fs.readFileSync(DOC, "utf8");
  const start = doc.indexOf("\n## Every setting\n");
  assert.notEqual(start, -1, "docs/config.md has no `## Every setting` section");
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 3);
  const section = end === -1 ? rest : rest.slice(0, end);
  const split = section.indexOf("`roles.<id>`");
  assert.notEqual(split, -1, "the section has no `roles.<id>` caption between its tables");
  const rows = (text: string) => text.split("\n").filter((line) => ROW_RE.test(line));
  return [rows(section.slice(0, split)), rows(section.slice(split))];
}

const keyOf = (row: string) => ROW_RE.exec(row)?.[1];

test("the top-level settings table lists every TOP_LEVEL_KEYS entry in order", () => {
  assert.deepEqual(settingRows()[0].map(keyOf), [...TOP_LEVEL_KEYS]);
});

test("the roles.<id> table lists every ROLE_ENTRY_KEYS entry in order", () => {
  assert.deepEqual(settingRows()[1].map(keyOf), [...ROLE_ENTRY_KEYS]);
});

test("every settings row has a key, a default and a description", () => {
  for (const row of settingRows().flat()) {
    const cells = row.split(/ \| /).map((cell) => cell.replace(/^\| |\ \|$/g, "").trim());
    assert.equal(cells.length, 3, `row is not three cells: ${row}`);
    for (const cell of cells) assert.notEqual(cell, "", `empty cell in: ${row}`);
  }
});

const NOTIFY_ROW_RE = /^\| `([a-z_]+)` \|/;

/** The `## Notify events` table rows. */
function notifyRows(): string[] {
  const doc = fs.readFileSync(DOC, "utf8");
  const start = doc.indexOf("\n## Notify events\n");
  assert.notEqual(start, -1, "docs/config.md has no `## Notify events` section");
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 3);
  const section = end === -1 ? rest : rest.slice(0, end);
  return section.split("\n").filter((line) => NOTIFY_ROW_RE.test(line));
}

test("the notify events table lists every NOTIFY_EVENT_TYPES entry in order", () => {
  assert.deepEqual(notifyRows().map((row) => NOTIFY_ROW_RE.exec(row)?.[1]), [...NOTIFY_EVENT_TYPES]);
});

test("every notify events row has a type and a description", () => {
  for (const row of notifyRows()) {
    const cells = row.split(/ \| /).map((cell) => cell.replace(/^\| |\ \|$/g, "").trim());
    assert.equal(cells.length, 2, `row is not two cells: ${row}`);
    for (const cell of cells) assert.notEqual(cell, "", `empty cell in: ${row}`);
  }
});
