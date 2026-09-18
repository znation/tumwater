import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic, writeJsonFile } from "../src/json-files.js";
import { tmpdir } from "./util.js";

test("readJsonFile treats missing or torn files as no data, not errors", () => {
  const dir = tmpdir();
  const file = path.join(dir, "state.json");

  assert.equal(readJsonFile<Record<string, unknown>>(file), null); // missing — no throw

  fs.writeFileSync(file, JSON.stringify({ ticks: 3 }));
  assert.deepEqual(readJsonFile<{ ticks: number }>(file), { ticks: 3 });

  // A torn write (crash mid-write by another process) must not throw — observers polling
  // these files every second would die on it.
  fs.writeFileSync(file, '{"ticks": ');
  assert.equal(readJsonFile<Record<string, unknown>>(file), null);
});

test("readJsonFile treats a valid JSON non-object as no data", () => {
  const dir = tmpdir();
  const file = path.join(dir, "state.json");
  // A state file that parses cleanly but is not an object is still not data: unchecked, the
  // cast would leak a lie (loadLoopState spreads a string's characters; readOrchestratorInfo
  // reads .pid off an array). Same no-data policy as a torn write.
  for (const body of ["[1, 2]", "[]", "5", '"name"', "true", "null"]) {
    fs.writeFileSync(file, body);
    assert.equal(readJsonFile<Record<string, unknown>>(file), null, `${body} is not a state object`);
  }
});

test("writeJsonFile creates parent dirs and writes pretty-printed JSON (overwriting)", () => {
  const dir = tmpdir();
  const file = path.join(dir, "nested", "marker.json"); // Parent does not exist yet.
  writeJsonFile(file, { at: 123, roles: ["feature"] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { at: 123, roles: ["feature"] });
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(raw.includes('\n  "at": 123'), "two-space pretty print — the shared marker/info format");

  writeJsonFile(file, { at: 456 }); // Overwrites an existing file in place.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { at: 456 });
});

test("writeJsonAtomic replaces the target atomically, honoring the caller's newline convention", () => {
  const dir = tmpdir();
  const file = path.join(dir, "nested", "state.json"); // Parent does not exist yet.

  writeJsonAtomic(file, { ticks: 1 });
  let raw = fs.readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(raw), { ticks: 1 });
  assert.ok(!raw.endsWith("\n"), "state files end without a trailing newline (writeJsonFile convention)");
  assert.ok(raw.includes('\n  "ticks": 1'), "two-space pretty print — the shared marker/info format");

  writeJsonAtomic(file, { ticks: 2 }, true); // tumwater.json convention.
  raw = fs.readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(raw), { ticks: 2 }, "the old content is replaced, not mixed");
  assert.ok(raw.endsWith("}\n") && !raw.endsWith("\n\n"), "trailingNewline adds exactly one newline");

  // The tmp file is renamed into place, not left behind.
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"]);
});

test("writeJsonAtomic rethrows a failed write, removes its tmp, and leaves the target untouched", () => {
  const dir = tmpdir();
  const file = path.join(dir, "state.json");
  writeJsonAtomic(file, { ticks: 1 });

  // A non-empty directory squatting on the target path makes the rename fail
  // (EISDIR/ENOTEMPTY) — deterministically, for any user including root, with the
  // tmp file already written, so the cleanup branch runs against a real tmp.
  fs.rmSync(file);
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, "blocker.txt"), "x\n");

  assert.throws(() => writeJsonAtomic(file, { ticks: 2 }), (err: unknown) => err instanceof Error);

  assert.ok(fs.statSync(file).isDirectory(), "the target is left untouched");
  assert.deepEqual(fs.readdirSync(file), ["blocker.txt"]);
  assert.ok(
    !fs.readdirSync(dir).some((f) => f.includes(".tmp-")),
    "a failed write leaves no tmp remnant behind",
  );
});
