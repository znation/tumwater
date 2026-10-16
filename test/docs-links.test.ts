import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Every relative link and backticked repo path in the current docs resolves, so a moved file
 * cannot leave a stale reference. Tests only; no source change. */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BANNER = "> Written before the 2026-10-16 plain-terms rename";
const LINK_RE = /\]\(([^)\s]+)\)/g;
const PATH_RE = /`((?:src|test|docs|plans|scripts)\/[\w./-]+)`/g;

function docFiles(): string[] {
  const docs = fs.readdirSync(`${ROOT}docs`).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);
  return ["README.md", "DEVELOPMENT.md", ...docs].filter((rel) => {
    const head = fs.readFileSync(ROOT + rel, "utf8").split("\n").slice(0, 5).join("\n");
    return !head.includes(BANNER);
  });
}

/** Lines of a doc outside fenced blocks, with 1-based line numbers. */
function proseLines(rel: string): { n: number; line: string }[] {
  const out: { n: number; line: string }[] = [];
  let fenced = false;
  fs.readFileSync(ROOT + rel, "utf8").split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) out.push({ n: i + 1, line });
  });
  return out;
}

/** GitHub heading slugs of a markdown file, without duplicate-heading suffixes. */
function anchors(rel: string): Set<string> {
  const set = new Set<string>();
  for (const { line } of proseLines(rel)) {
    const m = /^#{1,6} (.*)$/.exec(line);
    if (!m) continue;
    set.add((m[1] ?? "").trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-"));
  }
  return set;
}

function scan(): { broken: string[]; readmeLinks: number; anchored: number; devPaths: number } {
  const broken: string[] = [];
  let readmeLinks = 0;
  let anchored = 0;
  let devPaths = 0;
  for (const rel of docFiles()) {
    for (const { n, line } of proseLines(rel)) {
      for (const m of line.matchAll(LINK_RE)) {
        const target = m[1] ?? "";
        if (/^[a-z]+:/i.test(target)) continue;
        const [file = "", fragment] = target.split("#");
        const resolved = file ? path.join(path.dirname(rel), file) : rel;
        if (rel === "README.md") readmeLinks++;
        if (!fs.existsSync(ROOT + resolved)) {
          broken.push(`${rel}:${n} ${target}`);
          continue;
        }
        if (fragment !== undefined && resolved.endsWith(".md")) {
          anchored++;
          if (!anchors(resolved).has(fragment)) broken.push(`${rel}:${n} ${target}`);
        }
      }
      if (rel === "docs/invariants.md" || (rel === "docs/glossary.md" && line.startsWith("|"))) continue;
      for (const m of line.matchAll(PATH_RE)) {
        const p = m[1] ?? "";
        if (p.includes("...")) continue;
        if (rel === "DEVELOPMENT.md") devPaths++;
        if (!fs.existsSync(ROOT + p)) broken.push(`${rel}:${n} ${p}`);
      }
    }
  }
  return { broken, readmeLinks, anchored, devPaths };
}

test("every relative link, anchor, and backticked repo path in the current docs resolves", () => {
  assert.deepEqual(scan().broken, []);
});

test("the docs scan finds links, anchored links, and paths, so it cannot pass vacuously", () => {
  const { readmeLinks, anchored, devPaths } = scan();
  assert.ok(readmeLinks > 0, "README.md links");
  assert.ok(anchored > 0, "anchored links");
  assert.ok(devPaths > 0, "DEVELOPMENT.md paths");
});
