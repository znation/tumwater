import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** docs/invariants.md — the citation and id guard behind the register's "Keep it honest"
 * paragraph. The register promises every invariant a stable `INV-…` id, the three field labels,
 * and a resolvable `test/...` citation, but nothing enforced it: a renamed test, a moved module,
 * or a copied entry would turn the register the team reads into silent drift. The helpers below
 * parse the document and name each broken entry, and the last test pins the register as it stands.
 * Tests only; no source change. */

const DOC = fileURLToPath(new URL("../../docs/invariants.md", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const ID_RE = /^INV-[A-Z]{1,2}\d+$/;
/** `### INV-…:` captures looser than ID_RE so a malformed id is reported, not skipped. */
const HEADING_RE = /^### (INV-\S+):/gm;
const PATH_RE = /`((?:src|test|docs|plans|scripts)\/[^`]+)`/g;

/** Every cited path token in an entry body, minus the prose placeholders (`test/...`) and globs
 * that name no single file. */
function citedPaths(body: string): string[] {
  const paths: string[] = [];
  for (const match of body.matchAll(PATH_RE)) {
    const raw = match[1];
    if (raw === undefined) continue;
    if (raw.endsWith("/...") || raw.includes("*")) continue;
    paths.push(raw);
  }
  return paths;
}

/** A `test(`/`it(`/`describe(` call (optionally `.skip`/`.only`/`.todo`) whose first argument is
 * a string or template literal; group 1 is the quote, group 2 the title. */
const TITLE_RE = /\b(?:test|it|describe)(?:\.(?:skip|only|todo))?\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Every test title in a test source, whitespace collapsed; a template title keeps its
 * `${…}` placeholders. */
function testTitles(source: string): string[] {
  return [...source.matchAll(TITLE_RE)].map((m) => collapse(m[2] ?? ""));
}

/** Whether a cited title names `title`: equal, a prefix cite ending in `…`, or a citation of a
 * template title with each `${…}` placeholder read as a non-empty wildcard. */
function titleMatches(cited: string, title: string): boolean {
  if (cited === title) return true;
  if (cited.endsWith("…") && title.startsWith(cited.slice(0, -1))) return true;
  if (!title.includes("${")) return false;
  const parts = title.split(/\$\{[^}]*\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".+")}$`).test(cited);
}

/** Each quoted title that follows a cited `test/….test.ts` path in a **Pinned by.** field. A
 * backtick code span is consumed whole (a path sets the current file, anything else is skipped),
 * and a quote before any test path is ignored. */
function citedTitles(pinned: string): { file: string; title: string }[] {
  const cited: { file: string; title: string }[] = [];
  let file: string | undefined;
  for (const match of pinned.matchAll(/`([^`]*)`|"([^"]+)"/g)) {
    if (match[1] !== undefined) {
      if (/^test\/.*\.test\.ts$/.test(match[1])) file = match[1];
    } else if (file !== undefined && match[2] !== undefined) {
      cited.push({ file, title: collapse(match[2]) });
    }
  }
  return cited;
}

function readRepoFile(rel: string): string | undefined {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return undefined;
  }
}

/** Every way the register breaks its own promise, as one message per problem; empty means
 * honest. Names the entry and the field so a failure points at the edit that broke it. */
function invariantProblems(
  md: string,
  readTest: (rel: string) => string | undefined = readRepoFile,
): string[] {
  const problems: string[] = [];
  const matches = [...md.matchAll(HEADING_RE)];
  if (matches.length === 0) {
    return ["register holds no `### INV-…:` entries"];
  }
  const firstSeen = new Map<string, number>();
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (match === undefined) continue;
    const id = match[1] ?? "(unreadable id)";
    const start = match.index;
    if (start === undefined) continue;
    const next = matches[i + 1];
    const end = next?.index ?? md.length;
    const body = md.slice(start, end);
    const label = `${id} (entry ${i + 1})`;
    if (!ID_RE.test(id)) {
      problems.push(`${label}: malformed id, expected e.g. INV-A1 or INV-AA1`);
    }
    const earlier = firstSeen.get(id);
    if (earlier !== undefined) {
      problems.push(`${label}: duplicate id, first at entry ${earlier}`);
    } else {
      firstSeen.set(id, i + 1);
    }
    for (const field of ["**Guarantee.**", "**Binds.**", "**Pinned by.**"]) {
      if (!body.includes(field)) problems.push(`${label}: missing ${field} field`);
    }
    const paths = citedPaths(body);
    // The pin must be in the **Pinned by.** field: a `test/*.test.ts` path cited only in the
    // Guarantee or Binds prose is not a pin, even though `citedPaths` above (which feeds the
    // existence check) sees every cited path.
    const pinnedAt = body.indexOf("**Pinned by.**");
    const pins = citedPaths(pinnedAt >= 0 ? body.slice(pinnedAt) : "").filter(
      (p) => p.startsWith("test/") && p.endsWith(".test.ts"),
    );
    if (pins.length === 0) {
      problems.push(`${label}: **Pinned by.** cites no test/*.test.ts path`);
    }
    for (const cited of paths) {
      if (!fs.existsSync(path.join(ROOT, cited))) {
        problems.push(`${label}: cited path does not exist: ${cited}`);
      }
    }
    const titlesByFile = new Map<string, string[] | undefined>();
    for (const { file, title } of citedTitles(pinnedAt >= 0 ? body.slice(pinnedAt) : "")) {
      if (!titlesByFile.has(file)) {
        const source = readTest(file);
        titlesByFile.set(file, source === undefined ? undefined : testTitles(source));
      }
      const titles = titlesByFile.get(file);
      if (titles === undefined) continue;
      if (!titles.some((t) => titleMatches(title, t))) {
        problems.push(`${label}: cited test title not found in ${file}: "${title}"`);
      }
    }
  }
  return problems;
}

/** Gating test files allowed to name a live-host probe or a real bind, each with the reason it
 * is not one. Kept explicit and small: a new gating test that reaches the host must be added
 * here with its reason rather than slip through. */
const HERMETIC_ALLOWLIST: Record<string, string> = {
  "test/process.test.ts": "reads /proc through an injected fs seam, never the host",
  "test/run-marker.test.ts": "reads /proc through an injected fs seam, never the host",
  "test/host-sleep.test.ts": "reads the uptime pseudo-file through an injected fs seam, never the host",
  "test/cli-gui.test.ts": "binds a loopback listener to prove the GUI's port probe sees it taken",
  "test/cli-start-window.test.ts": "binds a loopback listener to hold the run window's port",
};

/** `/proc` is assembled, not written, so this guard's own source does not match the needle it
 * hunts for when the scan reads it. */
const PROC_DIR = "/pro" + "c/";

/** A live-host probe spawn: a spawn/exec call whose literal command is `lsof`, `top`, or
 * `sysctl` (the `[A-Za-z]*` admits `execFileAsync` and friends). */
const LIVE_HOST_RE = /\b(?:spawn|exec)[A-Za-z]*\s*\(\s*["'`](?:lsof|top|sysctl)["'`]/;

/** A real listener bind: a `.listen` method call or a `createServer` call. */
const LISTENER_RE = /\.[ \t]*listen\s*\(|createServer\s*\(/;

/** Every gating-tier hermeticity problem, one message per file; empty means hermetic. Gating
 * sources are `*.test.ts` except `*.e2e.test.ts` (the e2e tier owns the live host). A passed
 * allowlist entry whose file no longer matches is reported stale, so an exception cannot linger
 * after the probe it excused is gone. */
function hermeticProblems(
  files: { path: string; text: string }[],
  allowlist: Record<string, string> = HERMETIC_ALLOWLIST,
): string[] {
  const problems: string[] = [];
  for (const { path: file, text } of files) {
    if (!file.endsWith(".test.ts") || file.endsWith(".e2e.test.ts")) continue;
    const probe = LIVE_HOST_RE.test(text) || text.includes(PROC_DIR);
    const listener = LISTENER_RE.test(text);
    const reason = allowlist[file];
    if (reason !== undefined) {
      if (!probe && !listener) problems.push(`${file}: allowlist entry is stale (${reason})`);
      continue;
    }
    if (probe) problems.push(`${file}: probes the live host in the gating tier (lsof/top/sysctl//proc)`);
    if (listener) problems.push(`${file}: binds a real listener in the gating tier`);
  }
  return problems;
}

/** Every gating test source under `test/`, recursively, as `test/...`-relative path/text
 * pairs. e2e sources are skipped, not enumerated: the e2e tier is where the live host lives. */
function gatingTestSources(): { path: string; text: string }[] {
  const sources: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".test.ts") && !entry.name.endsWith(".e2e.test.ts")) {
        sources.push({ path: path.relative(ROOT, full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(path.join(ROOT, "test"));
  return sources;
}

function register(entries: string): string {
  return `# Invariants\n\n## Cross-surface agreement\n\n${entries}`;
}

function entry(id: string, opts: { guarantee?: boolean; binds?: boolean; pinned?: boolean; paths?: string[] } = {}): string {
  const { guarantee = true, binds = true, pinned = true, paths = ["test/backlog-structure.test.ts"] } = opts;
  return [
    `### ${id}: synthetic`,
    "",
    ...(guarantee ? ["**Guarantee.** Something holds."] : []),
    ...(binds ? ["**Binds.** `src/backlog/backlog-structure.ts`."] : []),
    ...(pinned ? [`**Pinned by.** ${paths.map((p) => `\`${p}\``).join(" and ")}.`] : []),
    "",
  ].join("\n");
}

test("a clean register yields no problems", () => {
  assert.deepEqual(invariantProblems(register(entry("INV-A1"))), []);
});

test("a malformed id is reported", () => {
  const problems = invariantProblems(register(entry("INV-a1")));
  assert.ok(problems.some((p) => p.includes("malformed id")), problems.join("; "));
});

test("a duplicate id is reported at the second entry", () => {
  const problems = invariantProblems(register(entry("INV-A1") + entry("INV-A1")));
  assert.ok(problems.some((p) => p.includes("duplicate id, first at entry 1")), problems.join("; "));
});

test("each missing field label is reported", () => {
  const problems = invariantProblems(
    register(
      entry("INV-A1", { guarantee: false }) +
        entry("INV-A2", { binds: false }) +
        entry("INV-A3", { pinned: false }),
    ),
  );
  assert.ok(problems.some((p) => p.includes("INV-A1") && p.includes("missing **Guarantee.**")), problems.join("; "));
  assert.ok(problems.some((p) => p.includes("INV-A2") && p.includes("missing **Binds.**")), problems.join("; "));
  assert.ok(problems.some((p) => p.includes("INV-A3") && p.includes("missing **Pinned by.**")), problems.join("; "));
});

test("a Pinned by line with no test/*.test.ts citation is reported", () => {
  const problems = invariantProblems(register(entry("INV-A1", { paths: ["src/backlog/backlog-structure.ts"] })));
  assert.ok(problems.some((p) => p.includes("cites no test/*.test.ts path")), problems.join("; "));
});

test("a cited path that does not exist is reported", () => {
  const problems = invariantProblems(register(entry("INV-A1", { paths: ["test/does-not-exist.test.ts"] })));
  assert.ok(problems.some((p) => p.includes("cited path does not exist: test/does-not-exist.test.ts")), problems.join("; "));
});

test("an empty register is reported", () => {
  assert.deepEqual(invariantProblems("# Invariants\n\n_None yet._\n"), ["register holds no `### INV-…:` entries"]);
});

test("a test path cited outside **Pinned by.** does not satisfy the pin check", () => {
  const md = [
    "# Invariants",
    "",
    "## Cross-surface agreement",
    "",
    "### INV-A1: synthetic",
    "",
    "**Guarantee.** Something holds, as `test/backlog-structure.test.ts` shows.",
    "",
    "**Binds.** `src/backlog/backlog-structure.ts`.",
    "",
    "**Pinned by.** the run that follows.",
    "",
  ].join("\n");
  const problems = invariantProblems(md);
  assert.ok(problems.some((p) => p.includes("cites no test/*.test.ts path")), problems.join("; "));
});

const PIN = "test/backlog-structure.test.ts";
const stub = (source: string) => (rel: string) => (rel === PIN ? source : undefined);
const pinnedEntry = (pinned: string): string =>
  register(
    [
      "### INV-A1: synthetic",
      "",
      "**Guarantee.** Something holds.",
      "",
      "**Binds.** `src/backlog/backlog-structure.ts`.",
      "",
      `**Pinned by.** ${pinned}`,
      "",
    ].join("\n"),
  );

test("a quoted title that no test in the cited file carries is reported", () => {
  const readTest = stub('test("the real title", () => {});');
  const problems = invariantProblems(pinnedEntry(`\`${PIN}\` — "the old title"`), readTest);
  assert.equal(problems.length, 1, problems.join("; "));
  assert.ok(
    problems[0]?.includes("INV-A1") && problems[0].includes(PIN) && problems[0].includes('"the old title"'),
    problems.join("; "),
  );
  assert.deepEqual(invariantProblems(pinnedEntry(`\`${PIN}\` — "the real title"`), readTest), []);
});

test("a wrapped, truncated or template-expanded citation matches its test", () => {
  const readTest = stub(
    'test("the real title", () => {});\ntest(`a commit made in the ${label} follow-up folds`, () => {});',
  );
  const check = (cite: string): string[] => invariantProblems(pinnedEntry(`\`${PIN}\` — ${cite}`), readTest);
  assert.deepEqual(check('"the real\n  title"'), []);
  assert.deepEqual(check('"the real…"'), []);
  assert.deepEqual(check('"a commit made in the missing-SUMMARY follow-up folds"'), []);
  assert.equal(check('"a commit made in the  follow-up folds"').length, 1);
});

test("quotes inside a code span and before any test path are not titles", () => {
  const readTest = stub('test("the real title", () => {});');
  assert.deepEqual(
    invariantProblems(pinnedEntry(`\`${PIN}\` — "the real title" (reads \`helpTopic("config")\`)`), readTest),
    [],
  );
  assert.deepEqual(
    invariantProblems(pinnedEntry(`"not a title" then \`${PIN}\` — "the real title"`), readTest),
    [],
  );
});

test("this repo's docs/invariants.md is honest", () => {
  const md = fs.readFileSync(DOC, "utf8");
  assert.deepEqual(invariantProblems(md), []);
});

// The planted fixtures are assembled from parts so this file's own source does not carry the
// probe/bind patterns the scan hunts for — the scan reads every gating source, this one included.
const planted = (parts: string[]): string => parts.join("");

test("a planted live-host probe and a planted listener bind are reported; an e2e source is not", () => {
  const probe = hermeticProblems([
    { path: "test/planted.test.ts", text: planted(["spawn", '("lsof", [])']) },
  ]);
  assert.ok(
    probe.some((p) => p.includes("test/planted.test.ts") && p.includes("live host")),
    probe.join("; "),
  );
  const bind = hermeticProblems([{ path: "test/planted.test.ts", text: planted(["probe.", "listen(0)"]) }]);
  assert.ok(bind.some((p) => p.includes("real listener")), bind.join("; "));
  const e2e = hermeticProblems([
    {
      path: "test/planted.e2e.test.ts",
      text: planted(["spawn", '("lsof", [])']) + planted(["probe.", "listen(0)"]),
    },
  ]);
  assert.deepEqual(e2e, []);
});

test("an allowlisted file that no longer probes or binds is reported as stale", () => {
  const problems = hermeticProblems([{ path: "test/allowlisted.test.ts", text: "const x = 1;" }], {
    "test/allowlisted.test.ts": "was a probe",
  });
  assert.ok(problems.some((p) => p.includes("allowlist entry is stale")), problems.join("; "));
});

test("this repo's gating test sources probe no live host and bind no real listener", () => {
  const problems = hermeticProblems(gatingTestSources());
  assert.deepEqual(problems, []);
});
