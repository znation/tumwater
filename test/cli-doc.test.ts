import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { HELP, HIDDEN_COMMAND_ALIASES, helpStanzas } from "../src/cli/help.js";

/** docs/cli.md against `tumwater help`: every command the help lists appears in the reference as
 * `tumwater <command>`, and the aliases the help hides do not. Tests only; no source change. */

const DOC = fileURLToPath(new URL("../../docs/cli.md", import.meta.url));

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
