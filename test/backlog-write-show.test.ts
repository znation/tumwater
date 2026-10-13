import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cli } from "./helpers/cli-harness.js";
import { initializedRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";

// `tumwater plan|bug --show <n>`: the read half of `--edit <n> --file`, printing an entry in
// the file shape that command takes back.

/** A scratch dir outside the repo, so the files do not dirty the checkout. */
function scratch(): string {
  return tmpdir("show-");
}

const BODY = ["- item", "  - nested item", "", "```", "  indented code", "```"].join("\n");

async function fileEntry(repo: string, kind: "plan" | "bug", title: string): Promise<void> {
  const file = path.join(scratch(), `${kind}-in.md`);
  fs.writeFileSync(file, `${title}\n\n${BODY}\n`);
  const r = await cli(repo, kind, "--file", file);
  assert.equal(r.code, 0, r.stderr);
}

for (const [kind, fileName] of [["plan", "PLANS.md"], ["bug", "BUGS.md"]] as const) {
  test(`${kind} --show prints title and indented body, and round-trips through --edit --file`, async () => {
    const repo = await initializedRepo();
    await fileEntry(repo, kind, "Shown entry");
    const before = fs.readFileSync(path.join(repo, fileName), "utf8");
    const r = await cli(repo, kind, "--show", "1");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `Shown entry\n\n${BODY}\n`);
    const out = path.join(scratch(), "shown.md");
    fs.writeFileSync(out, r.stdout);
    const e = await cli(repo, kind, "--edit", "1", "--file", out);
    assert.equal(e.code, 0, e.stderr);
    assert.equal(fs.readFileSync(path.join(repo, fileName), "utf8"), before);
  });
}

test("plan --show --json prints position, title, body, hold; --show commits nothing", async () => {
  const repo = await initializedRepo();
  await fileEntry(repo, "plan", "Json entry");
  const head = sh(repo, "git", "rev-parse", "HEAD");
  const r = await cli(repo, "plan", "--show", "1", "--json");
  assert.equal(r.code, 0, r.stderr);
  const shown = JSON.parse(r.stdout) as { position: number; title: string; body: string; hold: string | null };
  assert.deepEqual(shown, { position: 1, title: "Json entry", body: BODY, hold: null });
  assert.equal(sh(repo, "git", "rev-parse", "HEAD"), head);
});

test("plan --edit --file with the full heading pasted back keeps one stamp", async () => {
  const repo = await initializedRepo();
  await fileEntry(repo, "plan", "Stamped entry");
  const heading = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8").split("\n").find((l) => l.startsWith("### Stamped"));
  assert.ok(heading);
  const file = path.join(scratch(), "again.md");
  fs.writeFileSync(file, `${heading}\n\nnew body\n`);
  const e = await cli(repo, "plan", "--edit", "1", "--file", file);
  assert.equal(e.code, 0, e.stderr);
  const after = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8").split("\n").filter((l) => l.startsWith("### Stamped"));
  assert.deepEqual(after, [heading]);
});

test("--show refuses out-of-range, missing, stray, unknown, and repeated arguments", async () => {
  const repo = await initializedRepo();
  await fileEntry(repo, "plan", "Only entry");
  const bad = [
    ["--show", "5"],
    ["--show"],
    ["--show", "1", "stray"],
    ["--show", "1", "--bogus"],
    ["--show", "1", "--show", "1"],
    ["--show", "1", "--json", "--json"],
  ];
  for (const args of bad) {
    const r = await cli(repo, "plan", ...args);
    assert.notEqual(r.code, 0, args.join(" "));
  }
  const oor = await cli(repo, "plan", "--show", "5");
  assert.match(oor.stderr, /at position 5 \(1 in PLANS\.md\)/);
});
