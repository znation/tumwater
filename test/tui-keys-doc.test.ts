import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** docs/cli.md's TUI keys table against the TUI's key handlers: the Ctrl letters the code handles
 * and the ones the table names are the same set. Tests only; no source change. */

const read = (rel: string): string => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function handledCtrlKeys(): Set<string> {
  const keys = new Set<string>();
  // The prompt-line editor arms were split out of tui-editors.ts into per-editor modules, so
  // scan the tui/ directory for all of them (tui-editors.ts itself now only routes to them),
  // and the pane arms were split out of tui-panes.ts into per-pane modules the same way.
  const tuiDir = new URL("../../src/ui/tui/", import.meta.url);
  const fileNames = (prefix: string): string[] =>
    fs
      .readdirSync(fileURLToPath(tuiDir))
      .filter((f) => f.startsWith(prefix) && f.endsWith(".ts"))
      .map((f) => `../../src/ui/tui/${f}`);
  const editorFiles = fileNames("tui-editor-");
  const paneFiles = fileNames("tui-pane-");
  for (const file of [...editorFiles, ...paneFiles, "../../src/ui/tui/tui-keys.ts", "../../src/ui/tui/tui-panes.ts"]) {
    for (const line of read(file).split("\n")) {
      if (line.includes("key.ctrl &&")) {
        for (const m of line.matchAll(/key\.name === "([a-z])"/g)) keys.add(m[1]!.toUpperCase());
      }
      // The pause editor's dispatch is a route table, not `key.ctrl &&` arms; its
      // `name: "x", should:` entries are Ctrl routes too.
      if (/name: "([a-z])", should:/.test(line)) {
        for (const m of line.matchAll(/name: "([a-z])", should:/g)) keys.add(m[1]!.toUpperCase());
      }
    }
  }
  const input = read("../../src/ui/tui/tui-input.ts");
  for (const m of input.matchAll(/case "([a-z])":\s*(?:\/\/[^\n]*\s*)*if \(key\.ctrl\)/g)) keys.add(m[1]!.toUpperCase());
  return keys;
}

function documentedCtrlKeys(): Set<string> {
  const doc = read("../../docs/cli.md");
  const start = doc.indexOf("## TUI keys");
  assert.notEqual(start, -1, "docs/cli.md has a `## TUI keys` section");
  const rest = doc.slice(start + "## TUI keys".length);
  const next = rest.search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next);
  return new Set([...section.matchAll(/Ctrl\+([A-Z])\b/g)].map((m) => m[1]!));
}

test("the code scan finds the TUI's Ctrl keys", () => {
  const handled = handledCtrlKeys();
  assert.ok(handled.size >= 19, `found ${[...handled].join("")}`);
  for (const k of ["D", "T", "U"]) assert.ok(handled.has(k), `${k} found`);
});

test("docs/cli.md's TUI keys table names every Ctrl key the TUI handles", () => {
  const documented = documentedCtrlKeys();
  assert.deepEqual([...handledCtrlKeys()].filter((k) => !documented.has(k)).sort(), []);
});

test("docs/cli.md's TUI keys table names no Ctrl key the TUI lacks", () => {
  const handled = handledCtrlKeys();
  assert.deepEqual([...documentedCtrlKeys()].filter((k) => !handled.has(k)).sort(), []);
});

test("the Health view's hint and docs rows name the same Ctrl keys", () => {
  const hinted = new Set<string>();
  for (const line of read("../../src/ui/tui/tui-frame.ts").split("\n")) {
    if (!line.includes(`view.kind === "health") keys =`)) continue;
    for (const m of line.matchAll(/Ctrl\+([A-Z])/g)) hinted.add(m[1]!);
  }
  assert.ok(hinted.size > 0, "found the Health hint line");

  const doc = read("../../docs/cli.md");
  const start = doc.indexOf("## TUI keys");
  assert.notEqual(start, -1, "docs/cli.md has a `## TUI keys` section");
  const rest = doc.slice(start + "## TUI keys".length);
  const next = rest.search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next);
  const documentedHealth = new Set<string>();
  const documentedAny = new Set<string>();
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const key = cells[1] ?? "";
    const where = cells[2] ?? "";
    if (/Ctrl\+([A-Z])/.test(key)) {
      const letters = [...key.matchAll(/Ctrl\+([A-Z])/g)].map((m) => m[1]!);
      if (/\bany view\b/.test(where)) for (const k of letters) documentedAny.add(k);
      if (/\bHealth\b/.test(where)) for (const k of letters) documentedHealth.add(k);
    }
  }
  // Every Health hint key is documented for Health or for any view (catches a missing Ctrl+U row).
  assert.deepEqual(
    [...hinted].filter((k) => !documentedHealth.has(k) && !documentedAny.has(k)).sort(),
    [],
  );
  // No docs Health key is unhinted (catches a missing Ctrl+S hint entry); any-view keys stay out.
  assert.deepEqual([...documentedHealth].filter((k) => !hinted.has(k)).sort(), []);
});

test("the Pending view's hint and docs rows name the same Ctrl keys", () => {
  const hinted = new Set<string>();
  for (const line of read("../../src/ui/tui/tui-frame.ts").split("\n")) {
    if (!line.includes(`view.kind === "pending") keys =`)) continue;
    for (const m of line.matchAll(/Ctrl\+([A-Z])/g)) hinted.add(m[1]!);
  }
  assert.ok(hinted.size > 0, "found the Pending hint line");

  const doc = read("../../docs/cli.md");
  const start = doc.indexOf("## TUI keys");
  assert.notEqual(start, -1, "docs/cli.md has a `## TUI keys` section");
  const rest = doc.slice(start + "## TUI keys".length);
  const next = rest.search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next);
  const documentedPending = new Set<string>();
  const documentedAny = new Set<string>();
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const key = cells[1] ?? "";
    const where = cells[2] ?? "";
    if (/Ctrl\+([A-Z])/.test(key)) {
      const letters = [...key.matchAll(/Ctrl\+([A-Z])/g)].map((m) => m[1]!);
      if (/\bany view\b/.test(where)) for (const k of letters) documentedAny.add(k);
      if (/\bPending\b/.test(where)) for (const k of letters) documentedPending.add(k);
    }
  }
  // Every Pending hint key is documented for Pending or any view (catches missing Ctrl+N row).
  assert.deepEqual(
    [...hinted].filter((k) => !documentedPending.has(k) && !documentedAny.has(k)).sort(),
    [],
  );
  // No docs Pending key is unhinted (catches the missing Ctrl+V hint); any-view keys stay out.
  assert.deepEqual([...documentedPending].filter((k) => !hinted.has(k)).sort(), []);
});

test("the Transcript view's hint and docs rows name the same Ctrl keys", () => {
  // The transcript hint spans three physical lines; its marker line has no `keys =`.
  const lines = read("../../src/ui/tui/tui-frame.ts").split("\n");
  const marker = lines.findIndex((l) => l.includes(`view.kind === "transcript")`));
  assert.notEqual(marker, -1, "found the Transcript hint marker line");
  let end = marker;
  while (!lines[end]!.includes("];")) end += 1;
  const hinted = new Set([...lines.slice(marker, end + 1).join("\n").matchAll(/Ctrl\+([A-Z])/g)].map((m) => m[1]!));
  assert.ok(hinted.size > 0, "found the Transcript hint keys");

  const doc = read("../../docs/cli.md");
  const start = doc.indexOf("## TUI keys");
  assert.notEqual(start, -1, "docs/cli.md has a `## TUI keys` section");
  const rest = doc.slice(start + "## TUI keys".length);
  const next = rest.search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next);
  const documentedTranscript = new Set<string>();
  const documentedAny = new Set<string>();
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const key = cells[1] ?? "";
    const where = cells[2] ?? "";
    if (/Ctrl\+([A-Z])/.test(key)) {
      const letters = [...key.matchAll(/Ctrl\+([A-Z])/g)].map((m) => m[1]!);
      if (/\bany view\b/.test(where)) for (const k of letters) documentedAny.add(k);
      if (/\bTranscript\b/.test(where)) for (const k of letters) documentedTranscript.add(k);
    }
  }
  // Every Transcript hint key is documented for Transcript or for any view
  // (catches a stranded Ctrl+Y).
  assert.deepEqual(
    [...hinted].filter((k) => !documentedTranscript.has(k) && !documentedAny.has(k)).sort(),
    [],
  );
  // No docs Transcript key is unhinted (catches the missing Ctrl+L/Ctrl+S hint
  // entries); any-view keys stay out.
  assert.deepEqual([...documentedTranscript].filter((k) => !hinted.has(k)).sort(), []);
});

test("the Activity view's hint and docs rows name the same Ctrl keys", () => {
  const hinted = new Set<string>();
  for (const line of read("../../src/ui/tui/tui-frame.ts").split("\n")) {
    if (!line.includes(`else keys = [`)) continue;
    for (const m of line.matchAll(/Ctrl\+([A-Z])/g)) hinted.add(m[1]!);
  }
  assert.ok(hinted.size > 0, "found the Activity hint line");

  const doc = read("../../docs/cli.md");
  const start = doc.indexOf("## TUI keys");
  assert.notEqual(start, -1, "docs/cli.md has a `## TUI keys` section");
  const rest = doc.slice(start + "## TUI keys".length);
  const next = rest.search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next);
  const documentedActivity = new Set<string>();
  const documentedAny = new Set<string>();
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const key = cells[1] ?? "";
    const where = cells[2] ?? "";
    if (/Ctrl\+([A-Z])/.test(key)) {
      const letters = [...key.matchAll(/Ctrl\+([A-Z])/g)].map((m) => m[1]!);
      if (/\bany view\b/.test(where)) for (const k of letters) documentedAny.add(k);
      if (/\bActivity\b/.test(where)) for (const k of letters) documentedActivity.add(k);
    }
  }
  // Every Activity hint key is documented for Activity or any view (catches
  // an Activity hint key with no docs row).
  assert.deepEqual(
    [...hinted].filter((k) => !documentedActivity.has(k) && !documentedAny.has(k)).sort(),
    [],
  );
  // No docs Activity key is unhinted (catches the missing Ctrl+K/Ctrl+N/Ctrl+S/
  // Ctrl+U/Ctrl+W hint entries); any-view keys stay out.
  assert.deepEqual([...documentedActivity].filter((k) => !hinted.has(k)).sort(), []);
});
