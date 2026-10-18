// vocabulary: plain
/** Building one OpenCode run's command line (plans/opencode-backend.md "The invocation") —
 * pure argv construction plus the prompt-on-stdin pairing, with no subprocess, backend
 * registration, or session database. Part 5/7 wires this into the adapter; this module turns
 * its inputs (the resolved model, the catalog's variant, the session choice, the session
 * name, and the configured passthrough args) into the invocation's argv and stdin.
 *
 * The environment is built separately (opencode-env.ts) so each concern has one module.
 *
 * `.args` passthrough: a passthrough arg equal to a flag the harness itself sets would be
 * appended AFTER the harness's own copy and OpenCode's parser is last-wins, so it would
 * silently override the resolved model, the session choice, or the isolation flags. Each is
 * rejected by opencodeArgs with the offending arg named, matching the same rejection in
 * claudeArgs and the reserved set from plans/opencode-backend.md "Config and routing". */

/** Flags the harness invocation sets. A passthrough arg equal to one of these is rejected by
 * opencodeArgs with the offending arg named, so an operator's `backends.opencode.args` can
 * never silently override the resolved model, the session choice, or the isolation flags. This
 * is the reserved set from plans/opencode-backend.md "Config and routing"; part 3 adds
 * `--title`, which tumwater now sets (finding 6). */
import { appendPassthroughArgs } from "../agent-args.js";

export const HARNESS_OPENCODE_FLAGS: ReadonlySet<string> = new Set([
  "run",
  "--format",
  "--model",
  "-m",
  "--session",
  "-s",
  "--continue",
  "-c",
  "--fork",
  "--standalone",
  "--server",
  "--attach",
  "--auto",
  "--yolo",
  "--dangerously-skip-permissions",
  "--agent",
  "--thinking",
  "--dir",
  "--title",
]);

/** The opencode argv builder's inputs. `model` is the concrete resolved id (a tier map is
 * resolved before the seam, as claudeArgs's view is). `variant` is passed only when OpenCode's
 * catalog lists it for the model; part 6d/7 supplies that list from the catalog, and the
 * backend drops a level the catalog does not list.
 * `sessionId` is the resolved session choice from part 4/7's ledger. `title` names the session
 * so OpenCode skips its hidden title-generation model call (finding 6). */
export interface OpencodeArgOptions {
  /** The resolved concrete model id, e.g. `deepseek-v4.1-flash-free` or
   * `anthropic/claude-sonnet-5-5`. */
  model: string;
  /** OpenCode's catalog variant for the model (e.g. `low`), when the catalog lists one. */
  variant?: string;
  /** The session id OpenCode runs in, minted by the caller's ledger. */
  sessionId: string;
  /** The session name, passed as `--title` so OpenCode skips its hidden title call. */
  title: string;
  /** The configured `backends.opencode.args` passthrough, appended last. */
  args?: string[];
  /** The tick prompt, returned as stdin rather than as an argv element. */
  prompt: string;
}

/** Build one run's opencode argv and stdin. The prompt is never an argv element (OpenCode
 * reads a non-TTY stdin to EOF, and the runner closes it). A model with no `/` names a model
 * on OpenCode's own gateway and gets the `opencode/` provider; anything with a slash is the
 * provider-qualified id and passes as is. Throws on a passthrough arg that repeats a harness
 * flag, since OpenCode's last-wins parser would otherwise silently override what the harness
 * asked for. */
/** The opencode-namespaced model id: a bare id (no `/`) names a model on OpenCode's own
 * gateway and gets the `opencode/` provider; an id bearing a slash is provider-qualified and
 * passes as-is. The single home of this routing rule — shared by the argv builder
 * (opencodeArgs, here) and the catalog's cache key (opencode-catalog.ts's opencodeModelKey) —
 * so the id a run is invoked with always matches the id a run is priced by. */
export function opencodeQualifiedModel(model: string): string {
  return model.includes("/") ? model : `opencode/${model}`;
}

export function opencodeArgs(opts: OpencodeArgOptions): { args: string[]; stdin: string } {
  const model = opencodeQualifiedModel(opts.model) + (opts.variant !== undefined ? `#${opts.variant}` : "");
  const args = ["run", "--standalone", "--format", "json", "--auto", "--model", model, "--session", opts.sessionId, "--title", opts.title];
  appendPassthroughArgs(args, opts.args, HARNESS_OPENCODE_FLAGS, "opencodeArgs");
  return { args, stdin: opts.prompt };
}
