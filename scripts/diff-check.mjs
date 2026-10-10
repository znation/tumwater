// Throwaway behavior check: render the same fixture through the baseline (HEAD) build and the
// modified build; TUI table strings and GUI /api/status payloads must match exactly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { distRoleIds, requireDistBuild, seedLiveFleet } from "./live-fixture.mjs";

// Before any dist/ import below: a tree without a build would otherwise die with a raw
// ERR_MODULE_NOT_FOUND stack instead of the fix. This script's whole subject is comparing
// builds, so a missing build is not an edge case — name it and the command that produces one.
requireDistBuild("../dist/src/roles/roles.js", "diff-check compares compiled builds");

// Same guard for the baseline side: on a fresh checkout (or after a /tmp cleanup) no baseline
// has ever been staged, and the import below would die with a raw ERR_MODULE_NOT_FOUND stack
// for /tmp/tw-baseline/dist/src/status/status-data.js — naming the staging command instead.
if (!fs.existsSync("/tmp/tw-baseline/dist/src/status/status-data.js")) {
  console.error(
    "diff-check compares compiled builds: no baseline at /tmp/tw-baseline/dist — stage one before you start\n" +
    "changing code, from a clean main checkout:\n" +
    "  npm run build && rm -rf /tmp/tw-baseline && mkdir /tmp/tw-baseline && cp -R dist /tmp/tw-baseline/",
  );
  process.exit(1);
}

const ROLES = await distRoleIds();

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tw-diff-"));
  seedLiveFleet(root, ROLES);
  // One idle loop and one review-phase loop to cover the non-working branches.
  for (const [role, patch] of [["qa", { running: false, phase: undefined }], ["steward", { phase: "review" }]]) {
    const st = JSON.parse(fs.readFileSync(path.join(root, ".tumwater", "state", `${role}.json`), "utf8"));
    Object.assign(st, patch);
    fs.writeFileSync(path.join(root, ".tumwater", "state", `${role}.json`), JSON.stringify(st));
  }
  return root;
}

const baseline = await import("/tmp/tw-baseline/dist/src/status/status-data.js");
const current = await import("../dist/src/status/status-data.js");
const baseRender = (await import("/tmp/tw-baseline/dist/src/ui/status-render.js")).renderStatus;
const curRender = (await import("../dist/src/ui/status-render.js")).renderStatus;
const basePayload = (await import("/tmp/tw-baseline/dist/src/ui/status-payload.js")).statusPayload;
const curPayload = (await import("../dist/src/ui/status-payload.js")).statusPayload;

// Sanity, before any comparison: the shared fixture must actually render a working loop's
// live detail. Without this, a fixture that stopped covering the working branch renders the
// same (empty) table from both builds and every width reports "identical" — a vacuous PASS
// from the check whose whole point is to catch status-read drift. bench-live.mjs opens with
// the same guard on its own fixture; the 200-column width is the one its sanity uses.
{
  const probe = makeFixture();
  let probeOut;
  try {
    probeOut = baseRender(probe, baseline.snapshot(probe), 200);
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
  if (!/turn \d/.test(probeOut)) {
    console.error("diff-check fixture broken: the baseline render shows no live turn detail");
    process.exit(1);
  }
}

let failures = 0;
for (const width of [undefined, 120, 60]) {
  // One shared fixture: both builds render the same directory so tempdir names and
  // millisecond timestamps cannot differ between the two sides.
  const a = makeFixture();
  try {
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
  } finally {
    // A render that throws must not leak the fixture: the tempdir is this script's, and
    // repeated debugging runs (or a fixture regression) would otherwise stack /tmp/tw-diff-*
    // dirs — the cleanup bench-live.mjs already wraps its timed loop in.
    fs.rmSync(a, { recursive: true, force: true });
  }
}
console.log(failures === 0 ? "DIFF-CHECK PASS" : `DIFF-CHECK FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
