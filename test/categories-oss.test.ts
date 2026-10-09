/** docs/code-metrics/categories-oss.cjs — the path → category map behind the OSS baseline
 * comparison in docs/code-metrics.md. It had no test (grep for its name across test/ found
 * none), yet `analyze.cjs` filters every tracked OSS file on `category(f) !== null` and sums the
 * buckets, so a wrong rule order or a too-loose prefix silently misreports the comparison. The
 * rules are intricate: markdown is classified before everything else, the production root comes
 * from the REPO row of oss-repos.tsv, and EXCLUDE beats TEST beats the production-root check. It
 * is CommonJS outside dist/, so it is imported lazily by URL (the same trick
 * test/categories-tumwater.test.ts and test/live-fixture.test.ts use), keeping the .cjs specifier
 * out of tsc's resolution. */

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const CATEGORIES = fileURLToPath(new URL("../../docs/code-metrics/categories-oss.cjs", import.meta.url));

type Category = (file: string) => string | null;

const categoryPromise: Promise<Category> = import(pathToFileURL(CATEGORIES).href).then(
  (mod) => (mod as { default: Category }).default,
);

/** Run `fn` with process.env.REPO set to `repo` (undefined deletes it), restoring the prior value
 * afterwards. categories-oss reads the variable at call time, not import time. */
function withRepo<T>(repo: string | undefined, fn: () => T): T {
  const saved = process.env.REPO;
  if (repo === undefined) delete process.env.REPO;
  else process.env.REPO = repo;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.REPO;
    else process.env.REPO = saved;
  }
}

test("rejects a REPO not listed in oss-repos.tsv", async () => {
  const category = await categoryPromise;
  withRepo(undefined, () => {
    assert.throws(() => category("src/index.ts"), /REPO=undefined is not in oss-repos\.tsv/);
  });
  withRepo("definitely-not-a-repo", () => {
    assert.throws(() => category("src/index.ts"), /REPO=definitely-not-a-repo is not in oss-repos\.tsv/);
  });
});

test("classifies paths against the repo's production root and the exclusion/test rules", async () => {
  const category = await categoryPromise;
  // typedoc's production root in oss-repos.tsv is "src/"; yargs' is "lib/".
  const cases: Array<[repo: string, file: string, expected: string | null]> = [
    // Production TypeScript/TSX under the root.
    ["typedoc", "src/index.ts", "src"],
    ["typedoc", "src/nested/deep.tsx", "src"],
    ["typedoc", "src/index.mts", "src"],
    ["typedoc", "src/index.cts", "src"],
    ["yargs", "lib/index.ts", "src"],
    // The root is matched with its trailing slash: a sibling prefix is not production.
    ["typedoc", "srcfoo/index.ts", null],
    ["typedoc", "lib/index.ts", null],
    ["yargs", "src/index.ts", null],
    // Only TypeScript counts as production; JS and declarations do not.
    ["typedoc", "src/index.js", null],
    ["typedoc", "src/index.d.ts", null],
    ["typedoc", "src/index.json", null],
    // Markdown is classified before the root/exclude checks.
    ["typedoc", "src/README.md", "docs:prose"],
    ["typedoc", "CHANGELOG.md", "docs:changelog"],
    ["typedoc", "docs/CHANGELOG-1.md", "docs:changelog"],
    ["typedoc", "node_modules/pkg/README.md", null],
    // Markdown in a test directory still takes the prose branch.
    ["typedoc", "test/fixtures/README.md", "docs:prose"],
    // Test code anywhere wins over the production root.
    ["typedoc", "src/test/foo.ts", "test:spec"],
    ["typedoc", "src/tests/foo.ts", "test:spec"],
    ["typedoc", "src/__tests__/foo.ts", "test:spec"],
    ["typedoc", "src/__testUtils__/foo.ts", "test:spec"],
    ["typedoc", "src/spec/foo.ts", "test:spec"],
    ["typedoc", "src/integration/foo.ts", "test:spec"],
    ["typedoc", "src/fixtures/foo.ts", "test:spec"],
    ["typedoc", "src/foo.test.ts", "test:spec"],
    ["typedoc", "src/foo.spec.tsx", "test:spec"],
    ["typedoc", "src/foo.test.mjs", "test:spec"],
    ["typedoc", "src/foo.test.cjs", "test:spec"],
    // A path both rules match: EXCLUDE is tested first, so it wins over TEST.
    ["typedoc", "src/scripts/foo.test.ts", null],
    // EXCLUDE beats TEST and the root check.
    ["typedoc", "src/examples/foo.ts", null],
    ["typedoc", "src/example/foo.ts", null],
    ["typedoc", "src/samples/foo.ts", null],
    ["typedoc", "src/benchmarks/foo.ts", null],
    ["typedoc", "src/website/foo.ts", null],
    ["typedoc", "src/docs/foo.ts", null],
    ["typedoc", "src/doc/foo.ts", null],
    ["typedoc", "src/scripts/foo.ts", null],
    ["typedoc", "src/resources/foo.ts", null],
    ["typedoc", "src/tools/foo.ts", null],
    ["typedoc", "src/dist/foo.ts", null],
    ["typedoc", "src/dist-raw/foo.ts", null],
    ["typedoc", "src/build/foo.ts", null],
    ["typedoc", "src/node_modules/foo.ts", null],
    ["typedoc", "src/typings/foo.ts", null],
    ["typedoc", "src/client-dist/foo.ts", null],
    ["typedoc", ".github/workflows/ci.ts", null],
    ["typedoc", ".circleci/config.ts", null],
  ];
  for (const [repo, file, expected] of cases) {
    withRepo(repo, () => {
      assert.equal(category(file), expected, `${repo}: ${file}`);
    });
  }
});
