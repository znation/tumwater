import fs from "node:fs";
import path from "node:path";
import { errCode } from "../errno.js";
import { isJsonObject } from "../files/json-object.js";
import { readJsonFile } from "../files/json-files.js";
import { changeBaseRev, fileContentAt } from "../git/git.js";
import { piModelsPath } from "../pi/pi-models.js";
import { moreSuffix } from "../text/phrases.js";

/** Environment variable names that hold credentials. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)/i;
/** A value shorter than this is a setting (a token limit), not a credential. */
const MIN_SECRET_LENGTH = 16;
/** Files larger than this are not scanned. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
/** Most files named in one reason. */
const MAX_NAMED = 10;

/** A credential-shaped value: at least 16 characters, no whitespace, not a path. */
function looksLikeSecret(value: string): boolean {
  return value.length >= MIN_SECRET_LENGTH && !/\s/.test(value) && !value.startsWith("/");
}

interface Secret { name: string; value: string }

/** The environment entries that look like credentials: a secret-like name and a value of at
 * least 16 characters with no whitespace that is not a path (so `GOOGLE_APPLICATION_CREDENTIALS`
 * pointing at a key file is not a secret). */
export function secretEnvValues(env: NodeJS.ProcessEnv): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !SECRET_NAME.test(name)) continue;
    if (!looksLikeSecret(value)) continue;
    out.push({ name, value });
  }
  return out;
}

/** The credentials pi stores: literal `apiKey`s and header values in `models.json`, and the
 * `key`/`access`/`refresh` fields (plus secret-named `env` values) of the sibling `auth.json`.
 * `$NAME` interpolations (secretEnvValues covers those) and `!command` values are skipped. A
 * missing or torn file yields nothing; never throws. */
export function piCredentialValues(modelsPath: string = piModelsPath()): Secret[] {
  const out: Secret[] = [];
  const add = (name: string, value: unknown) => {
    if (typeof value !== "string" || value.startsWith("$") || value.startsWith("!")) return;
    if (looksLikeSecret(value)) out.push({ name, value });
  };
  const models = readJsonFile<Record<string, unknown>>(modelsPath);
  if (models && isJsonObject(models.providers)) {
    for (const [p, cfg] of Object.entries(models.providers)) {
      if (!isJsonObject(cfg)) continue;
      add(`models.json ${p}.apiKey`, cfg.apiKey);
      if (isJsonObject(cfg.headers)) {
        for (const [h, v] of Object.entries(cfg.headers)) add(`models.json ${p}.headers.${h}`, v);
      }
    }
  }
  const auth = readJsonFile<Record<string, unknown>>(path.join(path.dirname(modelsPath), "auth.json"));
  if (auth) {
    for (const [p, cred] of Object.entries(auth)) {
      if (!isJsonObject(cred)) continue;
      for (const f of ["key", "access", "refresh"]) add(`auth.json ${p}.${f}`, cred[f]);
      if (isJsonObject(cred.env)) {
        for (const [n, v] of Object.entries(cred.env)) {
          if (SECRET_NAME.test(n)) add(`auth.json ${p}.env.${n}`, v);
        }
      }
    }
  }
  return out;
}

/** Every secret the gate knows: secret-named environment values (named `$NAME`) then pi's stored
 * credentials (named `pi <file> <path>`), the first entry winning when two share a value. */
export function knownSecrets(
  env: NodeJS.ProcessEnv = process.env,
  modelsPath: string = piModelsPath(),
): Secret[] {
  const all = [
    ...secretEnvValues(env).map((s) => ({ name: `$${s.name}`, value: s.value })),
    ...piCredentialValues(modelsPath).map((s) => ({ name: `pi ${s.name}`, value: s.value })),
  ];
  return all.filter((s, i) => all.findIndex((o) => o.value === s.value) === i);
}

/** Whether `err` says the path holds no file (deleted, or a parent replaced). */
function noFile(err: unknown): boolean {
  const code = errCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The finding for a changed file the gate could not read. */
function unreadable(file: string, err: unknown): string {
  return `\`${file}\` could not be read to check for leaked secrets (${errCode(err) ?? "error"})`;
}

/** The deterministic gate/stage finding for a change that writes the value of a secret
 * environment variable or stored pi credential into a file (a Node diagnostic report dumps
 * the whole environment). A value already present in the file at the merge-base is not this
 * change's leak. The reason
 * names files and variables, never the value. undefined when nothing leaked. A changed file
 * that exists but cannot be read counts as a finding; a deleted file does not. */
export async function secretLeakReason(
  wt: string,
  mainBranch: string,
  files: string[],
  secrets: Secret[] = knownSecrets(),
): Promise<string | undefined> {
  if (secrets.length === 0) return undefined;
  let baseRev: string | undefined;
  const leaks: string[] = [];
  for (const file of files) {
    const full = path.join(wt, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch (err) {
      if (!noFile(err)) leaks.push(unreadable(file, err));
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) continue;
    let head: string;
    try {
      head = fs.readFileSync(full, "utf8");
    } catch (err) {
      if (!noFile(err)) leaks.push(unreadable(file, err));
      continue;
    }
    const hits = secrets.filter((s) => head.includes(s.value));
    if (hits.length === 0) continue;
    baseRev ??= await changeBaseRev(wt, mainBranch);
    const base = await fileContentAt(wt, baseRev, file);
    for (const s of hits) {
      if (!base.includes(s.value)) leaks.push(`\`${file}\` contains the value of ${s.name}`);
    }
  }
  if (leaks.length === 0) return undefined;
  const shown = leaks.slice(0, MAX_NAMED).join("; ");
  return `${shown}${moreSuffix(leaks.length - MAX_NAMED)} — delete the file or remove the value; never commit credentials (a Node diagnostic report, report.*.json, dumps the whole environment)`;
}
