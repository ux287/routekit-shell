/**
 * E2E: rks_plan auto-runs analyze when the codemap is missing (UAT finding F1).
 *
 * Story: backlog.feat.plan-auto-analyze-on-missing-codemap
 *
 * Before F1, runPlanTool threw "Run rks.analyze before planning." when no codemap
 * existed. Now it auto-runs analyze ONCE, re-reads, and proceeds — bounded to a single
 * attempt, with RKS_NO_AUTO_ANALYZE=1 preserving the legacy require-analyze-first error.
 *
 * Deterministic via RKS_SKIP_LLM=1 (sync, note-driven plan). The throwaway child
 * gitignores .rks/ so the auto-analyze artifacts don't trip the plan dirty-tree check.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runAnalyzeTool, runPlanTool } from "../../packages/mcp-rks/src/server/planner.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const registryPath = path.join(repoRoot, "projects", "index.jsonl");

function git(cwd, args) {
  execSync(`git ${args}`, { cwd, stdio: "pipe", timeout: 30000 });
}

function setupChild(tag) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectId = `e2e-autoanalyze-${tag}-${stamp}`;
  const projectRoot = path.join(repoRoot, `.tmp-e2e-autoanalyze-${stamp}`);

  fs.mkdirSync(path.join(projectRoot, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });

  fs.writeFileSync(
    path.join(projectRoot, "routekit", "project.json"),
    JSON.stringify({ id: projectId, baseBranch: "staging", kgFile: "routekit/kg.yaml" }, null, 2),
  );
  fs.writeFileSync(path.join(projectRoot, "routekit", "kg.yaml"), "code_roots: [src]\n");
  fs.writeFileSync(path.join(projectRoot, "src", "example.js"), 'export const value = "before";\n');
  // Gitignore .rks/ so the auto-analyze codemap/rag artifacts are invisible to the
  // plan dirty-tree preflight (codemap is still read from disk, not git).
  fs.writeFileSync(path.join(projectRoot, ".gitignore"), ".rks/\n");

  const storyId = "backlog.feat.autoanalyze-smoke";
  fs.writeFileSync(
    path.join(projectRoot, "notes", `${storyId}.md`),
    `---
id: "${storyId}"
title: "Auto-analyze smoke"
desc: "fixture"
phase: "arch-approved"
testExempt: true
targetFiles:
  - path: "src/example.js"
    op: "edit"
    desc: "flip value"
---

## Problem

Fixture for F1 auto-analyze.

## Acceptance Criteria

- [ ] value flipped

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

describe("rks_plan auto-analyze on missing codemap (F1)", () => {
  let originalRegistry = null;
  let originalSkipLlm;
  let originalNoAuto;
  const cleanupPaths = [];

  beforeEach(() => {
    originalRegistry = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, "utf8") : null;
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    originalSkipLlm = process.env.RKS_SKIP_LLM;
    originalNoAuto = process.env.RKS_NO_AUTO_ANALYZE;
    process.env.RKS_SKIP_LLM = "1";
    delete process.env.RKS_NO_AUTO_ANALYZE;
  });

  afterEach(() => {
    if (originalRegistry !== null) fs.writeFileSync(registryPath, originalRegistry);
    else if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    if (originalSkipLlm === undefined) delete process.env.RKS_SKIP_LLM; else process.env.RKS_SKIP_LLM = originalSkipLlm;
    if (originalNoAuto === undefined) delete process.env.RKS_NO_AUTO_ANALYZE; else process.env.RKS_NO_AUTO_ANALYZE = originalNoAuto;
    for (const p of cleanupPaths.splice(0)) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("auto-runs analyze and proceeds when no codemap exists (no 'Run rks.analyze' throw)", async () => {
    const { projectId, projectRoot, storyId } = setupChild("fires");
    cleanupPaths.push(projectRoot);

    // No explicit analyze. Plan must auto-analyze and produce an executable plan.
    const plan = await runPlanTool({ projectId, problemId: storyId, autoEmbed: false });
    expect(plan.ok).toBe(true);
    expect(plan.executable).toBe(true);
  });

  it("does NOT re-run analyze when a codemap already exists (no redundant work)", async () => {
    const { projectId, projectRoot, storyId } = setupChild("noredundant");
    cleanupPaths.push(projectRoot);

    const analyze = await runAnalyzeTool({ projectId });
    expect(analyze.ok).toBe(true);
    const codemapPath = analyze.codemapPath;
    const mtimeBefore = fs.statSync(codemapPath).mtimeMs;

    const plan = await runPlanTool({ projectId, problemId: storyId, autoEmbed: false });
    expect(plan.ok).toBe(true);
    // Codemap was not rewritten — analyze was not re-run.
    expect(fs.statSync(codemapPath).mtimeMs).toBe(mtimeBefore);
  });

  it("RKS_NO_AUTO_ANALYZE=1 preserves the legacy require-analyze-first error", async () => {
    const { projectId, projectRoot, storyId } = setupChild("optout");
    cleanupPaths.push(projectRoot);
    process.env.RKS_NO_AUTO_ANALYZE = "1";

    await expect(runPlanTool({ projectId, problemId: storyId, autoEmbed: false }))
      .rejects.toThrow(/Run rks\.analyze before planning/);
  });
});
