import test from "node:test";
import assert from "node:assert/strict";
import {
  entryListDetail,
  openRoleActions,
  openBacklogAction,
  listRoles,
  listRoleIds,
  stuckDetail,
  localizeInstants,
  type AlertRole,
} from "../src/ui/team-alert-shared.js";
import { formatTimestamp } from "../src/text/datetime.js";

// team-alert-shared.ts: the pure composition helpers the per-domain team-alert builders share,
// so their wording (separators, role labels, the role-list and backlog-button shapes, the
// stuck-detail and instant-localization rules) cannot drift between the alert modules.

test("entryListDetail strips the stamp, and names the extra count", () => {
  // A single present title is returned stripped of its trailing `(planned …)` stamp.
  assert.equal(entryListDetail(["Install better colors (planned 2026-11-01)"]), "Install better colors");
  // Multiple titles keep the first (stripped) plus the `— and N more` count.
  assert.equal(
    entryListDetail(["Alpha (filed 2026-11-02)", "Beta (planned 2026-11-03)", "Gamma"]),
    "Alpha — and 2 more",
  );
  // An empty list yields the empty string the caller renders as no detail.
  assert.equal(entryListDetail([]), "");
});

test("openRoleActions caps to three buttons and labels through roleLabel", () => {
  const actions = openRoleActions([{ role: "ci" }, { role: "feature-2" }, { role: "plan" }, { role: "bugfix" }]);
  assert.equal(actions.length, 3, "the banner never overflows with more than three buttons");
  assert.deepEqual(actions, [
    { label: "Open CI", act: "role", arg: "ci" },
    { label: "Open feature #2", act: "role", arg: "feature-2" },
    { label: "Open plan", act: "role", arg: "plan" },
  ]);
  assert.deepEqual(openRoleActions([]), [], "no roles means no buttons");
});

test("openBacklogAction encodes file:index for the dashboard's backlog card", () => {
  assert.deepEqual(openBacklogAction({ file: "plans", index: 3 }), [
    { label: "Open backlog", act: "backlog", arg: "plans:3" },
  ]);
  assert.deepEqual(openBacklogAction({ file: "bugs", index: 0 }), [
    { label: "Open backlog", act: "backlog", arg: "bugs:0" },
  ]);
});

const roleRow = (role: string): AlertRole => ({
  role,
  phase: "due",
  errorStreak: false,
  inFlight: false,
});

test("listRoles joins with and, commas, and Oxford comma", () => {
  assert.equal(listRoles([roleRow("ci")]), "CI");
  assert.equal(listRoles([roleRow("feature"), roleRow("plan")]), "feature and plan");
  assert.equal(
    listRoles([roleRow("feature"), roleRow("plan"), roleRow("bugfix")]),
    "feature, plan, and bugfix",
  );
  // roleLabel is applied to every member, so CI renders its special label, and an
  // instance id via `-N`.
  assert.equal(listRoles([roleRow("ci"), roleRow("feature-2")]), "CI and feature #2");
});

test("listRoleIds names every held id even a stale one no live role matches", () => {
  assert.equal(listRoleIds([]), "");
  assert.equal(listRoleIds(["feature"]), "feature");
  assert.equal(listRoleIds(["feature", "plan", "feature-2"]), "feature, plan, and feature #2");
  // A stale id still renders through roleLabel rather than being dropped.
  assert.equal(listRoleIds(["stale-role"]), "stale-role");
});

test("stuckDetail appends the silence span only to a tool-call stall on a live tail", () => {
  const toolStall: AlertRole = { role: "plan", phase: "tool call stalled, waiting on the provider", errorStreak: false, inFlight: true, stuckMs: 17 * 60_000 };
  assert.equal(stuckDetail(toolStall), "plan: tool call stalled, waiting on the provider for 17m00s");
  // No stuckMs (caller holds no live tail): the phrase is returned without a duration suffix.
  assert.equal(stuckDetail({ ...toolStall, stuckMs: undefined }), "plan: tool call stalled, waiting on the provider");
  // A no-model-reply phrase carries its own duration, so no suffix is appended.
  assert.equal(
    stuckDetail({ role: "feature", phase: "no model reply for 47m31s (2 attempts)", errorStreak: false, inFlight: true, stuckMs: 5 * 60_000 }),
    "feature: no model reply for 47m31s (2 attempts)",
  );
  // Empty cause yields just the role label (the caller joins these with ` · `).
  assert.equal(stuckDetail({ role: "ci", phase: "working", errorStreak: false, inFlight: true }), "CI: ");
});

test("localizeInstants rewrites an ISO instant in local time and leaves other text", () => {
  const iso = "2026-11-12T03:30:00Z";
  assert.equal(localizeInstants(`restart cooldown ends ${iso}`), `restart cooldown ends ${formatTimestamp(Date.parse(iso))}`);
  // Text without a full UTC instant is untouched.
  assert.equal(localizeInstants("no deadline here"), "no deadline here");
  // A fractional-second instant is matched too (the fraction stays part of the matched span).
  const fracIso = "2026-11-12T03:30:00.250Z";
  assert.equal(localizeInstants(fracIso), formatTimestamp(Date.parse(fracIso)));
});
