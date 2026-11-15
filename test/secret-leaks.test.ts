import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  knownSecrets,
  piCredentialValues,
  secretEnvValues,
  secretLeakReason,
} from "../src/review/secret-leaks.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { errnoError, patchFsMethod } from "./helpers/fs-faults.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

const VALUE = "hf_abcdefghijklmnopqrstuvwxyz";
const ENV_RAW = { HF_TOKEN: VALUE };
const ENV = secretEnvValues({ HF_TOKEN: VALUE }).map((s) => ({ ...s, name: `$${s.name}` }));

async function worktree(base: Record<string, string>, edit: Record<string, string>) {
  const root = makeRepo();
  for (const [f, c] of Object.entries(base)) fs.writeFileSync(path.join(root, f), c);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "base");
  const wt = await ensureWorktree(root, "improve", "main");
  for (const [f, c] of Object.entries(edit)) {
    writeFileDeep(path.join(wt, f), c);
  }
  return wt;
}

test("secretEnvValues keeps long credential-named values only", () => {
  const got = secretEnvValues({
    HF_TOKEN: VALUE,
    SHORT_TOKEN: "abc",
    SPACED_SECRET: "has some whitespace in it",
    GOOGLE_APPLICATION_CREDENTIALS: "/path/to/key.json",
    HOME: "/Users/someone/long/home/dir",
    PLAIN: "abcdefghijklmnopqrstuvwxyz",
  });
  assert.deepEqual(got, [{ name: "HF_TOKEN", value: VALUE }]);
});

test("secretLeakReason names the file and variable, never the value", async () => {
  const wt = await worktree({ "README.md": "# T\n" }, { "report.json": `{"env":"${VALUE}"}` });
  const reason = await secretLeakReason(wt, "main", ["report.json"], ENV);
  assert.match(reason!, /`report\.json` contains the value of \$HF_TOKEN/);
  assert.ok(!reason!.includes(VALUE));
});

test("secretLeakReason does not follow a symlink out of the worktree", async () => {
  // A hostile repo can ship a path that is a symlink to a file outside the worktree (e.g.
  // .tumwater/tumwater.json or /etc/...). The gate's leak check scans what a change writes;
  // a symlink writes no content, so the link's target must not be read — following it would
  // read an arbitrary host path and flag that outside file's contents as this change's leak.
  const wt = await worktree({ "README.md": "# T\n" }, {});
  const outside = path.join(tmpdir("tumwater-test-outside-"), "secret.txt");
  fs.writeFileSync(outside, `{"env":"${VALUE}"}`);
  fs.symlinkSync(outside, path.join(wt, "report.json"));
  assert.equal(await secretLeakReason(wt, "main", ["report.json"], ENV), undefined);
});

test("secretLeakReason passes a value already at the merge-base, a directory, and no secrets", async () => {
  const wt = await worktree({ "old.json": VALUE }, { "old.json": `${VALUE}\nmore`, "dir/x.json": VALUE });
  assert.equal(await secretLeakReason(wt, "main", ["old.json"], ENV), undefined);
  assert.equal(await secretLeakReason(wt, "main", ["dir"], ENV), undefined);
  assert.equal(await secretLeakReason(wt, "main", ["dir/x.json"], []), undefined);
});

const KEY = "sk-literal-apikey-0123456789";
const HEADER = "header-value-0123456789abc";
const ACCESS = "oauth-access-0123456789abc";
const REFRESH = "oauth-refresh-0123456789ab";
const APIKEY = "api-key-credential-0123456789";

function piDir(models: unknown, auth: unknown): string {
  const dir = tmpdir("tw-pi-");
  if (models !== undefined) fs.writeFileSync(path.join(dir, "models.json"), typeof models === "string" ? models : JSON.stringify(models));
  if (auth !== undefined) fs.writeFileSync(path.join(dir, "auth.json"), typeof auth === "string" ? auth : JSON.stringify(auth));
  return path.join(dir, "models.json");
}

test("piCredentialValues returns literal apiKey, header, key, access and refresh values", () => {
  const models = piDir(
    { providers: { qwenrunner: { apiKey: KEY, headers: { "x-auth": HEADER } } } },
    { hf: { type: "api_key", key: APIKEY }, anthropic: { type: "oauth", access: ACCESS, refresh: REFRESH } },
  );
  assert.deepEqual(piCredentialValues(models), [
    { name: "models.json qwenrunner.apiKey", value: KEY },
    { name: "models.json qwenrunner.headers.x-auth", value: HEADER },
    { name: "auth.json hf.key", value: APIKEY },
    { name: "auth.json anthropic.access", value: ACCESS },
    { name: "auth.json anthropic.refresh", value: REFRESH },
  ]);
});

test("piCredentialValues skips interpolations, commands and short dummy keys", () => {
  const models = piDir(
    {
      providers: {
        a: { apiKey: "$OPENAI_API_KEY_0123456789" },
        b: { apiKey: "${OPENAI_API_KEY_0123456789}" },
        c: { apiKey: "!security find-generic-password -w" },
        d: { apiKey: "ollama" },
      },
    },
    {},
  );
  assert.deepEqual(piCredentialValues(models), []);
});

test("piCredentialValues reads env values only under secret names", () => {
  const models = piDir({}, { p: { env: { MY_TOKEN: KEY, REGION: "us-east-1-long-region-name" } } });
  assert.deepEqual(piCredentialValues(models), [{ name: "auth.json p.env.MY_TOKEN", value: KEY }]);
});

test("piCredentialValues returns [] for a missing directory and non-JSON files", () => {
  assert.deepEqual(piCredentialValues(path.join(tmpdir(), "no-such-dir", "models.json")), []);
  assert.deepEqual(piCredentialValues(piDir("not json", "{torn")), []);
});

test("secretLeakReason names the pi models.json source, never the value", async () => {
  const models = piDir({ providers: { qwenrunner: { apiKey: KEY } } }, undefined);
  const wt = await worktree({ "README.md": "# T\n" }, { "dump.txt": `key=${KEY}` });
  const reason = await secretLeakReason(wt, "main", ["dump.txt"], knownSecrets({}, models));
  assert.match(reason!, /`dump\.txt` contains the value of pi models\.json qwenrunner\.apiKey/);
  assert.ok(!reason!.includes(KEY));
});

test("knownSecrets keeps the first of two entries sharing a value", () => {
  const models = piDir({ providers: { p: { apiKey: VALUE } } }, undefined);
  assert.deepEqual(knownSecrets(ENV_RAW, models), [{ name: "$HF_TOKEN", value: VALUE }]);
});

test("secretLeakReason names a changed file it cannot read, and skips a missing one", async () => {
  const wt = await worktree({ "README.md": "# T\n" }, { "clean.md": "nothing here\n" });
  const fault = (name: string, code: string) =>
    patchFsMethod(name, (orig) => (...args) => {
      if (String(args[0]).endsWith("clean.md")) throw errnoError(code);
      return orig(...args);
    });
  let undo = fault("readFileSync", "EMFILE");
  try {
    const reason = await secretLeakReason(wt, "main", ["clean.md"], ENV);
    assert.match(reason!, /`clean\.md` could not be read to check for leaked secrets \(EMFILE\)/);
  } finally {
    undo();
  }
  undo = fault("lstatSync", "EACCES");
  try {
    assert.match((await secretLeakReason(wt, "main", ["clean.md"], ENV))!, /\(EACCES\)/);
  } finally {
    undo();
  }
  assert.equal(await secretLeakReason(wt, "main", ["gone.md", "a/b.md"], ENV), undefined);
});

test("secretLeakReason names at most ten leaked files and appends the overflow count", async () => {
  // A change that dumps the same secret into eleven files: the reason names the first ten (its
  // most-files-named bound) and appends ` (+1 more)` instead of an unbounded string, so a
  // regression in the bound or the suffix wording fails here.
  const files = Array.from({ length: 11 }, (_, i) => `leak-${i}.json`);
  const edit: Record<string, string> = {};
  for (const f of files) edit[f] = `{"env":"${VALUE}"}`;
  const wt = await worktree({ "README.md": "# T\n" }, edit);
  const reason = await secretLeakReason(wt, "main", files, ENV);
  const shown = files.slice(0, 10);
  const hidden = files[10]!;
  for (const f of shown) assert.ok(reason!.includes(`\`${f}\` contains the value of $HF_TOKEN`), `${f} is named`);
  assert.ok(!reason!.includes(`\`${hidden}\``), "the eleventh file is not named");
  assert.match(reason!, / \(\+1 more\) — delete the file or remove the value; never commit credentials \(a Node diagnostic report, report\.\*\.json, dumps the whole environment\)$/);
});

test("secretLeakReason skips an oversized changed file without reading it", async () => {
  // The per-file size cap: a regular file over 8 MiB is skipped before it is read (lstat size,
  // never slurped), so a hostile or accidental huge file cannot be scanned. The oversized file
  // still holds the value, so if the guard regressed the file would be read AND named — both
  // fail here: the read-counting spy fails on any read of it, and the naming assertion fails if
  // the small file's finding is displaced.
  const big = "big.txt";
  const edit = {
    [big]: `big\n${"x".repeat(9_000_000)}`,
    "small.txt": `small\n${VALUE}`,
  };
  const wt = await worktree({ "README.md": "# T\n" }, edit);
  const readCalls: unknown[] = [];
  const undo = patchFsMethod("readFileSync", (orig) => (...args) => {
    readCalls.push(args[0]);
    return (orig as (...a: unknown[]) => unknown)(...args);
  });
  try {
    const reason = await secretLeakReason(wt, "main", [big, "small.txt"], ENV);
    assert.match(reason!, /`small\.txt` contains the value of \$HF_TOKEN/);
    assert.ok(!reason!.includes(`\`${big}\``), "the oversized file is not named");
  } finally {
    undo();
  }
  assert.ok(
    !readCalls.some((a) => String(a).endsWith(big)),
    `the oversized file must be skipped before it is read, reads: ${JSON.stringify(readCalls)}`,
  );
});
