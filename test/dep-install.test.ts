import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  type InstallRunner,
  installDrift,
  npmInstall,
  syncInstall,
  syncRootInstall,
} from "../src/build/dep-install.js";
import { runBuildCheck } from "../src/build/build-check.js";
import { runScopedBuildCheck } from "../src/build/build-check-scoped.js";
import { buildCheckSkipWarning } from "../src/build/build-check-events.js";
import { readEvents } from "../src/events/event-read.js";
import { eventsOfType, warningMessages } from "./log-fixtures.js";
import { buildCheckFixture } from "./loop-fixtures.js";
import { pathPrepend, pathReplace, writeScript } from "./fake-commands.js";
import { tmpdir } from "./repo-fixtures.js";

// A tree's install kept in step with its lockfile (src/build/dep-install.ts, BUGS.md 2026-10-01): a
// worktree has no node_modules of its own, so a change that adds a dependency failed its gate
// check (TS2307) against the root install that predates it, and nothing ever re-synced the root
// after one landed. No test here reaches a registry: every install goes through a fake
// InstallRunner that writes the pinned manifests itself.

/** A v3 lockfile pinning `deps` (name → version) as direct dependencies of `dir`. */
function writeLock(dir: string, deps: Record<string, string>, dev: Record<string, string> = {}): void {
  const packages: Record<string, object> = { "": { name: "proj", dependencies: deps, devDependencies: dev } };
  for (const [name, version] of Object.entries({ ...deps, ...dev }))
    packages[`node_modules/${name}`] = { version };
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
}

/** Install `name@version` into `dir/node_modules` the way npm leaves it on disk. */
function installPkg(dir: string, name: string, version: string): void {
  const pkgDir = path.join(dir, "node_modules", name);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name, version }));
}

/** A fake installer that installs `dir`'s lockfile pins (or does nothing / fails), recording
 * every dir it was asked to install. */
function fakeInstaller(mode: "install" | "noop" | "fail" = "install"): InstallRunner & { calls: string[] } {
  const calls: string[] = [];
  const run = async (dir: string) => {
    calls.push(dir);
    if (mode === "fail") return { ok: false, detail: "npm install exited 1: ENOTFOUND registry.npmjs.org" };
    if (mode === "install") {
      const lock = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"));
      for (const [key, entry] of Object.entries(lock.packages as Record<string, { version?: string }>))
        if (key.startsWith("node_modules/") && entry.version) installPkg(dir, key.slice(13), entry.version);
    }
    return { ok: true };
  };
  return Object.assign(run, { calls });
}

test("installDrift owes nothing without a lockfile, or when the walk-up resolves every pin", () => {
  const { root, wt } = buildCheckFixture();
  assert.deepEqual(installDrift(wt), [], "no lockfile pins nothing");
  installPkg(root, "left-pad", "1.3.0");
  writeLock(wt, { "left-pad": "1.3.0" });
  assert.deepEqual(installDrift(wt), [], "the root install an ancestor of the worktree provides counts");
});

test("installDrift names a direct dependency the walk-up lacks or holds at another version", () => {
  const { root, wt } = buildCheckFixture();
  installPkg(root, "left-pad", "1.3.0");
  installPkg(root, "typescript", "5.6.0");
  writeLock(wt, { "left-pad": "1.3.0", ink: "7.1.1" }, { typescript: "5.7.0" });
  assert.deepEqual(installDrift(wt), ["ink", "typescript"]);
});

test("syncInstall spawns nothing when nothing drifted", async () => {
  const { wt } = buildCheckFixture();
  const install = fakeInstaller();
  assert.equal(await syncInstall(wt, install), null);
  assert.deepEqual(install.calls, []);
});

test("syncInstall reports an install that exited 0 but left a pin unresolved as a failure", async () => {
  const { wt } = buildCheckFixture();
  writeLock(wt, { ink: "7.1.1" });
  const r = await syncInstall(wt, fakeInstaller("noop"));
  assert.equal(r?.ok, false);
  assert.match(r?.detail ?? "", /still unresolved after install: ink/);
});

// The reported trap: a worktree whose lockfile adds a package the root install never had. The
// build tool fails exactly as tsc's TS2307 did unless the package is installed into the tree.
test("runBuildCheck installs a drifted lockfile into the tree before running the check", async () => {
  const { root, wt } = buildCheckFixture();
  writeLock(wt, { ink: "7.1.1" });
  writeScript(
    path.join(root, "node_modules", ".bin", "buildcheck-tool"),
    "[ -f node_modules/ink/package.json ] && echo ok || { echo \"error TS2307: Cannot find module 'ink'\"; exit 1; }",
  );
  const install = fakeInstaller();
  const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000, undefined, undefined, install);
  assert.equal(outcome.status, "passed");
  assert.deepEqual(install.calls, [wt], "installed into the checked tree, never the root");
  assert.deepEqual(outcome.install?.packages, ["ink"]);
});

test("a failed install skips the gate check but rejects the landing as unverified", async () => {
  const { root, wt } = buildCheckFixture();
  writeLock(wt, { ink: "7.1.1" });
  const gate = await runScopedBuildCheck(root, "feature", "gate", wt, undefined, 30_000, undefined, fakeInstaller("fail"));
  assert.equal(gate!.outcome.status, "skipped");
  assert.equal(gate!.outcome.skipReason, "install");
  const landing = await runScopedBuildCheck(root, "feature", "landing", wt, undefined, 30_000, undefined, fakeInstaller("fail"));
  assert.equal(landing!.outcome.status, "failed");
  assert.equal(landing!.outcome.unverified, true);
  assert.match(landing!.outcome.outputTail?.[0] ?? "", /dependency install \(ink\) failed: .*ENOTFOUND.*the tree is unverified/);
  const priced = eventsOfType(root, "build_check").find((e) => e.scope === "landing");
  assert.deepEqual(priced?.installed, ["ink"], "the feed names what the check tried to install");
});

test("buildCheckSkipWarning names the packages and the failure on an install skip", () => {
  assert.equal(
    buildCheckSkipWarning("install", "gate check", "proceeding to review", 30_000, undefined, undefined, {
      packages: ["ink", "react"],
      detail: "npm install exited 1",
    }),
    "the dependency install (ink, react) failed: npm install exited 1; skipping gate check; proceeding to review",
  );
});

test("syncRootInstall re-syncs a drifted root install and prices it as a dep_install event", async () => {
  const root = tmpdir("dep-install-root-");
  writeLock(root, { ink: "7.1.1" });
  const install = fakeInstaller();
  await syncRootInstall(root, "feature", install);
  assert.deepEqual(install.calls, [root]);
  const [event] = eventsOfType(root, "dep_install");
  assert.deepEqual(event?.packages, ["ink"]);
  assert.equal(event?.status, "passed");
  await syncRootInstall(root, "feature", install);
  assert.equal(install.calls.length, 1, "an in-step root spawns nothing on the next landing");
});

// The production installer itself, driven by a fake npm on PATH (the suite's offline shim
// pattern): every branch of npmInstall's outcome handling — success, nonzero exit, a missing
// binary, a timeout, a signal death — exercises the real runScriptGroup spawn, and no run
// reaches a registry because the fake npm is the only npm on PATH.

test("npmInstall installs from the pinned args and syncInstall accepts the result through the default runner", async () => {
  const wt = tmpdir("dep-install-npm-ok-");
  writeLock(wt, { ink: "7.1.1" });
  const bin = tmpdir("dep-install-bin-");
  writeScript(
    path.join(bin, "npm"),
    // Record the arguments npm was pinned to, then leave the package where npm would.
    'printf "%s\\n" "$@" >> .npm-args && mkdir -p node_modules/ink && printf \'{"name":"ink","version":"7.1.1"}\' > node_modules/ink/package.json',
  );
  const restore = pathPrepend(bin); // The fake shadows the real npm; shell binaries stay reachable.
  try {
    const r = await syncInstall(wt); // No installer argument: the default npmInstall runs.
    assert.deepEqual(r?.packages, ["ink"]);
    assert.equal(r?.ok, true);
    assert.ok((r?.durationMs ?? -1) >= 0);
    const args = fs.readFileSync(path.join(wt, ".npm-args"), "utf8").trim().split("\n");
    assert.deepEqual(args, ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund"]);
  } finally {
    restore();
  }
});

test("npmInstall reports a nonzero exit with the output's last line", async () => {
  const bin = tmpdir("dep-install-bin-");
  writeScript(path.join(bin, "npm"), "echo 'npm warn nothing' >&2; echo 'npm error code ENOTFOUND' >&2; exit 1");
  const restore = pathPrepend(bin);
  try {
    const r = await npmInstall(tmpdir("dep-install-npm-fail-"), 30_000);
    assert.equal(r.ok, false);
    assert.equal(r.detail, "npm install exited 1: npm error code ENOTFOUND");
  } finally {
    restore();
  }
});

test("npmInstall reports npm missing from PATH as a spawn error, not a crash", async () => {
  // execFile spawns npm directly (no shell), so PATH can be emptied entirely here — the
  // isolation pathPrepend cannot express, since the real npm must NOT stay reachable.
  const restore = pathReplace(tmpdir("dep-install-empty-bin-"));
  try {
    const r = await npmInstall(tmpdir("dep-install-npm-missing-"), 30_000);
    assert.equal(r.ok, false);
    assert.equal(r.detail, "npm is not on PATH");
  } finally {
    restore();
  }
});

test("npmInstall reports an install that outlives its timeout", async () => {
  const bin = tmpdir("dep-install-bin-");
  writeScript(path.join(bin, "npm"), "sleep 5");
  const restore = pathPrepend(bin);
  try {
    const r = await npmInstall(tmpdir("dep-install-npm-slow-"), 200);
    assert.equal(r.ok, false);
    assert.equal(r.detail, "npm install timed out after 0.2s");
  } finally {
    restore();
  }
});

test("npmInstall reports an install killed by a signal before the timeout", async () => {
  const bin = tmpdir("dep-install-bin-");
  writeScript(path.join(bin, "npm"), "kill -s TERM $$");
  const restore = pathPrepend(bin);
  try {
    const r = await npmInstall(tmpdir("dep-install-npm-signal-"), 30_000);
    assert.equal(r.ok, false);
    assert.equal(r.detail, "npm install was killed by SIGTERM");
  } finally {
    restore();
  }
});

test("syncRootInstall warns when the root install fails, and stays silent with no drift", async () => {
  const quiet = tmpdir("dep-install-quiet-");
  await syncRootInstall(quiet, "feature", fakeInstaller("fail"));
  assert.deepEqual(readEvents(quiet), []);
  const root = tmpdir("dep-install-fail-");
  writeLock(root, { ink: "7.1.1" });
  await syncRootInstall(root, "feature", fakeInstaller("fail"));
  assert.equal(eventsOfType(root, "dep_install")[0]?.status, "failed");
  assert.ok(warningMessages(root).some((m) => /root install did not pick up main's dependencies \(ink\)/.test(m)));
});
