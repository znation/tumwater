import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { HELP, helpStanzas } from "../src/cli/help.js";

/** Every `tumwater <command>` the current docs quote is a command `tumwater help` lists, so a
 * rename cannot leave a stale command name in the docs. Tests only; no source change. */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BANNER = "> Written before the 2026-10-16 plain-terms rename";
const INLINE_RE = /`tumwater ([a-z][\w-]*)/g;
const FENCED_RE = /^\s*(?:\$ )?tumwater ([a-z][\w-]*)/;

function docFiles(): string[] {
  const docs = fs.readdirSync(`${ROOT}docs`).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);
  return ["README.md", "DEVELOPMENT.md", ...docs].filter((rel) => {
    const head = fs.readFileSync(ROOT + rel, "utf8").split("\n").slice(0, 5).join("\n");
    return !head.includes(BANNER);
  });
}

/** `"<file>:<line> <word>"` for each quoted command mention in a doc. */
function mentions(rel: string): string[] {
  const out: string[] = [];
  let fenced = false;
  fs.readFileSync(ROOT + rel, "utf8").split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (rel === "docs/glossary.md" && line.startsWith("|")) return;
    const words = fenced
      ? [FENCED_RE.exec(line)?.[1]]
      : [...line.matchAll(INLINE_RE)].map((m) => m[1]);
    for (const w of words) if (w) out.push(`${rel}:${i + 1} ${w}`);
  });
  return out;
}

test("every command the docs quote is a command `tumwater help` lists", () => {
  const known = new Set(helpStanzas(HELP).map((s) => s.command));
  const stale = docFiles()
    .flatMap(mentions)
    .filter((m) => !known.has(m.slice(m.lastIndexOf(" ") + 1)));
  assert.deepEqual(stale, []);
});

test("the scan finds command mentions in README.md and docs/how-it-works.md", () => {
  assert.ok(mentions("README.md").length > 0);
  assert.ok(mentions("docs/how-it-works.md").length > 0);
});
