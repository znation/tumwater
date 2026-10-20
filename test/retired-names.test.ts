/** Guards plans/terminology.md's "Code names": no identifier or file name in `src/` or `test/`
 * uses a retired word. Identifiers are read with the TypeScript compiler API (string literals and
 * comments are never scanned; test/vocabulary.test.ts owns literals), including the identifiers
 * of the `String.raw` browser blobs. Code that names old forms on purpose is exempt, visibly:
 * `LEGACY_FILES`, identifiers starting with `legacy`, `// retired-name-ok: <reason>` lines and
 * `retired-name-ok:start` … `retired-name-ok:end` regions, and a family's `allow`. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { repoRoot } from "./helpers/repo-root.js";
import { LEGACY_FILES, exemptLines } from "./helpers/legacy-files.js";

interface RetiredFamily {
  family: string;
  /** Identifier words (lowercase) that fail. */
  words: readonly string[];
  /** Path words (lowercase, split on `/ - _ .`) that fail. */
  fileWords: readonly string[];
  /** Exact identifiers the family keeps everywhere; give each a reason comment. */
  allow: readonly string[];
  /** Exact identifiers that fail though their words are current (a renamed command's names). */
  identifiers?: readonly string[];
}

// Each later Code-names series appends its family here.
const RETIRED: readonly RetiredFamily[] = [
  { family: "fleet → team", words: ["fleet", "fleets"], fileWords: ["fleet"], allow: [] },
  {
    family: "landing/land/lander/vet → merge",
    words: ["land", "lands", "landed", "landing", "landings", "lander", "landers", "unlanded", "vet", "vets", "vetted", "vetting"],
    fileWords: ["landing", "lander", "landed", "vetting"],
    // removeLegacyLandWorktrees removes the legacy `_land-<role>` worktrees "State and git" keeps.
    allow: ["removeLegacyLandWorktrees"],
  },
  {
    family: "loop → runner",
    words: ["loop", "loops"],
    fileWords: ["loop", "loops"],
    allow: [
      "pollLoop", // the poll loop is a JavaScript loop, not a role
      "crashLoop", // a crash loop is a failure mode
      "onCrashLoop", // the crash-loop callback
      "customLoops", // the live legacy config key
    ],
  },
  {
    family: "tick → run",
    words: ["tick", "ticks", "ticked", "ticking"],
    fileWords: ["tick", "ticks"],
    // Node's own names.
    allow: ["nextTick", "processTicksAndRejections"],
    // `tumwater run`'s old code names; "run" is the new word, so they cannot be words.
    identifiers: ["cmdRun", "RUN_FLAG_SPECS", "superviseRun", "superviseRunCommand", "spawnRunChild"],
  },
  { family: "notebook → notes", words: ["notebook", "notebooks"], fileWords: ["notebook"], allow: [] },
  {
    family: "initial prompt → brief",
    words: [],
    fileWords: [],
    allow: [],
    identifiers: ["initialPrompt", "readInitialPrompt", "editInitialPrompt", "replaceInitialPrompt", "INITIAL_PROMPT_MAX_CHARS"],
  },
  {
    // Not the words `dry` or `telemetry`: they still mean a dry run and generic telemetry.
    family: "role ids",
    words: [],
    fileWords: [],
    allow: [],
    identifiers: ["telemetryDigest", "TELEMETRY_DIGEST_DAYS", "dryRow", "dryFailedAt"],
  },
  {
    // Not `agent`/`agents`/`agentBin`: they are live legacy config keys and ids.
    family: "agent selector → backend",
    words: [],
    fileWords: [],
    allow: [],
    identifiers: [
      "AgentId", "AGENT_IDS", "isAgentId", "DEFAULT_AGENT", "AgentConfig", "AgentBinConfig", "AGENT_KEYS",
      "resolveAgentBin", "findAgentBinary", "checkAgentBinary", "agentMissingMessage", "agentsInUse",
      "collapseAgentAliases", "resolvedAgentConfig", "agentQualifiedSelector", "AGENT_DEFAULT_MODELS",
      "agentBaseEnv", "agentBinSourceLabel", "agentSessionResumable",
    ],
  },
];

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = repoRoot(TEST_DIR);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Lowercase words of an identifier, split at camelCase, PascalCase, `_`, `$` and digits. */
function identWords(name: string): string[] {
  return (name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []).map((w) => w.toLowerCase());
}

/** `path:line identifier (family)` for each retired identifier word in the file's code. */
function identifierFindings(rel: string, text: string, families: readonly RetiredFamily[] = RETIRED): string[] {
  const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const lines = text.split("\n");
  const exempt = exemptLines(lines);
  const out: string[] = [];
  const check = (name: string, line: number): void => {
    if (exempt.has(line)) return;
    const words = identWords(name);
    if (words[0] === "legacy") return;
    for (const fam of families) {
      if (fam.allow.includes(name)) continue;
      if (fam.identifiers?.includes(name)) out.push(`${rel}:${line} ${name} (${fam.family})`);
      if (words.some((w) => fam.words.includes(w))) out.push(`${rel}:${line} ${name} (${fam.family})`);
    }
  };
  const lineOf = (s: ts.SourceFile, pos: number): number => s.getLineAndCharacterOfPosition(pos).line + 1;
  const collect = (root: ts.Node, s: ts.SourceFile): void => {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) check(node.text, lineOf(s, node.getStart(s)));
      ts.forEachChild(node, visit);
    };
    visit(root);
  };
  const blobs: ts.TemplateLiteral[] = [];
  const visitMain = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(sf) === "String.raw") {
      blobs.push(node.template);
      return;
    }
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) check(node.text, lineOf(sf, node.getStart(sf)));
    ts.forEachChild(node, visitMain);
  };
  visitMain(sf);
  for (const tpl of blobs) {
    // Same offsets as the file: blank everything outside the template text and each `${…}`.
    const start = tpl.getStart(sf) + 1;
    const end = tpl.end - 1;
    const chars: string[] = text.split("").map((c) => (c === "\n" ? c : " "));
    for (let i = start; i < end; i++) chars[i] = text[i]!;
    if (!ts.isNoSubstitutionTemplateLiteral(tpl)) {
      const blank = (a: number, b: number): void => {
        chars[a] = "0";
        for (let i = a + 1; i < b; i++) if (chars[i] !== "\n") chars[i] = " ";
      };
      let from = tpl.head.end - 2;
      for (const span of tpl.templateSpans) {
        blank(from, span.literal.getStart(sf) + 1);
        from = span.literal.end - 2;
      }
    }
    const js = ts.createSourceFile(rel, chars.join(""), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    collect(js, js);
  }
  return out;
}

/** `path (family)` when a path word of the repo-relative file is retired. */
function fileFindings(rel: string, families: readonly RetiredFamily[] = RETIRED): string[] {
  const words = rel.toLowerCase().split(/[/\-_.]+/);
  return families.filter((f) => words.some((w) => f.fileWords.includes(w))).map((f) => `${rel} (${f.family})`);
}

/** Identifier findings, skipping a `LEGACY_FILES` path without reading it. */
function scanIdentifiers(rel: string, read: () => string, legacy: readonly string[] = LEGACY_FILES): string[] {
  return legacy.includes(rel) ? [] : identifierFindings(rel, read());
}

test("no identifier or file name in src/ or test/ uses a retired name", () => {
  const hits: string[] = [];
  for (const abs of ["src", "test"].flatMap((d) => walk(path.join(ROOT, d)))) {
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    hits.push(...fileFindings(rel));
    if (/\.tsx?$/.test(rel)) hits.push(...scanIdentifiers(rel, () => fs.readFileSync(abs, "utf8")));
  }
  assert.deepEqual(hits, [], `retired names (rename them; never exempt a missed rename):\n${hits.join("\n")}`);
});

test("every LEGACY_FILES entry exists", () => {
  for (const rel of LEGACY_FILES) assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is listed but missing`);
});

test("self-test: identifiers", () => {
  const f = (src: string): string[] => identifierFindings("src/x.ts", src);
  assert.equal(f("const pauseFleet = 1;\n").length, 1);
  assert.equal(f("const X = String.raw`\nfunction renderFleet() {}\n${a}`;\n").length, 1);
  assert.match(f("const X = String.raw`\n\nfunction renderFleet() {}`;\n")[0]!, /^src\/x\.ts:3 renderFleet/);
  assert.equal(f('const a = "fleet"; // the fleet\nconst fleetingly = 1;\nconst legacyFleetMarker = 1;\n').length, 0);
  assert.equal(f("const pauseFleet = 1; // retired-name-ok: legacy reader\n").length, 0);
  const region = "// retired-name-ok:start legacy table\nconst fleetA = 1;\n// retired-name-ok:end\nconst fleetB = 2;\n";
  assert.deepEqual(f(region), ["src/x.ts:4 fleetB (fleet → team)"]);
  assert.equal(f("const landingRefName = 1;\nconst vetted = 2;\n").length, 2);
  assert.equal(f("const userland = 1;\nconst landmarks = 2;\nconst Helvetica = 3;\n").length, 0);
  assert.equal(f("function removeLegacyLandWorktrees() {}\n").length, 0);
  assert.equal(f("type TickResult = 1;\n").length, 1);
  assert.equal(f("const cmdRun = 1;\n").length, 1);
  assert.equal(f("const cmdRunDetail = 1;\nprocess.nextTick(f);\nconst backtick = 1;\n").length, 0);
  assert.deepEqual(identWords("GUI_CLIENT_FLEET_JS"), ["gui", "client", "fleet", "js"]);
});

test("self-test: LEGACY_FILES skip identifiers", () => {
  const src = "const pauseFleet = 1;\n";
  assert.equal(scanIdentifiers("src/a.ts", () => src, []).length, 1);
  assert.equal(scanIdentifiers("src/a.ts", () => src, ["src/a.ts"]).length, 0);
});

test("self-test: file names", () => {
  assert.equal(fileFindings("src/fleet/x.ts").length, 1);
  assert.equal(fileFindings("test/gui-client-fleet.test.ts").length, 1);
  assert.equal(fileFindings("src/landing/x.ts").length, 1);
  assert.equal(fileFindings("test/lander.test.ts").length, 1);
  assert.equal(fileFindings("src/scheduling/work-landed-cache.ts").length, 1);
  assert.equal(fileFindings("src/merge/merge-to-main.ts").length, 0);
  assert.equal(fileFindings("src/team/team-hold.ts").length, 0);
});
