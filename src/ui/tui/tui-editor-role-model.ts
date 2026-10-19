// vocabulary: plain
import { setRoleModelFields } from "../../config/config-write.js";
import { rawRoleField } from "../../roles/role-view.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";
import { createRoleKeyEditor } from "./tui-editor-role-key.js";

/** The Ctrl+X role-model editor on the Transcript view's shared prompt line, the terminal twin
 * of `tumwater role <id> --model` / `--clear-model` and the dashboard role drawer's Model
 * overrides editor. Enter writes the viewed base role's `roles.<base>.model` through the shared
 * setRoleModelFields the CLI and the drawer use — so checkModelTripleField (a non-empty model id
 * or a bare tier name like `strong`) owns the value's truth, and an empty line clears the
 * override. Pre-fill reads the FILE's raw `roles.<base>.model`: overlayDefaults seeds every
 * built-in role's model from the catalog, so the merged value cannot tell an operator override
 * from a seeded default. On the notes view Ctrl+X keeps its clear-notes meaning, and on every
 * non-Transcript view it falls through to its own pane arms (the backlog cancel, the queued
 * cancel, the Health retire). The shape it shares with the instances editor lives in
 * createRoleKeyEditor. */
export function createRoleModelEditor(session: TuiEditorSession): TuiEditorModule {
  return createRoleKeyEditor(session, {
    mode: "roleModel",
    openCtrl: "x",
    yieldsOn: (ctx) => ctx.noteMode,
    prefill: (s, base) => {
      const existing = rawRoleField(s.root, base, "model");
      return typeof existing === "string" ? existing : "";
    },
    openFlash: (role) =>
      `edit ${role}'s model override (a model id or tier name like strong; empty clears): Enter to save, Esc to cancel`,
    commit: (s, base, text) => setRoleModelFields(s.root, base, { model: text }),
    savedFlash: (role, text) =>
      text === "" ? `${role}: model override cleared` : `${role}: model override set to ${text}`,
  });
}
