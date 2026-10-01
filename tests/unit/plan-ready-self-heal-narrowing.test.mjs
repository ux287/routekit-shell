/**
 * backlog.fix.plan-exec-start-phase-write-durability — stale_executing_self_heal narrowing.
 *
 * Once rks_plan lands a DURABLE arch-approved → executing transition, a story sits
 * legitimately at 'executing' for the whole window between plan and exec. An unnarrowed
 * self-heal resets it straight back — reopening the very deadlock this story closes.
 *
 * The narrowing must be STRICTLY ADDITIVE: it may only stop the reset in the new
 * legitimate case, never in the stranding cases the heal was written for. The pivot is
 * that "un-consumed" means the ABSENCE of exec-state.json, NOT the absence of a run
 * directory — findIncompleteRuns excludes terminal failed/aborted, so a rolled-back or
 * interrupted exec leaves liveRun false while still leaving exec-state.json on disk.
 *
 * TR13 and TR15 must be INDEPENDENTLY sensitive; if one mutation reddens both, the pair
 * proves nothing.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";

const STORY = "backlog.test-story";
const SLUG = STORY.replace(/\./g, "-");

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeProject({ runDir = null, planJson = false, execState = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-self-heal-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "notes", `${STORY}.md`),
    `---\nid: ${STORY}\ntitle: Test\nphase: "executing"\ntargetFiles:\n  - path: "src/a.mjs"\n    op: "edit"\ntestRequirements:\n  - "t"\n---\n\n## Problem\nx\n`,
  );
  if (runDir) {
    const rd = path.join(dir, ".rks", "runs", `${runDir}_${SLUG}`);
    fs.mkdirSync(rd, { recursive: true });
    if (planJson) fs.writeFileSync(path.join(rd, "plan.json"), JSON.stringify({ steps: [] }));
    if (execState) fs.writeFileSync(path.join(rd, "exec-state.json"), JSON.stringify(execState));
  }
  return dir;
}

const phaseOnDisk = (dir) => {
  const raw = fs.readFileSync(path.join(dir, "notes", `${STORY}.md`), "utf8");
  return raw.match(/^phase:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
};

const healed = (result) =>
  (result.warnings || []).some((w) => w.check === "stale_executing_self_heal");

async function planReady(projectRoot) {
  return runPlanReadyTool({ projectId: "test", problemId: STORY, projectRoot });
}

describe("stale_executing_self_heal — narrowed, not removed", () => {
  it("TR13: does NOT reset a story with a fresh, UN-CONSUMED plan run", async () => {
    // The new legitimate state: rks_plan landed executing, exec has not run yet.
    // Resetting here is what deadlocked the child.
    const dir = makeProject({ runDir: "2026-08-16T00-00-00-000Z", planJson: true, execState: null });

    const result = await planReady(dir);

    expect(healed(result)).toBe(false);
    expect(phaseOnDisk(dir)).toBe("executing");
  });

  it("TR14: DOES reset when there are no run directories at all", async () => {
    // Baseline stranding case — nothing has ever planned this story into a run.
    const dir = makeProject();

    const result = await planReady(dir);

    expect(healed(result)).toBe(true);
    expect(phaseOnDisk(dir)).toBe("arch-approved");
  });

  it("TR15: DOES reset when a run exists but was CONSUMED — terminal failed", async () => {
    // Test-failed rollback. findIncompleteRuns excludes `failed`, so liveRun is false and
    // the story really is stranded. Keying "un-consumed" off directory existence rather
    // than exec-state.json would misread this as fresh and strand it permanently.
    const dir = makeProject({
      runDir: "2026-08-16T00-00-00-000Z", planJson: true,
      execState: { storyId: STORY, currentPhase: "failed" },
    });

    const result = await planReady(dir);

    expect(healed(result)).toBe(true);
    expect(phaseOnDisk(dir)).toBe("arch-approved");
  });

  it("TR15: DOES reset when a run was CONSUMED — terminal aborted", async () => {
    const dir = makeProject({
      runDir: "2026-08-16T00-00-00-000Z", planJson: true,
      execState: { storyId: STORY, currentPhase: "aborted" },
    });

    const result = await planReady(dir);

    expect(healed(result)).toBe(true);
    expect(phaseOnDisk(dir)).toBe("arch-approved");
  });

  it("DOES reset when a run directory exists with no plan.json — nothing to protect", async () => {
    const dir = makeProject({ runDir: "2026-08-16T00-00-00-000Z", planJson: false });

    const result = await planReady(dir);

    expect(healed(result)).toBe(true);
    expect(phaseOnDisk(dir)).toBe("arch-approved");
  });

  it("ignores a fresh run belonging to a DIFFERENT story", async () => {
    const dir = makeProject();
    const rd = path.join(dir, ".rks", "runs", "2026-08-16T00-00-00-000Z_backlog-other-story");
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, "plan.json"), JSON.stringify({ steps: [] }));

    const result = await planReady(dir);

    expect(healed(result)).toBe(true);
    expect(phaseOnDisk(dir)).toBe("arch-approved");
  });
});
