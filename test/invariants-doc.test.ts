import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** docs/invariants.md — the citation and id guard behind the register's "Keep it honest"
 * paragraph. The register promises every invariant a stable `INV-…` id, the three field labels,
 * and a resolvable `test/...` citation, but nothing enforced it: a renamed test, a moved module,
 * or a copied entry would turn the register the fleet reads into silent drift. The helpers below
 * parse the document and name each broken entry, and the last test pins the register as it stands.
 * Tests only; no source change. */

const DOC = fileURLToPath(new URL("../../docs/invariants.md", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const ID_RE = /^INV-[A-Z]\d+$/;
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

/** Every way the register breaks its own promise, as one message per problem; empty means
 * honest. Names the entry and the field so a failure points at the edit that broke it. */
function invariantProblems(md: string): string[] {
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
      problems.push(`${label}: malformed id, expected e.g. INV-A1`);
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
  }
  return problems;
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

test("this repo's docs/invariants.md is honest", () => {
  const md = fs.readFileSync(DOC, "utf8");
  assert.deepEqual(invariantProblems(md), []);
});
