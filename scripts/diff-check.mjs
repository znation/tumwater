// Throwaway behavior check: render the same fixture through the baseline (HEAD) build and the
// modified build; TUI table strings and GUI /api/status payloads must match exactly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROLES = ["feature", "bugfix", "plan", "readme", "organize", "coverage", "clean", "dry", "perf", "qa", "improve", "steward", "director"];

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tw-diff-"));
  fs.mkdirSync(path.join(root, ".tumwater", "state"), { recursive: true });
  fs.mkdirSync(path.join(root, ".tumwater", "log"), { recursive: true });
  fs.writeFileSync(path.join(root, ".tumwater", "state", "orchestrator.json"), JSON.stringify({ pid: process.pid }));
  const startedAt = Date.now() - 90_000;
  const endedAt = Date.now() - 3600_000;
  const logLines = [
    JSON.stringify({ type: "session", id: "abc" }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I will implement the plan now." }], usage: { totalTokens: 4200, output: 310 } } }),
    JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Tests pass, committing." }], usage: { totalTokens: 5100, output: 280 } } }),
  ].join("\n") + "\n";
  for (const role of ROLES) {
    const st = {
      role, ticks: 3, commits: 2, nextRunAt: 0, backoffSeconds: 0, lastMainHead: "x",
      generatedTokens: 100, peakContextTokens: 4000, totalCostUsd: 0.5, dayStamp: "", dayCostUsd: 0.2,
      running: true, phase: "pi", lastTickStartedAt: startedAt, lastTickEndedAt: endedAt,
    };
    fs.writeFileSync(path.join(root, ".tumwater", "state", `${role}.json`), JSON.stringify(st));
    fs.writeFileSync(path.join(root, ".tumwater", "log", `${role}.pi.jsonl`), logLines);
  }
  // One idle loop and one review-phase loop to cover the non-working branches.
  for (const [role, patch] of [["qa", { running: false, phase: undefined }], ["steward", { phase: "review" }]]) {
    const st = JSON.parse(fs.readFileSync(path.join(root, ".tumwater", "state", `${role}.json`), "utf8"));
    Object.assign(st, patch);
    fs.writeFileSync(path.join(root, ".tumwater", "state", `${role}.json`), JSON.stringify(st));
  }
  return root;
}

const baseline = await import("/tmp/tw-baseline/dist/src/ui/status.js");
const current = await import("../dist/src/ui/status.js");
const baseRender = (await import("/tmp/tw-baseline/dist/src/ui/status-render.js")).renderStatus;
const curRender = (await import("../dist/src/ui/status-render.js")).renderStatus;
const basePayload = (await import("/tmp/tw-baseline/dist/src/ui/status-payload.js")).statusPayload;
const curPayload = (await import("../dist/src/ui/status-payload.js")).statusPayload;

let failures = 0;
for (const width of [undefined, 120, 60]) {
  // One shared fixture: both builds render the same directory so tempdir names and
  // millisecond timestamps cannot differ between the two sides.
  const a = makeFixture();
  // Warm both (first frame seeds tail state), then compare steady frames.
  baseRender(a, baseline.snapshot(a), width);
  curRender(a, current.snapshot(a), width);
  const outA = baseRender(a, baseline.snapshot(a), width);
  const outB = curRender(a, current.snapshot(a), width);
  if (outA !== outB) {
    failures++;
    console.log(`TUI MISMATCH at width=${width}`);
    for (let i = 0; i < Math.max(outA.split("\n").length, outB.split("\n").length); i++) {
      const la = outA.split("\n")[i] ?? "<missing>";
      const lb = outB.split("\n")[i] ?? "<missing>";
      if (la !== lb) console.log(`  line ${i}:\n    base: ${JSON.stringify(la)}\n    new:  ${JSON.stringify(lb)}`);
    }
  } else {
    console.log(`TUI width=${width}: identical`);
  }

  const pa = JSON.parse(JSON.stringify(basePayload(a)));
  const pb = JSON.parse(JSON.stringify(curPayload(a)));
  if (JSON.stringify(pa) !== JSON.stringify(pb)) {
    failures++;
    console.log("GUI MISMATCH");
    for (const role of ROLES) {
      const ja = pa.loops.find((l) => l.role === role);
      const jb = pb.loops.find((l) => l.role === role);
      if (JSON.stringify(ja) !== JSON.stringify(jb)) console.log(`  ${role}:\n    base: ${JSON.stringify(ja)}\n    new:  ${JSON.stringify(jb)}`);
    }
    for (const k of Object.keys(pa)) {
      if (k === "loops") continue;
      if (JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) console.log(`  field ${k}:\n    base: ${JSON.stringify(pa[k])}\n    new:  ${JSON.stringify(pb[k])}`);
    }
  } else {
    console.log("GUI payload: identical");
  }
  fs.rmSync(a, { recursive: true, force: true });
}
console.log(failures === 0 ? "DIFF-CHECK PASS" : `DIFF-CHECK FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
