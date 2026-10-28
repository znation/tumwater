// Guards the suite against the child busy-wait that once defeated the owner preload: a test
// child spinning in a synchronous `while (!fs.existsSync(...)) {}` holds the event loop, so the
// owner watch (`exitWithOwner`, a setInterval) can never fire and the child outlives every sweep
// (BUGS.md 2026-10-28). The preload's companion fix (spawnReadyChild's readiness handshake,
// b98d1ba31) replaced the one such barrier, but nothing stopped a future synchronous one — a lint
// rule sees a child's source as a string, so the check belongs here, reading each test source the
// way the deterministic guard tests (backlog-structure, retired-names) read the repo. The rule:
// a `while` (or counting `for`) loop whose condition calls `existsSync` is a poll, and a poll
// whose body yields nowhere — no `await`, `Atomics.wait`, or timer — is a busy-wait. for-of and
// for-in loops iterate a fixed collection and are never polls, so they stay exempt.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./helpers/repo-root.js";

/** One of the body tokens that lets the event loop turn; see child-process.ts's readiness
 * handshake, which polls through `sleep`. */
const YIELD_RE = /await|Atomics\.wait|setTimeout|setInterval/;

/** The index of `closeCh` matching the `openCh` at `open`, or -1 when unmatched. */
function matching(text: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Child busy-waits in one test source: `rel:line` for every `while`/counting-`for` loop whose
 * condition calls `existsSync` and whose body yields nowhere. Returns [] when none. */
function busyWaitFindings(rel: string, text: string): string[] {
  const out: string[] = [];
  const RE = /\b(while|for)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(text))) {
    const keyword = m[1];
    // A loop whose opening line is a `//` comment is documentation, not a child source (the
    // guard is a text scanner; real child sources live in string/template literals, never a
    // comment). This keeps the rule's own description — and a doc note like child-process.ts's —
    // from tripping it while every executable mention still does.
    const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
    const lineEnd = text.indexOf("\n", lineStart);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    if (/^\s*\/\//.test(line)) continue;
    const condOpen = m.index + m[0].indexOf("(");
    const condClose = matching(text, condOpen, "(", ")");
    if (condClose < 0) continue;
    const condition = text.slice(condOpen + 1, condClose);
    if (!/\bexistsSync\b/.test(condition)) continue;
    // A counting `for (let …; cond; …)` is a poll; for-of / for-in have no `;` and iterate a
    // fixed collection, so they are never a busy-wait.
    if (keyword === "for" && !condition.includes(";")) continue;
    let bodyStart = condClose + 1;
    while (bodyStart < text.length && /\s/.test(text[bodyStart] ?? "")) bodyStart++;
    let body: string;
    if (text[bodyStart] === "{") {
      const bodyClose = matching(text, bodyStart, "{", "}");
      if (bodyClose < 0) continue;
      body = text.slice(bodyStart + 1, bodyClose);
    } else {
      const end = text.indexOf("\n", bodyStart);
      body = end < 0 ? text.slice(bodyStart) : text.slice(bodyStart, end);
    }
    if (YIELD_RE.test(body)) continue;
    const lineNumber = text.slice(0, m.index).split("\n").length;
    out.push(`${rel}:${lineNumber}`);
  }
  return out;
}

/** Every `test/**\/*.ts` source path, rooted at the repo's test dir (works from dist too). */
function testSources(root: string): string[] {
  const base = path.join(root, "test");
  const out: string[] = [];
  const walkDir = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walkDir(base);
  return out;
}

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = repoRoot(TEST_DIR);

test("the detector names the body-less synchronous existsSync poll and spares the yielding ones", () => {
  const rel = "snippet.ts";
  // The history shape that defeated the owner preload; must be flagged.
  assert.deepEqual(busyWaitFindings(rel, `  while (!fs.existsSync(".../start-when-aligned")) {}`), [`${rel}:1`]);
  // A counting for with a synchronous body is equally a busy-wait.
  assert.deepEqual(
    busyWaitFindings(rel, `for (let i = 0; !fs.existsSync(lock); i++) {\n  fs.readdirSync(root);\n}`),
    [`${rel}:1`],
  );
  // Yielding bodies are the sanctioned way to poll; none flagged.
  assert.deepEqual(busyWaitFindings(rel, `while (!fs.existsSync(f)) await sleep(25);`), []);
  assert.deepEqual(busyWaitFindings(rel, `for (let i = 0; i < 300 && !fs.existsSync(x); i++) await sleep(50);`), []);
  assert.deepEqual(busyWaitFindings(rel, `while (!fs.existsSync(f)) { await new Promise((r) => setTimeout(r, 20)); }`), []);
  // for-of over a fixed collection is not a poll, even with existsSync in the body.
  assert.deepEqual(busyWaitFindings(rel, `for (const f of files) assert.ok(fs.existsSync(path.join(dir, f)), f);`), []);
});

test("every test source is free of a child busy-wait: no synchronous existsSync poll loop", () => {
  const findings: string[] = [];
  for (const abs of testSources(ROOT)) {
    // The guard reads its own source too, whose only mentions of the pattern are the doc comment
    // and the detector's examples above; exclude this file, which holds no child sources.
    if (path.basename(abs) === "test-child-spin-guard.test.ts") continue;
    const rel = path.relative(ROOT, abs);
    const text = fs.readFileSync(abs, "utf8");
    findings.push(...busyWaitFindings(rel, text));
  }
  assert.deepEqual(findings, [], [
    "a synchronous existsSync poll loop is a child busy-wait: it holds the event loop, so the owner",
    "preload cannot fire and the child outlives the test (add an `await`, Atomics.wait, or a timer):",
    ...findings,
  ].join("\n"));
});
