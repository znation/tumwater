/** The usage report's CLI command half (cmdReport): parse the flags, collect through
 * src/report/report-data.ts / src/failure/failure-data.ts, and print. The Markdown renderers
 * live in the pure-render modules they pair with: src/report/report-render.ts and
 * src/failure/failure-render.ts. */
import { collectReport } from "./report-data.js";
import { collectReportSince } from "./report-since-data.js";
import { collectFailureReport, collectFailureReportSince } from "../failure/failure-data.js";
import { renderFailureMarkdown } from "../failure/failure-render.js";
import { renderReportMarkdown } from "./report-render.js";
import { renderSinceReportMarkdown } from "./report-since-render.js";
import { fail, say, sayJson, sayJsonOrRender } from "../cli/cli-output.js";
import { followView, type FollowViewSeams } from "../cli/follow-view.js";
import { failRivalShapes, failUntilShorterThanSince, flagValue, parseCountFlag, parseRoleListScope, parseSinceFlag } from "../cli/cli-args.js";
import { hasFollowFlag } from "../cli/cli-flag-specs.js";
import { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS, REPORT_SINCE_MAX_MS } from "../events/event-window.js";

/** `tumwater report [--days <n>] [--failures] [--since <duration>]
 * [--until <duration>]`: parse the flags and
 * print. Unknown-args rejection and the no-ready-repo-gate decision stay in cli.ts's case,
 * like every other command's. */
export async function cmdReport(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  // --since is handled before the day-shape reads: it is a rival shape (totals over a
  // trailing window vs a series over whole days), not a modifier of either.
  const ms = parseSinceFlag(args, "report --since", REPORT_SINCE_MAX_MS);
  const untilMs = parseSinceFlag(args, "report --until", REPORT_SINCE_MAX_MS, "--until");
  failUntilShorterThanSince("report", untilMs, ms);
  // --role scopes both report shapes: the usage report (day and --since) and the failure
  // digest, whose day and --since collectors take the same optional list of base roles.
  const role = parseRoleListScope(root, args);
  const follow = hasFollowFlag(args);
  if (follow && args.includes("--json")) fail("report --json prints one document; -f/--follow repaints a live view — drop one of them");
  if (ms !== null) {
    // --days is still a rival shape: it counts whole local days, while --since totals a trailing
    // window. --failures is not a rival anymore — the digest has a windowed-since collector that
    // reuses the day digest's own sections, so `report --failures --since <d>` dispatches it
    // through the existing --json / render choice; --until bounds its window's end.
    if (follow)
      failRivalShapes("report --since", "-f/--follow", 'follow means "from now on"; --since shows a bounded past window');
    if (args.includes("--days"))
      failRivalShapes("report --since", "--days", "--days counts whole local days; --since totals a trailing window");
    if (args.includes("--failures")) {
      const digest = collectFailureReportSince(root, ms, role ?? undefined, untilMs ?? undefined);
      if (args.includes("--json")) sayJson(digest);
      else say(renderFailureMarkdown(digest));
      return;
    }
    // --json swaps the renderer for the collector's own payload, exactly as status --json
    // does: bounds and cap checks above are shared, only the printing differs.
    const since = collectReportSince(root, ms, role ?? undefined, untilMs ?? undefined);
    sayJsonOrRender(args, since, renderSinceReportMarkdown);
    return;
  }
  const daysRaw = flagValue(args, "--days");
  let days = REPORT_DEFAULT_DAYS;
  if (daysRaw !== null) {
    // /api/report clamps its ?days= param to the same bound; an explicit flag fails fast
    // instead — a typo'd "3650" must not build a ten-year series (one entry per day), and
    // a huge value would grow it until the process runs out of memory. parseCountFlag's max
    // is that bound, with its shared `must be between 1 and <max>` wording; it has already
    // rejected 0, non-decimals, and a missing value.
    days = parseCountFlag("--days", daysRaw, REPORT_MAX_DAYS);
  }
  // --failures --json prints the collector's own payload (the FailureReportData object), the
  // report --json and doctor --json precedent: the time-and-spend fold gave the digest a
  // stable data shape, so the machine-readable form is the data itself, not a re-parse of the
  // Markdown (the old "clustered narrative with no agreed shape" refusal is retired).
  if (follow) {
    await followView(() => args.includes("--failures") ? renderFailureMarkdown(collectFailureReport(root, days, role ?? undefined)) : renderReportMarkdown(collectReport(root, days, role ?? undefined)), seams);
    return;
  }
  if (args.includes("--failures") && args.includes("--json")) {
    sayJson(collectFailureReport(root, days, role ?? undefined));
    return;
  }
  if (args.includes("--json")) {
    sayJson(collectReport(root, days, role ?? undefined));
    return;
  }
  say(
    args.includes("--failures")
      ? renderFailureMarkdown(collectFailureReport(root, days, role ?? undefined))
      : renderReportMarkdown(collectReport(root, days, role ?? undefined)),
  );
}
