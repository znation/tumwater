// Post-compile dist/ preparation (package.json "build" and "test" both end here): prune
// outputs that no longer have a source, then stamp dist/ with the commit it was built
// from, so the running harness can tell whether main has moved past its own code (see
// src/build-info.ts). Runs from the package root — npm sets cwd there — and imports the
// just-built module so the stamp's shape has exactly one definition. Missing git (or a
// checkout without HEAD) leaves the build unstamped: provenance then reads as unknown,
// which is the honest answer, and nothing else about the build changes.
//
// The prune matters for the incremental test build: `tsc --incremental` never deletes a
// previously emitted output whose source was deleted or renamed, and dist/test is globbed
// by the test runner — without pruning, a renamed or removed *.test.ts would keep running
// as its stale .js forever. `npm run build` (the clean path) removes dist/ wholesale, so
// the prune is a no-op there; it costs one directory walk either way.
import fs from "node:fs";
import path from "node:path";
import { stampBuild } from "../dist/src/build-info.js";

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
      const source = path.join(
        srcDir,
        e.name.endsWith(".js") ? e.name.replace(/\.js$/, ".ts") : e.name,
      );
      if (!fs.existsSync(source)) {
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
const info = await stampBuild(root, distDir);
if (info) process.stdout.write(`stamped dist/ with ${info.sha.slice(0, 8)}\n`);
else process.stdout.write("dist/ left unstamped (no git HEAD)\n");
