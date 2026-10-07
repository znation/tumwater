/** The guarded read of pi's `ctx.getContextUsage()` — the one home of the rule that the call
 * throws when the run has no session yet. Both bundled context extensions read usage
 * (context-budget.ts's threshold notes and context-shake.ts's reclaim pass) and each used to
 * spell the same `try { ctx?.getContextUsage?.() } catch { return undefined }` inline; an
 * unknown reading is always `undefined`, never an escaped throw.
 *
 * pi itself loads the bundled extensions, so the real pi types stay out of the dependency tree
 * and this stays structural; the usage shape is left to each caller (context-budget requires
 * the fields it prints, context-shake tolerates a field pi could not compute), so the generic
 * return carries the caller's own type. */

/** Read `ctx.getContextUsage()` without letting pi's no-session throw escape: undefined when
 * the context or its accessor is absent, or when the call throws. */
export function readContextUsage<T>(
  ctx: { getContextUsage?: () => T | undefined } | undefined,
): T | undefined {
  try {
    return ctx?.getContextUsage?.();
  } catch {
    return undefined;
  }
}
