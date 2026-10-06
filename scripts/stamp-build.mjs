// Post-compile dist/ preparation (package.json "build" and "test" both end here): prune
// outputs that no longer have a source, then stamp dist/ with the commit it was built
// from, so the running harness can tell whether main has moved past its own code (see
// src/build/build-info.ts). Runs from the package root — npm sets cwd there — and imports the
// just-built module so the stamp's shape has exactly one definition. Missing git (or a
// checkout without HEAD) leaves the build unstamped: provenance then reads as unknown,
// which is the honest answer, and nothing else about the build changes.
//
// The prune matters for the incremental test build: `tsc --incremental` never deletes a
// previously emitted output whose source was deleted or renamed, and dist/test is globbed
// by the test runner — without pruning, a renamed or removed *.test.ts would keep running
// as its stale .js forever. `npm run build` (the clean path) removes dist/ wholesale, so
// the prune is a no-op there; it costs one directory walk either way.
//
// The bin chmod matters the same way: tsc emits dist/src/cli.js 0644 on every compile,
// and the file carries a `#!/usr/bin/env node` shebang — without the exec bit back, a
// developer's direct `./dist/src/cli.js status` dies with EACCES (npm's own link/install
// re-marks bins, but the checkout itself never gains one). Both build paths end here, so
// the bit is restored on every rebuild.
import fs from "node:fs";
import path from "node:path";
import { stampBuild } from "../dist/src/build/build-info.js";

/** Artifacts in dist/ that are not compiled sources: the build stamp and tsc's own
 * incremental-state file (present when the last compile was incremental). */
const KEEP = new Set(["build-info.json", "tsconfig.tsbuildinfo"]);

function pruneDir(outDir, srcDir) {
  let entries;
  try {
    entries = fs.readdirSync(outDir, { withFileTypes: true });
  } catch {
    return; // Nothing emitted for this tree (fresh dist, or the source dir never existed).
  }
  for (const e of entries) {
    const out = path.join(outDir, e.name);
    if (e.isDirectory()) {
      pruneDir(out, path.join(srcDir, e.name));
      try {
        fs.rmdirSync(out); // Fails harmlessly while the directory still holds outputs.
      } catch {
        // Still has kept outputs.
      }
    } else if (KEEP.has(e.name)) {
      // Non-module artifact: keep.
    } else {
      // A .js output may come from a .ts or a .tsx source (the ink renderer is tsx) —
      // either counts as "has a source". Checking .ts alone pruned every .tsx's
      // output right after tsc emitted it — and `tsc --incremental` never re-emits a file its
      // build info already records, so the output stayed gone: dist/src/cli.js could not
      // import ./ui/tui.js, every CLI test failed, and one leaked stand-in hung the suite
      // (2026-10-01, the ink renderer's first .tsx).
      const base = e.name.endsWith(".js") ? e.name.slice(0, -3) : null;
      const sources = base === null ? [e.name] : [`${base}.ts`, `${base}.tsx`];
      if (!sources.some((s) => fs.existsSync(path.join(srcDir, s)))) {
        try {
          fs.unlinkSync(out);
        } catch {
          // Vanished under us: nothing left to prune.
        }
      }
    }
  }
}

const root = process.cwd();
const distDir = path.join(root, "dist");
for (const dir of ["src", "test"]) pruneDir(path.join(distDir, dir), path.join(root, dir));
for (const e of fs.existsSync(distDir) ? fs.readdirSync(distDir, { withFileTypes: true }) : []) {
  // Top level: only the keep-set and the two mirrored source trees belong here.
  if (!e.isDirectory() && !KEEP.has(e.name)) {
    try {
      fs.unlinkSync(path.join(distDir, e.name));
    } catch {
      // Vanished under us: nothing left to prune.
    }
  }
}
// The bin entry points at dist/src/cli.js (relative to the package root, as npm resolves
// it); a string form and the { name: path } object form are both legal package.json.
function binPaths(pkg) {
  const bin = pkg?.bin;
  if (typeof bin === "string") return [bin];
  if (bin && typeof bin === "object") return Object.values(bin).filter((p) => typeof p === "string");
  return [];
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const rel of binPaths(pkg)) {
  const target = path.join(root, rel);
  if (fs.existsSync(target)) fs.chmodSync(target, 0o755);
}

const info = await stampBuild(root, distDir);
if (info) process.stdout.write(`stamped dist/ with ${info.sha.slice(0, 8)}\n`);
else process.stdout.write("dist/ left unstamped (no git HEAD)\n");
