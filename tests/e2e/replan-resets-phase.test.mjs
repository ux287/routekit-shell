/**
 * P0-3 behavioral coverage (e2e tier — gated behind RKS_E2E_ENABLED).
 *
 * A bare re-plan resets a story at planned/executing/executed back to arch-approved
 * before exec_start, so re-planning re-lands at executing instead of state_transition_failed.
 *
 * Lives in the e2e tier (NOT tests/unit) because it drives runPlanTool end-to-end, which
 * triggers live RAG embedding — integration-weight, must stay out of the unit shard.
 * (The lightweight source/import guards live in tests/unit/replan-resets-phase.test.mjs.)
 *
 * Story: backlog.fix.replan-resets-phase-test-misplaced-in-unit-tier
 * Determinism via RKS_SKIP_LLM=1; throwaway child gitignores .rks/.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runPlanTool } from "../../packages/mcp-rks/src/server/planner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const registryPath = path.join(repoRoot, "projects", "index.jsonl");

function git(cwd, args) {
  execSync(`git ${args}`, { cwd, stdio: "pipe", timeout: 30000 });
}

function readPhase(projectRoot, storyId) {
  const p = path.join(projectRoot, "notes", `${storyId}.md`);
  const m = fs.readFileSync(p, "utf8").match(/^phase:\s*["']?([a-z-]+)["']?\s*$/m);
  return m ? m[1] : null;
}

function setPhase(projectRoot, storyId, phase) {
  const p = path.join(projectRoot, "notes", `${storyId}.md`);
  const c = fs.readFileSync(p, "utf8").replace(/^phase:\s*["']?[a-z-]+["']?\s*$/m, `phase: "${phase}"`);
  fs.writeFileSync(p, c);
}

function setupChild() {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectId = `e2e-replan-${stamp}`;
  const projectRoot = path.join(repoRoot, `.tmp-replan-${stamp}`);
  fs.mkdirSync(path.join(projectRoot, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "routekit", "project.json"),
    JSON.stringify({ id: projectId, baseBranch: "staging", kgFile: "routekit/kg.yaml" }, null, 2),
  );
  fs.writeFileSync(path.join(projectRoot, "routekit", "kg.yaml"), "code_roots: [src]\n");
  fs.writeFileSync(path.join(projectRoot, "src", "example.js"), 'export const value = "before";\n');
  fs.writeFileSync(path.join(projectRoot, ".gitignore"), ".rks/\n");
  const storyId = "backlog.feat.replan-smoke";
  fs.writeFileSync(
    path.join(projectRoot, "notes", `${storyId}.md`),
    `---
id: "${storyId}"
title: "Replan smoke"
desc: "fixture"
phase: "arch-approved"
testExempt: true
targetFiles:
  - path: "src/example.js"
    op: "edit"
    desc: "flip"
---

## Acceptance Criteria

- [ ] flipped

### src/example.js
@@SEARCH
export const value = "before";
@@REPLACE
export const value = "after";
@@END
`,
  );
  git(projectRoot, "init -q");
  git(projectRoot, "config user.email test@example.com");
  git(projectRoot, "config user.name 'Test User'");
  git(projectRoot, "checkout -q -b staging");
  git(projectRoot, "add -A");
  git(projectRoot, "commit -q -m chore:baseline");
  const record = { id: projectId, root: projectRoot };
  const existing = fs.existsSync(registryPath)
    ? fs.readFileSync(registryPath, "utf8").trim().split("\n").filter(Boolean)
    : [];
  fs.writeFileSync(registryPath, [...existing, JSON.stringify(record)].join("\n") + "\n");
  return { projectId, projectRoot, storyId };
}

describe("P0-3: re-plan resets phase before exec_start (behavioral)", () => {
  let originalRegistry = null;
  let originalSkipLlm;
  const cleanupPaths = [];

  beforeEach(() => {
    originalRegistry = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, "utf8") : null;
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    originalSkipLlm = process.env.RKS_SKIP_LLM;
    process.env.RKS_SKIP_LLM = "1";
  });

  afterEach(() => {
    if (originalRegistry !== null) fs.writeFileSync(registryPath, originalRegistry);
    else if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    if (originalSkipLlm === undefined) delete process.env.RKS_SKIP_LLM; else process.env.RKS_SKIP_LLM = originalSkipLlm;
    for (const p of cleanupPaths.splice(0)) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("first-plan from arch-approved reaches executing (reset is a no-op)", async () => {
    const { projectId, projectRoot, storyId } = setupChild();
    cleanupPaths.push(projectRoot);
    const plan = await runPlanTool({ projectId, problemId: storyId, autoEmbed: false });
    expect(plan.ok).toBe(true);
    expect(readPhase(projectRoot, storyId)).toBe("executing");
  });

  it("re-plan from planned re-lands executing (no state_transition_failed)", async () => {
    const { projectId, projectRoot, storyId } = setupChild();
    cleanupPaths.push(projectRoot);
    setPhase(projectRoot, storyId, "planned");
    const plan = await runPlanTool({ projectId, problemId: storyId, autoEmbed: false });
    expect(plan.error).not.toBe("state_transition_failed");
    expect(plan.ok).toBe(true);
    expect(readPhase(projectRoot, storyId)).toBe("executing");
  });

  it("re-plan from executed re-lands executing (no state_transition_failed)", async () => {
    const { projectId, projectRoot, storyId } = setupChild();
    cleanupPaths.push(projectRoot);
    setPhase(projectRoot, storyId, "executed");
    const plan = await runPlanTool({ projectId, problemId: storyId, autoEmbed: false });
    expect(plan.error).not.toBe("state_transition_failed");
    expect(plan.ok).toBe(true);
    expect(readPhase(projectRoot, storyId)).toBe("executing");
  });
});
