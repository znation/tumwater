// Cut a release: bump (when asked), push main, wait for CI, then push the `v<version>`
// tag — the `v*` trigger runs .github/workflows/release.yml, which re-runs the full
// suite on the tag, stages the package on npm with --provenance (a maintainer approves
// the stage with 2FA before it goes live), and attaches the tarball to a GitHub
// release. This script never publishes or stages itself: npm auth lives only in the
// workflow's NPM_TOKEN secret, so a release is always exactly what CI just tested.
//
// Usage:
//   node scripts/release.mjs                    # release the current package.json version
//   node scripts/release.mjs patch|minor|major  # bump, commit, then release the new version
//   node scripts/release.mjs --status           # report version/tag/CI state, change nothing
//
// Refuses to act when: the tree is dirty, HEAD is not on main, main diverged from
// origin/main, or the version's tag already exists locally or on the remote. The commit
// the tag names is always the one CI green-lit, never an implicit newer commit.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd(); // npm runs scripts from the package root
const sh = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch (e) {
    die(`git ${args.join(" ")} failed:\n${e.stderr || e.message}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg) {
  process.stderr.write(`release: ${msg}\n`);
  process.exit(1);
}

function gh(args) {
  const out = spawnSync("gh", args, { cwd: root, encoding: "utf8" });
  if (out.error?.code === "ENOENT") die("`gh` is not on PATH — install the GitHub CLI to cut releases.");
  if (out.status !== 0) return null; // e.g. no run yet for this commit
  return JSON.parse(out.stdout);
}

/** The latest CI run row for a commit, or null when none exists yet. */
function ciRun(commit) {
  const runs = gh(["run", "list", "--workflow", "CI", "--commit", commit, "--json", "databaseId,status,conclusion"]);
  return runs?.length ? runs[runs.length - 1] : null;
}

async function ciWait(runId) {
  const deadline = Date.now() + 30 * 60 * 1000; // observed CI wall time is ~3.5 minutes
  let state = null;
  while (Date.now() < deadline) {
    const rows = gh(["run", "view", String(runId), "--json", "databaseId,status,conclusion"]);
    if (rows) state = { ...rows, databaseId: runId };
    if (state?.status === "completed") return state;
    await sleep(30_000);
  }
  return { status: "timed-out", conclusion: null, databaseId: runId };
}

// --- arguments ---------------------------------------------------------------

const args = process.argv.slice(2);
const statusOnly = args.includes("--status");
const bump = args.find((a) => ["patch", "minor", "major"].includes(a));
const unknown = args.filter((a) => !["patch", "minor", "major", "--status"].includes(a));
if (unknown.length) {
  die(`unknown argument(s): ${unknown.join(" ")}\n` +
    "usage: node scripts/release.mjs [patch|minor|major] [--status]");
}

// --- state -------------------------------------------------------------------

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return { version: pkg.version, tag: `v${pkg.version}` };
}

const branch = sh("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") die(`HEAD is on ${branch}, not main — cut releases from main.`);

const dirty = sh("status", "--porcelain");
if (dirty) die(`working tree is not clean — commit or stash first:\n${dirty}`);

const remoteMain = sh("ls-remote", "origin", "refs/heads/main").split(/\s+/)[0];
if (!remoteMain) die("origin has no refs/heads/main — is the repo pushed at all?");
const ahead = Number(sh("rev-list", "--count", `${remoteMain}..HEAD`));
const mergeBase = sh("merge-base", "HEAD", remoteMain);
if (mergeBase !== remoteMain) die("main has diverged from origin/main — reconcile (pull/rebase) before releasing.");

let { version, tag } = readVersion();
const head = () => sh("rev-parse", "HEAD");
let run = ciRun(head());

console.log(`version ${version} → tag ${tag} @ ${head().slice(0, 8)} on ${branch}`);
console.log(`origin/main: ${ahead} commit(s) to push`);
console.log(`CI: ${run ? `run ${run.databaseId}: ${run.status} ${run.conclusion ?? ""}` : "no run yet for HEAD"}`);
console.log(`tag: ${sh("tag", "-l", tag) || sh("ls-remote", "--tags", "origin", `refs/tags/${tag}`) ? "already exists" : "not yet created"}`);

if (statusOnly) process.exit(0);

// --- actions -----------------------------------------------------------------

if (bump) {
  // npm version edits package.json and package-lock.json; --no-git-tag-version leaves
  // the commit to us, stamped per the repo's tumwater(<role>): convention.
  const out = spawnSync("npm", ["version", "--no-git-tag-version", bump], { cwd: root, encoding: "utf8" });
  if (out.status !== 0) die(`npm version failed: ${(out.stderr || out.stdout).trim()}`);
  version = out.stdout.trim().replace(/^v/, ""); // npm echoes the new version as "v0.2.0"
  tag = `v${version}`;
  execFileSync("git", ["add", "package.json", "package-lock.json"], { cwd: root });
  execFileSync("git", ["commit", "-m", `tumwater(release): ${version}`], { cwd: root });
  console.log(`bumped to ${version} and committed.`);
} else if (sh("tag", "-l", tag) || sh("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) {
  die(`tag ${tag} already exists — if it is wrong, delete it on both sides and re-cut.`);
}

console.log("pushing main…");
sh("push", "origin", "main");

console.log("waiting for CI on the pushed commit…");
const pushed = head();
const deadline = Date.now() + 5 * 60 * 1000;
while (!ciRun(pushed) && Date.now() < deadline) await sleep(15_000);
run = ciRun(pushed);
if (!run) die("CI never started for the pushed commit within 5 minutes — check Actions, then re-run with --status.");

const state = await ciWait(run.databaseId);
if (state.status === "timed-out") {
  die(`CI (run ${state.databaseId}) still running after 30 minutes — check it, then re-run with --status.`);
}
if (state.conclusion !== "success") {
  die(`CI run ${state.databaseId} concluded ${state.conclusion} — fix and re-cut.`);
}

console.log(`CI green (run ${state.databaseId}); pushing tag ${tag}…`);
sh("tag", "-a", tag, "-m", `tumwater ${version}`, pushed);
sh("push", "origin", tag);

console.log(`tag ${tag} pushed — release.yml now publishes to npm via trusted publishing and creates the GitHub release.`);
console.log("watch it: gh run watch $(gh run list --workflow Release --limit 1 --json databaseId -q '.[0].databaseId')");