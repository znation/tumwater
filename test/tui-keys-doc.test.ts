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
      if (!line.includes("key.ctrl &&")) continue;
      for (const m of line.matchAll(/key\.name === "([a-z])"/g)) keys.add(m[1]!.toUpperCase());
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
