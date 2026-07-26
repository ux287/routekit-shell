import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import { runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeStory(projectRoot, id, phase, extra = "") {
  const notesDir = path.join(projectRoot, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  const targetFile = "src/dummy.mjs";
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, targetFile), "export const x = 1;\n");
  const content = [
    "---",
    `id: "${id}"`,
    `title: "Test Story"`,
    `phase: "${phase}"`,
    "multiFileAcknowledged: true",
    "testRequirements:",
    '  - "something"',
    "targetFiles:",
    `  - path: "${targetFile}"`,
    '    op: "edit"',
    "---",
    "",
    "## Problem",
    "Problem.",
    "",
    "## Solution",
    "Solution.",
    "",
    "## Acceptance Criteria",
    "- [ ] It works",
    "",
    `## Target Files`,
    `- \`${targetFile}\` — EDIT`,
    "",
    "@@SEARCH",
    "export const x = 1;",
    "@@REPLACE",
    "export const x = 2;",
    "@@END",
    extra,
  ].join("\n");
  fs.writeFileSync(path.join(notesDir, `${id}.md`), content);
  return { projectRoot, targetFile };
}

describe("plan-ready phase gate", () => {
  it("accepts phase 'ready' — no phase_status issue", async () => {
    const projectRoot = makeTempDir("plan-ready-ready");
    dirs.push(projectRoot);
    makeStory(projectRoot, "backlog.feat.test", "ready");

    const result = await runPlanReadyTool({
      projectId: "test",
      problemId: "backlog.feat.test",
      projectRoot,
    });

    const phaseIssue = result.issues.find(i => i.check === "phase_status");
    expect(phaseIssue).toBeUndefined();
  });

  it("accepts phase 'arch-approved' — no phase_status issue", async () => {
    const projectRoot = makeTempDir("plan-ready-arch");
    dirs.push(projectRoot);
    makeStory(projectRoot, "backlog.feat.test", "arch-approved");

    const result = await runPlanReadyTool({
      projectId: "test",
      problemId: "backlog.feat.test",
      projectRoot,
    });

    const phaseIssue = result.issues.find(i => i.check === "phase_status");
    expect(phaseIssue).toBeUndefined();
  });

  it("rejects phase 'draft' — adds phase_status issue blocking planning", async () => {
    const projectRoot = makeTempDir("plan-ready-draft");
    dirs.push(projectRoot);
    makeStory(projectRoot, "backlog.feat.test", "draft");

    const result = await runPlanReadyTool({
      projectId: "test",
      problemId: "backlog.feat.test",
      projectRoot,
    });

    const phaseIssue = result.issues.find(i => i.check === "phase_status");
    expect(phaseIssue).toBeDefined();
    expect(phaseIssue.currentPhase).toBe("draft");
  });

  it("rejects unknown phase — adds phase_status issue", async () => {
    const projectRoot = makeTempDir("plan-ready-unknown");
    dirs.push(projectRoot);
    makeStory(projectRoot, "backlog.feat.test", "pending-review");

    const result = await runPlanReadyTool({
      projectId: "test",
      problemId: "backlog.feat.test",
      projectRoot,
    });

    const phaseIssue = result.issues.find(i => i.check === "phase_status");
    expect(phaseIssue).toBeDefined();
  });

  it("self-heals a STALE 'executing' phase (no live run) — resets to arch-approved, no phase issue", async () => {
    const projectRoot = makeTempDir("plan-ready-selfheal");
    dirs.push(projectRoot);
    makeStory(projectRoot, "backlog.feat.stale", "executing");

    const result = await runPlanReadyTool({
      projectId: "test",
      problemId: "backlog.feat.stale",
      projectRoot,
    });

    expect(result.issues.find(i => i.check === "phase_status")).toBeUndefined();
    expect(result.currentPhase).toBe("arch-approved");
    expect(result.warnings.some(w => w.check === "stale_executing_self_heal")).toBe(true);
    // frontmatter reset on disk
    const note = fs.readFileSync(path.join(projectRoot, "notes", "backlog.feat.stale.md"), "utf8");
    expect(note).toMatch(/^phase:\s*["']?arch-approved["']?\s*$/m);
  });

  it("does NOT self-heal 'executing' when a live exec run exists — keeps the phase rejection", async () => {
    const projectRoot = makeTempDir("plan-ready-liverun");
    dirs.push(projectRoot);
    makeStory(projectRoot, "backlog.feat.live", "executing");
    // a live (incomplete) exec run for THIS story
    const runDir = path.join(projectRoot, ".rks", "runs", "2026-run_live");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "exec-state.json"),
      JSON.stringify({ currentPhase: "applyingSteps", storyId: "backlog.feat.live", completedSteps: [], startedAt: new Date().toISOString() }),
    );

    const result = await runPlanReadyTool({
      projectId: "test",
      problemId: "backlog.feat.live",
      projectRoot,
    });

    expect(result.issues.find(i => i.check === "phase_status")).toBeDefined();
    // phase NOT reset — a live exec must not be clobbered
    const note = fs.readFileSync(path.join(projectRoot, "notes", "backlog.feat.live.md"), "utf8");
    expect(note).toMatch(/^phase:\s*["']?executing["']?\s*$/m);
  });
});
