import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readRunTranscript } from "../src/ui/transcript-run.js";
import { writeLogLines } from "./fixtures/log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const seg = (ts: number | undefined, text: string, label?: string) => [
  { type: "tumwater_run", kind: "author", agent: "pi", ...(ts === undefined ? {} : { ts }), ...(label ? { label } : {}) },
  { type: "agent_start" },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } },
];
const join = (lines: string[]) => lines.join("\n");

test("readRunTranscript keeps only segments whose start is inside the window", () => {
  const f = path.join(tmpdir(), "r.pi.jsonl");
  writeLogLines(f, [...seg(1000, "AAA"), ...seg(2000, "BBB"), ...seg(3000, "CCC")]);
  const mid = join(readRunTranscript(f, 1500, 2500));
  assert.match(mid, /BBB/);
  assert.doesNotMatch(mid, /AAA|CCC/);
  const open = join(readRunTranscript(f, 1500, null));
  assert.match(open, /BBB/);
  assert.match(open, /CCC/);
  assert.doesNotMatch(open, /AAA/);
});

test("readRunTranscript reads the rotated generation first, then the live file", () => {
  const f = path.join(tmpdir(), "r.pi.jsonl");
  writeLogLines(f + ".1", seg(1000, "AAA"));
  writeLogLines(f, [...seg(2000, "BBB"), ...seg(3000, "CCC")]);
  const all = join(readRunTranscript(f, 0, null));
  assert.ok(all.indexOf("AAA") < all.indexOf("BBB") && all.indexOf("BBB") < all.indexOf("CCC"));
});

test("a legacy marker without ts falls back to its first user message timestamp", () => {
  const f = path.join(tmpdir(), "r.pi.jsonl");
  writeLogLines(f, [
    seg(undefined, "x")[0],
    { type: "agent_start" },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "p" }], timestamp: 2000 } },
    seg(undefined, "LEGACY")[2],
    ...seg(undefined, "NOSTAMP"),
  ]);
  const out = join(readRunTranscript(f, 1500, 2500));
  assert.match(out, /LEGACY/);
  assert.doesNotMatch(out, /NOSTAMP/);
});

test("a missing file yields nothing and a labeled marker renders its separator", () => {
  const dir = tmpdir();
  assert.deepEqual(readRunTranscript(path.join(dir, "none.jsonl"), 0, null), []);
  const f = path.join(dir, "r.pi.jsonl");
  writeLogLines(f, seg(1000, "AAA", "review"));
  assert.match(join(readRunTranscript(f, 0, null)), /── review/);
  assert.ok(fs.existsSync(f));
});
