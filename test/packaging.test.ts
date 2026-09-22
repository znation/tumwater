import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/** Pin the packaging metadata that makes the npm package publishable and the two workflow
 * triggers, so the landing gate's `npm test` sees a broken allowlist or a missing `prepack`
 * on a metadata-only diff — a diff the suite would otherwise verify nothing about. */

const pkg = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  files?: string[];
  scripts?: Record<string, string>;
  engines?: { node?: string; os?: string[] };
  bin?: Record<string, string>;
};

test("files allowlist ships only the built package", () => {
  assert.deepEqual(pkg.files, ["dist/src", "dist/build-info.json", "README.md", "LICENSE"]);
  for (const entry of pkg.files ?? []) {
    assert.ok(!/^(test|src|plans|docs)\//.test(entry), `files must not ship ${entry}`);
    assert.ok(
      !["PLANS.md", "BUGS.md", "PRINCIPLES.md", "tsconfig.json", "tumwater.json"].includes(entry),
      `files must not ship ${entry}`,
    );
  }
});

test("prepack builds the tarball's dist/", () => {
  assert.equal(pkg.scripts?.prepack, "npm run build");
});

test("engines state the real floor and the supported platforms", () => {
  assert.equal(pkg.engines?.node, ">=20.3");
  for (const os of ["darwin", "linux"]) assert.ok(pkg.engines?.os?.includes(os), `missing ${os}`);
  assert.ok(!pkg.engines?.os?.includes("win32"), "win32 is out of scope");
});

test("bin points into dist/", () => {
  assert.ok(pkg.bin?.tumwater?.startsWith("dist/"), "bin.tumwater must point into dist/");
});

test("CI workflow carries the stable triggers", () => {
  const yml = fs.readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  for (const needle of ["pull_request", "ubuntu-latest", "macos-latest"]) {
    assert.ok(yml.includes(needle), `ci.yml must mention ${needle}`);
  }
});

test("release workflow is tag-driven on v*", () => {
  const yml = fs.readFileSync(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.ok(yml.includes("'v*'"), "release.yml must trigger on v* tags");
});
