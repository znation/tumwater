import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// tumwater is a public package: every dependency in package-lock.json must resolve from the
// public npm registry. A contributor's ~/.npmrc pointing at a private mirror would otherwise
// leak that mirror's URL into the lockfile (and break installs for everyone else); the
// repo's .npmrc pins the registry, and this pins the lockfile.

test("package-lock.json resolves every package from the public npm registry", () => {
  const lock = JSON.parse(
    fs.readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
  ) as { packages: Record<string, { resolved?: string }> };
  const offRegistry = Object.entries(lock.packages)
    .filter(([, pkg]) => pkg.resolved !== undefined && !pkg.resolved.startsWith("https://registry.npmjs.org/"))
    .map(([name, pkg]) => `${name}: ${pkg.resolved}`);
  assert.deepEqual(offRegistry, []);
});

test(".npmrc pins the public npm registry", () => {
  const npmrc = fs.readFileSync(new URL("../../.npmrc", import.meta.url), "utf8");
  assert.match(npmrc, /^registry=https:\/\/registry\.npmjs\.org\/$/m);
});
