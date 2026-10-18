/** The package bin's executable bit: `npm run build` and `npm test` both end in
 * scripts/stamp-build.mjs, which re-marks dist/src/cli.js +x after every compile — tsc
 * emits it 0644, and the file carries a `#!/usr/bin/env node` shebang, so a checkout
 * developer's direct `./dist/src/cli.js status` needs the bit or dies with EACCES
 * (npm's link/install re-marks bins, but the checkout itself never gains one). The
 * suite runs stamp-build before this file, so an unmarked build fails here — the same
 * rule build-stage.test.ts applies to the tsc shim's own shebang spawn. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readJson } from "./helpers/json-read.js";

// From dist/test/ this is dist/src/cli.js — the compiled file package.json's bin names.
const pkg = readJson(fileURLToPath(new URL("../../package.json", import.meta.url))) as {
  bin: Record<string, string>;
};

test("the compiled package bins keep their executable bits across builds", () => {
  assert.deepEqual(pkg.bin, {
    tumwater: "dist/src/cli.js",
    "tumwater-notes": "dist/src/notes-cli.js",
  });
  for (const script of Object.entries(pkg.bin)) {
    const file = fileURLToPath(new URL(`../src/${script[1].split("/src/")[1]}`, import.meta.url));
    assert.equal(fs.readFileSync(file, "utf8").split("\n")[0], "#!/usr/bin/env node", script[0]);
    fs.accessSync(file, fs.constants.X_OK); // Throws EACCES when the bit is missing.
  }
});
