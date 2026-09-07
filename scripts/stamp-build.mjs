// Build step (package.json "build"): stamp the freshly compiled dist/ with the commit it was
// built from, so the running harness can tell whether main has moved past its own code (see
// src/build-info.ts). Runs after tsc, from the package root — npm sets cwd there — and imports
// the just-built module so the stamp's shape has exactly one definition. Missing git (or a
// checkout without HEAD) leaves the build unstamped: provenance then reads as unknown, which is
// the honest answer, and nothing else about the build changes.
import path from "node:path";
import { stampBuild } from "../dist/src/build-info.js";

const root = process.cwd();
const info = await stampBuild(root, path.join(root, "dist"));
if (info) process.stdout.write(`stamped dist/ with ${info.sha.slice(0, 8)}\n`);
else process.stdout.write("dist/ left unstamped (no git HEAD)\n");
