/**
 * E2E Pipeline Bootstrap Smoke Harness
 *
 * Story: backlog.chore.e2e-pipeline-harness
 *
 * The campaign regression gate: a deterministic, headless proof that a fresh
 * project can be driven through the full build pipeline
 * (scaffold -> onboard -> story -> plan -> exec -> ship) and reach the
 * executed/integrated phase. Codifies the "fresh project builds an app" UAT.
 *
 * Determinism: RKS_SKIP_LLM=1 makes rks_plan run synchronously in-process
 * (server.mjs:1996-2029) and the LLM planner returns null (llm/planner.mjs:1225),
 * falling through to the deterministic @@SEARCH/@@REPLACE early-exit path
 * (planner.mjs:779-828) which converts story blocks directly to executable
 * search_replace steps. No live LLM, no network, no detached worker.
 *
 * Drive-from-outside: pipeline handlers resolve the project root from
 * projects/index.jsonl by projectId, not cwd (project-context.mjs), so the
 * harness registers a throwaway child and drives it by projectId.
 *
 * Keystone: a successful plan advances arch-approved -> executing (exec_start);
 * rks_exec gates on PHASE_GATE_EXEC === "executing" (phases.mjs) and advances
 * executing -> executed (exec_end); story_ship advances executed -> integrated.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runAnalyzeTool, runPlanTool } from "../../packages/mcp-rks/src/server/planner.mjs";
import { runExecTool } from "../../packages/mcp-rks/src/server/exec.mjs";
import { runStoryShipTool } from "../../packages/mcp-rks/src/server/story-ship.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const registryPath = path.join(repoRoot, "projects", "index.jsonl");

function git(cwd, args) {
  execSync(`git ${args}`, { cwd, stdio: "pipe", timeout: 30000 });
}

/** Read a story's current phase from frontmatter, tolerating the post-ship z_implemented rename. */
function readPhase(projectRoot, storyId) {
  const notesDir = path.join(projectRoot, "notes");
  const candidates = [
    path.join(notesDir, `${storyId}.md`),
    path.join(notesDir, `${storyId.replace(/^backlog\./, "backlog.z_implemented.")}.md`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, "utf8");
      const m = content.match(/^phase:\s*["']?([a-z-]+)["']?\s*$/m);
      return m ? m[1] : null;
    }
  }
  return null;
}

function writeStory(projectRoot, storyId, { executable }) {
  const notesDir = path.join(projectRoot, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  const body = executable
    ? `## Problem

Smoke story exercising the deterministic plan->exec->ship pipeline.

## Acceptance Criteria

- [ ] src/example.js value flipped from "before" to "after"

### src/example.js
@@SEARCH
export const value = "before";
@@REPLACE
export const value = "after";
@@END
`
    : `## Problem

A note-only story with no executable edit blocks. The deterministic planner
must NOT produce an executable plan from this; the negative control asserts the
harness fails loudly rather than passing vacuously.

## Acceptance Criteria

- [ ] Something happens (intentionally vague, no @@SEARCH/@@REPLACE blocks)
`;
  const content = `---
id: "${storyId}"
title: "Harness smoke (${executable ? "executable" : "note-only"})"
desc: "deterministic pipeline harness fixture"
phase: "arch-approved"
testExempt: true
targetFiles:
  - path: "src/example.js"
    op: "edit"
    desc: "flip the exported value"
---

${body}`;
  fs.writeFileSync(path.join(notesDir, `${storyId}.md`), content);
}

/** Scaffold + register a throwaway child project on a feature branch with a clean tree. */
function setupChild(tag) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectId = `e2e-pipeline-${tag}-${stamp}`;
  const projectRoot = path.join(repoRoot, `.tmp-e2e-pipeline-${stamp}`);

  fs.mkdirSync(path.join(projectRoot, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".rks", "state", projectId), { recursive: true });

  fs.writeFileSync(
    path.join(projectRoot, "routekit", "project.json"),
    JSON.stringify({ id: projectId, baseBranch: "staging", kgFile: "routekit/kg.yaml" }, null, 2),
  );
  fs.writeFileSync(path.join(projectRoot, "routekit", "kg.yaml"), "code_roots: [src]\n");
  fs.writeFileSync(path.join(projectRoot, "src", "example.js"), 'export const value = "before";\n');

  git(projectRoot, "init -q");
  git(projectRoot, "config user.email test@example.com");
  git(projectRoot, "config user.name 'Test User'");
  git(projectRoot, "checkout -q -b staging");
  git(projectRoot, "add -A");
  git(projectRoot, "commit -q -m chore:baseline");
  // Stay on the base branch (staging): rks_plan must run from the base branch,
  // and rks_exec creates the rks/<slug> feature branch itself (exec.mjs:479-505).

  // Register so handlers resolve the child by projectId (not cwd).
  const record = { id: projectId, root: projectRoot };
  const existing = fs.existsSync(registryPath)
    ? fs.readFileSync(registryPath, "utf8").trim().split("\n").filter(Boolean)
    : [];
  fs.writeFileSync(registryPath, [...existing, JSON.stringify(record)].join("\n") + "\n");

  return { projectId, projectRoot };
}

describe("E2E pipeline bootstrap smoke (RKS_SKIP_LLM=1)", () => {
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
    if (originalSkipLlm === undefined) delete process.env.RKS_SKIP_LLM;
    else process.env.RKS_SKIP_LLM = originalSkipLlm;
    for (const p of cleanupPaths.splice(0)) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  // Full-pipeline keystone gate: a successful deterministic plan must advance the
  // story arch-approved -> executing (the P0-1 keystone), then exec -> executed,
  // then ship -> integrated. (Unblocked by backlog.fix.planner-early-exit-status-not-executable.)
  it("drives a fresh project arch-approved -> executing -> executed -> integrated", async () => {
    const { projectId, projectRoot } = setupChild("happy");
    cleanupPaths.push(projectRoot);
    const storyId = "backlog.feat.harness-smoke";
    writeStory(projectRoot, storyId, { executable: true });

    // Onboard: analyze builds the codemap that runPlanTool requires.
    const analyze = await runAnalyzeTool({ projectId });
    expect(analyze.ok).toBe(true);
    // Commit onboarding artifacts so rks_plan sees a clean working tree.
    git(projectRoot, "add -A");
    git(projectRoot, "commit -q -m chore:onboard");

    // Plan (sync, deterministic) -> executable plan, phase advances to executing.
    const plan = await runPlanTool({ projectId, problemId: storyId, autoEmbed: false });
    expect(plan.ok).toBe(true);
    expect(plan.executable).toBe(true);
    expect(readPhase(projectRoot, storyId)).toBe("executing");

    // Commit the plan's run artifacts before exec. rks_exec resolves the plan from
    // .rks/runs/<slug>; in this synthetic in-process harness the untracked run dir is
    // not preserved across exec's git handling, so we commit it to represent a settled
    // post-plan state. (Whether on-rail exec should preserve an untracked run dir is a
    // separate exec-robustness question, tracked as a follow-up — not exercised here.)
    git(projectRoot, "add -A");
    git(projectRoot, "commit -q -m chore:plan");

    // Exec: gate accepts "executing", applies the plan, advances to executed.
    const exec = await runExecTool({ projectId, label: plan.slug, skipTests: true, autoCommit: true });
    expect(exec.ok).toBe(true);
    expect(readPhase(projectRoot, storyId)).toBe("executed");
    // The deterministic edit was actually applied.
    expect(fs.readFileSync(path.join(projectRoot, "src", "example.js"), "utf8")).toContain('"after"');

    // Ship: local merge (no remote), advances to integrated.
    const ship = await runStoryShipTool({ projectId, problemId: storyId });
    expect(ship.ok).toBe(true);
    expect(readPhase(projectRoot, storyId)).toBe("integrated");
  });

  it("negative control: a note-only story does NOT reach executed (no vacuous pass)", async () => {
    const { projectId, projectRoot } = setupChild("noteonly");
    cleanupPaths.push(projectRoot);
    const storyId = "backlog.feat.harness-noteonly";
    writeStory(projectRoot, storyId, { executable: false });

    const analyze = await runAnalyzeTool({ projectId });
    expect(analyze.ok).toBe(true);

    const plan = await runPlanTool({ projectId, problemId: storyId, autoEmbed: false });
    // Either the plan is non-executable, or exec refuses — but the story must NOT reach executed.
    expect(plan.executable).not.toBe(true);
    expect(readPhase(projectRoot, storyId)).not.toBe("executed");
  });
});
