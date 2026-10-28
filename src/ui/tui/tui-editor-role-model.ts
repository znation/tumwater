import { setRoleModelFields } from "../../config/config-write.js";
import { rawRoleField } from "../../roles/role-view.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";
import { createRoleKeyEditor } from "./tui-editor-role-key.js";

/** A role's model-override triple as its Ctrl+X editor sees it: each field `""` when the line
 * omitted it (an omitted field is cleared by the write). 'backend' is deliberately not part of
 * the line — the editor never reads or writes it. */
export interface RoleModelFields {
  provider: string;
  model: string;
  thinking: string;
}

/** A parsed model-overrides line: `{ ok: true; fields }` or `{ ok: false; error }`. */
type ParseRoleModelLine =
  | { ok: true; fields: RoleModelFields }
  | { ok: false; error: string };

/** Parse a Ctrl+X model-overrides line into its triple. The line is whitespace-separated
 * tokens: a bare token is the model (so today's single-token input keeps working), and
 * `provider=<value>`, `model=<value>` and `thinking=<level>` set those fields explicitly.
 * A field the line leaves out stays `""` — the caller clears it. A second model token (a
 * second bare token, or a bare token plus `model=`, or a repeated `model=`), any other
 * repeated field, a `key=` that names no field of the triple (the error names the three
 * accepted keys), or an empty value such as `thinking=` is an input error. */
export function parseRoleModelLine(line: string): ParseRoleModelLine {
  const tokens = line.trim().split(/\s+/).filter((t) => t.length > 0);
  const fields: RoleModelFields = { provider: "", model: "", thinking: "" };
  for (const token of tokens) {
    const eq = token.indexOf("=");
    // A bare token IS the model; `model=<value>` is the explicit spelling of the same slot.
    const key = eq === -1 ? "model" : token.slice(0, eq);
    const value = eq === -1 ? token : token.slice(eq + 1);
    if (key !== "provider" && key !== "model" && key !== "thinking")
      return {
        ok: false,
        error: `unknown key ${key}: only provider, model and thinking are accepted`,
      };
    if (value === "") return { ok: false, error: `${key}= needs a value` };
    if (fields[key] !== "")
      return {
        ok: false,
        error:
          key === "model"
            ? "the model may be given only once (a bare token or model=, not both or twice)"
            : `repeated ${key}=`,
      };
    fields[key] = value;
  }
  return { ok: true, fields };
}

/** Format a triple as the Ctrl+X line's pre-fill, the inverse of parseRoleModelLine: the model
 * first as a bare token, then `provider=…` then `thinking=…`, each only when set. */
export function formatRoleModelLine(fields: RoleModelFields): string {
  const parts: string[] = [];
  if (fields.model) parts.push(fields.model);
  if (fields.provider) parts.push(`provider=${fields.provider}`);
  if (fields.thinking) parts.push(`thinking=${fields.thinking}`);
  return parts.join(" ");
}

/** The Ctrl+X role-model editor on the Transcript view's shared prompt line, the terminal twin
 * of `tumwater role <id> --model` / `--provider` / `--thinking` and the dashboard role
 * drawer's Model overrides editor. Enter parses the whole triple on one line and writes all
 * three through the shared setRoleModelFields the CLI and the drawer use — so validateConfig's
 * triple check owns the values (a bad thinking level writes nothing and flashes with the editor
 * still open). A field the line leaves out is cleared, and an empty line clears all three.
 * `backend` stays out of the line and is never touched. Pre-fill reads the FILE's raw
 * `roles.<base>.provider` / `.model` / `.thinking`: overlayDefaults seeds every built-in role's
 * model from the catalog, so the merged value cannot tell an operator override from a seeded
 * default (and the seed is not offered as a pre-fill). On the notes view Ctrl+X keeps its
 * clear-notes meaning, and on every non-Transcript view it falls through to its own pane arms
 * (the backlog cancel, the queued cancel, the Health retire). The shape it shares with the
 * instances and interval editors lives in createRoleKeyEditor. */
export function createRoleModelEditor(session: TuiEditorSession): TuiEditorModule {
  return createRoleKeyEditor(session, {
    mode: "roleModel",
    openCtrl: "x",
    yieldsOn: (ctx) => ctx.noteMode,
    prefill: (s, base) => {
      const provider = rawRoleField(s.root, base, "provider");
      const model = rawRoleField(s.root, base, "model");
      const thinking = rawRoleField(s.root, base, "thinking");
      return formatRoleModelLine({
        provider: typeof provider === "string" ? provider : "",
        model: typeof model === "string" ? model : "",
        thinking: typeof thinking === "string" ? thinking : "",
      });
    },
    openFlash: (role) =>
      `edit ${role}'s model overrides (model, provider=<provider>, thinking=<level>; a field you leave out is cleared, an empty line clears all): Enter to save, Esc to cancel`,
    commit: (s, base, text) => {
      const parsed = parseRoleModelLine(text);
      if (!parsed.ok) return parsed;
      // The line IS the whole triple: a field it leaves out is "" and thus cleared, an empty
      // field string deletes the file key, and clearing the last override removes roles.<base>
      // (the setter's rule). `undefined` is never used, so `backend` is never touched.
      const { provider, model, thinking } = parsed.fields;
      const result = setRoleModelFields(s.root, base, { provider, model, thinking });
      if (result.ok && result.unchanged) return { ok: true, noop: true };
      return result;
    },
    savedFlash: (role, text) => {
      const parsed = parseRoleModelLine(text);
      if (!parsed.ok) return `${role}: model overrides saved`;
      const { provider, model, thinking } = parsed.fields;
      const set: string[] = [];
      if (model) set.push(`model ${model}`);
      if (provider) set.push(`provider ${provider}`);
      if (thinking) set.push(`thinking ${thinking}`);
      if (set.length === 0) return `${role}: all model overrides cleared`;
      const rest = set.length === 3 ? "" : "; the rest cleared";
      return `${role}: model overrides set to ${set.join(", ")}${rest}`;
    },
    noopFlash: (role) => `${role}: no model override changed`,
  });
}
