// The reader of pi's own saved default (src/pi/pi-settings.ts): every settings file is written
// in a temp dir, so the reader never touches the host's real ~/.pi/agent — and the project-root
// override seam is exercised with its own temp project dir.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { piSettingsPath, readPiDefaultModel } from "../src/pi/pi-settings.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

function writeSettings(agentDir: string, body: unknown): string {
  const file = path.join(agentDir, "settings.json");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

test("piSettingsPath derives settings.json beside the models catalog", () => {
  assert.equal(piSettingsPath("/a/agent/models.json"), path.join("/a/agent", "settings.json"));
  assert.equal(piSettingsPath(path.join("x", "models.json")), path.join("x", "settings.json"));
});

test("readPiDefaultModel reads pi's saved default pair and its thinking", () => {
  const project = tmpdir("pi-default-project-");
  const file = writeSettings(tmpdir("pi-default-a-"), {
    defaultProvider: "prov",
    defaultModel: "org/m:route",
    defaultThinkingLevel: "low",
  });
  assert.deepEqual(readPiDefaultModel(file, project), { provider: "prov", model: "org/m:route", thinking: "low" });

  // A modelThinkingLevels entry for the exact pair wins over defaultThinkingLevel — pi's
  // precedence.
  const file2 = writeSettings(tmpdir("pi-default-b-"), {
    defaultProvider: "prov",
    defaultModel: "org/m:route",
    defaultThinkingLevel: "low",
    modelThinkingLevels: { "prov/org/m:route": "high" },
  });
  assert.deepEqual(readPiDefaultModel(file2, project), { provider: "prov", model: "org/m:route", thinking: "high" });
});

test("readPiDefaultModel reads as null when the saved default cannot be known", () => {
  const project = tmpdir("pi-default-null-project-");
  // A missing file.
  assert.equal(readPiDefaultModel(path.join(tmpdir("pi-null-missing-"), "settings.json"), project), null);
  // Malformed JSON.
  const malformed = path.join(tmpdir("pi-null-bad-"), "settings.json");
  writeFileDeep(malformed, "{ not json");
  assert.equal(readPiDefaultModel(malformed, project), null);
  // defaultModel without defaultProvider — pi uses a saved default only as a pair.
  assert.equal(
    readPiDefaultModel(writeSettings(tmpdir("pi-null-pair-"), { defaultModel: "org/m:route" }), project),
    null,
  );
  // enabledModels scoped: pi starts on the first scoped model, not the saved pair.
  assert.equal(
    readPiDefaultModel(
      writeSettings(tmpdir("pi-null-scoped-"), { defaultProvider: "prov", defaultModel: "org/m:route", enabledModels: ["x/*"] }),
      project,
    ),
    null,
  );
});

test("a project .pi/settings.json that names a default key makes the read null", () => {
  const settings = writeSettings(tmpdir("pi-override-settings-"), {
    defaultProvider: "prov",
    defaultModel: "org/m:route",
  });
  // A project override naming defaultModel: pi's final choice depends on whether it trusts the
  // project, so tumwater shows nothing.
  const overrideRoot = tmpdir("pi-override-project-");
  fs.mkdirSync(path.join(overrideRoot, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(overrideRoot, ".pi", "settings.json"), JSON.stringify({ defaultModel: "other/model" }));
  assert.equal(readPiDefaultModel(settings, overrideRoot), null);

  // A project override naming only `theme` leaves the result unchanged.
  const benignRoot = tmpdir("pi-override-benign-");
  fs.mkdirSync(path.join(benignRoot, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(benignRoot, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }));
  assert.deepEqual(readPiDefaultModel(settings, benignRoot), { provider: "prov", model: "org/m:route" });
});
