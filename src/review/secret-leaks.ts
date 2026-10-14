import fs from "node:fs";
import path from "node:path";
import { readTextOrNull } from "../files/files.js";
import { changeBaseRev, fileContentAt } from "../git/git.js";
import { moreSuffix } from "../text/phrases.js";

/** Environment variable names that hold credentials. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)/i;
/** A value shorter than this is a setting (a token limit), not a credential. */
const MIN_SECRET_LENGTH = 16;
/** Files larger than this are not scanned. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
/** Most files named in one reason. */
const MAX_NAMED = 10;

/** The environment entries that look like credentials: a secret-like name and a value of at
 * least 16 characters with no whitespace that is not a path (so `GOOGLE_APPLICATION_CREDENTIALS`
 * pointing at a key file is not a secret). */
export function secretEnvValues(env: NodeJS.ProcessEnv): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !SECRET_NAME.test(name)) continue;
    if (value.length < MIN_SECRET_LENGTH || /\s/.test(value) || value.startsWith("/")) continue;
    out.push({ name, value });
  }
  return out;
}

/** The deterministic gate/stage finding for a change that writes the value of a secret
 * environment variable into a file (a Node diagnostic report dumps the whole environment).
 * A value already present in the file at the merge-base is not this change's leak. The reason
 * names files and variables, never the value. undefined when nothing leaked; never throws on
 * an unreadable file. */
export async function secretLeakReason(
  wt: string,
  mainBranch: string,
  files: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const secrets = secretEnvValues(env);
  if (secrets.length === 0) return undefined;
  let baseRev: string | undefined;
  const leaks: string[] = [];
  for (const file of files) {
    const full = path.join(wt, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) continue;
    const head = readTextOrNull(full);
    if (head === null) continue;
    const hits = secrets.filter((s) => head.includes(s.value));
    if (hits.length === 0) continue;
    baseRev ??= await changeBaseRev(wt, mainBranch);
    const base = await fileContentAt(wt, baseRev, file);
    for (const s of hits) {
      if (!base.includes(s.value)) leaks.push(`\`${file}\` contains the value of $${s.name}`);
    }
  }
  if (leaks.length === 0) return undefined;
  const shown = leaks.slice(0, MAX_NAMED).join("; ");
  return `${shown}${moreSuffix(leaks.length - MAX_NAMED)} — delete the file or remove the value; never commit credentials (a Node diagnostic report, report.*.json, dumps the whole environment)`;
}
