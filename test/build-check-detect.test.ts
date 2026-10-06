import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir, writeMalformedJson } from "./repo-fixtures.js";
import { buildCheckFixture } from "./loop-fixtures.js";
import { projManifest } from "./fake-commands.js";
import {
  BUILD_CHECK_TIMEOUT_MS,
  detectBuildCheck,
  gateCommandOf,
  resolveFromNodeModules,
} from "../src/build-check/build-check-detect.js";

// build-check-detect.ts is the pure-filesystem half of the build check: it decides WHERE the
// deterministic check lives (the nearest ancestor holding both package.json and node_modules)
// and WHICH npm script it names, or defers to a configured `check.command`. Every gate that
// keeps a broken tree off main (doctor, main-baseline, the review gate) reads its verdict, so
// a wrong walk or a false-green script selection silently turns the safety checks off. These
// tests pin the contract on real temp directories: script preference, the blank-value fall-
// through, the walk-up bound, the "first qualifying root wins" rule, and the config-command
// override that must beat the walk for non-JS repos.

/** Make `dir` look like an installed JS project root: package.json with `scripts` plus a real
 * node_modules/ directory (hasInstall requires both, and requires node_modules to be a dir). */
/** The role id buildCheckFixture names its worktree after (the walk-up tests start from
 * a fixture-shaped `.tumwater/worktrees/<role>` path). */
const ROLE = "improve";

function installRoot(scripts: Record<string, string | undefined>): string {
  const dir = tmpdir("tumwater-bcd-");
  fs.mkdirSync(path.join(dir, "node_modules"));
  const body: Record<string, unknown> = { name: "fixture", version: "0.0.0" };
  if (Object.keys(scripts).length > 0) body.scripts = scripts;
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(body));
  return dir;
}

test("a configured check.command wins over the walk-up and carries cwd and timeout", () => {
  const start = tmpdir("tumwater-bcd-");
  const check = detectBuildCheck(start, { check: { command: "cargo test", cwd: "sub", timeoutSeconds: 42 } });
  assert.deepEqual(check, {
    kind: "command",
    command: "cargo test",
    cwd: path.resolve(start, "sub"),
    timeoutMs: 42_000,
  });
});

test("a command without timeoutSeconds gets the shared 300 s cap; invalid values fall to it too", () => {
  const start = tmpdir("tumwater-bcd-");
  const check = detectBuildCheck(start, { check: { command: "make test" } });
  assert.equal(check?.kind, "command");
  if (check?.kind === "command") {
    assert.equal(check.timeoutMs, BUILD_CHECK_TIMEOUT_MS);
    assert.equal(check.cwd, start, "blank cwd resolves to the start directory itself");
  }
  for (const bad of [0, -5]) {
    const c = detectBuildCheck(start, { check: { command: "make test", timeoutSeconds: bad } });
    assert.equal(c?.kind, "command");
    if (c?.kind === "command") assert.equal(c.timeoutMs, BUILD_CHECK_TIMEOUT_MS, "non-positive timeoutSeconds falls to the default");
  }
});

test("a blank command falls through to the walk-up instead of disabling the check", () => {
  const root = installRoot({ test: "node --test" });
  const check = detectBuildCheck(path.join(root, "nested", "deep"), { check: { command: "   " } });
  assert.deepEqual(check, { kind: "npm", rootDir: root, script: "test" });
});

test("the walk-up finds the nearest ancestor with package.json AND node_modules", () => {
  const root = installRoot({ test: "node --test" });
  const deep = path.join(root, "a", "b", "c");
  fs.mkdirSync(deep, { recursive: true });
  assert.deepEqual(detectBuildCheck(deep), { kind: "npm", rootDir: root, script: "test" });
});

test("scripts.test is preferred, then typecheck, then build", () => {
  const root = installRoot({ test: "npm test", typecheck: "tsc", build: "tsc && node --test" });
  assert.deepEqual(detectBuildCheck(root), { kind: "npm", rootDir: root, script: "test" });

  const tc = installRoot({ typecheck: "tsc", build: "tsc" });
  assert.deepEqual(detectBuildCheck(tc), { kind: "npm", rootDir: tc, script: "typecheck" });

  const bd = installRoot({ build: "make" });
  assert.deepEqual(detectBuildCheck(bd), { kind: "npm", rootDir: bd, script: "build" });
});

test("a whitespace-only script value is skipped, not trusted — npm run of it would exit 0 unverified", () => {
  const root = installRoot({ test: "   ", typecheck: "\t\n", build: "make" });
  assert.deepEqual(detectBuildCheck(root), { kind: "npm", rootDir: root, script: "build" });
});

test("an ancestor with package.json but NO node_modules does not qualify — the walk skips it", () => {
  const outer = installRoot({ test: "node --test" });
  const nested = path.join(outer, "nested-pkg", "kid");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(outer, "nested-pkg", "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  // nested-pkg holds a package.json but no node_modules, so it is not a qualifying root; the
  // walk from kid climbs past it to the installed outer root.
  assert.deepEqual(detectBuildCheck(nested), { kind: "npm", rootDir: outer, script: "test" });
});

test("the FIRST qualifying directory is the project: no scripts there means null, never an unrelated ancestor", () => {
  const outer = installRoot({ test: "node --test" });
  const inner = path.join(outer, "subproject");
  fs.mkdirSync(path.join(inner, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(inner, "package.json"), JSON.stringify({ name: "no-scripts" }));
  assert.equal(detectBuildCheck(inner), null);
});

test("a malformed or JSON-null package.json yields null instead of throwing into the gate", () => {
  const root = tmpdir("tumwater-bcd-");
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "package.json"), "{not json");
  assert.equal(detectBuildCheck(root), null);

  const nullRoot = tmpdir("tumwater-bcd-");
  fs.mkdirSync(path.join(nullRoot, "node_modules"));
  fs.writeFileSync(path.join(nullRoot, "package.json"), "null");
  assert.equal(detectBuildCheck(nullRoot), null, "JSON.parse('null') succeeds — the isJsonObject guard must catch it");
});

test("no qualifying ancestor within the bound means null", () => {
  const bare = tmpdir("tumwater-bcd-");
  fs.mkdirSync(path.join(bare, "x", "y"), { recursive: true });
  assert.equal(detectBuildCheck(path.join(bare, "x", "y")), null);
});

test("maxLevels bounds the climb: the root one level too deep is never used", () => {
  const root = installRoot({ test: "node --test" });
  const deep = path.join(root, "a", "b");
  fs.mkdirSync(deep, { recursive: true });
  // root is 2 ancestors up; a bound of 1 must miss it.
  assert.equal(detectBuildCheck(deep, undefined, 1), null);
  assert.deepEqual(detectBuildCheck(deep, undefined, 2), { kind: "npm", rootDir: root, script: "test" });
});

test("gateCommandOf: on for a real string, off for blank or missing", () => {
  assert.equal(gateCommandOf({ check: { command: "npm test", gateCommand: "npm run typecheck" } }), "npm run typecheck");
  assert.equal(gateCommandOf({ check: { command: "npm test", gateCommand: "  " } }), undefined);
  assert.equal(gateCommandOf({ check: { command: "npm test" } }), undefined);
  assert.equal(gateCommandOf({}), undefined);
  assert.equal(gateCommandOf(), undefined);
});

test("resolveFromNodeModules finds the nearest install's path, walking up like npm does", () => {
  const root = tmpdir("tumwater-bcd-");
  fs.mkdirSync(path.join(root, "node_modules", "typescript"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "typescript", "package.json"), "{}");
  const deep = path.join(root, "a", "b");
  fs.mkdirSync(deep, { recursive: true });

  const expected = path.join(root, "node_modules", "typescript");
  assert.equal(resolveFromNodeModules(deep, "typescript"), expected);
  assert.equal(resolveFromNodeModules(root, "typescript"), expected);
  assert.equal(resolveFromNodeModules(root, "typescript/package.json"), path.join(expected, "package.json"));
  assert.equal(resolveFromNodeModules(root, "no-such-package"), null);
});

test("resolveFromNodeModules honors maxLevels and never throws from a bare start", () => {
  const root = tmpdir("tumwater-bcd-");
  fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
  const deep = path.join(root, "a", "b");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(resolveFromNodeModules(deep, "x", 1), null);
  assert.equal(resolveFromNodeModules(deep, "x", 2), path.join(root, "node_modules", "x"));
});
test("detectBuildCheck walks up from a worktree without node_modules to the installed project root", () => {
  const { root, wt } = buildCheckFixture();
  assert.deepEqual(detectBuildCheck(wt), { kind: "npm", rootDir: root, script: "build" });
});

test("detectBuildCheck returns the NEAREST qualifying ancestor when several qualify", () => {
  const base = tmpdir("buildcheck-nearest-");
  const outer = path.join(base, "outer");
  const inner = path.join(outer, "inner");
  for (const [dir, script] of [
    [outer, "echo outer"],
    [inner, "echo inner"],
  ] as const) {
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: script } }));
  }
  // Start from a worktree-shaped path below the inner root — inner is closer and must win.
  const start = path.join(inner, ".tumwater", "worktrees", ROLE);
  fs.mkdirSync(start, { recursive: true });
  assert.deepEqual(detectBuildCheck(start), { kind: "npm", rootDir: inner, script: "build" });
});

// --- detectBuildCheck semantics: preference, first-qualifying-directory-wins, and failure modes.
// These are documented in src/build-check/build-check.ts but were untested; the first-qualifier rule is the
// load-bearing one — skipping past a scriptless installed project to an unrelated ancestor would
// run THAT project's build script against this worktree (or nothing of this project at all).

test("detectBuildCheck prefers test over typecheck and build when all three scripts are declared", () => {
  const base = tmpdir("buildcheck-pref-");
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });

  // All three declared: test wins — npm convention makes `npm test` the canonical verify command.
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ build: "b", typecheck: "t", test: "x" }),
  );
  assert.deepEqual(detectBuildCheck(root), { kind: "npm", rootDir: root, script: "test" });

  // Without a test script the old preference stands: typecheck over build.
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ build: "b", typecheck: "t" }),
  );
  assert.deepEqual(detectBuildCheck(root), { kind: "npm", rootDir: root, script: "typecheck" });
});

test("detectBuildCheck stops at the first qualifying directory even when it declares no check script", () => {
  const base = tmpdir("buildcheck-first-qualifies-");
  const outer = path.join(base, "outer"); // installed and HAS a build script — must never be used
  fs.mkdirSync(path.join(outer, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(outer, "package.json"),
    JSON.stringify({ name: "other", version: "1.0.0", scripts: { build: "echo other-project" } }),
  );
  const project = path.join(outer, "project"); // installed but scriptless — the first qualifier
  fs.mkdirSync(path.join(project, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0" }),
  );
  const wt = path.join(project, ".tumwater", "worktrees", ROLE);
  fs.mkdirSync(wt, { recursive: true });

  assert.equal(detectBuildCheck(wt), null, "no check — the scriptless project wins over its ancestor");
});

test("detectBuildCheck tolerates a malformed or scriptless package.json without throwing", () => {
  const base = tmpdir("buildcheck-malformed-");
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });

  // Unparseable JSON at the qualifying directory: no check, and detection never throws into the gate.
  writeMalformedJson(path.join(root, "package.json"));
  assert.equal(detectBuildCheck(root), null);

  // Valid JSON that is not an object must not throw: reading `.scripts` off the null from
  // JSON.parse("null") would otherwise escape detection, which callers rely on never throwing.
  for (const raw of ["null", "true", '"proj"', "[1,2]"]) {
    fs.writeFileSync(path.join(root, "package.json"), raw);
    assert.equal(detectBuildCheck(root), null, `non-object package.json ${raw} must not throw`);
  }

  // A scripts object with neither a usable test, typecheck, nor build (empty string / non-string) is no check.
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ test: "", build: "", typecheck: null }),
  );
  assert.equal(detectBuildCheck(root), null);

  // Whitespace-only scripts are empty in effect — `npm run test` on one is a no-op that exits 0,
  // so honoring it would report a false green. All blank → no check.
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ test: "   ", build: "\t\n" }),
  );
  assert.equal(detectBuildCheck(root), null);

  // A blank test still lets a real build be used: the preference order is preserved, not skipped.
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ test: "  ", build: "echo ok" }),
  );
  assert.deepEqual(detectBuildCheck(root), { kind: "npm", rootDir: root, script: "build" });
});

test("detectBuildCheck honors the maxLevels bound and terminates at the filesystem root", () => {
  // No install anywhere up a plain tmpdir chain. Walking 10 levels from here passes through /
  // (tmpdir is only a few levels deep), so this also pins the parent===dir termination: a
  // regression that kept walking past root would loop forever and hang the suite.
  const base = tmpdir("buildcheck-none-");
  const deep = path.join(base, "a", "b", "c");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(detectBuildCheck(deep, undefined, 10), null);

  // The bound is inclusive: an install exactly maxLevels up is found; one level further out is not.
  const chain = tmpdir("buildcheck-bound-");
  let dir = path.join(chain, "l1", "l2", "l3");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(chain, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(chain, "package.json"),
    projManifest({ build: "echo ok" }),
  );
  assert.deepEqual(detectBuildCheck(dir, undefined, 3), { kind: "npm", rootDir: chain, script: "build" });
  assert.equal(detectBuildCheck(dir, undefined, 2), null);
});

// --- resolveFromNodeModules: the same walk-up detectBuildCheck makes, for a dependency the
// harness must locate itself (redeploy's tsc) rather than let npm's PATH walk find.

test("resolveFromNodeModules climbs to an ancestor's install and gives up past the level cap", () => {
  const base = tmpdir("walkup-");
  fs.mkdirSync(path.join(base, "node_modules", "typescript", "bin"), { recursive: true });
  const tsc = path.join(base, "node_modules", "typescript", "bin", "tsc");
  fs.writeFileSync(tsc, "#!/usr/bin/env node\n");
  const nested = path.join(base, "a", "b", "c");
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(resolveFromNodeModules(base, path.join("typescript", "bin", "tsc")), tsc, "found at the start dir");
  assert.equal(resolveFromNodeModules(nested, path.join("typescript", "bin", "tsc")), tsc, "and three levels down");
  assert.equal(resolveFromNodeModules(nested, path.join("typescript", "bin", "tsc"), 2), null, "cap reached first");
  assert.equal(resolveFromNodeModules(nested, "nonesuch"), null, "nothing to find");
});
