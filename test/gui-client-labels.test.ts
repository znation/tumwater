import { test } from "node:test";
import assert from "node:assert/strict";
import { clientScope } from "./helpers/gui-client-scope.js";
import { EVENT_TYPE_LABELS, RUN_RESULT_LABELS, eventTypeLabel } from "../src/events/event-labels.js";
import { ROLES } from "../src/roles/role-catalog.js";
import { roleLabel, roleTitle } from "../src/roles/role-labels.js";

interface Twins {
  roleLabel(id: string): string;
  roleTitle(id: string): string;
  eventTypeLabel(code: string): string;
}

test("the dashboard's label helpers answer exactly as the server's do", () => {
  const c = clientScope<Twins>(["labels"], ["roleLabel", "roleTitle", "eventTypeLabel"]);
  const ids = [...ROLES.map((r) => r.id), "director", "feature-2", "bugfix-10", "feature-1", "nightly", "nightly-2", "constructor"];
  for (const id of ids) {
    assert.equal(c.roleLabel(id), roleLabel(id), `roleLabel ${id}`);
    assert.equal(c.roleTitle(id), roleTitle(id), `roleTitle ${id}`);
  }
  const codes = [...Object.keys(EVENT_TYPE_LABELS), ...Object.keys(RUN_RESULT_LABELS), "some_unknown_code", "constructor"];
  for (const code of codes) assert.equal(c.eventTypeLabel(code), eventTypeLabel(code), `eventTypeLabel ${code}`);
});
