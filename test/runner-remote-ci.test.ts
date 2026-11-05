/** The Remote CI slice of the runner e2e suite (plans/remote-ci.md "Shape"): the `ci` healer's
 * fresh prompt ends with the Remote CI block when the base branch's remote is on GitHub and the
 * repo has a workflow file, and is byte-identical to today's prompt without a GitHub remote. Like
 * every runner suite file it runs in its own process (fakePi's global PATH swap requires it) and
 * its top-level tests run sequentially within it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRoleRunner } from "./fixtures/runner-fixtures.js";
import { readRemoteCi } from "../src/observer/remote-ci.js";
import { initializedRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { logPromptsTo, withPi } from "./fakes/fake-pi.js";
import { APPROVE_PI, assistantLine } from "./fixtures/pi-events.js";

function withGitHubRemote(repo: string): void {
  const workflows = path.join(repo, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(path.join(workflows, "ci.yml"), "name: ci\n");
  sh(repo, "git", "remote", "add", "origin", "https://github.com/znation/tumwater.git");
}

test("the ci healer's fresh prompt carries the Remote CI block on a GitHub remote", async () => {
  const repo = await initializedRepo();
  withGitHubRemote(repo);
  const promptsFile = path.join(tmpdir(), "prompts.log");
  const marker = path.join(tmpdir(), "pi-invoked");
  await withPi(
    [
      logPromptsTo(promptsFile),
      APPROVE_PI,
      `printf '%s\\n' '${assistantLine("done\\nSUMMARY: verified main", { tokens: 10, output: 10, cost: 0.01 })}'`,
      `echo hello > hello.txt`,
      `touch '${marker}'`,
    ].join("\n"),
    async () => {
      await makeRoleRunner(repo, "ci").run();
      assert.ok(fs.existsSync(marker), "its pi run started");

      const run = fs.readFileSync(promptsFile, "utf8");
      assert.ok(run.includes("Remote CI (GitHub Actions on znation/tumwater, branch main; from this team's own record):"),
        "the run prompt names the repo and branch");
      assert.ok(run.includes("no result recorded yet"), "…with no record yet");
      assert.ok(
        run.includes("gh run list --repo znation/tumwater --branch main --event push --limit 20 --json headSha,status,conclusion,workflowName,databaseId,url,createdAt"),
        "…and the read-only gh run list command",
      );
    },
  );
});

test("a ci prompt without a GitHub remote carries no Remote CI block", async () => {
  const repo = await initializedRepo();
  // A workflow file but no remote: detection returns null and the prompt is unchanged.
  const workflows = path.join(repo, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(path.join(workflows, "ci.yml"), "name: ci\n");
  const promptsFile = path.join(tmpdir(), "prompts.log");
  const marker = path.join(tmpdir(), "pi-invoked");
  await withPi(
    [
      logPromptsTo(promptsFile),
      APPROVE_PI,
      `printf '%s\\n' '${assistantLine("done\\nSUMMARY: verified main", { tokens: 10, output: 10, cost: 0.01 })}'`,
      `echo hello > hello.txt`,
      `touch '${marker}'`,
    ].join("\n"),
    async () => {
      await makeRoleRunner(repo, "ci").run();
      assert.ok(fs.existsSync(marker), "its pi run started");
      const run = fs.readFileSync(promptsFile, "utf8");
      assert.ok(!run.includes("Remote CI (GitHub Actions"), "no remote, no block");
    },
  );
});

test("a block-less ci reply's REMOTE line records nothing even if a target appears mid-run", async () => {
  const repo = await initializedRepo();
  // No remote or workflow when the prompt is built, so the prompt carries no Remote CI block.
  // The shim creates both while pi runs: a re-resolution after the run would now find a target,
  // but the reply's REMOTE line still belongs to a run the harness never asked to check CI.
  const workflow = path.join(repo, ".github", "workflows");
  const script = [
    `printf '%s\\n' '${assistantLine("done\\nREMOTE: 3e450b0c4 — passed\\nTUMWATER_NOTHING_TO_DO")}'`,
    `mkdir -p '${workflow}'`,
    `printf 'name: ci\\n' > '${path.join(workflow, "ci.yml")}'`,
    `git -C '${repo}' remote add origin https://github.com/znation/tumwater.git`,
  ].join("\n");
  await withPi(script, async () => {
    const outcome = await makeRoleRunner(repo, "ci").run();
    assert.equal(outcome.result, "no_change");
    assert.equal(readRemoteCi(repo), null, "a block-less reply records no remote verdict");
  });
});
