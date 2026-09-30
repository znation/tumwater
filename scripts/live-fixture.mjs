// The shared live-fleet fixture behind the two hand-run status scripts: bench-live.mjs times
// one dashboard frame, diff-check.mjs compares the baseline build's rendering against the
// modified one. Both seed the same fleet — every role working, with a realistic pi log tail —
// and both were copy-pasting the same setup lines (the roles derivation had already drifted
// once, per the note on distRoleIds). One home here for the dist guard both scripts open
// with, the compiled catalog's role set, and the seeder both call. Not a test fixture: these
// scripts run by hand against the compiled build, which is why the imports reach into dist/
// and the guard names the command that produces one.
import fs from "node:fs";
import path from "node:path";

/** Fail fast when the compiled module a script imports is missing: a tree without a build
 * would otherwise die at the import with a raw ERR_MODULE_NOT_FOUND stack instead of the fix.
 * Each caller names its own purpose phrase ("bench-live benchmarks the compiled build") and
 * the module whose absence is the symptom, so the message still says which import died. */
export function requireDistBuild(relModule, purpose) {
  if (!fs.existsSync(new URL(relModule, import.meta.url))) {
    const named = relModule.replace(/^\.\.\//, "");
    console.error(`${purpose}: run \`npm run build\` first (${named} is missing).`);
    process.exit(1);
  }
}

/** Every role the catalog knows, straight from the compiled harness. A hardcoded copy once
 * drifted — it silently omitted `telemetry` — so both scripts track the real role set instead. */
export async function distRoleIds() {
  return (await import("../dist/src/roles.js")).allRoleIds();
}

// A realistic raw log tail: session start + a few assistant turns with usage.
const LOG_LINES = [
  JSON.stringify({ type: "session", id: "abc" }),
  JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I will implement the plan now." }], usage: { totalTokens: 4200, output: 310 } } }),
  JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }),
  JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Tests pass, committing." }], usage: { totalTokens: 5100, output: 280 } } }),
].join("\n") + "\n";

/** Seed `root` as a running fleet: the .tumwater state/log directories, a live orchestrator
 * marker (this process's pid, so snapshot reports running and live detail renders), and one
 * working loop-state + pi log per role — ticks recently finished, a tick started 90s ago and
 * still running, so the TUI's live-detail and elapsed branches both have something to show.
 * The caller owns the tempdir itself (mkdtemp names differ per script) and any per-role state
 * overrides it wants on top (diff-check's idle and review-phase loops). */
export function seedLiveFleet(root, roles) {
  fs.mkdirSync(path.join(root, ".tumwater", "state"), { recursive: true });
  fs.mkdirSync(path.join(root, ".tumwater", "log"), { recursive: true });
  fs.writeFileSync(path.join(root, ".tumwater", "state", "orchestrator.json"), JSON.stringify({ pid: process.pid }));
  const startedAt = Date.now() - 90_000;
  const endedAt = Date.now() - 3_600_000;
  for (const role of roles) {
    const st = {
      role, ticks: 3, commits: 2, nextRunAt: 0, backoffSeconds: 0, lastMainHead: "x",
      generatedTokens: 100, peakContextTokens: 4000, totalCostUsd: 0.5, dayStamp: "", dayCostUsd: 0.2,
      running: true, phase: "pi", lastTickStartedAt: startedAt, lastTickEndedAt: endedAt,
    };
    fs.writeFileSync(path.join(root, ".tumwater", "state", `${role}.json`), JSON.stringify(st));
    fs.writeFileSync(path.join(root, ".tumwater", "log", `${role}.pi.jsonl`), LOG_LINES);
  }
}
