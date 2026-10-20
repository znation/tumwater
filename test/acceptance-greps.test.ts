import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { acceptanceGrepFindings, emptyGrepCriteria, grepArgv } from "../src/run/acceptance-greps.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const NOTHING = "finds" + " nothing";

test("emptyGrepCriteria picks the matches-nothing greps and skips qualified or only-kind ones", () => {
  const body = [
    `\`grep -rn foo src\` ${NOTHING}.`,
    `\`git grep -n bar\` is empty.`,
    "`grep -rn baz src` prints only kept names.",
    `\`grep -rn qux src\` ${"prints" + " nothing"} apart from a fixture.`,
  ].join("\n- ");
  assert.deepEqual(emptyGrepCriteria(body), ["grep -rn foo src", "git grep -n bar"]);
});

test("grepArgv splits quotes and refuses shell syntax", () => {
  assert.deepEqual(grepArgv(`grep -rnE 'a|b' "src dir" --include=*.ts`), {
    file: "grep",
    args: ["-rnE", "a|b", "src dir", "--include=*.ts"],
  });
  assert.deepEqual(grepArgv("git grep -n x"), { file: "git", args: ["grep", "-n", "x"] });
  assert.equal(grepArgv("grep x | wc -l"), undefined);
  assert.equal(grepArgv("grep 'x"), undefined);
});

test("acceptanceGrepFindings reports a matches-nothing grep that still matches", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/a.ts"), "leftoverName\n");
  const entry = { title: "Entry title", body: `\`grep -rn leftoverName src\` ${NOTHING}.` };
  const found = await acceptanceGrepFindings(dir, [entry]);
  assert.equal(found.length, 1);
  assert.match(found[0] as string, /Entry title/);
  assert.match(found[0] as string, /src\/a\.ts:1/);
  fs.writeFileSync(path.join(dir, "src/a.ts"), "clean\n");
  assert.deepEqual(await acceptanceGrepFindings(dir, [entry]), []);
  const missing = { title: "T", body: `\`grep -rn x nowhere\` ${NOTHING}.` };
  assert.deepEqual(await acceptanceGrepFindings(dir, [missing]), []);
});
