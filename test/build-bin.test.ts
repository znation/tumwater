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
const bin = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const pkg = readJson(fileURLToPath(new URL("../../package.json", import.meta.url))) as {
  bin: Record<string, string>;
};

test("the compiled package bin keeps its executable bit across builds", () => {
  assert.deepEqual(pkg.bin, { tumwater: "dist/src/cli.js" });
  assert.equal(fs.readFileSync(bin, "utf8").split("\n")[0], "#!/usr/bin/env node");
  fs.accessSync(bin, fs.constants.X_OK); // Throws EACCES when the bit is missing.
});
