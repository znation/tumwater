import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readJson } from "./helpers/json-read.js";

/** Pin the packaging metadata that makes the npm package publishable and the two workflow
 * triggers, so the merge gate's `npm test` sees a broken allowlist or a missing `prepack`
 * on a metadata-only diff — a diff the suite would otherwise verify nothing about. */

const pkg = readJson(new URL("../../package.json", import.meta.url)) as {
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
  for (const needle of ["pull_request", "ubuntu-latest"]) {
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

test("the README leads with the token warning", () => {
  const readme = fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const title = readme.indexOf("# tumwater");
  const promptStart = readme.indexOf("<!-- tumwater:prompt:start -->");
  const warning = readme.search(/### ⚠️ Warning: tumwater eats tokens/);
  assert.ok(warning > -1, "README must carry the token warning heading");
  assert.ok(readme.includes("billion tokens a day or more"), "README must state the billion-token figure");
  assert.ok(
    warning > title && warning < promptStart,
    "the token warning must sit between the H1 and the prompt block",
  );
});

test("the README's prose outside the brief appendix steers, and its steering section sits between Install and Status", () => {
  const readme = fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  // Everything the README says outside the brief the operator owns.
  const outside = readme.slice(0, readme.indexOf("<!-- tumwater:prompt:start -->"));
  const install = outside.indexOf("\n## Install\n");
  const steering = outside.indexOf("\n## How you work with tumwater\n");
  const status = outside.indexOf("\n## Status\n");
  assert.ok(install > -1 && status > -1, "README must carry an Install and a Status section");
  assert.ok(
    steering > install && steering < status,
    "the steering section must sit between Install and Status",
  );
  const section = outside.slice(steering, status);
  assert.ok(section.includes("[docs/steering.md](docs/steering.md)"), "links the steering guide");
  assert.ok(section.includes("`tumwater guide`"), "names tumwater guide");
  assert.match(section, /your own agent/i, "puts the operator's own agent first");
  // A first-time reader must not learn hands-off is the design.
  assert.ok(!/only write (the brief|the initial prompt)/.test(outside), "no hands-off framing");
  assert.ok(!outside.includes("always-on specialists"), "no hands-off framing");
});

test("every release prepends the token warning and the hand-written notes", () => {
  const yml = fs.readFileSync(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.ok(yml.includes("--generate-notes"), "release.yml must keep --generate-notes");
  assert.ok(yml.includes('--notes "$notes"'), "release.yml must pass the composed --notes");
  assert.ok(yml.includes("cat RELEASE_NOTES.md"), "release.yml must read RELEASE_NOTES.md");
  assert.ok(yml.includes("billion tokens a day or more"), "release.yml's warning must state the billion-token figure");
  assert.ok(yml.includes("Require release notes for this tag"), "release.yml must guard the notes before publishing");
});

test("a release attaches only its own version's tarball", () => {
  const yml = fs.readFileSync(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const create = yml.split("\n").find((line) => line.includes("gh release create")) ?? "";
  assert.ok(create.endsWith(' "tumwater-${GITHUB_REF_NAME#v}.tgz"'), "attach the tag's own tarball by name");
  // v0.4.6 shipped a stale tumwater-0.4.5.tgz committed to the repo because the glob matched it.
  assert.ok(!create.includes("*.tgz"), "a tarball glob attaches any stray .tgz in the checkout");
});
