import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ghReadiness, ghRunner } from "../src/github/gh.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { pathPrepend, pathReplace, writeScript } from "./fakes/fake-commands.js";
import { setEnv } from "./helpers/env.js";

// Every GitHub-facing test injects fakeGh()'s probe (test/fakes/fake-gh.ts), so nothing tested
// the DEFAULT runner src/github/gh.ts hands its callers — ghRunner(pathEnv) over boundedProbe
// (src/process/bounded-probe.ts). That wiring is where four promises live: gh is resolved on the
// pathEnv PATH handed in, not the process's inherited PATH (every caller passes the PATH the
// harness probed); the args vector reaches gh verbatim, spaces and all — `gh api
// repos/<repo>/issues?state=open&per_page=100` is one argument, and a runner that word-split it
// would still answer fakeGh-style tests while the real gh rejected it; the environment is
// inherited apart from PATH, so the operator's GH_TOKEN/GH_HOST reach gh; and a gh that cannot be
// resolved answers null, never a throw. Each test drives a fake `gh` script on PATH — no test
// reaches a real gh (PRINCIPLES.md). The fake answers on stdout, which is what the probe returns.

/** A dir holding a fake `gh` whose body is `body`. */
function ghBin(body: string): string {
  const bin = tmpdir("gh-runner-bin-");
  writeScript(path.join(bin, "gh"), body);
  return bin;
}

test("ghRunner forwards the args vector verbatim and returns gh's code and stdout", async () => {
  // The fake prints each argument wrapped in <>, so an argument carrying a space survives only
  // if the runner handed it over as one argument — the shape every `gh api …` call needs.
  const bin = ghBin('printf "<%s>" "$@"');
  const probe = await ghRunner(bin)(["api", "repos/o/r/issues?state=open&per_page=100", "--paginate", "two words"]);
  assert.deepEqual(probe, {
    code: 0,
    stdout: "<api><repos/o/r/issues?state=open&per_page=100><--paginate><two words>",
  });
});

test("ghRunner runs the gh on the pathEnv PATH, not the inherited one", async () => {
  // A decoy gh sits on the INHERITED PATH: a runner that probed process.env.PATH (or appended
  // pathEnv to it) would run the decoy, and every GitHub surface would read the wrong install —
  // the harness probes its own PATH precisely so it does not inherit the shell's.
  const decoy = ghBin('echo "decoy"');
  const bin = ghBin('echo "chosen"');
  const restore = pathReplace(`${decoy}${path.delimiter}${bin}`);
  try {
    const probe = await ghRunner(bin)(["--version"]);
    assert.deepEqual(probe, { code: 0, stdout: "chosen\n" }, "the pathEnv gh answered, not the decoy on PATH");
  } finally {
    restore();
  }
});

test("ghRunner inherits the environment apart from PATH, which is exactly the pathEnv", async () => {
  // The operator's gh login lives in the environment (GH_TOKEN, GH_HOST) and in gh's own config
  // home, so the probe inherits the environment and overrides only PATH — and PATH must be the
  // pathEnv itself, not the process PATH with pathEnv prepended, so the harness's probed PATH is
  // the one gh is resolved on.
  const sentinel = "TUMWATER_TEST_GH_RUNNER_SENTINEL";
  const decoy = ghBin('echo "decoy"');
  const restoreEnv = setEnv(sentinel, "kept");
  const restorePath = pathPrepend(decoy);
  try {
    const bin = ghBin(`printf 'env=%s path=%s\\n' "\$${sentinel}" "$PATH"`);
    const probe = await ghRunner(bin)(["--version"]);
    assert.equal(probe!.stdout, `env=kept path=${bin}\n`);
  } finally {
    restorePath();
    restoreEnv();
  }
});

test("ghRunner answers null, never throws, when no gh can be resolved", async () => {
  // An empty PATH: node reports ENOENT on the child, and the probe's answer is null — the same
  // shape every caller already handles for a probe that could not finish. A thrown error would
  // crash the doctor's `github issues` row and the hourly scan instead of reporting them.
  const restore = pathReplace(tmpdir("gh-runner-empty-bin-"));
  try {
    assert.equal(await ghRunner(process.env.PATH ?? "")(["--version"]), null);
  } finally {
    restore();
  }
});

test("ghReadiness over the default runner answers unauthenticated, missing, and ok", async () => {
  // The readiness verdict's production path: fakeGh's probes pin the verdict mapping, and this
  // pins it over the default runner — the exit codes the real probe reports do reach those arms.
  // The first fake answers `--version` and fails `auth status`; the second fails `--version`; a
  // dir with no gh at all answers null, which the mapping also reads as missing.
  const unauth = ghBin('if [ "$1" = "--version" ]; then echo "gh version 2.60.0"; else exit 1; fi');
  assert.equal(await ghReadiness(ghRunner(unauth)), "unauthenticated");
  const broken = ghBin('if [ "$1" = "--version" ]; then exit 127; else exit 0; fi');
  assert.equal(await ghReadiness(ghRunner(broken)), "missing");
  const ok = ghBin('if [ "$1" = "--version" ]; then echo "gh version 2.60.0"; else exit 0; fi');
  assert.equal(await ghReadiness(ghRunner(ok)), "ok");
  const empty = tmpdir("gh-runner-missing-bin-");
  assert.equal(await ghReadiness(ghRunner(empty)), "missing");
});
