import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { rawRoleField } from "../../roles/role-view.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";
import { createRoleKeyEditor } from "./tui-editor-role-key.js";

/** The Ctrl+G parallel-runner-count editor on the shared prompt line, the terminal twin of
 * `tumwater role <id> --instances` and the dashboard role drawer's instance-count editor. Enter
 * writes `roles.<base>.instances` through the shared setConfigKey/unsetConfigKey family the CLI
 * and the drawer use — an empty line clears the key (a no-op success when the file never set
 * it), otherwise the raw text is written — so validateConfig's INSTANCE_COUNT (an integer 1–8)
 * and INSTANCE_ROLES (feature and bugfix) own the value's truth, exactly as the CLI documents.
 * Pre-fill reads the FILE's raw `roles.<base>.instances` (empty when unset), since the merged
 * count may default. Ctrl+G keeps its scope-cycle meaning on every other view: the arm consumes
 * the key only on a role's Transcript. The shape it shares with the role-model editor lives in
 * createRoleKeyEditor. */
export function createInstancesEditor(session: TuiEditorSession): TuiEditorModule {
  return createRoleKeyEditor(session, {
    mode: "instances",
    openCtrl: "g",
    prefill: (s, base) => {
      const existing = rawRoleField(s.root, base, "instances");
      return typeof existing === "number" ? String(existing) : "";
    },
    openFlash: (role) =>
      `edit ${role}'s parallel-runner count (an integer 1-8; feature and bugfix only; empty clears): Enter to save, Esc to cancel`,
    commit: (s, base, text) => {
      const cfgKey = `roles.${base}.instances`;
      if (text === "") {
        const r = unsetConfigKey(s.root, cfgKey);
        return r.ok && r.oldValue === undefined ? { ok: true, noop: true } : r;
      }
      // Shape, before the write: an exponent spelling like "2e0" is itself a JSON number (2),
      // so setConfigKey's JSON.parse would read it past validateConfig's INSTANCE_COUNT integer
      // check and silently write 2 — the same silent misread the CLI's --instances guard
      // refuses (and the dashboard drawer's instance editor), so this refuses it too, naming
      // the key and staying in edit mode. A non-exponent spelling falls through to
      // validateConfig, whose message names the key.
      if (!/^\d*\.?\d+$/.test(text) && /^\d+(\.\d+)?[eE][+-]?\d+$/.test(text)) {
        return { ok: false, error: `${cfgKey} must be a plain integer from 1 to 8 — no exponent notation` };
      }
      const r = setConfigKey(s.root, cfgKey, text);
      return r.ok && r.unchanged ? { ok: true, noop: true } : r;
    },
    savedFlash: (role, text) =>
      text === "" ? `${role}: instances cleared` : `${role}: instances set to ${text}`,
    noopFlash: (role, text) =>
      text === ""
        ? `${role}: instances is not set in tumwater.json, so nothing was cleared`
        : `${role}: instances is already ${text}, so tumwater.json was not written`,
  });
}
