import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROLES, roleById } from "../src/roles.js";
import { buildTickPrompt } from "../src/prompt.js";
import { configForRole, defaultConfig, loadConfig } from "../src/config.js";
import { tmpdir } from "./util.js";

// Prompt contract for the qa role (plans/qa-role.md): a first-time-user exerciser that never
// edits source — BUGS.md is its only write. Every tick is a fresh session with no memory of
// what was tested before, so the find text must carry the flow menu, the vary rule, and the
// once-per-day guard on expensive real runs in prose; these assertions pin that contract.

const qa = roleById("qa");

test("the qa role exists after perf in catalog order", () => {
  assert.ok(qa, "roleById('qa') returns a role");
  const ids = ROLES.map((r) => r.id);
  assert.equal(ids[ids.indexOf("perf") + 1], "qa", "qa sits right after perf (tie-break priority)");
  assert.equal(qa.title, "product QA");
});

test("the qa prompt is a first-time-user exercise of the README in a scratch dir", () => {
  const find = qa!.find;
  assert.match(find, /first-time user/);
  assert.match(find, /README's usage instructions literally/);
  assert.match(find, /scratch directory under the system temp/);
  assert.match(find, /never inside this worktree or \.tumwater\//);
  assert.match(find, /build the product fresh per its README/);
  assert.match(find, /endpoints via curl/);
  assert.match(find, /check outputs against what the docs promise/);
  assert.match(find, /Delete the scratch dir when the flow is done/);
});

test("the qa prompt restricts writes to BUGS.md", () => {
  const find = qa!.find;
  assert.match(find, /record ONE reproducible bug in BUGS\.md/);
  assert.match(find, /exact commands, expected vs actual/);
  assert.match(find, /never edit source, tests, or docs — BUGS\.md is your only write/);
  assert.match(find, /If the flow works as documented, there is nothing to do/);
});

test("the qa prompt carries the safety rails for launched processes", () => {
  const find = qa!.find;
  assert.match(find, /every process gets a hard time limit and an explicit kill/);
  assert.match(find, /ephemeral high ports, never the product's documented default port/);
  assert.match(find, /no listening process may outlive your tick/);
});

test("the qa prompt picks one flow per tick from the README usage menu, cheap first", () => {
  const find = qa!.find;
  assert.match(find, /README's usage section is your menu of flows/);
  assert.match(find, /cheapest-first/);
  assert.match(find, /pick ONE per tick/);
});

test("the qa prompt varies across ticks and leaves no record for passing cheap flows", () => {
  const find = qa!.find;
  assert.match(find, /prefer a flow not recently exercised/);
  assert.match(find, /BUGS\.md filings and Verified notes show/);
  assert.match(find, /leaves NO record — declare nothing-to-do/);
});

test("the qa prompt guards the expensive real run: constrained, capped, once per day", () => {
  const find = qa!.find;
  // Prefer a deterministic offline mode when the project documents one.
  assert.match(find, /prefer a deterministic offline mode \(a fake\/shim\)/);
  // Otherwise ONE real bounded run — minimal scope (constrained nested fleet), wall-capped,
  // and killed with its whole process tree so no orphaned child survives the tick.
  assert.match(find, /exactly one enabled role and maxConcurrent 1/);
  assert.match(find, /wall-cap it \(~10 min including prefill\)/);
  assert.match(find, /kill its whole process tree when done/);
  // The once-per-day guard is self-enforcing across fresh sessions through the Verified note.
  assert.match(find, /only when the newest Verified note for the flow is older than a day/);
  assert.match(find, /## Verified section at the end of BUGS\.md/);
  assert.match(find, /- 2026-08-28 run \(real\): init \+ one tick landed; status\/logs confirm/);
});

test("buildTickPrompt for qa carries the find text plus the shared rules", () => {
  const prompt = buildTickPrompt({ role: qa!, initialPrompt: "" });
  assert.match(prompt, /"qa" loop \(product QA\)/);
  assert.ok(prompt.includes(qa!.find.trim()), "the full find text is embedded");
  assert.match(prompt, /TUMWATER_NOTHING_TO_DO/);
});

test("defaultConfig enables qa with its ~2 h clock", () => {
  const config = defaultConfig();
  assert.equal(config.roles.qa?.enabled, true);
  assert.equal(configForRole(config, "qa").minTickIntervalSeconds, 7200);
});

test("loadConfig enables qa with its slow clock when the file omits it", () => {
  // This repo's tumwater.json lists every other role but not qa (or steward): per-role
  // defaults merge in for ids absent from the file, so enabling needs no config edit.
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "tumwater.json"),
    JSON.stringify({ roles: { feature: { enabled: true } } }),
  );
  const config = loadConfig(dir);
  assert.equal(config.roles.qa?.enabled, true);
  assert.equal(configForRole(config, "qa").minTickIntervalSeconds, 7200);
});
