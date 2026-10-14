import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ageInDays, entryAgeSuffix, filingDate } from "../src/backlog/backlog.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

/** Unit coverage for the waiting-entry age surface (src/backlog/backlog.ts's filingDate /
 * ageInDays / entryAgeSuffix, and their consumers in listAndAnnounce): `plan|bug --list`
 * names how long each waiting entry has been open — a ` · since <date> (<N>d)` tail on the
 * numbered prose line and a `since`/`ageDays` pair on the `--json` objects — parsed from the
 * `(planned …)`/`(reported …)`/`(found by …)` stamp every eligible heading already carries. */

test("filingDate reads the first date after a planned/reported/found-by stamp, else null", () => {
  assert.equal(filingDate("Export part 1 (planned 2026-10-10 by plan)"), "2026-10-10");
  assert.equal(filingDate("Bug (found by director 2026-10-12)"), "2026-10-12");
  assert.equal(filingDate("Bug (reported 2026-10-02)"), "2026-10-02");
  // A heading with no stamp clause yields null, even though the body names a date.
  assert.equal(filingDate("Undated plan"), null);
  // The stamp's own date wins over a date the body-only text would otherwise tempt with.
  assert.equal(filingDate("Thing (planned 2026-10-10; body would mention 2026-09-01)"), "2026-10-10");
});

test("ageInDays floors at 0 for a future date and counts whole days otherwise", () => {
  const now = Date.parse("2026-10-13");
  assert.equal(ageInDays("2026-10-10", now), 3);
  assert.equal(ageInDays("2026-10-13", now), 0);
  assert.equal(ageInDays("2026-10-20", now), 0);
});

test("entryAgeSuffix words the age, with (today) for a zero-day entry and '' when unstamped", () => {
  assert.equal(
    entryAgeSuffix("Export part 1 (planned 2026-10-10 by plan)", Date.parse("2026-10-13")),
    " · since 2026-10-10 (3d)",
  );
  assert.equal(
    entryAgeSuffix("Export part 1 (planned 2026-10-10)", Date.parse("2026-10-10")),
    " · since 2026-10-10 (today)",
  );
  assert.equal(entryAgeSuffix("Undated plan", Date.parse("2026-10-13")), "");
});

/** A PLANS.md with one dated and one undated `## Planned` entry. */
function seededPlans(): string {
  return [
    "# Plans",
    "",
    "## Planned",
    "",
    "### Dated one (planned 2026-10-10 by plan)",
    "",
    "body one",
    "",
    "### Undated plan",
    "",
    "body two",
    "",
    "## Done",
    "",
    "_None yet._",
    "",
  ].join("\n");
}

test("plan --list shows the dated line's age suffix and leaves an undated line bare", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), seededPlans());
  const r = await cli(repo, "plan", "--list");
  assert.equal(r.code, 0);
  const [header, line1, line2] = r.stdout.split("\n");
  assert.equal(header, "planned features in PLANS.md:");
  const dated = "Dated one (planned 2026-10-10 by plan)";
  assert.equal(line1, `1. ${dated}${entryAgeSuffix(dated)}`);
  assert.match(line1 as string, / · since 2026-10-10 \(\d+d\)$/);
  assert.equal(line2, "2. Undated plan");
});

test("plan --list --json carries since and ageDays only for a dated entry", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), seededPlans());
  const json = JSON.parse((await cli(repo, "plan", "--list", "--json")).stdout) as {
    entries: Record<string, unknown>[];
  };
  assert.deepEqual(json.entries.map((e) => e.title), [
    "Dated one (planned 2026-10-10 by plan)",
    "Undated plan",
  ]);
  assert.equal(json.entries[0]!.since, "2026-10-10");
  assert.equal(json.entries[0]!.ageDays, ageInDays("2026-10-10"));
  assert.equal("since" in (json.entries[1] as object), false);
  assert.equal("ageDays" in (json.entries[1] as object), false);
});

test("bug --list names the age from a found-by stamp too", async () => {
  const repo = makeRepo();
  fs.writeFileSync(
    path.join(repo, "BUGS.md"),
    [
      "# Bugs",
      "",
      "## Open",
      "",
      "### Found bug (found by director 2026-10-12)",
      "",
      "body",
      "",
      "## Fixed",
      "",
      "_None yet._",
      "",
    ].join("\n"),
  );
  const r = await cli(repo, "bug", "--list");
  assert.equal(r.code, 0);
  const title = "Found bug (found by director 2026-10-12)";
  assert.ok(
    r.stdout.includes(`1. ${title} · since 2026-10-12`),
    `expected a found-by stamp to name its age in: ${r.stdout}`,
  );
});
