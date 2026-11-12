/** The `tumwater salvage` command: the view of the workspace patches kept for the operator
 * under `.tumwater/salvage/` — the readable half of the doctor `salvage patches` row and the
 * standing `salvage-patches` alert, which name only each patch's file, age and size, plus the
 * `--drop` twin that deletes one at the operator's request. Split out of cli.ts's dispatcher
 * like cli-query-commands.ts's command bodies: main() routes to cmdSalvage here exactly as it
 * routes to cmdQuarantine, and cli.ts keeps only routing. The command owns its argument gate,
 * its no-ready-repo stance (refuseTeamWorkspace, like `quarantine` and `reviews`: a missing or
 * unreadable salvage dir degrades to the empty list, so the list reads in any directory and
 * never writes), and its output shape. */

import { fail, say, sayJson, sayJsonOrRender } from "./cli-output.js";
import { failFollowJsonRival, parseGrepFlag, scanPositionArgs } from "./cli-args.js";
import { DRY_RUN_FLAG, FOLLOW_FLAG, JSON_FLAG, grepFlagSpec, hasFollowFlag, rejectUnknownArgs } from "./cli-flag-specs.js";
import { followView, type FollowViewSeams } from "./follow-view.js";
import { refuseTeamWorkspace } from "./cli-repo-gate.js";
import { salvagePatchStat, applySalvagePatchForOperator, checkSalvagePatchForOperator } from "../git/slot-salvage.js";
import { isGitRepo } from "../git/git.js";
import {
  collectSalvagePatches,
  dropSalvagePatch,
  grepSalvagePatches,
  readSalvagePatch,
  salvagePatchAt,
} from "../status/status-salvage.js";
import { formatAge } from "../text/datetime.js";
import { formatBytes } from "../text/format.js";

/** `tumwater salvage [-f/--follow] [--grep <text>] [--show <n>] [--drop <n>]
 * [--apply <n>] [--json]`:
 * list the kept workspace
 * patches under `.tumwater/salvage/` oldest first, as the doctor's `salvage patches` row
 * counts them, each naming its file, how long ago it was saved and its size — so an operator
 * can see what a run left behind before applying or deleting it. `--grep <text>` keeps only
 * the patches whose file name or patch text contains the text (case-insensitively), each
 * under its whole-list number. `-f/--follow` repaints the list every couple of seconds until
 * Ctrl+C or the process that started it exits, re-reading `.tumwater/salvage/` each frame so
 * a patch a run keeps while the operator watches appears without a rerun, composing with
 * `--grep` and refusing `--json` (a live view repaints one document, not one snapshot).
 * `--show <n>` prints the Nth patch as the list numbers it, in
 * full (the exact patch text), the read-only detail twin of `quarantine --show` and
 * `reviews --show`; `--drop <n>` deletes the Nth patch the list numbers, the destructive
 * twin whose text and `--json` say what it removed; `--apply <n>` applies the Nth patch to
 * the current checkout as unstaged edits — the one branch that also writes the checkout, and
 * the only one that needs a git checkout there: it never commits, never deletes the patch, and
 * applies nothing when the patch does not fit the tree. `--apply <n> --dry-run` asks the
 * apply's `git apply --check` question alone and writes nothing — the read-only preview twin
 * of `revert --dry-run`, `archive --dry-run` and `reclaim --dry-run`, the read-only preview
 * every other mutating operator command already has. Read-only in every branch but
 * `--drop` and `--apply`, and needing no ready repo: refuseTeamWorkspace is the whole gate,
 * so the list degrades to the empty line in a plain directory and no run ever writes a patch
 * except, at the operator's request, the unlink a `--drop` makes. `--dry-run` is accepted
 * only on `--apply` (the read-only preview); on the list, `--show` and `--drop` each run
 * their own flag gate, which refuses a `--dry-run` token as an unknown flag before any patch
 * or checkout is touched, so a stray `--dry-run` never changes what the command does. */
export async function cmdSalvage(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  const grepAt = args.indexOf("--grep");
  const grepValueIndex = grepAt >= 0 ? grepAt + 1 : -1;
  const modeNamed = (flag: string): boolean => args.some((arg, i) => arg === flag && i !== grepValueIndex);
  if (modeNamed("--show")) {
    await cmdSalvageShow(root, args);
    return;
  }
  if (modeNamed("--drop")) {
    await cmdSalvageDrop(root, args);
    return;
  }
  if (modeNamed("--apply")) {
    await cmdSalvageApply(root, args);
    return;
  }
  // --grep filters the positioned patches to the ones whose file name or patch text contains
  // the text (case-insensitively), each kept row's position unchanged so `--show` keeps
  // addressing the whole list. The missing-value wording lives in SALVAGE_GREP_VALUE_ERROR,
  // the flag gate's and this parser's shared string. The --json and -f/--follow scans run
  // over `rest` (the pattern token removed), so a flag-shaped pattern like `--grep --json` is
  // the text "--json", not the flag (and `--grep --follow` stays a one-shot pattern search
  // for the text "--follow").
  const SALVAGE_GREP_VALUE_ERROR = "salvage --grep needs text (usage: tumwater salvage --grep <text>)";
  rejectUnknownArgs("salvage", args, [JSON_FLAG, FOLLOW_FLAG, grepFlagSpec(SALVAGE_GREP_VALUE_ERROR)]);
  refuseTeamWorkspace(root);
  const { rest, pattern } = parseGrepFlag(args, SALVAGE_GREP_VALUE_ERROR);
  const follow = hasFollowFlag(rest);
  if (follow && rest.includes("--json")) failFollowJsonRival("salvage --json");
  // Each frame re-reads `.tumwater/salvage/` and reads the clock once, so a patch a run
  // keeps while the operator watches appears in the next repaint — the same per-frame read
  // `quarantine -f` uses. The --grep filter applies inside the per-frame read, so a
  // filtered frame still numbers the kept rows whole-list.
  const readSalvageRows = (): {
    full: ReturnType<typeof collectSalvagePatches>;
    rows: ReturnType<typeof grepSalvagePatches>;
  } => {
    const full = collectSalvagePatches(root);
    return {
      full,
      rows:
        pattern === null
          ? full.map((p, i) => ({ position: i + 1, file: p.file, savedAt: p.savedAt, bytes: p.bytes }))
          : grepSalvagePatches(root, full, pattern),
    };
  };
  // The no-match prose is a filter's line (the dir is non-empty but nothing matches); a
  // genuinely empty dir keeps the empty line, and --json prints the filtered rows in both
  // cases.
  const renderSalvageRows = (r: {
    full: ReturnType<typeof collectSalvagePatches>;
    rows: ReturnType<typeof grepSalvagePatches>;
  }): string => {
    if (r.full.length === 0) return "no salvaged workspace patches are kept for you";
    if (r.rows.length === 0) return `no salvaged workspace patches match "${pattern}"`;
    const now = Date.now();
    const lines = r.rows.map(
      (p) => `${p.position}. ${p.file} — saved ${formatAge(now - p.savedAt)} ago, ${formatBytes(p.bytes)}`,
    );
    return [`salvaged workspace patches: ${r.rows.length}`, ...lines].join("\n");
  };
  if (follow) {
    await followView(() => renderSalvageRows(readSalvageRows()), seams);
    return;
  }
  const result = readSalvageRows();
  sayJsonOrRender(rest, { patches: result.rows }, () => renderSalvageRows(result));
}

/** The `tumwater salvage --show <n>` branch: print the Nth patch `tumwater salvage` lists
 * read-only and in full — a header naming the position and file, the saved-ago and size line,
 * git's per-file diffstat (`git apply --stat`) when the patch is a valid diff, then the patch
 * text verbatim — so an operator can see which files a kept patch touches before reading every
 * hunk. Parsed the way cmdQuarantineShow parses `--show` — the same `scanPositionArgs`, and
 * like it the read's `refuseTeamWorkspace` with no `requireReadyRepo`, so it never needs a
 * ready tree; the out-of-range wording is salvage's own (`salvagePatchAt`, shared with
 * `--drop` and `--apply`), not quarantine's. `--json` serves the position, file,
 * savedAt, bytes, the diffstat as `stat` (null when it is not a valid diff) and the exact
 * patch text. */
async function cmdSalvageShow(root: string, args: string[]): Promise<void> {
  const { json, position, rest } = scanPositionArgs(args, "--show", "--show 2");
  rejectUnknownArgs("salvage", rest, []);
  if (position === null) fail("--show needs a position (usage: tumwater salvage --show <n>)");
  refuseTeamWorkspace(root);
  const at = salvagePatchAt(collectSalvagePatches(root), position);
  if ("message" in at)
    fail(at.message!);
  const patch = at.patch;
  const text = readSalvagePatch(root, patch.file);
  if (text === null) fail(`could not read salvaged patch ${patch.file}`);
  // `git apply --stat` reads the patch without applying it, so the summary is safe to compute
  // in any directory; a non-diff patch (or a git that fails) yields null and the text branch
  // simply omits the stat line, so a malformed patch prints exactly what it printed before.
  const stat = await salvagePatchStat(root, patch.file);
  if (json) {
    sayJson({ position, file: patch.file, savedAt: patch.savedAt, bytes: patch.bytes, stat, patch: text });
  } else {
    const now = Date.now();
    say(`salvaged workspace patch ${position}: ${patch.file}`);
    say(`saved ${formatAge(now - patch.savedAt)} ago, ${formatBytes(patch.bytes)}`);
    if (stat !== null) say(stat);
    say(text);
  }
}

/** The `tumwater salvage --drop <n>` branch: delete the Nth patch `tumwater salvage` lists —
 * the destructive twin of `--show`, so an operator can clear a reviewed or unwanted patch
 * without `rm` under `.tumwater/salvage/`. Parsed the way cmdSalvageShow parses `--show`,
 * sharing its scanPositionArgs and out-of-range wording, and staying on its
 * refuseTeamWorkspace (no requireReadyRepo) so it never needs a ready tree. `--json`
 * serves the dropped position and file. */
async function cmdSalvageDrop(root: string, args: string[]): Promise<void> {
  const { json, position, rest } = scanPositionArgs(args, "--drop", "--drop 2");
  rejectUnknownArgs("salvage", rest, []);
  if (position === null) fail("--drop needs a position (usage: tumwater salvage --drop <n>)");
  refuseTeamWorkspace(root);
  const at = salvagePatchAt(collectSalvagePatches(root), position);
  if ("message" in at)
    fail(at.message!);
  const patch = at.patch;
  if (!dropSalvagePatch(root, patch.file)) fail(`could not drop salvaged patch ${patch.file}`);
  if (json) {
    sayJson({ dropped: { position, file: patch.file } });
  } else {
    say(`dropped salvaged workspace patch ${position}: ${patch.file}`);
  }
}

/** The `tumwater salvage --apply <n>` branch: apply the Nth patch `tumwater salvage` lists
 * to the current checkout as unstaged edits — the apply twin of the read-only `--show` and
 * the destructive `--drop`. Parsed the way both parse, sharing scanPositionArgs (which also
 * reads the `--dry-run` boolean through its extra-boolean slot), its rival-flag gate and the
 * out-of-range wording. Where `--show` and `--drop` need no repo, apply needs a git checkout:
 * it fails outside one, and it applies against `root` itself, never committing and never
 * deleting the patch (a patch the tree rejects applies nothing). `--json` serves
 * `{ applied: { position, file } }` in place of the prose line.
 *
 * With `--dry-run` the branch asks `checkSalvagePatchForOperator` — the same `git apply
 * --check` read the real apply runs first — and writes nothing: a patch that fits prints
 * `would apply …` and exits 0; one that no longer fits fails with the apply's existing
 * `does not apply cleanly …` wording (which already says `no files were changed`) and exits
 * 1, and `--json` serves `{ dryRun: true, position, file, applies }` on either outcome,
 * exiting 1 when `applies` is false (the `revert --dry-run --json` shape, with the apply's
 * `applies` key). The preview reuses the apply's position, git-checkout, team-workspace and
 * out-of-range gates in the same order, so it fails where the apply would fail and previews
 * only where the apply could run. */
async function cmdSalvageApply(root: string, args: string[]): Promise<void> {
  const { json, flags, position, rest } = scanPositionArgs(args, "--apply", "--apply 2", [DRY_RUN_FLAG.names[0]!]);
  const dryRun = flags[DRY_RUN_FLAG.names[0]!] === true;
  rejectUnknownArgs("salvage", rest, [JSON_FLAG]);
  if (position === null) fail("--apply needs a position (usage: tumwater salvage --apply <n>)");
  refuseTeamWorkspace(root);
  if (!(await isGitRepo(root))) fail("salvage --apply needs a git checkout (run it from the checkout the patch should apply to)");
  const at = salvagePatchAt(collectSalvagePatches(root), position);
  if ("message" in at)
    fail(at.message!);
  const patch = at.patch;
  if (dryRun) {
    const applies = await checkSalvagePatchForOperator(root, patch.file);
    if (json) {
      if (!applies) process.exitCode = 1;
      sayJson({ dryRun: true, position, file: patch.file, applies });
      return;
    }
    if (!applies) {
      fail(
        `salvaged workspace patch ${patch.file} does not apply cleanly to this checkout — no files were changed (run tumwater salvage --show ${position} to print it for a manual apply)`,
      );
    }
    say(`would apply salvaged workspace patch ${position}: ${patch.file} — applies cleanly to this checkout; nothing was written`);
    return;
  }
  const applied = await applySalvagePatchForOperator(root, patch.file);
  if (!applied) {
    fail(
      `salvaged workspace patch ${patch.file} does not apply cleanly to this checkout — no files were changed (run tumwater salvage --show ${position} to print it for a manual apply)`,
    );
  }
  if (json) {
    sayJson({ applied: { position, file: patch.file } });
  } else {
    say(`applied salvaged workspace patch ${position}: ${patch.file}`);
  }
}
