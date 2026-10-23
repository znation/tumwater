import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  type InstallRunner,
  installDrift,
  npmInstall,
  resyncRootInstall,
  rootInstallResyncLines,
  syncInstall,
  syncRootInstall,
} from "../src/build/dep-install.js";
import { runBuildCheck } from "../src/build/build-check.js";
import { runScopedBuildCheck } from "../src/build/build-check-scoped.js";
import { buildCheckSkipWarning } from "../src/build/build-check-events.js";
import { readEvents } from "../src/events/event-read.js";
import { eventsOfType, warningMessages } from "./fixtures/log-fixtures.js";
import { buildCheckFixture } from "./fixtures/runner-fixtures.js";
import { pathPrepend, pathReplace, writeScript } from "./fakes/fake-commands.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { readJson } from "./helpers/json-read.js";
import { eventsLogPath } from "../src/paths.js";

// A tree's install kept in step with its lockfile (src/build/dep-install.ts, BUGS.md 2026-10-01): a
// worktree has no node_modules of its own, so a change that adds a dependency failed its gate check
// (TS2307) against the root install that predates it, and nothing ever re-synced the root after one
// merged. No test here reaches a registry: every install goes through a fake InstallRunner that
// writes the pinned manifests itself.

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
      const lock = readJson<{ packages: Record<string, { version?: string }> }>(path.join(dir, "package-lock.json"));
      for (const [key, entry] of Object.entries(lock.packages))
        if (key.startsWith("node_modules/") && entry.version) installPkg(dir, key.slice(13), entry.version);
    }
    return { ok: true };
  };
  return Object.assign(run, { calls });
}

/** Run `fn` with a fake `npm` on PATH: a fresh bin dir holding `script` as npm shadows the real
 * one while shell binaries stay reachable, and PATH is restored afterwards even when `fn` throws
 * — the shared form of the `const bin = tmpdir(...); writeScript(...); const restore =
 * pathPrepend(bin); try { ... } finally { restore(); }` boilerplate the npmInstall tests
 * repeated. */
async function withFakeNpm<T>(script: string, fn: () => Promise<T>): Promise<T> {
  const bin = tmpdir("dep-install-bin-");
  writeScript(path.join(bin, "npm"), script);
  const restore = pathPrepend(bin);
  try {
    return await fn();
  } finally {
    restore();
  }
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

test("syncInstall surfaces a throwing runner's message without an 'Error:' prefix", async () => {
  const { wt } = buildCheckFixture();
  writeLock(wt, { ink: "7.1.1" }); // drift, so the install runs
  const throwing: InstallRunner = async () => {
    throw new Error("registry unreachable");
  };
  const r = await syncInstall(wt, throwing);
  assert.equal(r?.ok, false);
  assert.equal(r?.detail, "registry unreachable");
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

test("a failed install skips the gate check but rejects the merge as unverified", async () => {
  const { root, wt } = buildCheckFixture();
  writeLock(wt, { ink: "7.1.1" });
  const gate = await runScopedBuildCheck(root, "feature", "gate", wt, undefined, 30_000, undefined, fakeInstaller("fail"));
  assert.equal(gate!.outcome.status, "skipped");
  assert.equal(gate!.outcome.skipReason, "install");
  const mergeResult = await runScopedBuildCheck(root, "feature", "merge", wt, undefined, 30_000, undefined, fakeInstaller("fail"));
  assert.equal(mergeResult!.outcome.status, "failed");
  assert.equal(mergeResult!.outcome.unverified, true);
  assert.match(mergeResult!.outcome.outputTail?.[0] ?? "", /dependency install \(ink\) failed: .*ENOTFOUND.*the tree is unverified/);
  const priced = eventsOfType(root, "build_check").find((e) => e.scope === "merge");
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
  assert.equal(install.calls.length, 1, "an in-step root spawns nothing on the next merge");
});

// The production installer itself, driven by a fake npm on PATH (the suite's offline shim
// pattern): every branch of npmInstall's outcome handling — success, nonzero exit, a missing
// binary, a timeout, a signal death — exercises the real runScriptGroup spawn, and no run
// reaches a registry because the fake npm is the only npm on PATH.

test("npmInstall installs from the pinned args and syncInstall accepts the result through the default runner", async () => {
  const wt = tmpdir("dep-install-npm-ok-");
  writeLock(wt, { ink: "7.1.1" });
  await withFakeNpm(
    // Record the arguments npm was pinned to, then leave the package where npm would.
    'printf "%s\\n" "$@" >> .npm-args && mkdir -p node_modules/ink && printf \'{"name":"ink","version":"7.1.1"}\' > node_modules/ink/package.json',
    async () => {
      const r = await syncInstall(wt); // No installer argument: the default npmInstall runs.
      assert.deepEqual(r?.packages, ["ink"]);
      assert.equal(r?.ok, true);
      assert.ok((r?.durationMs ?? -1) >= 0);
      const args = fs.readFileSync(path.join(wt, ".npm-args"), "utf8").trim().split("\n");
      assert.deepEqual(args, ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund"]);
    },
  );
});

test("npmInstall reports a nonzero exit with the output's last line", async () => {
  await withFakeNpm("echo 'npm warn nothing' >&2; echo 'npm error code ENOTFOUND' >&2; exit 1", async () => {
    const r = await npmInstall(tmpdir("dep-install-npm-fail-"), 30_000);
    assert.equal(r.ok, false);
    assert.equal(r.detail, "npm install exited 1: npm error code ENOTFOUND");
  });
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
  await withFakeNpm("sleep 5", async () => {
    const r = await npmInstall(tmpdir("dep-install-npm-slow-"), 200);
    assert.equal(r.ok, false);
    assert.equal(r.detail, "npm install timed out after 0.2s");
  });
});

test("npmInstall reports an install killed by a signal before the timeout", async () => {
  await withFakeNpm("kill -s TERM $$", async () => {
    const r = await npmInstall(tmpdir("dep-install-npm-signal-"), 30_000);
    assert.equal(r.ok, false);
    assert.equal(r.detail, "npm install was killed by SIGTERM");
  });
});

test("syncRootInstall warns when the root install fails, and stays silent with no drift", async () => {
  const quiet = tmpdir("dep-install-quiet-");
  await syncRootInstall(quiet, "feature", fakeInstaller("fail"));
  assert.deepEqual(readEvents(quiet), []);
  const root = tmpdir("dep-install-fail-");
  writeLock(root, { ink: "7.1.1" });
  await syncRootInstall(root, "feature", fakeInstaller("fail"));
  assert.equal(eventsOfType(root, "dep_install")[0]?.status, "failed");
  assert.ok(warningMessages(root).some((m) => m.includes('root install did not pick up main\'s dependencies (ink)')));
});

test("syncRootInstall resolves when the events feed is unwritable, leaving the post-ff merge un-rejected", async () => {
  const root = tmpdir("dep-install-broken-feed-");
  writeLock(root, { ink: "7.1.1" });
  // A directory at the feed path makes every append throw EISDIR. The install itself still
  // succeeds, and the dep_install pricing that follows is observability: the merge that awaits this
  // after its fast-forward must not be turned into a failure by it.
  fs.mkdirSync(eventsLogPath(root), { recursive: true });
  const install = fakeInstaller();

  await syncRootInstall(root, "feature", install);

  assert.deepEqual(install.calls, [root], "the awaited root install still ran");
  assert.deepEqual(installDrift(root), [], "the root install was still re-synced");
});

test("resyncRootInstall reports nothing to do, a re-sync and a failure, logging under tumwater", async () => {
  // A real root's merge lock lives under `.tumwater` (always present in an initialized project);
  // give each fixture one so the lock can acquire.
  const project = (label: string): string => {
    const dir = tmpdir(label);
    fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
    return dir;
  };
  // No lockfile (nothing pinned): attempted false, nothing spawned, nothing logged, and the line
  // says there is nothing to match — not that the tree matches a lockfile none exists.
  const quiet = project("dep-install-resync-quiet-");
  const still = await resyncRootInstall(quiet, fakeInstaller());
  assert.equal(still.attempted, false);
  assert.equal(still.ok, true);
  assert.deepEqual(still.packages, []);
  assert.equal(still.pinned, false);
  assert.deepEqual(readEvents(quiet), []);
  assert.deepEqual(rootInstallResyncLines(still), ["no package-lock.json to match — nothing to re-sync"]);

  // A lockfile the tree already matches (no drift): attempted false, but pinned true, so the line
  // says the install already matches the lockfile rather than that there is none to match.
  const match = project("dep-install-resync-match-");
  writeLock(match, { ink: "7.1.1" });
  installPkg(match, "ink", "7.1.1");
  const matched = await resyncRootInstall(match, fakeInstaller());
  assert.equal(matched.attempted, false);
  assert.equal(matched.pinned, true);
  assert.deepEqual(rootInstallResyncLines(matched), ["node_modules already matches package-lock.json — nothing to re-sync"]);

  // A drifted root: one dep_install under TUMWATER_SOURCE naming the re-synced packages.
  const root = project("dep-install-resync-");
  writeLock(root, { ink: "7.1.1", "left-pad": "1.3.0" });
  const install = fakeInstaller();
  const r = await resyncRootInstall(root, install);
  assert.deepEqual(install.calls, [root]);
  assert.equal(r.attempted, true);
  assert.equal(r.ok, true);
  assert.deepEqual(r.packages, ["ink", "left-pad"]);
  const [event] = eventsOfType(root, "dep_install");
  assert.equal(event?.source, "tumwater");
  assert.deepEqual(event?.packages, ["ink", "left-pad"]);
  assert.equal(event?.status, "passed");
  assert.match(rootInstallResyncLines(r)[0] ?? "", /re-synced the root install \(ink, left-pad\) in/);

  // A failing fake: ok false with its detail, a warn, and no throw.
  const failRoot = project("dep-install-resync-fail-");
  writeLock(failRoot, { ink: "7.1.1" });
  const failed = await resyncRootInstall(failRoot, fakeInstaller("fail"));
  assert.equal(failed.attempted, true);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.packages, ["ink"]);
  assert.match(failed.detail ?? "", /ENOTFOUND/);
  assert.equal(eventsOfType(failRoot, "dep_install")[0]?.status, "failed");
  assert.ok(warningMessages(failRoot).some((m) => m.includes("root install re-sync did not pick up the root lockfile's dependencies (ink)")));
  assert.equal(rootInstallResyncLines(failed)[0], "the root install re-sync failed: npm install exited 1: ENOTFOUND registry.npmjs.org");
});
