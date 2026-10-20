import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  publishInfoFields,
  readOrchestratorInfo,
  writeOrchestratorInfo,
  type OrchestratorInfo,
} from "../src/team/orchestrator-info.js";
import { orchestratorStatePath } from "../src/paths.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { warningMessages } from "./fixtures/log-fixtures.js";

/** The publish rules of src/team/orchestrator-info.ts's publishInfoFields: one write for a
 * changed batch, none for an unchanged one, and a warning instead of a throw on a failed write. */

function startInfo(root: string): OrchestratorInfo {
  const info: OrchestratorInfo = { pid: 1, startedAt: 2, roles: ["feature"] };
  writeOrchestratorInfo(root, info);
  return info;
}

test("publishInfoFields writes every field of a changed batch in one publish", () => {
  const root = tmpdir();
  const info = startInfo(root);
  const base = { pid: 1, startedAt: 2, roles: ["feature"] };
  assert.equal(
    publishInfoFields(root, info, [
      ["stopsAt", 5],
      ["slotPool", { leased: 1, limit: 2, waiting: 0 }],
    ]),
    true,
  );
  assert.deepEqual(readOrchestratorInfo(root), {
    ...base,
    stopsAt: 5,
    slotPool: { leased: 1, limit: 2, waiting: 0 },
  });
  publishInfoFields(root, info, [
    ["stopsAt", 5],
    ["slotPool", { leased: 2, limit: 2, waiting: 0 }],
  ]);
  assert.equal(readOrchestratorInfo(root)!.slotPool?.leased, 2);
});

test("publishInfoFields leaves the file untouched when no field changed", () => {
  const root = tmpdir();
  const info = startInfo(root);
  publishInfoFields(root, info, [
    ["stopsAt", 5],
    ["slotPool", { leased: 1, limit: 2, waiting: 0 }],
  ]);
  fs.rmSync(orchestratorStatePath(root));
  assert.equal(
    publishInfoFields(root, info, [
      ["stopsAt", 5],
      ["slotPool", { leased: 1, limit: 2, waiting: 0 }],
      ["disk", undefined],
    ]),
    false,
  );
  assert.equal(fs.existsSync(orchestratorStatePath(root)), false);
});

test("publishInfoFields removes a field published as undefined", () => {
  const root = tmpdir();
  const info = startInfo(root);
  publishInfoFields(root, info, [["slotPool", { leased: 1, limit: 2, waiting: 0 }]]);
  assert.equal(publishInfoFields(root, info, [["slotPool", undefined]]), true);
  assert.equal("slotPool" in readOrchestratorInfo(root)!, false);
});

test("publishInfoFields warns instead of throwing when the info file cannot be written", () => {
  const root = tmpdir();
  const info = startInfo(root);
  fs.rmSync(orchestratorStatePath(root));
  fs.mkdirSync(orchestratorStatePath(root));
  const publishes = (): string[] =>
    warningMessages(root).filter((m) => m.startsWith("could not publish orchestrator info: "));
  let result: boolean | undefined;
  assert.doesNotThrow(() => {
    result = publishInfoFields(root, info, [["stopsAt", 9]]);
  });
  assert.equal(result, true);
  assert.equal(info.stopsAt, 9);
  assert.equal(publishes().length, 1);
  assert.equal(publishInfoFields(root, info, [["stopsAt", 9]]), false);
  assert.equal(publishes().length, 1);
});
