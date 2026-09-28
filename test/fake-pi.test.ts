import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { strict as assert } from "node:assert";

test("loading the fake-pi helpers drops an inherited TUMWATER_PI_BIN, so a file run directly with node --test keeps its fakes", () => {
  // BUGS.md 2026-09-28: the variable outranks PATH in resolveAgentBin. The test runner strips it
  // (suiteEnv), but `node --test dist/test/<file>`, which the fleet's agents run too, never goes
  // through the runner. So the helpers drop it themselves as soon as a test file imports them.
  const fakePiPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-pi.js");
  const script = `
    import ${JSON.stringify(pathToFileURL(fakePiPath).href)};
    console.log(process.env.TUMWATER_PI_BIN ?? "<unset>");
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, TUMWATER_PI_BIN: "/opt/pi-wrapper/pi" },
    timeout: 30_000,
  });
  assert.equal(child.error, undefined, `child failed to run: ${child.error}`);
  assert.equal(child.status, 0, `child exited ${child.status}: ${child.stderr}`);
  assert.equal(child.stdout.trim(), "<unset>");
});
