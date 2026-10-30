import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { checkMinRunInterval } from "../../config/config-keys.js";
import { rawRoleField } from "../../roles/role-view.js";
import { gotSuffix, isPlainDecimal } from "../../text/text.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";
import { createRoleKeyEditor } from "./tui-editor-role-key.js";

/** The Ctrl+S min-run-interval editor on the shared prompt line, the terminal twin of
 * `tumwater role <id> --min-run-interval` and the dashboard role drawer's `Min run interval`
 * row, from the same createRoleKeyEditor factory the role-model and instance-count editors
 * share. It owns its held-marker slot and the role pinned when it opened, so a roster shift
 * cannot redirect the write. Enter writes through the shared setConfigKey/unsetConfigKey family
 * the CLI and the drawer use — so checkMinRunInterval (naming `roles.<base>.minRunIntervalSeconds`)
 * and validateConfig own the value's truth — a non-plain-decimal spelling (hex/exponent,
 * negative, or non-numeric) flashes the editor's own shape message first, mirroring the budget
 * editor's plain-decimal rule, and stays open — and Esc, Ctrl+S again, and Ctrl+T cancel by
 * restoring the prompt draft. Unlike the quiet editor there is no director refusal:
 * `tumwater role director --min-run-interval` is accepted, so the director edits too. Mutually
 * exclusive with the other editors on the one prompt line via the session's held registry. */
export function createIntervalEditor(session: TuiEditorSession): TuiEditorModule {
  return createRoleKeyEditor(session, {
    mode: "interval",
    openCtrl: "s",
    prefill: (s, base) => {
      const existing = rawRoleField(s.root, base, "minRunIntervalSeconds");
      return typeof existing === "number" ? String(existing) : "";
    },
    openFlash: (role) =>
      `edit ${role}'s min run interval in seconds (0 allows back-to-back runs, empty clears): Enter to save, Esc to cancel`,
    commit: (s, base, text) => {
      const cfgKey = `roles.${base}.minRunIntervalSeconds`;
      // An empty or whitespace-only line clears the override (a no-op success when the file
      // never set it, so the operator sees "is not set").
      if (text === "") {
        const r = unsetConfigKey(s.root, cfgKey);
        return r.ok && r.oldValue === undefined ? { ok: true, noop: true } : r;
      }
      // Plain decimal seconds only — bare Number() would also read hex ("0x10" → 16) and
      // exponent ("1e2" → 100) as an interval, neither of which an operator means when
      // typing a second count; the budget editor's parseBudgetInput applies the same
      // plain-decimal rule in the TUI, the CLI's --min-run-interval uses plainDecimalToJson,
      // and the GUI drawer's interval-save arm applies the same shape guard.
      // Non-plain spellings flash their own shape message — which, like checkMinRunInterval's
      // bounds wording below, names cfgKey so a rejected entry tells which per-role key the
      // editor was about to write — and STAY in edit mode (negative and non-numeric text hit
      // this shape arm too, so the operator sees one consistent message).
      if (!isPlainDecimal(text)) {
        return {
          ok: false,
          error: `${cfgKey} must be a plain second count like 300, 0.5, or .5 — no +/-, exponent, or hex notation${gotSuffix(text)}`,
        };
      }
      const value = Number(text);
      const invalid = checkMinRunInterval(value, cfgKey);
      if (invalid) return { ok: false, error: invalid };
      const result = setConfigKey(s.root, cfgKey, JSON.stringify(value));
      return result.ok && result.unchanged ? { ok: true, noop: true } : result;
    },
    savedFlash: (role, text) =>
      text === "" ? `${role}: min run interval cleared` : `${role}: min run interval set to ${text}s`,
    noopFlash: (role, text) =>
      text === ""
        ? `${role}: min run interval is not set in tumwater.json, so nothing was cleared`
        : `${role}: min run interval is already ${text}s, so tumwater.json was not written`,
  });
}
