// Cut releases and bump for the next one. Main always carries the NEXT version; a
// release tags the version main already has:
//
//   node scripts/release.mjs                          # release: push main, wait for CI, tag `v<version>`
//   node scripts/release.mjs bump [patch|minor|major] # right after a release: bump, commit `tumwater(release): <version>`, push
//   node scripts/release.mjs --status                 # report version/tag/CI state, change nothing
//
// The bump is a separate commit AFTER the tag, never part of the release: a tag then
// always names the exact commit CI green-lit while package.json still said the released
// version (the Release workflow's tag-vs-version check passes trivially), and main's
// version means what's next while npm's `latest` means what shipped. The old flow bumped
// before tagging, which folded a version commit into every release.
// This script never publishes: publishing lives in the Release workflow (trusted
// publishing OIDC), so npm only ever ships what CI just tested.
//
// Refuses to act when: the tree is dirty, HEAD is not on main, main diverged from
// origin/main, or the version's tag already exists locally or on the remote.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd(); // npm runs scripts from the package root

function die(msg) {
  process.stderr.write(`release: ${msg}\n`);
  process.exit(1);
}

const sh = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch (e) {
    die(`git ${args.join(" ")} failed:\n${e.stderr || e.message}`);
  }
};

/** git that reports failure instead of dying — for pushes the caller can retry. */
const soft = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const usage = "usage: node scripts/release.mjs [--status]\n       node scripts/release.mjs bump [patch|minor|major]";
const LEVELS = ["patch", "minor", "major"];
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("-"));
const flags = args.filter((a) => a.startsWith("-"));
const statusOnly = flags.includes("--status");
if (flags.some((f) => f !== "--status")) die(`unknown flag: ${flags.find((f) => f !== "--status")}\n${usage}`);
if (positional.length > 2 || (positional[0] && positional[0] !== "bump")) die(`unknown argument(s): ${positional.join(" ")}\n${usage}`);
const bumpMode = positional[0] === "bump";
if (bumpMode && positional[1] && !LEVELS.includes(positional[1])) {
  die(`unknown bump level: ${positional[1]}\n${usage}`);
}
const bumpLevel = bumpMode ? (positional[1] ?? "patch") : null;

// --- state -------------------------------------------------------------------

const head = () => sh("rev-parse", "HEAD");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const tag = `v${version}`;
const tagTaken = Boolean(sh("tag", "-l", tag) || sh("ls-remote", "--tags", "origin", `refs/tags/${tag}`));

function guardMain() {
  const branch = sh("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") die(`HEAD is on ${branch}, not main — cut releases from main.`);
  const dirty = sh("status", "--porcelain");
  if (dirty) die(`working tree is not clean — commit or stash first:\n${dirty}`);
  const remoteMain = sh("ls-remote", "origin", "refs/heads/main").split(/\s+/)[0];
  if (!remoteMain) die("origin has no refs/heads/main — is the repo pushed at all?");
  const mergeBase = sh("merge-base", "HEAD", remoteMain);
  if (mergeBase !== remoteMain) die("main has diverged from origin/main — reconcile (pull/rebase) before releasing.");
  return Number(sh("rev-list", "--count", `${remoteMain}..HEAD`));
}

if (statusOnly) {
  const branch = sh("rev-parse", "--abbrev-ref", "HEAD");
  const dirty = sh("status", "--porcelain");
  const remoteMain = sh("ls-remote", "origin", "refs/heads/main").split(/\s+/)[0];
  const ahead = remoteMain ? Number(sh("rev-list", "--count", `${remoteMain}..HEAD`)) : "?";
  const run = ciRun(head());
  console.log(`version ${version} → tag ${tag} @ ${head().slice(0, 8)} on ${branch}${dirty ? " (dirty!)" : ""}`);
  console.log(`origin/main: ${ahead} commit(s) to push`);
  console.log(`CI: ${run ? `run ${run.databaseId}: ${run.status} ${run.conclusion ?? ""}` : "no run yet for HEAD"}`);
  console.log(`tag: ${tagTaken ? "already exists" : "not yet created"}`);
  process.exit(0);
}

// --- bump: the version commit that follows a release -------------------------

if (bumpMode) {
  const ahead = guardMain();
  const out = spawnSync("npm", ["version", "--no-git-tag-version", bumpLevel], { cwd: root, encoding: "utf8" });
  if (out.status !== 0) die(`npm version failed: ${(out.stderr || out.stdout).trim()}`);
  const newVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  sh("add", "package.json", "package-lock.json");
  sh("commit", "-m", `tumwater(release): ${newVersion}`);
  if (soft("push", "origin", "main") === null) {
    // The fleet lands commits continuously; replay the bump on the new main and retry once.
    console.log("push rejected — origin moved; replaying the bump on the new main…");
    if (soft("pull", "--rebase", "origin", "main") === null) die("could not rebase onto origin/main — reconcile manually, then re-run.");
    if (soft("push", "origin", "main") === null) die("push still rejected after rebase — reconcile manually, then re-run.");
  }
  console.log(`bumped ${version} → ${newVersion} (${bumpLevel}); committed and pushed (was ${ahead} commit(s) ahead).`);
  console.log("cut it when ready: node scripts/release.mjs");
  process.exit(0);
}

// --- release: tag what main already carries ----------------------------------

const ahead = guardMain();
if (tagTaken) die(`tag ${tag} already exists — if it is wrong, delete it on both sides and re-cut.`);

console.log(`releasing ${version} → tag ${tag} @ ${head().slice(0, 8)} (${ahead} commit(s) to push)`);

console.log("pushing main…");
sh("push", "origin", "main");

console.log("waiting for CI on the pushed commit…");
const pushed = head();
const deadline = Date.now() + 5 * 60 * 1000;
while (!ciRun(pushed) && Date.now() < deadline) await sleep(15_000);
const run = ciRun(pushed);
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

console.log(`tag ${tag} pushed — release.yml publishes to npm via trusted publishing and creates the GitHub release.`);
console.log("watch it: gh run watch $(gh run list --workflow Release --limit 1 --json databaseId -q '.[0].databaseId')");
console.log("then bump for the next cut: node scripts/release.mjs bump");
