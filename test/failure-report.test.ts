import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TELEMETRY_DIGEST_DAYS,
  collectFailureReport,
  normalizeClusterKey,
  renderFailureMarkdown,
  telemetryDigest,
} from "../src/failure-report.js";
import { makeRepo, tmpdir } from "./util.js";

// The digest buckets by LOCAL calendar day, so fixtures build timestamps from local date parts
// (never UTC strings), matching the reader and collectReport.
function at(daysAgo: number, hour = 12): number {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

function keyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Write events.jsonl under the fixture root's .tumwater/log/ (objects are JSON-encoded like
 * logEvent writes them; strings pass through verbatim). */
function writeEvents(root: string, lines: unknown[]): void {
  const file = path.join(root, ".tumwater", "log", "events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
}

test("normalizeClusterKey collapses volatile parts and keeps exit codes distinct", () => {
  assert.equal(normalizeClusterKey("boom deadbeef0"), "boom <sha>");
  assert.equal(normalizeClusterKey("ENOENT /Users/a/b/c.ts"), "ENOENT <path>");
  assert.equal(normalizeClusterKey("stalled at 2026-09-18T01:02:03.000Z"), "stalled at <ts>");
  assert.equal(normalizeClusterKey("timed out after 1800s"), "timed out after <dur>");
  assert.equal(normalizeClusterKey("retry 5 of 10"), "retry <n> of <n>");
  // The integer rule's negative lookbehind keeps the exit status semantic.
  assert.equal(normalizeClusterKey("pi exited 1"), "pi exited 1");
  assert.equal(normalizeClusterKey("pi exited null"), "pi exited null");
  assert.notEqual(normalizeClusterKey("pi exited 1"), normalizeClusterKey("pi exited null"));
  // Trimmed to the display cap.
  assert.equal(normalizeClusterKey("x".repeat(200)).length, 120);
});

test("collectFailureReport tallies tick_end results per role", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "tick_end", result: "changed" },
    { ts: at(0), loop: "feature", type: "tick_end", result: "changed" },
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "boom" },
    { ts: at(0), loop: "bugfix", type: "tick_end", result: "no_change" },
    { ts: at(0), loop: "", type: "tick_end", result: "queued" }, // empty loop id → "?"
  ]);
  const data = collectFailureReport(root, 1);
  assert.equal(data.ticks, 5);
  const feature = data.outcomes.find((o) => o.role === "feature");
  assert.deepEqual(feature?.counts, { changed: 2, error: 1 });
  const bugfix = data.outcomes.find((o) => o.role === "bugfix");
  assert.deepEqual(bugfix?.counts, { no_change: 1 });
  const unnamed = data.outcomes.find((o) => o.role === "?");
  assert.deepEqual(unnamed?.counts, { queued: 1 });
});

test("error strings differing only in volatile parts cluster; exit codes stay distinct", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "ENOENT /Users/a/one.ts deadbeef0" },
    { ts: at(0), loop: "bugfix", type: "tick_end", result: "error", error: "ENOENT /Users/b/two.ts cafebabe1" },
    { ts: at(0), loop: "clean", type: "tick_end", result: "error", error: "ENOENT /Users/c/three.ts 1234567" },
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "pi exited 1" },
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "pi exited null" },
  ]);
  const data = collectFailureReport(root, 1);
  assert.equal(data.errorClusters.length, 3);
  const merged = data.errorClusters.find((c) => c.count === 3);
  assert.equal(merged?.key, "ENOENT <path> <sha>");
  assert.deepEqual(merged?.roles, ["bugfix", "clean", "feature"]);
  assert.equal(merged?.example, "ENOENT /Users/a/one.ts deadbeef0");
  assert.ok(data.errorClusters.some((c) => c.key === "pi exited 1"));
  assert.ok(data.errorClusters.some((c) => c.key === "pi exited null"));
});

test("review rejections cluster on (role, reasons[0]), not role alone", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "review_rejected", head: "a".repeat(40), reasons: ["too big"] },
    { ts: at(0), loop: "feature", type: "review_rejected", head: "b".repeat(40), reasons: ["half done"] },
    { ts: at(0), loop: "feature", type: "review_rejected", head: "c".repeat(40), reasons: ["too big"] },
    { ts: at(0), loop: "bugfix", type: "review_rejected", head: "d".repeat(40), reasons: [] },
  ]);
  const data = collectFailureReport(root, 1);
  const find = (role: string, example: string) =>
    data.rejectionClusters.find((c) => c.roles[0] === role && c.example === example);
  assert.equal(find("feature", "too big")?.count, 2);
  assert.equal(find("feature", "half done")?.count, 1);
  assert.equal(find("bugfix", "no reasons given")?.count, 1);
  assert.equal(data.rejectionClusters.length, 3);
});

test("a window longer than the retained log is reported as partial", () => {
  const root = tmpdir();
  writeEvents(root, [{ ts: at(2), loop: "feature", type: "tick_end", result: "error", error: "boom" }]);
  const data = collectFailureReport(root, 5);
  assert.equal(data.partial, true);
  assert.equal(data.emptyLog, false);
  assert.equal(data.oldestEventDate, keyOf(at(2)));
  assert.match(renderFailureMarkdown(data), /^partial: retained log starts \d{4}-\d{2}-\d{2}$/m);
});

test("a log retaining only events outside the read span says so, not 'no events retained'", () => {
  const root = tmpdir();
  writeEvents(root, [{ ts: at(30), loop: "feature", type: "tick_end", result: "changed" }]);
  const data = collectFailureReport(root, 5);
  assert.equal(data.hasEvents, false);
  assert.equal(data.emptyLog, false);
  assert.equal(data.partial, false);
  const md = renderFailureMarkdown(data);
  assert.match(md, /^no events in the last 5 days$/m);
  assert.ok(!md.includes("no events retained"));
});

test("an empty log reads 'no events retained'", () => {
  const data = collectFailureReport(tmpdir(), 5);
  assert.equal(data.emptyLog, true);
  assert.match(renderFailureMarkdown(data), /^no events retained$/m);
});

test("deltas report new roles as absent, not an infinite increase", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "tick_end", result: "error" },
    { ts: at(1), loop: "bugfix", type: "tick_end", result: "no_change" },
    { ts: at(1), loop: "bugfix", type: "tick_end", result: "no_change" },
  ]);
  const data = collectFailureReport(root, 1);
  const feature = data.deltas.find((d) => d.role === "feature");
  assert.equal(feature?.prevTicks, 0);
  assert.equal(feature?.ticks, 1);
  assert.equal(feature?.errors, 1);
  const md = renderFailureMarkdown(data);
  assert.match(md, /\| feature \| — → 1 \| — → 100% \|/);
  assert.match(md, /\| bugfix \| 2 → — \| 0% → — \|/);
});

test("deltas count quiet kills and rejections per role, both windows", () => {
  // The delta table has dedicated quiet-kills and rejections columns. A rejection is recorded
  // by the landing slot AFTER its authoring tick has ended `queued` (plans/merge-queue.md 3/5),
  // so the fixture pairs a `queued` tick_end with a `review_rejected` event — the shape the
  // live fleet emits. A fixture that fabricates a `rejected` tick_end would pass even while the
  // counter reads 0 on every real rejection, the regression an operator could not notice.
  const root = tmpdir();
  const head = (c: string) => c.repeat(40);
  writeEvents(root, [
    // Preceding window (yesterday): feature had a quiet kill, a rejection, an error, a pass.
    { ts: at(1), loop: "feature", type: "tick_end", result: "quiet_killed" },
    { ts: at(1), loop: "feature", type: "tick_end", result: "queued" },
    { ts: at(1), loop: "feature", type: "review_rejected", head: head("a"), reasons: ["too big"] },
    { ts: at(1), loop: "feature", type: "tick_end", result: "error" },
    { ts: at(1), loop: "feature", type: "tick_end", result: "changed" },
    // Current window (today): feature again, and bugfix appears for the first time.
    { ts: at(0), loop: "feature", type: "tick_end", result: "quiet_killed" },
    { ts: at(0), loop: "feature", type: "tick_end", result: "queued" },
    { ts: at(0), loop: "feature", type: "review_rejected", head: head("b"), reasons: ["too big"] },
    { ts: at(0), loop: "bugfix", type: "tick_end", result: "quiet_killed" },
    { ts: at(0), loop: "bugfix", type: "tick_end", result: "queued" },
    { ts: at(0), loop: "bugfix", type: "review_rejected", head: head("c"), reasons: ["too big"] },
  ]);
  const data = collectFailureReport(root, 1);

  const feature = data.deltas.find((d) => d.role === "feature")!;
  assert.equal(feature.prevTicks, 4);
  assert.equal(feature.ticks, 2);
  assert.equal(feature.prevQuietKills, 1);
  assert.equal(feature.quietKills, 1);
  assert.equal(feature.prevRejections, 1);
  assert.equal(feature.rejections, 1);

  // A role absent from the preceding window carries its current counts, with "—" on the
  // previous side of every column rather than an infinite increase.
  const bugfix = data.deltas.find((d) => d.role === "bugfix")!;
  assert.equal(bugfix.prevTicks, 0);
  assert.equal(bugfix.quietKills, 1);
  assert.equal(bugfix.rejections, 1);

  const md = renderFailureMarkdown(data);
  assert.match(md, /\| feature \| 4 → 2 \| 25% → 0% \| 1 → 1 \| 1 → 1 \|/);
  assert.match(md, /\| bugfix \| — → 2 \| — → 0% \| — → 1 \| — → 1 \|/);

  // The delta and the rejection cluster read the same source: a window with a rejection shows
  // both, so the delta can never claim "no rejections" while the cluster section lists one.
  assert.equal(data.rejectionClusters.reduce((n, c) => n + c.count, 0), 2);
});

test("the digest renders under 6 KB however bad the window was", () => {
  const root = tmpdir();
  const lines: unknown[] = [];
  const roles = Array.from({ length: 13 }, (_, i) => `role${i}`);
  for (const role of roles) {
    for (let i = 0; i < 40; i++) {
      lines.push({
        ts: at(0),
        loop: role,
        type: "tick_end",
        result: i % 3 === 0 ? "error" : "changed",
        error: i % 3 === 0 ? `boom ${i} at /Users/a/very/deep/path/file${i}.ts sha${i.toString(16).padStart(8, "0")}` : undefined,
      });
    }
    for (let i = 0; i < 10; i++) {
      lines.push({ ts: at(0), loop: role, type: "warning", message: `warning ${i} on ${role} at /Users/a/b/c${i}.ts` });
      lines.push({ ts: at(0), loop: role, type: "review_rejected", reasons: [`reason ${i} for ${role}`] });
    }
    for (let i = 0; i < 5; i++) {
      lines.push({ ts: at(0), loop: role, type: "merged", commit: i.toString(16).padStart(40, "0"), summary: `land ${i} `.repeat(20) });
    }
  }
  writeEvents(root, lines);
  const md = renderFailureMarkdown(collectFailureReport(root, 14));
  assert.ok(Buffer.byteLength(md) < 6 * 1024, `rendered ${Buffer.byteLength(md)} bytes`);
});

test("TELEMETRY_DIGEST_DAYS is the role's one-day window", () => {
  assert.equal(TELEMETRY_DIGEST_DAYS, 1);
});

test("telemetryDigest renders the digest over the role's one-day window", () => {
  const root = makeRepo();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "pi exited null" },
    { ts: at(3), loop: "feature", type: "tick_end", result: "error", error: "older, out of window" },
  ]);
  const digest = telemetryDigest(root);
  assert.ok(digest, "a readable log always yields a digest string");
  assert.match(digest, /\(1 day\)/);
  assert.match(digest, /pi exited null/);
  assert.doesNotMatch(digest, /older, out of window/);
});

// The CLI runs main() on import, so it is tested as a child process against the built dist,
// the same pattern report.test.ts uses.
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runCli(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? Number(err.code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

test("tumwater report --failures prints the digest and shares the --days bound", async () => {
  const root = makeRepo();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "pi exited null" },
    { ts: at(0), loop: "feature", type: "tick_end", result: "changed" },
    { ts: at(0), loop: "feature", type: "merged", commit: "abc1234", summary: "land a thing" },
  ]);
  const ok = await runCli(root, "report", "--failures");
  assert.equal(ok.code, 0);
  assert.match(ok.out, /^# tumwater failure digest/m);
  assert.match(ok.out, /\(14 days\)/);

  const one = await runCli(root, "report", "--failures", "--days", "1");
  assert.equal(one.code, 0);
  assert.match(one.out, /pi exited null/);

  const tooLong = await runCli(root, "report", "--failures", "--days", "91");
  assert.notEqual(tooLong.code, 0);
  assert.match(tooLong.out, /--days must be between 1 and 90/);

  const unknown = await runCli(root, "report", "--failure");
  assert.notEqual(unknown.code, 0);
});
