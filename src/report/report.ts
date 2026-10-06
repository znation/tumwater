/** The usage report's CLI command half (cmdReport): parse the flags, collect through
 * src/report/report-data.ts / src/failure/failure-data.ts, and print. The Markdown renderers live in the pure-render
 * modules they pair with: src/report/report-render.ts (beside src/failure/failure-render.ts) and
 * src/failure/failure-render.ts. */
import { collectReport, collectReportSince } from "./report-data.js";
import { collectFailureReport } from "../failure/failure-data.js";
import { renderFailureMarkdown } from "../failure/failure-render.js";
import { renderReportMarkdown, renderSinceReportMarkdown } from "./report-render.js";
import { say, sayJson, sayJsonOrRender } from "../cli/cli-output.js";
import { failRivalShapes, flagValue, parseCountFlag, parseSinceFlag } from "../cli/cli-args.js";
import { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS, REPORT_SINCE_MAX_MS } from "../events/event-window.js";

/** `tumwater report [--days <n>] [--failures] [--since <duration>]`: parse the flags,
 * collect through src/report/report-data.ts / src/failure/failure-data.ts, and print. Unknown-args rejection and the
 * no-ready-repo-gate decision stay in cli.ts's case, like every other command's. */
export async function cmdReport(root: string, args: string[]): Promise<void> {
  // --since is handled before the day-shape reads: it is a rival shape (totals over a
  // trailing window vs a series over whole days), not a modifier of either.
  const ms = parseSinceFlag(args, "report --since", REPORT_SINCE_MAX_MS);
  if (ms !== null) {
    if (args.includes("--days"))
      failRivalShapes("report --since", "--days", "--days counts whole local days; --since totals a trailing window");
    if (args.includes("--failures"))
      failRivalShapes("report --since", "--failures", "the failure digest has no windowed-since mode");
    // --json swaps the renderer for the collector's own payload, exactly as status --json
    // does: bounds and cap checks above are shared, only the printing differs.
    const since = collectReportSince(root, ms);
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
  if (args.includes("--failures") && args.includes("--json")) {
    sayJson(collectFailureReport(root, days));
    return;
  }
  if (args.includes("--json")) {
    sayJson(collectReport(root, days));
    return;
  }
  say(
    args.includes("--failures")
      ? renderFailureMarkdown(collectFailureReport(root, days))
      : renderReportMarkdown(collectReport(root, days)),
  );
}
