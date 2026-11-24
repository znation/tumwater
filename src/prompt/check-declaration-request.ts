import type { TumwaterConfig } from "../config/config-schema.js";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { queuedPrompts } from "../inbox/inbox.js";
import { submitPrompt } from "../inbox/inbox-submit.js";
import { hasUnmergedPin } from "../runner/runner-leftover.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { checkDeclarationStatePath } from "../paths.js";
import { buildCheckForPoll } from "../build/build-check-poll.js";
import { errorMessage } from "../text/text.js";

/** The first line of every automatic check-declaration prompt the orchestrator queues the
 * director. `requestCheckDeclaration` matches a queued prompt against this prefix to keep one
 * declaration request at a time, so a test can seed a queued request by this marker alone. */
export const CHECK_DECLARATION_LEAD = "[automatic] This project declares no deterministic check; declare one:";

/** How long a declaration attempt waits before it is retried on an unchanged main. One fixed
 * default, not a config knob: a project with nothing to verify yet gets one director run a day
 * at most, and only once main has moved since the last attempt. */
export const CHECK_DECLARATION_RETRY_MS = 24 * 60 * 60 * 1000;

/** The prompt the orchestrator hands the director when the project declares no check. The
 * director is a model reading the repo, so it finds the verifying command itself (any language
 * or build tool), then declares it by one of two routes: a `test`/`typecheck`/`build` script on
 * the install root's package.json, or a `check.command` request file tumwater applies after
 * running it green. The rules say to stay out of the project's config file directly and to file
 * no backlog entry. */
export function checkDeclarationPrompt(): string {
  return (
    `${CHECK_DECLARATION_LEAD}\n` +
    `\n` +
    `tumwater runs a deterministic check after each change, and this project has none, so every ` +
    `gate is blind. Find the command that verifies this repo — its test suite, typecheck or build ` +
    `(for example \`cargo test\`, \`go test ./...\`, \`pytest\`, \`make test\`, \`npm test\`). Read its ` +
    `manifests, CI workflows and README to find it. Do not guess from the language alone.\n` +
    `\n` +
    `Declare it by one route:\n` +
    `- (1) When the install root's package.json (the nearest directory holding both a package.json ` +
    `and a node_modules directory) lacks a \`test\`, \`typecheck\` or \`build\` script, add one there. ` +
    `That is a tracked diff the review sees.\n` +
    `- (2) Otherwise write \`{ "check": { "command": "…" } }\` to \`.tumwater-config-request.json\` at ` +
    `the worktree root. Never write the project's config file directly. tumwater runs the request ` +
    `green before it applies it.\n` +
    `\n` +
    `Pick a command that passes on the tree as it is. A check that is red on main is worse than none.\n` +
    `If there is nothing to verify yet (no source, no runnable tests), change nothing and end with ` +
    `TUMWATER_NOTHING_TO_DO.\n` +
    `\n` +
    `Add no PLANS.md or BUGS.md entry for this work. In your summary, say which route you took and ` +
    `the command you declared.`
  );
}

/** The injectable seams, so a test pins each refusal without a real pin, a real inbox, or a
 * real clock. The no-check verdict itself is the production `buildCheckForPoll`. */
interface RequestCheckDeclarationOptions {
  /** Whether a director run is in flight right now; the orchestrator passes its
   * `directorInFlight` set's `size > 0`. */
  directorBusy?: boolean;
  /** The held-pin probe (default `hasUnmergedPin`). */
  hasPin?: (root: string, role: string) => Promise<boolean>;
  /** The enqueue (default `submitPrompt`). */
  submit?: (root: string, text: string) => string;
  /** main's head sha right now; the retry gate re-requests only when it moved. */
  mainHead?: string;
  /** The clock in epoch milliseconds (default `Date.now()`). */
  now?: number;
}

/** The one verdict the orchestrator's poll turns into a request: the declaration was enqueued
 * (`requested`), or the reason it was not. A thrown enqueue is caught into `error` rather than
 * propagated, so a broken inbox can never end the poll loop. */
interface CheckDeclarationRequestResult {
  requested: boolean;
  error?: string;
}

/** The attempt record `.tumwater/check-declaration.json` holds: when a declaration prompt was
 * last submitted and main's head at that moment. */
interface CheckDeclarationAttempt {
  at: number;
  head: string;
}

/** The retry gate: a missing or unreadable record means request now; otherwise request again only
 * when main's head differs from the recorded one and the recorded attempt is at least a day old. */
function retryDue(root: string, head: string, now: number): boolean {
  const record = readJsonFile<Partial<CheckDeclarationAttempt>>(checkDeclarationStatePath(root));
  if (!record || typeof record.at !== "number" || typeof record.head !== "string") return true;
  return head !== record.head && now - record.at >= CHECK_DECLARATION_RETRY_MS;
}

/** Queue the director a declaration prompt when the project declares no check, at most one at
 * a time and at most once per day per main head: `false` when a check is declared (the
 * `buildCheckForPoll` verdict is non-null), when a declaration prompt is already queued, when
 * `opts.directorBusy` is true, when the director holds an unmerged pin, or when the retry gate
 * says the last attempt is too recent. Otherwise it enqueues through the production
 * `submitPrompt`, writes the attempt record, and returns `{ requested: true }`; an enqueue that
 * throws returns `{ requested: false, error }` and writes no record. */
export async function requestCheckDeclaration(
  root: string,
  config: TumwaterConfig,
  opts: RequestCheckDeclarationOptions = {},
): Promise<CheckDeclarationRequestResult> {
  if (buildCheckForPoll(root, config) !== null) return { requested: false };
  if (queuedPrompts(root).some((p) => p.startsWith(CHECK_DECLARATION_LEAD))) {
    return { requested: false };
  }
  if (opts.directorBusy) return { requested: false };
  const hasPin = opts.hasPin ?? hasUnmergedPin;
  if (await hasPin(root, DIRECTOR_ROLE)) return { requested: false };
  const head = opts.mainHead ?? "";
  const now = opts.now ?? Date.now();
  if (!retryDue(root, head, now)) return { requested: false };
  const submit = opts.submit ?? submitPrompt;
  try {
    submit(root, checkDeclarationPrompt());
  } catch (err) {
    return { requested: false, error: errorMessage(err) };
  }
  writeJsonAtomic(checkDeclarationStatePath(root), { at: now, head } satisfies CheckDeclarationAttempt);
  return { requested: true };
}
