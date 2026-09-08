// Throwaway benchmark: steady-state cost of one dashboard frame (snapshot + renderStatus)
// with every loop running. Measures the redundant readLiveProgress reads per frame.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { snapshot } = await import("../dist/src/status.js");
const { renderStatus } = await import("../dist/src/ui/status-render.js");

const ROLES = ["feature", "bugfix", "plan", "readme", "organize", "coverage", "clean", "dry", "perf", "qa", "improve", "steward", "director"];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tw-bench-"));
fs.mkdirSync(path.join(root, ".tumwater", "state"), { recursive: true });
fs.mkdirSync(path.join(root, ".tumwater", "log"), { recursive: true });
// A live orchestrator (this process) so snapshot reports running and live detail renders.
fs.writeFileSync(path.join(root, ".tumwater", "state", "orchestrator.json"), JSON.stringify({ pid: process.pid }));

// A realistic raw log tail: session start + a few assistant turns with usage.
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
    running: true, phase: "pi", lastTickStartedAt: Date.now() - 90_000, lastTickEndedAt: Date.now() - 3600_000,
  };
  fs.writeFileSync(path.join(root, ".tumwater", "state", `${role}.json`), JSON.stringify(st));
  fs.writeFileSync(path.join(root, ".tumwater", "log", `${role}.pi.jsonl`), logLines);
}

// Warm up: first frame seeds tail state and stat caches.
snapshot(root);
renderStatus(root, snapshot(root), 120);

const FRAMES = 20_000;
let best = Infinity;
for (let rep = 0; rep < 3; rep++) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < FRAMES; i++) {
    const snap = snapshot(root);
    renderStatus(root, snap, 120);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (ms < best) best = ms;
}
console.log(`best of 3: ${FRAMES} frames in ${best.toFixed(1)} ms -> ${(best / FRAMES * 1000).toFixed(1)} us/frame`);

// Sanity: the rendered table must show live detail for a working loop.
const out = renderStatus(root, snapshot(root), 200);
if (!/turn \d/.test(out)) throw new Error("benchmark fixture broken: no live turn detail in output");
fs.rmSync(root, { recursive: true, force: true });
