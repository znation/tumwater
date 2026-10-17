// vocabulary: plain
/**
 * Bundled pi extension: on a model that declares a context window of at most 128k, send pi's
 * system prompt without its `docs` section. Loaded on every pi run via `-e <this file>` from
 * src/pi/pi-args.ts.
 *
 * Why: pi 1.2.0's default system prompt carries a `<docs>` section — the install paths of pi's own
 * README, docs and examples, to read "only when the user asks about pi itself". A tumwater run
 * never does, and the section is ~1,400 characters (~350 tokens) that every request re-sends. On a
 * small window that is a real share of the first request, which tumwater's own prompt shrinks for
 * the same model (prompt.ts CompactPrompt, chosen by the same compactPromptWindow rule). pi offers
 * no option to leave the section out short of replacing the whole prompt, so the
 * `before_agent_start` handler returns the rendered prompt with that one section cut — the
 * preamble, tool list, tool rules and working directory are pi's own text. On a larger or unknown
 * window the prompt is left alone.
 *
 * The cut is a pure exported function so it is unit-testable without pi; the default export is
 * the thin adapter over pi's `before_agent_start` event and `ctx.model`.
 */

import { compactPromptWindow } from "./context-window.js";

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

interface ContextLike {
  model?: { contextWindow?: unknown };
}

interface PiExtensionApi {
  on(
    event: "before_agent_start",
    handler: (event: BeforeAgentStartLikeEvent, ctx?: ContextLike) => { systemPrompt: string } | undefined,
  ): void;
}

/** The pi extension entry point: on a small declared window, replace the run's system prompt
 * with the same prompt minus its docs section. */
export default function trimSystemPrompt(pi: PiExtensionApi): void {
  pi.on("before_agent_start", (event, ctx) => {
    if (!compactPromptWindow(ctx?.model?.contextWindow) || typeof event.systemPrompt !== "string") return undefined;
    const trimmed = withoutDocsSection(event.systemPrompt);
    return trimmed === null ? undefined : { systemPrompt: trimmed };
  });
}
