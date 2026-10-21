/** ensureNotesShim (plans/notes-command.md "Reaching it from a run"): it writes an executable
 * `tumwater-notes` shim under `<root>/.tumwater/bin` whose `show` run prints the note, a
 * second call with unchanged content leaves the file's mtime alone, and a different dist path
 * rewrites it. Runs the shim only — never a real model (see PRINCIPLES.md). */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { ensureNotesShim, NOTES_SHIM_NAME } from "../src/agent/notes-shim.js";

test("ensureNotesShim writes an executable shim whose show run prints the note", () => {
  const root = tmpdir();
  const notesPath = path.join(root, "feature.md");
  const body = "the note body\n";
  fs.writeFileSync(notesPath, body);

  const dir = ensureNotesShim(root);
  assert.equal(dir, path.join(root, ".tumwater", "bin"), "returns the shim dir");
  const shim = path.join(dir, NOTES_SHIM_NAME);
  fs.accessSync(shim, fs.constants.X_OK); // Throws EACCES when the executable bit is missing.

  const res = spawnSync(shim, ["show"], {
    env: { ...process.env, TUMWATER_NOTES_PATH: notesPath },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, body, "the execed notes-cli reads the note the env names");
});

test("a second call with unchanged content leaves the shim's mtime alone", () => {
  const root = tmpdir();
  const dir = ensureNotesShim(root);
  const shim = path.join(dir, NOTES_SHIM_NAME);
  const before = fs.statSync(shim).mtimeMs;

  ensureNotesShim(root);
  assert.equal(fs.statSync(shim).mtimeMs, before, "identical content is not rewritten");
});

test("a shim runs even when its recorded node binary was deleted (a node upgrade under the running team)", () => {
  const root = tmpdir();
  const notesPath = path.join(root, "feature.md");
  fs.writeFileSync(notesPath, "still there\n");
  // The old keg an upgrade removed: `process.execPath` names a file that no longer exists.
  const deadNode = path.join(root, "Cellar", "node", "0.0.0", "bin", "node");
  assert.equal(fs.existsSync(deadNode), false, "the fake deleted binary is gone");

  const dir = ensureNotesShim(root, deadNode);
  const shim = path.join(dir, NOTES_SHIM_NAME);
  assert.match(fs.readFileSync(shim, "utf8"), /\] \|\| n=node/, "the shim falls back to PATH's node");
  const res = spawnSync(shim, ["show"], {
    env: { ...process.env, TUMWATER_NOTES_PATH: notesPath },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "still there\n", "the fallback node runs the notes cli");
});

test("a different dist path rewrites the shim", () => {
  const root = tmpdir();
  const dir = ensureNotesShim(root);
  const shim = path.join(dir, NOTES_SHIM_NAME);

  // Simulate a stale shim from a previous build whose exec path differs (e.g. a redeploy).
  fs.writeFileSync(shim, '#!/bin/sh\nexec "/old/node" "/old/dist/src/notes-cli.js" "$@"\n', { mode: 0o755 });
  ensureNotesShim(root);

  const rewritten = fs.readFileSync(shim, "utf8");
  assert.match(rewritten, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "re-pointed at this node");
  assert.match(rewritten, /\/src\/notes-cli\.js/, "and this build's notes cli");
});
