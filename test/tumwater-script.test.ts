import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./repo-fixtures.js";

// scripts/tumwater.mjs — the `npm run tumwater` dev entry point the package exposes beside the
// installed bin. It resolves the compiled CLI beside its own directory, names the missing-build
// fix instead of letting the spawn die on a raw ERR_MODULE_NOT_FOUND for dist/src/cli.js, and
// passes every argument through with the CLI's exit code. It runs before any compile and is
// otherwise untested (release-status and stamp-build are the precedent for driving a scripts/
// module as a subprocess), so these tests copy it into throwaway trees whose dist/ side is under
// their control: only then can both the guard and the passthrough be reached offline.

const SCRIPT = fileURLToPath(new URL("../../scripts/tumwater.mjs", import.meta.url));

/** A throwaway checkout holding the wrapper with a chosen dist/src/cli.js: the wrapper resolves
 * the CLI relative to its own location, so the copied script must sit under `<root>/scripts/`. A
 * null `cli` leaves dist/src/cli.js absent, driving the missing-build guard. */
function layout(cli: string | null): string {
  const root = tmpdir("tw-tumwater-script-");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, "scripts", "tumwater.mjs"));
  if (cli !== null) {
    fs.mkdirSync(path.join(root, "dist", "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "src", "cli.js"), cli);
  }
  return root;
}

function run(root: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [path.join(root, "scripts", "tumwater.mjs"), ...args], { encoding: "utf8" });
}

test("tumwater.mjs names the missing build instead of dying on a raw module error", () => {
  const r = run(layout(null), "status");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(
    r.stderr,
    /npm run tumwater runs the compiled build: run `npm run build` first \(dist\/src is missing\)\./,
  );
});

test("tumwater.mjs passes every argument to the compiled CLI and propagates its exit code", () => {
  const root = layout(
    'process.stdout.write("ARGS:" + JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exit(7);\n',
  );
  const r = run(root, "status", "--json", "extra");
  assert.equal(r.status, 7);
  assert.equal(r.stdout, 'ARGS:["status","--json","extra"]\n');
});

test("tumwater.mjs exits 1 when the CLI is killed by a signal and reports no status", () => {
  const root = layout('process.kill(process.pid, "SIGKILL");\n');
  const r = run(root, "version");
  assert.equal(r.status, 1);
});
