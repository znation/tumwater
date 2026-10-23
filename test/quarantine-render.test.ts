import test from "node:test";
import assert from "node:assert/strict";
import { quarantineRows, renderQuarantine, renderQuarantineSection } from "../src/review/quarantine-render.js";
import { QUARANTINE_AGE_MS, QUARANTINE_WARN_COUNT } from "../src/baseline/main-guardrails.js";
import type { QuarantineEntry } from "../src/review/known-flakes.js";

// The `tumwater quarantine` renderer: sorting/numbering of the raw list and the text form
// of the command. Pure over its inputs, so every branch is a unit test here (the CLI wiring
// and the read-only guarantee live in test/cli-quarantine.test.ts).

const now = 1_000_000_000_000;

function entry(over: Partial<QuarantineEntry>): QuarantineEntry {
  return { test: "test/a.test.ts", firstSeen: 0, lastSeen: 0, count: 1, bug: "", ...over };
}

test("quarantineRows sorts newest-first input oldest first and numbers 1..N", () => {
  const rows = quarantineRows([
    entry({ test: "new", firstSeen: 300 }),
    entry({ test: "oldest", firstSeen: 100 }),
    entry({ test: "mid", firstSeen: 200 }),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.position, r.test]),
    [
      [1, "oldest"],
      [2, "mid"],
      [3, "new"],
    ],
  );
});

test("quarantineRows breaks a firstSeen tie by test name", () => {
  const rows = quarantineRows([
    entry({ test: "b", firstSeen: 100 }),
    entry({ test: "a", firstSeen: 100 }),
    entry({ test: "c", firstSeen: 50 }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.test),
    ["c", "a", "b"],
  );
});

test("quarantineRows returns [] for [] and preserves an empty bug", () => {
  assert.deepEqual(quarantineRows([]), []);
  const [r] = quarantineRows([entry({ bug: "" })]);
  assert.equal(r!.bug, "");
  const [f] = quarantineRows([entry({ bug: "A filed bug" })]);
  assert.equal(f!.bug, "A filed bug");
});

test("renderQuarantine prints the empty line for no rows", () => {
  assert.equal(renderQuarantine([], now), "flake quarantine is empty");
});

test("renderQuarantine headers and numbers each row with age, flake count and filed state", () => {
  const rows = quarantineRows([
    entry({ test: "test/a.test.ts", firstSeen: now - 2 * 24 * 3_600_000, lastSeen: now - 3_600_000, count: 3, bug: "A hidden flake" }),
    entry({ test: "test/b.test.ts", firstSeen: now - 3_600_000, lastSeen: now, count: 1, bug: "" }),
  ]);
  const text = renderQuarantine(rows, now);
  const lines = text.split("\n");
  assert.equal(lines[0], "flake quarantine: 2 tests");
  assert.equal(lines.length, 3, "header, then one line per row; no warning for a quiet list");
  assert.match(lines[1]!, /^1\. test\/a\.test\.ts — first seen 2d ago, last seen 1h ago, 3 flakes — filed: A hidden flake$/);
  assert.match(lines[2]!, /^2\. test\/b\.test\.ts — first seen 1h ago, last seen 0s ago, 1 flake — not filed$/);
});

test("renderQuarantine appends the doctor's warning phrase for an old entry and an over-ceiling list", () => {
  {
    const rows = quarantineRows([entry({ test: "old", firstSeen: now - QUARANTINE_AGE_MS - 1, count: 1 })]);
    const text = renderQuarantine(rows, now);
    assert.match(text, /quarantine holds 1 test over 3 days:/);
  }
  {
    const rows = quarantineRows(
      Array.from({ length: QUARANTINE_WARN_COUNT + 1 }, (_, i) => entry({ test: `test/t${i}.test.ts`, firstSeen: now - 3_600_000 })),
    );
    const text = renderQuarantine(rows, now);
    assert.match(text, new RegExp(`quarantine holds ${QUARANTINE_WARN_COUNT + 1} tests — over the ${QUARANTINE_WARN_COUNT}-test ceiling`));
  }
  {
    const rows = quarantineRows([entry({ test: "fresh", firstSeen: now - 3_600_000 })]);
    const lines = renderQuarantine(rows, now).split("\n");
    assert.equal(lines.length, 2, "no warning line for a fresh, quiet list");
  }
});

test("renderQuarantineSection is empty for an empty list and a Markdown section otherwise", () => {
  assert.equal(renderQuarantineSection([], now), "");
  // One old enough for quarantineWarning to fire, one fresh; the first names its test, ages,
  // flake count and "not filed", the second ends "filed: …".
  const rows = quarantineRows([
    entry({ test: "test/not-filed.test.ts", firstSeen: now - QUARANTINE_AGE_MS - 1, lastSeen: now - 3_600_000, count: 2, bug: "" }),
    entry({ test: "test/filed.test.ts", firstSeen: now - 3_600_000, lastSeen: now, count: 1, bug: "A filed flake" }),
  ]);
  const text = renderQuarantineSection(rows, now);
  assert.match(text, /^## Flake quarantine\n/);
  assert.match(text, /quarantine holds 1 test over 3 days:/, "the shared warning phrase appears when it fires");
  const bullets = text.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(bullets.length, 2, "exactly two bullets");
  assert.match(bullets[0]!, /^- test\/not-filed\.test\.ts — first seen 3d ago, last seen 1h ago, 2 flakes — not filed$/);
  assert.match(bullets[1]!, /^- test\/filed\.test\.ts — first seen 1h ago, last seen 0s ago, 1 flake — filed: A filed flake$/);
});
