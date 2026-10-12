import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildDepGraph, selectAffected } from "./affected-tests.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// The affected-test selector behind `npm run test:gate` (test/affected-tests.ts), pinned on a
// synthetic checkout: TypeScript sources (whose existence maps compiled files back to them) and
// a hand-written dist/ in the shape tsc emits.

/** A checkout holding `files` (repo-relative path → content). Every `dist/<x>.js` also gets the
 * `<x>.ts` source it maps back to. */
function checkout(files: Record<string, string>): string {
  const root = tmpdir("affected-");
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
    const source = /^dist\/(.+)\.js$/.exec(rel);
    if (source) {
      fs.mkdirSync(path.dirname(path.join(root, `${source[1]}.ts`)), { recursive: true });
      fs.writeFileSync(path.join(root, `${source[1]}.ts`), "");
    }
  }
  return root;
}

function select(root: string, changed: string[]) {
  return selectAffected(buildDepGraph(path.join(root, "dist"), root), changed);
}

/** A small product with two modules, a helper, and tests over each. */
function product(): string {
  return checkout({
    "dist/src/a.js": 'import { b } from "./b.js";\nexport const a = b;\n',
    "dist/src/b.js": "export const b = 1;\n",
    "dist/src/c.js": "export const c = 2;\n",
    "dist/test/helpers/h.js": 'export { a } from "../../src/a.js";\n',
    "dist/test/a.test.js": 'import { a } from "./helpers/h.js";\n',
    "dist/test/c.test.js": 'import { c } from "../src/c.js";\n',
    "dist/test/live.e2e.test.js": 'import { b } from "../src/b.js";\n',
  });
}

test("a change selects the tests whose imports reach it, through helpers, and nothing else", () => {
  const root = product();
  assert.deepEqual(select(root, ["src/b.ts"]).tests, ["test/a.test.ts"], "b → a → helper → a.test, never the e2e tier");
  assert.deepEqual(select(root, ["src/c.ts"]).tests, ["test/c.test.ts"]);
  assert.deepEqual(select(root, ["test/c.test.ts"]).tests, ["test/c.test.ts"], "a changed test selects itself");
  assert.deepEqual(select(root, ["src/gone.ts"]).tests, [], "a deleted module nothing imports reaches no test");
});

test("documentation and lint configuration select no tests; machinery and unmapped files select the full suite", () => {
  const root = product();
  assert.deepEqual(select(root, ["README.md", "docs/guide.md", "eslint.config.js"]).tests, []);
  assert.match(select(root, ["src/c.ts", "package.json"]).reason ?? "", /package\.json changed/);
  assert.match(select(root, ["test/test-runner.ts"]).reason ?? "", /test-runner\.ts changed/);
  assert.match(select(root, ["scripts/deploy.sh"]).reason ?? "", /no test's dependencies name it/);
});

test("files named through new URL(…, import.meta.url) are dependencies, and a directory is a prefix", () => {
  const root = checkout({
    "docs/tool.cjs": 'module.exports = require("./lib.cjs");\n',
    "docs/lib.cjs": "module.exports = 1;\n",
    "dist/src/ext/one.js": "export {};\n",
    "dist/src/args.js": 'export const f = (n) => new URL(`../src/ext/${n}`, import.meta.url);\n',
    "dist/test/tool.test.js": 'const TOOL = new URL("../../docs/tool.cjs", import.meta.url);\n',
    "dist/test/plans.test.js": 'const P = new URL("../../PLANS.md", import.meta.url);\n',
    "dist/test/args.test.js": 'import { f } from "../src/args.js";\n',
    "dist/test/tree.test.js": 'const SRC = new URL("../src", import.meta.url);\n',
  });
  assert.deepEqual(select(root, ["docs/lib.cjs"]).tests, ["test/tool.test.ts"], "require edges inside docs/ count");
  assert.deepEqual(select(root, ["PLANS.md"]).tests, ["test/plans.test.ts"], "a doc a test reads is a dependency");
  assert.deepEqual(select(root, ["src/ext/one.ts"]).tests, ["test/args.test.ts", "test/tree.test.ts"], "template and directory URLs");
});

test("a test that scans the tree runs on any code change, but not on a doc change", () => {
  const root = checkout({
    "dist/src/a.js": "export const a = 1;\n",
    "dist/test/layering.test.js": 'import fs from "node:fs";\nfs.readdirSync(ROOT);\n',
    "dist/test/a.test.js": 'import { a } from "../src/a.js";\n',
  });
  assert.deepEqual(select(root, ["src/a.ts"]).tests, ["test/a.test.ts", "test/layering.test.ts"]);
  assert.deepEqual(select(root, ["NOTES.md"]).tests, []);
});

test("the CLI binary is resolved per command at each call site", () => {
  const root = checkout({
    "dist/src/cli.js": [
      'import { core } from "./core.js";',
      "switch (command) {",
      '    case "logs": {',
      '        const { cmdLogs } = await import("./logs.js");',
      "        break;",
      "    }",
      '    case "wake":',
      "    // the marker commands share one body",
      '    case "pause": {',
      '        await (await import("./markers.js")).run();',
      "        break;",
      "    }",
      '    case "status":',
      '        await (await import("./status.js")).cmdStatus();',
      "        break;",
      "}",
    ].join("\n"),
    "dist/src/core.js": "export const core = 1;\n",
    "dist/src/logs.js": "export {};\n",
    "dist/src/markers.js": "export {};\n",
    "dist/src/status.js": "export {};\n",
    "dist/test/helpers/cli-harness.js": 'export const CLI = new URL("../../src/cli.js", import.meta.url);\n',
    "dist/test/logs.test.js": [
      'import { cli, spawnCli } from "./helpers/cli-harness.js";',
      '// a comment naming the CLI and cli(dir, "status") is not a call',
      'test("the CLI prints logs", async () => { await cli(repo, "logs", "-n", "3"); spawnCli(repo, ["logs", "-f"]); });',
    ].join("\n"),
    "dist/test/wake.test.js": 'import { cliWithEnv } from "./helpers/cli-harness.js";\nawait cliWithEnv(repo, {}, ["wake"]);\n',
    "dist/test/status.test.js": 'import { CLI } from "./helpers/cli-harness.js";\nspawn(process.execPath, [CLI, "status"]);\n',
    "dist/test/any.test.js": 'import { cli } from "./helpers/cli-harness.js";\nfor (const c of cmds) await cli(repo, c);\n',
    "dist/test/direct.test.js": 'const BIN = new URL("../src/cli.js", import.meta.url);\n',
  });
  assert.deepEqual(select(root, ["src/logs.ts"]).tests, ["test/any.test.ts", "test/direct.test.ts", "test/logs.test.ts"]);
  assert.deepEqual(select(root, ["src/markers.ts"]).tests, ["test/any.test.ts", "test/direct.test.ts", "test/wake.test.ts"], "a fallthrough label shares its body's imports");
  assert.deepEqual(select(root, ["src/status.ts"]).tests, ["test/any.test.ts", "test/direct.test.ts", "test/status.test.ts"]);
  assert.deepEqual(
    select(root, ["src/core.ts"]).tests,
    ["test/any.test.ts", "test/direct.test.ts", "test/logs.test.ts", "test/status.test.ts", "test/wake.test.ts"],
    "the dispatcher's static imports load for every command",
  );
});

test("a script that locates files from its own path depends on all of src/", () => {
  const root = checkout({
    "scripts/run.mjs": 'const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "src", "cli.js");\n',
    "dist/src/a.js": "export {};\n",
    "dist/test/script.test.js": 'const SCRIPT = new URL("../../scripts/run.mjs", import.meta.url);\n',
  });
  assert.deepEqual(select(root, ["src/a.ts"]).tests, ["test/script.test.ts"]);
  assert.deepEqual(select(root, ["scripts/run.mjs"]).tests, ["test/script.test.ts"]);
});
