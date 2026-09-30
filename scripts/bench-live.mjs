// Benchmark: steady-state cost of one dashboard frame (snapshot + renderStatus) with
// every loop running. Not a pass/fail gate — run it by hand before and after a change to
// status-data.ts/status-render.ts/progress.ts and compare the us/frame numbers. A jump usually
// means a helper stopped receiving the threaded readLiveProgress tail and re-reads the log
// per cell; renderStatus reads once per running loop and passes `live` down on purpose.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { distRoleIds, requireDistBuild, seedLiveFleet } from "./live-fixture.mjs";

// Before the dist/ imports below: a tree without a build would otherwise die with a raw
// ERR_MODULE_NOT_FOUND stack instead of the fix. The benchmark's numbers mean nothing against
// a stale one anyway, so a missing dist is not an edge case.
requireDistBuild("../dist/src/status-data.js", "bench-live benchmarks the compiled build");

const { snapshot } = await import("../dist/src/status-data.js");
const { renderStatus } = await import("../dist/src/ui/status-render.js");

const ROLES = await distRoleIds();

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tw-bench-"));
seedLiveFleet(root, ROLES);

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
