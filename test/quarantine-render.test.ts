import test from "node:test";
import assert from "node:assert/strict";
import { quarantineEntryAt, quarantineRows, quarantineViewRows, renderQuarantine, renderQuarantineDetail, renderQuarantineSection } from "../src/review/quarantine-render.js";
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

test("quarantineViewRows positions and details each entry", () => {
  // The dashboard card's structured rows: position and test ride off the shared sort, and each
  // detail is exactly the per-row text renderQuarantineSection prints after the test.
  const rows = quarantineRows([
    entry({ test: "test/a.test.ts", firstSeen: now - 2 * 24 * 3_600_000, lastSeen: now - 3_600_000, count: 3, bug: "A hidden flake" }),
    entry({ test: "test/b.test.ts", firstSeen: now - 3_600_000, lastSeen: now, count: 1, bug: "" }),
  ]);
  const view = quarantineViewRows(rows, now);
  assert.deepEqual(
    view.map((r) => [r.position, r.test]),
    [
      [1, "test/a.test.ts"],
      [2, "test/b.test.ts"],
    ],
  );
  assert.equal(view[0]!.detail, "first seen 2d ago, last seen 1h ago, 3 flakes — filed: A hidden flake");
  assert.equal(view[1]!.detail, "first seen 1h ago, last seen 0s ago, 1 flake — not filed");
  // The detail is exactly what the Markdown section prints after the test, so the digest and
  // the structured card cannot drift on wording.
  assert.deepEqual(quarantineViewRows([], now), []);
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

test("renderQuarantineSection shows a test name over 80 chars in full, not squashed", () => {
  // The Failures Ctrl+X release editor matches the exact path the list shows, so a long
  // title must render untruncated or it could never be released. `renderQuarantine` keeps
  // its own numbered squash because --release <n> never needs the full name.
  const long = `test/${"a".repeat(120)}.test.ts`;
  const rows = quarantineRows([entry({ test: long, firstSeen: now - 3_600_000, lastSeen: now, count: 1, bug: "" })]);
  assert.match(renderQuarantineSection(rows, now), new RegExp(`- ${long} —`));
});

test("renderQuarantineDetail prints a bare entry's header, ages and filed line", () => {
  const d = renderQuarantineDetail(
    entry({ test: "test/a.test.ts", firstSeen: now - 2 * 24 * 3_600_000, lastSeen: now - 3_600_000, count: 3, bug: "A filed flake" }),
    2,
    now,
  );
  assert.equal(
    d,
    "quarantined test 2: test/a.test.ts\n" +
      "first seen 2d ago, last seen 1h ago, 3 flakes\n" +
      "filed: A filed flake",
  );
});

test("renderQuarantineDetail prints not filed and skips the absent recurrence and output lines", () => {
  const d = renderQuarantineDetail(entry({ test: "test/a.test.ts", firstSeen: now - 3_600_000, lastSeen: now, count: 1, bug: "" }), 1, now);
  assert.equal(d, "quarantined test 1: test/a.test.ts\nfirst seen 1h ago, last seen 0s ago, 1 flake\nnot filed");
  assert.ok(!d.includes("failing output:"));
  assert.ok(!d.includes("recurred"));
});

test("renderQuarantineDetail adds the recurrence line only for a recurred entry", () => {
  assert.ok(renderQuarantineDetail(entry({ recurred: true }), 1, now).includes("recurred since its bug last heard of it"));
  assert.ok(!renderQuarantineDetail(entry({}), 1, now).includes("recurred since its bug last heard of it"));
});

test("renderQuarantineDetail adds failing output verbatim only for a non-empty tail", () => {
  const d = renderQuarantineDetail(entry({ tail: "line1\nline2\nline3" }), 1, now);
  assert.ok(d.endsWith("failing output:\nline1\nline2\nline3"));
  assert.ok(!renderQuarantineDetail(entry({}), 1, now).includes("failing output:"));
});

test("renderQuarantineDetail keeps a long test path, bug heading and tail whole", () => {
  const long = `test/${"a".repeat(120)}.test.ts`;
  const bug = `BUGS.md ${"b".repeat(100)} flake heading ${"c".repeat(40)}`;
  const d = renderQuarantineDetail(entry({ test: long, bug, tail: "oops: lost" }), 3, now);
  assert.ok(d.includes(`quarantined test 3: ${long}`), "the test path is not squashed");
  assert.ok(d.includes(`filed: ${bug}`), "the bug heading is not squashed");
  assert.ok(d.includes("oops: lost"), "the tail rides through verbatim");
});

test("quarantineEntryAt and quarantineRows agree on what each position names, and null past the end", () => {
  const entries = [
    entry({ test: "new", firstSeen: 300 }),
    entry({ test: "oldest", firstSeen: 100 }),
    entry({ test: "mid", firstSeen: 200 }),
  ];
  const rows = quarantineRows(entries);
  assert.equal(quarantineEntryAt(entries, 1)!.test, rows[0]!.test);
  assert.equal(quarantineEntryAt(entries, 2)!.test, rows[1]!.test);
  assert.equal(quarantineEntryAt(entries, 3)!.test, rows[2]!.test);
  assert.equal(quarantineEntryAt(entries, 4), null);
  assert.equal(quarantineEntryAt(entries, 0), null);
  assert.equal(quarantineEntryAt([], 1), null);
});
