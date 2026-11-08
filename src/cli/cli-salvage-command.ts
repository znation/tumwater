/** The `tumwater salvage` command: the read-only view of the workspace patches kept for the
 * operator under `.tumwater/salvage/` — the readable half of the doctor `salvage patches` row
 * and the standing `salvage-patches` alert, which name only each patch's file, age and size.
 * Split out of cli.ts's dispatcher like cli-query-commands.ts's read-only command bodies:
 * main() routes to cmdSalvage here exactly as it routes to cmdQuarantine, and cli.ts keeps
 * only routing. The command owns its argument gate, its no-ready-repo stance (refuseTeamWorkspace,
 * like `quarantine` and `reviews`: a missing or unreadable salvage dir degrades to the empty
 * list, so it reads in any directory and never writes), and its output shape. */

import { fail, say, sayJson, sayJsonOrRender } from "./cli-output.js";
import { parseGrepFlag, scanPositionArgs } from "./cli-args.js";
import { JSON_FLAG, grepFlagSpec, rejectUnknownArgs } from "./cli-flag-specs.js";
import { refuseTeamWorkspace } from "./cli-repo-gate.js";
import { collectSalvagePatches, grepSalvagePatches, readSalvagePatch } from "../status/status-salvage.js";
import { formatAge } from "../text/datetime.js";
import { formatBytes } from "../text/format.js";

/** `tumwater salvage [--grep <text>] [--show <n>] [--json]`: list the kept workspace
 * patches under `.tumwater/salvage/` oldest first, as the doctor's `salvage patches` row
 * counts them, each naming its file, how long ago it was saved and its size — so an operator
 * can see what a run left behind before applying or deleting it. `--grep <text>` keeps only
 * the patches whose file name or patch text contains the text (case-insensitively), each
 * under its whole-list number. `--show <n>` prints the Nth patch as the list numbers it, in
 * full (the exact patch text), the read-only detail twin of `quarantine --show` and
 * `reviews --show`. Read-only and needing no ready repo: refuseTeamWorkspace is the whole
 * gate, so the list degrades to the empty line in a plain directory and no run ever writes a
 * patch. */
export async function cmdSalvage(root: string, args: string[]): Promise<void> {
  // `--show <n>` is the command's read-only detail branch: route it before the list gate,
  // exactly as cmdQuarantine routes its `--show` first, so its own flag gate owns a token
  // the list would otherwise refuse. A `--show` token sitting in `--grep`'s value slot is the
  // pattern, not the mode: the scan skips it, so `salvage --grep --show` greps for the text
  // "--show" instead of opening the detail view (the same quirk cmdQuarantine guards).
  const grepAt = args.indexOf("--grep");
  const grepValueIndex = grepAt >= 0 ? grepAt + 1 : -1;
  const modeNamed = (flag: string): boolean => args.some((arg, i) => arg === flag && i !== grepValueIndex);
  if (modeNamed("--show")) {
    await cmdSalvageShow(root, args);
    return;
  }
  // --grep filters the positioned patches to the ones whose file name or patch text contains
  // the text (case-insensitively), each kept row's position unchanged so `--show` keeps
  // addressing the whole list. The missing-value wording lives in SALVAGE_GREP_VALUE_ERROR,
  // the flag gate's and this parser's shared string. The --json scan runs over `rest` (the
  // pattern token removed), so a flag-shaped pattern like `--grep --json` is the text
  // "--json", not the flag.
  const SALVAGE_GREP_VALUE_ERROR = "salvage --grep needs text (usage: tumwater salvage --grep <text>)";
  rejectUnknownArgs("salvage", args, [JSON_FLAG, grepFlagSpec(SALVAGE_GREP_VALUE_ERROR)]);
  refuseTeamWorkspace(root);
  const patches = collectSalvagePatches(root);
  const { rest, pattern } = parseGrepFlag(args, SALVAGE_GREP_VALUE_ERROR);
  const rows =
    pattern === null
      ? patches.map((p, i) => ({ position: i + 1, file: p.file, savedAt: p.savedAt, bytes: p.bytes }))
      : grepSalvagePatches(root, patches, pattern);
  const now = Date.now();
  sayJsonOrRender(
    rest,
    { patches: rows },
    () => {
      if (patches.length === 0) return "no salvaged workspace patches are kept for you";
      if (rows.length === 0) return `no salvaged workspace patches match "${pattern}"`;
      const lines = rows.map(
        (p) => `${p.position}. ${p.file} — saved ${formatAge(now - p.savedAt)} ago, ${formatBytes(p.bytes)}`,
      );
      return [`salvaged workspace patches: ${rows.length}`, ...lines].join("\n");
    },
  );
}

/** The `tumwater salvage --show <n>` branch: print the Nth patch `tumwater salvage` lists
 * read-only and in full — a header naming the position and file, the saved-ago and size line,
 * then the patch text verbatim — so an operator can read what a run left behind without
 * guessing the directory. Parsed the way cmdQuarantineShow parses `--show`, sharing its
 * scanPositionArgs and out-of-range wording, and staying on the read's refuseTeamWorkspace
 * (no requireReadyRepo) so it never needs a ready tree. `--json` serves the position, file,
 * savedAt, bytes and the exact patch text. */
async function cmdSalvageShow(root: string, args: string[]): Promise<void> {
  const { json, position, rest } = scanPositionArgs(args, "--show", "--show 2");
  rejectUnknownArgs("salvage", rest, []);
  if (position === null) fail("--show needs a position (usage: tumwater salvage --show <n>)");
  refuseTeamWorkspace(root);
  const patches = collectSalvagePatches(root);
  if (position < 1 || position > patches.length) {
    fail(`no salvaged workspace patch at position ${position} (salvage holds ${patches.length} patches)`);
  }
  const patch = patches[position - 1]!;
  const text = readSalvagePatch(root, patch.file);
  if (text === null) fail(`could not read salvaged patch ${patch.file}`);
  if (json) {
    sayJson({ position, file: patch.file, savedAt: patch.savedAt, bytes: patch.bytes, patch: text });
  } else {
    const now = Date.now();
    say(`salvaged workspace patch ${position}: ${patch.file}`);
    say(`saved ${formatAge(now - patch.savedAt)} ago, ${formatBytes(patch.bytes)}`);
    say(text);
  }
}
