import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import {
  INITIAL_PROMPT_MAX_CHARS,
  PROMPT_END,
  PROMPT_START,
  briefFile,
  readInitialPrompt,
} from "../src/readme.js";
import { defaultConfig, loadConfig } from "../src/config.js";
import { VALIDATION_GAP_TAGS } from "../src/roles.js";
import { exampleConfigPath } from "../src/paths.js";
import { makeRepo, sh, tmpdir } from "./util.js";

test("initProject creates and commits the harness files", async () => {
  const repo = makeRepo();
  const result = await initProject(repo, "Build a todo CLI.");
  assert.deepEqual(
    [...result.created].sort(),
    [".gitignore", "BUGS.md", "PLANS.md", "PRINCIPLES.md", "QUESTIONS.md", "README.md", "tumwater.json"],
  );
  assert.ok(result.committed);
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
  assert.equal(readInitialPrompt(repo), "Build a todo CLI.");
  assert.match(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), /^\.tumwater\/$/m);
  assert.ok(loadConfig(repo).roles.director?.enabled);
});

test("initProject works on a repo with no commits", async () => {
  const dir = tmpdir();
  sh(dir, "git", "init", "-b", "main");
  const result = await initProject(dir, "Fresh start.");
  assert.ok(result.committed);
  assert.equal(sh(dir, "git", "log", "--oneline").split("\n").length, 1);
});

test("initProject seeds PRINCIPLES.md with positive starter principles", async () => {
  const repo = makeRepo();
  await initProject(repo, "prompt");
  const seeded = fs.readFileSync(path.join(repo, "PRINCIPLES.md"), "utf8");
  assert.match(seeded, /^# Principles/);
  // The write policy is stated in the file itself: only director/steward edit it.
  assert.match(seeded, /only the director and steward/i);
  // Starter principles are phrased positively ("prefer…", "keep…", "every… ships").
  assert.match(seeded, /Prefer the standard library/);
  assert.match(seeded, /Every behavior change ships with a test/);
  // Ecosystem-neutral (plans/portability.md §7/7): init writes this into someone else's repo,
  // so no codebase-specific size rule, and the file says the list is the director's to tune.
  assert.doesNotMatch(seeded, /500 lines/);
  assert.match(seeded, /This list is a starting point: the director and steward own it/);
});

test("initProject seeds BUGS.md with the validation-gap convention", async () => {
  const repo = makeRepo();
  await initProject(repo, "prompt");
  const seeded = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  // A fresh project starts with the trace line rather than acquiring it later.
  assert.match(seeded, /\*\*Validation gap:\*\* <tag> — <one sentence>/);
  // The seeded list is the same closed vocabulary the roles enforce.
  for (const tag of VALIDATION_GAP_TAGS) assert.ok(seeded.includes(tag), `template names ${tag}`);
});

test("initProject never clobbers an existing PRINCIPLES.md", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PRINCIPLES.md"), "# my taste\n- do things well\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own principles");
  const result = await initProject(repo, "prompt");
  assert.ok(!result.created.includes("PRINCIPLES.md"));
  assert.equal(fs.readFileSync(path.join(repo, "PRINCIPLES.md"), "utf8"), "# my taste\n- do things well\n");
});

test("initProject never clobbers existing files and is idempotent", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), "# mine\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own plans");
  const first = await initProject(repo, "prompt");
  assert.ok(!first.created.includes("PLANS.md"));
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), "# mine\n");
  const second = await initProject(repo, "prompt");
  assert.deepEqual(second.created, []);
  assert.ok(!second.committed);
});

test("initProject appends both ignore entries to an existing .gitignore on their own lines", async () => {
  // An existing project's .gitignore usually has entries already, often with no trailing
  // newline. The rules must land on their own lines: glued onto the last entry
  // ("dist.tumwater/") they would ignore nothing, and every later `git add -A` would commit
  // the state dir. Both entries are checked independently — a .gitignore that already carries
  // one still gains the other (plans/portability.md §4a/7).
  const noNewline = makeRepo();
  fs.writeFileSync(path.join(noNewline, ".gitignore"), "node_modules\ndist");
  sh(noNewline, "git", "add", "-A");
  sh(noNewline, "git", "commit", "-m", "own gitignore");
  const first = await initProject(noNewline, "prompt");
  assert.ok(first.created.includes(".gitignore"));
  assert.equal(
    fs.readFileSync(path.join(noNewline, ".gitignore"), "utf8"),
    "node_modules\ndist\n.tumwater/\ntumwater.json\n",
  );

  // A trailing newline already present gets no extra blank line before the rules.
  const withNewline = makeRepo();
  fs.writeFileSync(path.join(withNewline, ".gitignore"), "node_modules\n");
  sh(withNewline, "git", "add", "-A");
  sh(withNewline, "git", "commit", "-m", "own gitignore");
  await initProject(withNewline, "prompt");
  assert.equal(
    fs.readFileSync(path.join(withNewline, ".gitignore"), "utf8"),
    "node_modules\n.tumwater/\ntumwater.json\n",
  );

  // The bare `.tumwater` form already ignores the dir: no duplicate `.tumwater/` is added,
  // but the config entry is still missing and gets added on its own.
  const bare = makeRepo();
  fs.writeFileSync(path.join(bare, ".gitignore"), ".tumwater\n");
  sh(bare, "git", "add", "-A");
  sh(bare, "git", "commit", "-m", "already ignores state");
  const result = await initProject(bare, "prompt");
  assert.ok(result.created.includes(".gitignore"));
  assert.equal(fs.readFileSync(path.join(bare, ".gitignore"), "utf8"), ".tumwater\ntumwater.json\n");
});

// Adoption (plans/portability.md §7/7): an existing repo's README.md is its real documentation,
// so the brief goes in TUMWATER.md and README.md is never touched.

/** An unrelated repo with its own README.md (no tumwater markers) and PLANS.md, committed. */
function foreignRepo(): string {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "# mine\n\nThe project's own docs.\n");
  fs.writeFileSync(path.join(repo, "PLANS.md"), "# my roadmap\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own readme and plans");
  return repo;
}

test("initProject adopts a repo whose README has no tumwater markers instead of refusing", async () => {
  // This used to throw "your prompt would be lost"; now the same README-without-markers case
  // is the adoption path, taken automatically without --adopt.
  const repo = foreignRepo();
  const readme = fs.readFileSync(path.join(repo, "README.md"));
  const plans = fs.readFileSync(path.join(repo, "PLANS.md"));
  const result = await initProject(repo, "Adopted brief.");
  assert.ok(result.adopted);
  // Only the missing files are created — never README.md or the repo's own PLANS.md.
  assert.deepEqual(
    [...result.created].sort(),
    [".gitignore", "BUGS.md", "PRINCIPLES.md", "QUESTIONS.md", "TUMWATER.md", "tumwater.json"],
  );
  assert.deepEqual(fs.readFileSync(path.join(repo, "README.md")), readme, "README.md byte-identical");
  assert.deepEqual(fs.readFileSync(path.join(repo, "PLANS.md")), plans, "PLANS.md byte-identical");
  assert.ok(result.leftAlone.includes("README.md") && result.leftAlone.includes("PLANS.md"));
  // The brief round-trips from TUMWATER.md, and the adopted repo is committed clean.
  assert.equal(briefFile(repo), "TUMWATER.md");
  assert.equal(readInitialPrompt(repo), "Adopted brief.");
  assert.ok(result.committed);
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
  // A re-run finds the marked brief and has nothing to do.
  const again = await initProject(repo, "Adopted brief.", undefined, { adopt: true });
  assert.deepEqual(again.created, []);
  assert.ok(!again.adopted);
});

test("initProject --adopt writes TUMWATER.md even with no README, and never creates one", async () => {
  const repo = makeRepo();
  const result = await initProject(repo, "Explicitly adopted.", undefined, { adopt: true });
  assert.ok(result.adopted);
  assert.ok(result.created.includes("TUMWATER.md"));
  assert.ok(!fs.existsSync(path.join(repo, "README.md")), "no README.md on the adopt path");
  assert.equal(briefFile(repo), "TUMWATER.md");

  // Against a repo tumwater created (marked README.md), --adopt is today's no-op: the brief
  // already has a home, so no TUMWATER.md appears to shadow it.
  const created = makeRepo();
  await initProject(created, "Original.");
  const again = await initProject(created, "Original.", undefined, { adopt: true });
  assert.deepEqual(again.created, []);
  assert.ok(!fs.existsSync(path.join(created, "TUMWATER.md")));
  assert.equal(briefFile(created), "README.md");
});

test("initProject refuses to adopt over a TUMWATER.md without markers", async () => {
  // Create-if-absent would leave the marker-less file alone and drop the prompt — every loop
  // would run blind — so this is the one case adoption still refuses, before any side effect.
  const repo = foreignRepo();
  fs.writeFileSync(path.join(repo, "TUMWATER.md"), "# notes\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "unrelated TUMWATER.md");
  await assert.rejects(() => initProject(repo, "prompt"), /TUMWATER\.md already exists.*tumwater:prompt/);
  for (const f of ["BUGS.md", "QUESTIONS.md", "tumwater.json"]) {
    assert.ok(!fs.existsSync(path.join(repo, f)), `${f} should not exist`);
  }
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
});

test("initProject --dry-run writes nothing: no files, no gitignore edit, no commit", async () => {
  const repo = foreignRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own gitignore");
  const head = sh(repo, "git", "rev-parse", "HEAD");
  const listing = fs.readdirSync(repo).sort();
  const result = await initProject(repo, "Dry brief.", undefined, { dryRun: true });
  assert.ok(result.dryRun);
  assert.ok(!result.committed);
  // The same lists a real run computes...
  assert.deepEqual(
    [...result.created].sort(),
    [".gitignore", "BUGS.md", "PRINCIPLES.md", "QUESTIONS.md", "TUMWATER.md", "tumwater.json"],
  );
  assert.deepEqual([...result.leftAlone].sort(), ["PLANS.md", "README.md"]);
  // ...and none of it on disk: same directory listing, same tree, same HEAD.
  assert.deepEqual(fs.readdirSync(repo).sort(), listing);
  assert.equal(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), "node_modules\n");
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
  assert.equal(sh(repo, "git", "rev-parse", "HEAD"), head);

  // Outside a git repo, a dry run reports the repo it would seed without running `git init`.
  const dir = tmpdir();
  const fresh = await initProject(dir, "Fresh.", "trunk", { dryRun: true });
  assert.ok(fresh.repoInitialized);
  assert.equal(fresh.branch, "trunk");
  assert.ok(fresh.created.includes("README.md"));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("initProject's bare-init refusal names a marker-less README", async () => {
  // A bare init against a README without markers refused before any seed — and the message
  // must say why the "bare init reads README" path did not fire (a README exists, but it
  // carries no tumwater:prompt block), not just the generic "prompt required".
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "# mine\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own readme");
  await assert.rejects(
    () => initProject(repo, ""),
    /initial prompt is required.*README\.md carries none/s,
  );
  for (const f of ["PLANS.md", "BUGS.md", "tumwater.json"]) {
    assert.ok(!fs.existsSync(path.join(repo, f)), `${f} should not exist`);
  }
});

test("initProject's bare-init refusal stays generic with no README to read", async () => {
  // No README means there was nothing for bare init to read — no README hint in the message.
  const dir = tmpdir();
  await assert.rejects(
    () => initProject(dir, "   "),
    { message: "an initial prompt is required: tumwater init <prompt | --file prompt.md>" },
  );
});

test("initProject accepts an existing README that already carries the prompt", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), `# mine\n${PROMPT_START}\nmy prompt\n${PROMPT_END}\n`);
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own readme with markers");
  const result = await initProject(repo, "my prompt");
  assert.ok(!result.created.includes("README.md"));
  assert.equal(readInitialPrompt(repo), "my prompt");
});

test("initProject refuses a prompt that differs from the one a README-owned brief carries", async () => {
  // The existing brief is never rewritten, so a different prompt used to be accepted and
  // silently dropped ("already initialized; nothing to do") while every tick kept the old one.
  const repo = makeRepo();
  const readme = `# mine\n${PROMPT_START}\nmy prompt\n${PROMPT_END}\n`;
  fs.writeFileSync(path.join(repo, "README.md"), readme);
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own readme with markers");
  await assert.rejects(
    () => initProject(repo, "a different prompt"),
    /README\.md already carries a different initial prompt.*edit it in README\.md between.*bare `tumwater init`/s,
  );
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), readme);
  for (const f of ["PLANS.md", "BUGS.md", "tumwater.json"]) {
    assert.ok(!fs.existsSync(path.join(repo, f)), `${f} should not exist`);
  }
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
});

// Brief resolution (plans/portability.md §7a/7) applies to BOTH init guards: a marked
// TUMWATER.md satisfies the bare-init re-seed path AND silences the marker-less-README throw.

test("a marked TUMWATER.md satisfies init's bare-init re-seed path", async () => {
  // A checkout with a marked TUMWATER.md but no tumwater.json re-seeds the config bare, same
  // as a marked README.md does — the prompt is not required on the command line. README.md
  // exists too (an ordinary repo), so only the config is created.
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "# mine\n");
  fs.writeFileSync(
    path.join(repo, "TUMWATER.md"),
    `# mine\n${PROMPT_START}\nthe original prompt\n${PROMPT_END}\n`,
  );
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own brief");
  const again = await initProject(repo, "");
  assert.ok(again.created.includes("tumwater.json"));
  assert.ok(!again.created.includes("README.md"), "README.md is never rewritten");
  assert.equal(readInitialPrompt(repo), "the original prompt");
});

test("a marked TUMWATER.md silences init's marker-less-README throw", async () => {
  // An adopted repo (7b/7): its own README.md stays untouched — the brief lives in TUMWATER.md,
  // so init neither throws nor rewrites the README.
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "# mine\n");
  fs.writeFileSync(
    path.join(repo, "TUMWATER.md"),
    `# mine\n${PROMPT_START}\nadopted prompt\n${PROMPT_END}\n`,
  );
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own readme and brief");
  const before = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  const result = await initProject(repo, "adopted prompt");
  assert.ok(!result.created.includes("README.md"), "README.md is never created on the adopt path");
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), before, "README.md byte-identical");
  assert.equal(readInitialPrompt(repo), "adopted prompt");
});

test("a TUMWATER.md-owned brief refuses a different prompt instead of writing it into a new README.md", async () => {
  // The bug (BUGS.md 2026-09-23): TUMWATER.md passed the marker guard, then the unconditional
  // README.md write created a README carrying the NEW prompt — but readInitialPrompt resolves
  // TUMWATER.md first, so every tick kept running the old one. The refusal names the file that
  // actually owns the brief, and nothing is created or committed.
  const repo = makeRepo();
  const brief = `# mine — project brief\n${PROMPT_START}\nthe original prompt\n${PROMPT_END}\n`;
  fs.writeFileSync(path.join(repo, "TUMWATER.md"), brief);
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own brief");
  await assert.rejects(
    () => initProject(repo, "a different prompt"),
    /TUMWATER\.md already carries a different initial prompt.*edit it in TUMWATER\.md between/s,
  );
  assert.ok(!fs.existsSync(path.join(repo, "README.md")), "no README.md carrying the dropped prompt");
  for (const f of ["PLANS.md", "BUGS.md", "tumwater.json"]) {
    assert.ok(!fs.existsSync(path.join(repo, f)), `${f} should not exist`);
  }
  assert.equal(fs.readFileSync(path.join(repo, "TUMWATER.md"), "utf8"), brief);
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
  assert.equal(readInitialPrompt(repo), "the original prompt");
});

test("a TUMWATER.md-owned brief never gains a duplicate README.md on a matching or bare init", async () => {
  // With the brief in TUMWATER.md and no README.md, the re-seed paths (the same prompt, or none)
  // create the backlog files and config but no README.md — one would duplicate the managed
  // prompt + status sections in a file neither the loops nor the readme role read.
  const repo = makeRepo();
  fs.writeFileSync(
    path.join(repo, "TUMWATER.md"),
    `# mine — project brief\n${PROMPT_START}\nthe original prompt\n${PROMPT_END}\n`,
  );
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own brief");
  const result = await initProject(repo, "the original prompt");
  assert.deepEqual(
    [...result.created].sort(),
    [".gitignore", "BUGS.md", "PLANS.md", "PRINCIPLES.md", "QUESTIONS.md", "tumwater.json"],
  );
  assert.ok(!fs.existsSync(path.join(repo, "README.md")));
  fs.rmSync(path.join(repo, "tumwater.json"));
  const bare = await initProject(repo, "");
  assert.deepEqual(bare.created, ["tumwater.json"]);
  assert.ok(!fs.existsSync(path.join(repo, "README.md")));
  assert.equal(readInitialPrompt(repo), "the original prompt");
});

test("initProject rejects empty prompts", async () => {
  await assert.rejects(() => initProject(makeRepo(), "   "), /initial prompt is required/);
});

test("a bare init re-seeds a lost config from the README's prompt (portability 4a/7)", async () => {
  const repo = makeRepo();
  await initProject(repo, "the original prompt");
  // The config is untracked since 4a/7: a fresh clone, or a checkout whose landing removed the
  // once-tracked file, has README.md with the prompt but no tumwater.json.
  fs.rmSync(path.join(repo, "tumwater.json"));
  const again = await initProject(repo, "");
  assert.deepEqual(again.created, ["tumwater.json"]);
  assert.equal(readInitialPrompt(repo), "the original prompt");
  // A repo tumwater created before adoption existed keeps its brief in README.md: the marked
  // README is not an adoption case, so no TUMWATER.md appears and no migration is needed.
  assert.ok(!again.adopted);
  assert.equal(briefFile(repo), "README.md");
  assert.ok(!fs.existsSync(path.join(repo, "TUMWATER.md")));
});

test("initProject seeds a git repo when the cwd is not one yet (BUGS.md 2026-09-08)", async () => {
  const dir = tmpdir();
  const result = await initProject(dir, "Fresh project.");
  assert.ok(result.repoInitialized);
  assert.ok(result.committed);
  // The seeded repo is on main with exactly the harness commit, and the prompt round-trips.
  assert.equal(sh(dir, "git", "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(sh(dir, "git", "log", "--oneline").split("\n").length, 1);
  assert.equal(readInitialPrompt(dir), "Fresh project.");
});

test("initProject honors the caller's branch and git's init.defaultBranch preference (portability 2/7)", async () => {
  // Explicit --branch wins over everything.
  const explicit = tmpdir();
  const withBranch = await initProject(explicit, "On a named branch.", "trunk");
  assert.equal(withBranch.repoInitialized, true);
  assert.equal(withBranch.branch, "trunk");
  assert.equal(sh(explicit, "git", "symbolic-ref", "--short", "HEAD"), "trunk");

  // With none given, git's own init.defaultBranch preference is honored (git init -b does
  // not consult it, so the preference is read here). Scoped hermetically via GIT_CONFIG_GLOBAL.
  const dir = tmpdir();
  const global = path.join(dir, "global-gitconfig");
  fs.writeFileSync(global, "[init]\n\tdefaultBranch = trunk\n");
  const bare = tmpdir();
  process.env.GIT_CONFIG_GLOBAL = global;
  try {
    const result = await initProject(bare, "On the configured default.");
    assert.equal(result.repoInitialized, true);
    assert.equal(result.branch, "trunk");
    assert.equal(sh(bare, "git", "symbolic-ref", "--short", "HEAD"), "trunk");
  } finally {
    delete process.env.GIT_CONFIG_GLOBAL;
  }

  // And with neither, main — the long-standing default.
  const plain = tmpdir();
  process.env.GIT_CONFIG_GLOBAL = "/nonexistent-tumwater-test-config";
  try {
    const result = await initProject(plain, "On main.");
    assert.equal(result.branch, "main");
  } finally {
    delete process.env.GIT_CONFIG_GLOBAL;
  }
});

test("initProject validates before seeding: a bad prompt leaves no repo behind", async () => {
  const dir = tmpdir();
  await assert.rejects(() => initProject(dir, "   "), /initial prompt is required/);
  assert.ok(!fs.existsSync(path.join(dir, ".git")));
});

test("initProject rejects an over-long initial prompt before seeding", async () => {
  const dir = tmpdir();
  await assert.rejects(
    () => initProject(dir, "x".repeat(INITIAL_PROMPT_MAX_CHARS + 1)),
    /shorten it to at most 4096/,
  );
  assert.ok(!fs.existsSync(path.join(dir, ".git")));
});

test("initProject leaves user's unrelated dirty files uncommitted", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "wip.txt"), "wip\n");
  await initProject(repo, "prompt");
  assert.match(sh(repo, "git", "status", "--porcelain"), /wip\.txt/);
});

test("initProject seeds the config from a tracked tumwater.example.json and keeps it untracked", async () => {
  const repo = makeRepo();
  fs.writeFileSync(
    exampleConfigPath(repo),
    JSON.stringify({ minTickIntervalSeconds: 45, review: { enabled: false } }),
  );
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "ship a template");
  const result = await initProject(repo, "prompt");
  assert.ok(result.created.includes("tumwater.json"));

  // Seeded from the template, with the same merge behavior loadConfig applies to a file.
  const cfg = loadConfig(repo);
  assert.equal(cfg.minTickIntervalSeconds, 45);
  assert.deepEqual(cfg.review, { ...defaultConfig().review, enabled: false });
  assert.equal(cfg.maxConcurrent, defaultConfig().maxConcurrent);

  // Untracked and gitignored, so the freshly initialized repo is clean — while the created
  // line (and result.created) still reports the config.
  assert.equal(sh(repo, "git", "ls-files", "tumwater.json"), "");
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
  assert.match(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), /^tumwater\.json$/m);
  // Everything but the config still lands in the init commit.
  assert.ok(result.committed);
  assert.ok(sh(repo, "git", "ls-files").includes(".gitignore"));
});

test("initProject seeds defaults when the template is malformed", async () => {
  const repo = makeRepo();
  fs.writeFileSync(exampleConfigPath(repo), "{ not json");
  const result = await initProject(repo, "prompt");
  assert.ok(result.created.includes("tumwater.json"));
  // Seeding never throws: a bad template falls back to the defaults.
  assert.equal(loadConfig(repo).minTickIntervalSeconds, defaultConfig().minTickIntervalSeconds);
});

test("a repo that only gains a config reports it and stays uncommitted", async () => {
  const repo = makeRepo();
  await initProject(repo, "prompt");
  assert.ok(fs.existsSync(path.join(repo, ".gitignore")));
  fs.rmSync(path.join(repo, "tumwater.json"));
  // The .gitignore already carries both entries, so the config is the only creation left —
  // and the commit pathspec would be empty (`git add --` with no pathspec exits 1).
  const again = await initProject(repo, "prompt");
  assert.deepEqual(again.created, ["tumwater.json"]);
  assert.ok(!again.committed);
  assert.ok(fs.existsSync(path.join(repo, "tumwater.json")));
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
});
