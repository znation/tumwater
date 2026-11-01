// The compile step of package.json's build and suite scripts: TypeScript 7's native compiler,
// installed as the `typescript-native` alias (npm:typescript@7). It type-checks and emits the
// same JavaScript as the JS compiler did (every file byte-identical, 2026-11-01) in a fraction of
// the time: a full build 0.5 s against 4.2 s, a no-op `--incremental` 0.17 s against 1.0 s, a
// one-file edit about 0.5 s against 2.2–2.7 s. `typescript` itself stays on 5.x because
// typescript-eslint's type-aware lint needs its JS API (TypeScript 7 has none it supports), and
// because the harness's self-redeploy compiles with `node_modules/typescript/bin/tsc`.
//
// Both packages ship a `tsc` bin and npm links only one of them, in an order that is not fixed, so
// the scripts never call a bare `tsc`. This finds the alias the way Node does, climbing to an
// ancestor's node_modules (team worktrees have none of their own), and runs its launcher, which
// replaces this process with the native binary and passes these arguments through.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

let manifest;
try {
  manifest = createRequire(import.meta.url).resolve("typescript-native/package.json");
} catch {
  process.stderr.write("tumwater: typescript-native is not installed — run `npm install`\n");
  process.exit(1);
}
await import(pathToFileURL(path.join(path.dirname(manifest), "lib", "tsc.js")).href);
