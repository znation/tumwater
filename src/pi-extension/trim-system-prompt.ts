/**
 * Bundled pi extension: send pi's system prompt without its `docs` section, on every model.
 * Loaded on every pi run via `-e <this file>` from src/pi/pi-args.ts.
 *
 * Why: pi 1.2.0's default system prompt carries a `<docs>` section — the install paths of pi's own
 * README, docs and examples, to read "only when the user asks about pi itself". A tumwater run
 * never does, and the section is ~1,400 characters (~350 tokens) that every request re-sends,
 * alongside tumwater's own run prompt, which is compact on every model too (prompt.ts). Until
 * 2026-10-18 both applied only at a declared window of at most 128k; they
 * now apply everywhere to cut token spend (a 2026-10-18 audit of the team's 1M-window runs). pi
 * offers no option to leave the section out short of replacing the whole prompt, so the
 * `before_agent_start` handler returns the rendered prompt with that one section cut — the
 * preamble, tool list, tool rules and working directory are pi's own text.
 *
 * The cut is a pure exported function so it is unit-testable without pi; the default export is
 * the thin adapter over pi's `before_agent_start` event.
 */

/** pi's docs section as rendered, with the blank lines that separate it from the section before
 * it. pi wraps each named section in a tag of the same name. */
const DOCS_SECTION = /\n*<docs>[\s\S]*?<\/docs>/;

/** `systemPrompt` without pi's `<docs>` section, or null when it carries none (a prompt pi did not
 * build from its default sections, or a pi that no longer renders one). Pure. */
export function withoutDocsSection(systemPrompt: string): string | null {
  if (!DOCS_SECTION.test(systemPrompt)) return null;
  return systemPrompt.replace(DOCS_SECTION, "");
}

/** Minimal structural types for pi's extension API — pi itself loads this file, so the real
 * types are not needed at compile time and stay out of the dependency tree. */
interface BeforeAgentStartLikeEvent {
  systemPrompt?: unknown;
}

interface PiExtensionApi {
  on(
    event: "before_agent_start",
    handler: (event: BeforeAgentStartLikeEvent) => { systemPrompt: string } | undefined,
  ): void;
}

/** The pi extension entry point: replace the run's system prompt with the same prompt minus its
 * docs section. */
export default function trimSystemPrompt(pi: PiExtensionApi): void {
  pi.on("before_agent_start", (event) => {
    if (typeof event.systemPrompt !== "string") return undefined;
    const trimmed = withoutDocsSection(event.systemPrompt);
    return trimmed === null ? undefined : { systemPrompt: trimmed };
  });
}
