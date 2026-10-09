/** docs/code-metrics/categories-tumwater.cjs — the path → category map behind the published
 * repository breakdown in docs/code-metrics.md. It had no test of its own (grep for its name or
 * its only export found none), yet `analyze.cjs` filters tracked files on `category(f) !== null`
 * and sums the buckets, so a wrong prefix order or a missing fallback silently misreports the
 * metrics. It is CommonJS outside dist/, so it is imported lazily by URL (the same trick
 * test/live-fixture.test.ts uses), keeping the .cjs specifier out of tsc's resolution. */

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const CATEGORIES = fileURLToPath(new URL("../../docs/code-metrics/categories-tumwater.cjs", import.meta.url));

type Category = (file: string) => string;

async function loadCategory(): Promise<Category> {
  const mod = (await import(pathToFileURL(CATEGORIES).href)) as { default: Category };
  return mod.default;
}

test("classifies a path by its longest-matching rule", async () => {
  const category = await loadCategory();
  const cases: Array<[string, string]> = [
    // The pipeline's own files are tooling, even when they look like prose.
    ["docs/code-metrics/analyze.cjs", "docs:tooling"],
    ["docs/code-metrics/categories-tumwater.cjs", "docs:tooling"],
    ["docs/code-metrics/README.md", "docs:tooling"],
    // src/ui must win over the src prefix, or the UI split collapses into the general bucket.
    ["src/ui/tui/tui.tsx", "src/ui"],
    ["src/ui/gui/gui-client.ts", "src/ui"],
    ["src/cli.ts", "src"],
    ["src/backlog/backlog.ts", "src"],
    // A test spec is the narrowed case; every other test/ file is support.
    ["test/backlog.test.ts", "test:spec"],
    ["test/helpers/cli-harness.ts", "test:support"],
    ["test/fixtures/repo-fixtures.ts", "test:support"],
    // scripts/ plus the one root config the project treats as a script.
    ["scripts/release.mjs", "scripts"],
    ["scripts/diff-check.mjs", "scripts"],
    ["eslint.config.js", "scripts"],
    [".github/workflows/ci.yml", "ci"],
    // Backlog paths beat the generic .md prose rule.
    ["BUGS.md", "docs:backlog"],
    ["PLANS.md", "docs:backlog"],
    ["QUESTIONS.md", "docs:backlog"],
    ["plans/model-tiers.md", "docs:backlog"],
    // Remaining prose.
    ["README.md", "docs:prose"],
    ["docs/how-it-works.md", "docs:prose"],
    ["LICENSE", "docs:prose"],
    // Everything else is still counted.
    ["package.json", "config/other"],
    ["tsconfig.json", "config/other"],
    ["tumwater.json", "config/other"],
  ];
  for (const [file, expected] of cases) {
    assert.equal(category(file), expected, file);
  }
});

test("never returns null, so no tracked file vanishes from the breakdown", async () => {
  const category = await loadCategory();
  const known = new Set(["docs:tooling", "src/ui", "src", "test:spec", "test:support", "scripts", "ci", "docs:backlog", "docs:prose", "config/other"]);
  const paths = [
    "",
    "unknown.txt",
    "src/ui",
    "src",
    "test/",
    "plans/",
    ".github/",
    "LICENSE-OTHER",
    "CHANGELOG.md",
  ];
  for (const file of paths) {
    const got = category(file);
    assert.equal(typeof got, "string", file);
    assert.ok(known.has(got), `${file} -> ${got} is not a known category`);
  }
});
