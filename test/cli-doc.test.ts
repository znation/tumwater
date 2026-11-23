import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { HELP, HIDDEN_COMMAND_ALIASES, helpStanzas } from "../src/cli/cli-help.js";

/** docs/cli.md against `tumwater help`: every command the help lists appears in the reference as
 * `tumwater <command>`, and the aliases the help hides do not. Long flags too: the help and the
 * reference name the same set, and every numeric cap the help states for a command appears on a
 * reference line that documents it. Tests only; no source change. */

const DOC = fileURLToPath(new URL("../../docs/cli.md", import.meta.url));

const LONG_FLAG = /(?<![\w-])--[a-z][a-z0-9-]*/g;

function longFlags(text: string): Set<string> {
  return new Set(text.match(LONG_FLAG) ?? []);
}

/** True when the doc names `tumwater <command>` as a whole word (`re` is not met by `reclaim`). */
function documents(doc: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`tumwater ${escaped}(?![\\w-])`).test(doc);
}

test("docs/cli.md names every command `tumwater help` lists", () => {
  const doc = fs.readFileSync(DOC, "utf8");
  const commands = [...new Set(helpStanzas(HELP).map((s) => s.command))];
  const missing = commands.filter((c) => !documents(doc, c));
  assert.deepEqual(missing, []);
});

test("docs/cli.md does not document the aliases the help hides", () => {
  const doc = fs.readFileSync(DOC, "utf8");
  const documented = Object.keys(HIDDEN_COMMAND_ALIASES).filter((c) => documents(doc, c));
  assert.deepEqual(documented, []);
});

/** A stated bound on a flag value: `capped at 7d`, `capped at 90d`. The help prose wraps, so the
 * stanza text is whitespace-collapsed before the search. */
const CAP = /capped at (\d+[a-z]+)/g;

const collapse = (text: string): string => text.replace(/\s+/g, " ");

/** The cap phrase's scope is the whole docs/cli.md table row: each row is one very long line that
 * documents several command forms in one shared parenthetical, so a bound stated anywhere in the
 * row is stated for the command this scan is checking. That is coarser than per-form and accepts
 * a bound carried by a sibling form in the same row; it still catches the real drift, a row that
 * names no bound at all (BUGS.md 2026-11-22: logs and history carried no cap while report did). */
test("docs/cli.md names every numeric cap `tumwater help` states for a command", () => {
  const docLines = fs.readFileSync(DOC, "utf8").split("\n");
  const missing: string[] = [];
  for (const stanza of helpStanzas(HELP)) {
    const caps = [...collapse(stanza.text).matchAll(CAP)].map((m) => m[1]);
    if (caps.length === 0) continue;
    const rows = docLines.filter((line) => documents(line, stanza.command));
    assert.ok(
      rows.length > 0,
      `the help lists \`tumwater ${stanza.command}\` but docs/cli.md documents it nowhere`,
    );
    for (const cap of caps)
      if (!rows.some((row) => collapse(row).includes(`capped at ${cap}`)))
        missing.push(`${stanza.command} cap ${cap} is missing from docs/cli.md`);
  }
  assert.deepEqual(missing, []);
});

test("the cap scan sees the caps the help states", () => {
  // Guards the scan itself: a stanza really does carry a `capped at` bound, so a pass cannot
  // come from a help text that stopped naming any bound.
  const caps = helpStanzas(HELP).flatMap((s) => [...collapse(s.text).matchAll(CAP)].map((m) => `${s.command} ${m[1]}`));
  assert.ok(caps.includes("logs 7d"), caps.join(" | "));
  assert.ok(caps.includes("history 7d"), caps.join(" | "));
  assert.ok(caps.includes("report 7d"), caps.join(" | "));
});

test("docs/cli.md names every long flag `tumwater help` lists", () => {
  const doc = longFlags(fs.readFileSync(DOC, "utf8"));
  const help = longFlags(HELP);
  const missing = [...help].filter((f) => !doc.has(f));
  assert.deepEqual(missing, []);
  assert.ok(help.size >= 40, `the help names only ${help.size} long flags; the flag pattern may have regressed`);
});

test("docs/cli.md names no long flag `tumwater help` lacks", () => {
  const doc = longFlags(fs.readFileSync(DOC, "utf8"));
  const help = longFlags(HELP);
  const stale = [...doc].filter((f) => !help.has(f));
  assert.deepEqual(stale, []);
});
