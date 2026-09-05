import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "../src/json-files.js";
import { tmpdir } from "./util.js";

test("readJsonFile treats missing or torn files as no data, not errors", () => {
  const dir = tmpdir();
  const file = path.join(dir, "state.json");

  assert.equal(readJsonFile<unknown>(file), null); // missing — no throw

  fs.writeFileSync(file, JSON.stringify({ ticks: 3 }));
  assert.deepEqual(readJsonFile<{ ticks: number }>(file), { ticks: 3 });

  // A torn write (crash mid-write by another process) must not throw — observers polling
  // these files every second would die on it.
  fs.writeFileSync(file, '{"ticks": ');
  assert.equal(readJsonFile<unknown>(file), null);
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
