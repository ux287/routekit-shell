import assert from "node:assert";
import { describe, it } from "node:test";
import { isTestFixStory } from "../src/server/test-runner.mjs";

// backlog.fix.exec-test-gate-blocks-test-infra-bootstrap
//
// rks.exec's pre-apply baseline-test gate bypasses for test-fix stories via isTestFixStory().
// A test-INFRA bootstrap story (installs vitest + creates the config/setup) can't pass a baseline
// that fails precisely because the framework isn't installed yet — it was hard-blocked, forcing a
// manual skipTests. The predicate now also detects bootstrap from the story's frontmatter
// targetFiles (survives a dropped create_file step) + an explicit id token, kept NARROW so an
// ordinary failing story is still gated.

describe("isTestFixStory — test-infra bootstrap detection", () => {
  it("detects bootstrap from frontmatter targetFiles (vitest.config) even when the plan dropped the create steps", () => {
    // plan.steps has ONLY the package.json edit (the planner-drop case); the creates survive in frontmatter targetFiles
    const plan = { problemId: "backlog.calc.testing", steps: [{ action: "search_replace", path: "package.json" }] };
    const targetFiles = [
      { path: "package.json", op: "edit" },
      { path: "vitest.config.ts", op: "create" },
      { path: "src/test/smoke.test.ts", op: "create" },
    ];
    assert.strictEqual(isTestFixStory(plan, targetFiles), true);
  });

  it("detects bootstrap from a test-setup id token", () => {
    const plan = { problemId: "backlog.calc.test-setup", steps: [{ action: "search_replace", path: "package.json" }] };
    assert.strictEqual(isTestFixStory(plan, [{ path: "package.json", op: "edit" }]), true);
  });

  it("detects a jest.setup config target too", () => {
    const plan = { problemId: "backlog.proj.add-jest", steps: [] };
    assert.strictEqual(isTestFixStory(plan, ["config/jest.config.js"]), true);
  });

  it("does NOT bypass a normal story with ordinary source targetFiles (still gated)", () => {
    const plan = { problemId: "backlog.feat.add-widget", steps: [{ action: "search_replace", path: "src/widget.js" }] };
    const targetFiles = [{ path: "src/widget.js", op: "edit" }, { path: "README.md", op: "edit" }];
    assert.strictEqual(isTestFixStory(plan, targetFiles), false);
  });

  it("does NOT treat a non-test .config file as a bootstrap trigger", () => {
    assert.strictEqual(isTestFixStory({ problemId: "backlog.feat.cfg", steps: [] }, [{ path: "src/app.config.ts", op: "create" }]), false);
  });

  it("preserves the existing fix&&test id heuristic", () => {
    assert.strictEqual(isTestFixStory({ problemId: "backlog.fix.flaky-test" }, null), true);
  });

  it("preserves the existing targetsTests (plan-steps) heuristic", () => {
    const plan = { problemId: "backlog.fix.thing", steps: [{ action: "create_file", path: "tests/unit/foo.test.mjs" }] };
    assert.strictEqual(isTestFixStory(plan, null), true);
  });

  it("is backward compatible with no targetFiles argument", () => {
    assert.strictEqual(isTestFixStory({ problemId: "backlog.feat.x", steps: [] }), false);
    assert.strictEqual(isTestFixStory({ problemId: "backlog.feat.x", steps: [] }, undefined), false);
  });
});
