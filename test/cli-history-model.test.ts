import test from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init/init.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { seedWindowedHistory } from "./fixtures/history-fixtures.js";

// The `history` command's --role list and --model views, with --summary --by model — split
// from cli-history-filtering.test.ts (see there for the split) so each file fits the gate's
// 30 s budget.

test("history --role takes a comma list of role ids", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history role list");
  writeEvents(repo, [
    { ts: 1787222691956, loop: "feature", type: "run_start", run: 7 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1787222695956, loop: "feature", type: "run_end", run: 7, result: "changed", summary: "added a widget" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1787222700000, loop: "clean", type: "run_end", run: 3, result: "no_change" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1787222760000, loop: "bugfix", type: "run_end", run: 9, result: "error", error: "pi unreachable" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1787222800000, loop: "feature", type: "run_end", run: 8, result: "no_change" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const roles = async (...a: string[]) => {
    const r = await cli(repo, "history", "--json", ...a);
    assert.equal(r.code, 0);
    return (JSON.parse(r.stdout) as { rows: Array<{ role: string; run: number }> }).rows;
  };

  const both = await roles("--role", "feature,clean");
  assert.deepEqual(both.map((r) => `${r.role}#${r.run}`), ["feature#8", "clean#3", "feature#7"]);
  assert.deepEqual(await roles("--role", "clean,clean"), await roles("--role", "clean"));

  const summary = await cli(repo, "history", "--role", "feature,clean", "--summary", "--json");
  assert.equal(summary.code, 0);
  const parsed = JSON.parse(summary.stdout) as { roles: Array<{ role: string }> };
  assert.deepEqual(parsed.roles.map((r) => r.role), ["clean", "feature"]);

  // -n counts runs across the listed roles, with bugfix's run sitting between them.
  const two = await roles("--role", "feature,clean", "-n", "2");
  assert.deepEqual(two.map((r) => `${r.role}#${r.run}`), ["feature#8", "clean#3"]);
  assert.deepEqual((await roles("--role", "feature,clean", "--grep", "widget")).map((r) => r.run), [7]);
  assert.deepEqual((await roles("--role", "feature,clean", "--result", "none")).map((r) => r.run), [8, 3]);

  const unknown = await cli(repo, "history", "--role", "feature,nosuch");
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /unknown role: nosuch/);
  for (const bad of [["--role", ","], ["--role"]]) {
    const r = await cli(repo, "history", ...bad);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--role/);
  }
});

test("history --role list composes with --since", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history role list since");
  seedWindowedHistory(repo);
  const r = await cli(repo, "history", "--since", "1h", "--role", "feature,clean", "--json");
  assert.equal(r.code, 0);
  const rows = (JSON.parse(r.stdout) as { rows: Array<{ role: string }> }).rows;
  assert.deepEqual(rows.map((x) => x.role), ["feature", "clean"]);
});

test("history --summary --by model tallies runs per model", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history by model");
  writeEvents(repo, [
    { ts: 1000, loop: "feature", type: "run_start", run: 1, model: "acme/m1" }, // retired-name-ok: legacy event field in a fixture
    { ts: 2000, loop: "feature", type: "run_end", run: 1, result: "changed", summary: "w" }, // retired-name-ok: legacy event field in a fixture
    { ts: 3000, loop: "clean", type: "run_start", run: 2, model: "acme/m2" }, // retired-name-ok: legacy event field in a fixture
    { ts: 4000, loop: "clean", type: "run_end", run: 2, result: "no_change" }, // retired-name-ok: legacy event field in a fixture
    { ts: 5000, loop: "feature", type: "run_start", run: 3, model: "acme/m1" }, // retired-name-ok: legacy event field in a fixture
    { ts: 6000, loop: "feature", type: "run_end", run: 3, result: "no_change" }, // retired-name-ok: legacy event field in a fixture
    { ts: 7000, loop: "bugfix", type: "run_end", run: 9, result: "error", error: "x" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const r = await cli(repo, "history", "--summary", "--by", "model");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0] ?? "", /^model /);
  assert.deepEqual(lines.slice(1).map((l) => l.split(/\s+/)[0]), ["acme/m1", "acme/m2", "(unknown)", "total"]);
  assert.match(lines[1] ?? "", /^acme\/m1\s+2\s+1\s+1\b/);
  const j = await cli(repo, "history", "--summary", "--by", "model", "--json");
  const parsed = JSON.parse(j.stdout) as { models: Array<{ model: string | null }>; total: { runs: number } };
  assert.equal(parsed.models.length, 3);
  assert.equal(parsed.models[2]?.model, null);
  assert.equal(parsed.total.runs, 4);
  const plain = await cli(repo, "history", "--summary");
  assert.equal((await cli(repo, "history", "--summary", "--by", "role")).stdout, plain.stdout);
  const narrowed = await cli(repo, "history", "--summary", "--by", "model", "--role", "feature");
  assert.deepEqual(narrowed.stdout.trim().split("\n").slice(1).map((l) => l.split(/\s+/)[0]), ["acme/m1", "total"]);
  const noSummary = await cli(repo, "history", "--by", "model");
  assert.notEqual(noSummary.code, 0);
  assert.match(noSummary.stderr, /--summary/);
  const typo = await cli(repo, "history", "--summary", "--by", "modle");
  assert.notEqual(typo.code, 0);
  assert.match(typo.stderr, /role, model/);
  const bare = await cli(repo, "history", "--summary", "--by");
  assert.notEqual(bare.code, 0);
  assert.match(bare.stderr, /history --by needs role or model/);
});

function writeModelFixture(repo: string): void {
  writeEvents(repo, [
    { ts: 1000, loop: "feature", type: "run_start", run: 1, model: "acme/m1" }, // retired-name-ok: legacy event field in a fixture
    { ts: 2000, loop: "feature", type: "run_end", run: 1, result: "changed", summary: "w" }, // retired-name-ok: legacy event field in a fixture
    { ts: 3000, loop: "clean", type: "run_start", run: 2, model: "acme/m2" }, // retired-name-ok: legacy event field in a fixture
    { ts: 4000, loop: "clean", type: "run_end", run: 2, result: "no_change" }, // retired-name-ok: legacy event field in a fixture
    { ts: 5000, loop: "feature", type: "run_start", run: 3, model: "acme/m1" }, // retired-name-ok: legacy event field in a fixture
    { ts: 6000, loop: "feature", type: "run_end", run: 3, result: "no_change" }, // retired-name-ok: legacy event field in a fixture
    { ts: 7000, loop: "bugfix", type: "run_end", run: 9, result: "error", error: "x" }, // retired-name-ok: legacy event field in a fixture
  ]);
}

test("history --model keeps only the runs that started on the listed models", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history model");
  writeModelFixture(repo);
  const one = await cli(repo, "history", "--model", "acme/m1");
  assert.equal(one.code, 0);
  const rows = one.stdout.trim().split("\n");
  assert.equal(rows.length, 2);
  assert.match(rows[0] ?? "", /feature\s+#?3\b/);
  assert.match(rows[1] ?? "", /feature\s+#?1\b/);
  const both = await cli(repo, "history", "--model", "acme/m1,acme/m2", "--json");
  const parsed = JSON.parse(both.stdout) as { rows: Array<{ role?: string }> };
  assert.deepEqual(parsed.rows.map((r) => r.role), ["feature", "clean", "feature"]);
  assert.equal((await cli(repo, "history", "--model", "acme/m1,acme/m1")).stdout, one.stdout);
  for (const sel of ["acme/M1", "m1"]) {
    const r = await cli(repo, "history", "--model", sel);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), `no runs on model "${sel}"`);
  }
});

test("history --model composes with --role, --result and --summary", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history model compose");
  writeModelFixture(repo);
  const merged = await cli(repo, "history", "--model", "acme/m1", "--result", "merged");
  assert.equal(merged.stdout.trim().split("\n").length, 1);
  assert.match(merged.stdout, /feature\s+#?1\b/);
  const role = await cli(repo, "history", "--model", "acme/m1", "--role", "clean");
  assert.equal(role.stdout.trim(), 'no runs on model "acme/m1"');
  const byModel = await cli(repo, "history", "--model", "acme/m1", "--summary", "--by", "model");
  assert.deepEqual(byModel.stdout.trim().split("\n").slice(1).map((l) => l.split(/\s+/)[0]), ["acme/m1", "total"]);
  const byRole = await cli(repo, "history", "--model", "acme/m1", "--summary");
  assert.deepEqual(byRole.stdout.trim().split("\n").slice(1).map((l) => l.split(/\s+/)[0]), ["feature", "total"]);
  const none = await cli(repo, "history", "--model", "nosuch", "--json");
  assert.deepEqual(JSON.parse(none.stdout), { rows: [] });
});

test("history --model fails with its own wording when the value is missing or empty", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history model missing");
  for (const args of [["--model"], ["--model", ""], ["--model", ","]]) {
    const r = await cli(repo, "history", ...args);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /history --model needs a model selector/);
  }
});

test("history --model/--result followed by a flag names the forgotten value in the listing form", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history model flag value");
  writeModelFixture(repo);
  // `history --role feature --model --last`: --role (not a positional) routes to the listing
  // form, which would otherwise treat "--last" as a model filter and exit 0 showing nothing
  // ("no runs on model \"--last\""). The flag-looking-value guard refuses up front.
  const model = await cli(repo, "history", "--role", "feature", "--model", "--last");
  assert.notEqual(model.code, 0);
  assert.match(model.stderr, /history --model needs a value \(the next token "--last" is a flag, not a value\)/);
  // --result follows the same rule in the listing form.
  const result = await cli(repo, "history", "--result", "--last");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /history --result needs a value \(the next token "--last" is a flag, not a value\)/);
  // A genuinely valued write still works (the guard is scoped to -- tokens).
  const ok = await cli(repo, "history", "--model", "acme/m1", "--role", "feature");
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /feature\s+#?3\b/);
});

test("an empty log keeps its own wording under --model", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history model empty");
  const r = await cli(repo, "history", "--model", "acme/m1");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "no runs yet");
});
