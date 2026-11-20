/**
 * Companion story: refine-apply-resets-phase-to-arch-approved
 *
 * Asserts that rks_refine_apply writes phase=arch-approved on non-decompose
 * amendments and leaves the decompose path unchanged (parent → "decomposed").
 * Pins source-grep guards on refine.mjs and planner-persistence.mjs, plus
 * PHASE_MACHINE invariants and governor-build.md presence.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import yaml from "js-yaml";
import { makeTempDir, writeFile, ensureDir } from "../helpers/tmp.mjs";
import { runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";
import { OPERATION_TRANSITIONS, PHASE_MACHINE } from "../../packages/mcp-rks/src/workflow/phases.mjs";

const REPO_ROOT = path.resolve(process.cwd());
const REFINE_PATH = path.join(REPO_ROOT, "packages", "mcp-rks", "src", "server", "refine.mjs");
const PERSISTENCE_PATH = path.join(REPO_ROOT, "packages", "mcp-rks", "src", "server", "planner-persistence.mjs");
const PHASES_PATH = path.join(REPO_ROOT, "packages", "mcp-rks", "src", "workflow", "phases.mjs");
const GOVERNOR_BUILD_PATH = path.join(REPO_ROOT, ".rks", "prompts", "governor-build.md");

function readDiskFm(storyPath) {
  const content = fs.readFileSync(storyPath, "utf8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  return yaml.load(fmMatch[1]) || {};
}

function makeStory(projectRoot, problemId, fm) {
  const body = "\n# " + (fm.title || problemId) + "\n\n## Problem\n\nNeed to fix something in src/target.mjs.\n";
  const content = "---\n" + yaml.dump(fm, { lineWidth: -1, quotingType: '"', forceQuotes: true }).trim() + "\n---\n" + body;
  writeFile(path.join(projectRoot, "notes", problemId + ".md"), content);
}

describe("refine_apply: non-decompose writes phase=arch-approved", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_apply_phase");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
    writeFile(path.join(projectRoot, "src", "target.mjs"), "// target file");
  });

  describe("AC1.a / AC3.a / AC3.b / AC8.a — source-grep pins", () => {
    it("refine.mjs non-decompose branch sets phase to arch-approved before the writeback", () => {
      const src = fs.readFileSync(REFINE_PATH, "utf8");
      // Find the decompose-branch early return marker and the non-decompose writeback marker.
      const decomposeReturnIdx = src.indexOf("decomposed: true,\n          problemId: problemId");
      const writebackIdx = src.indexOf('await fs.writeFile(storyPath, updatedContent, "utf8")');
      expect(decomposeReturnIdx, "decompose-branch early return marker missing").toBeGreaterThan(-1);
      expect(writebackIdx, "non-decompose writeback marker missing").toBeGreaterThan(-1);
      expect(writebackIdx).toBeGreaterThan(decomposeReturnIdx);

      const nonDecomposeWindow = src.slice(decomposeReturnIdx, writebackIdx);
      // Tolerant of single/double quotes per AC1.a.
      expect(nonDecomposeWindow).toMatch(/\.phase\s*=\s*["']arch-approved["']/);
    });

    it("refine.mjs decompose branch still writes phase=decomposed and does NOT write arch-approved", () => {
      const src = fs.readFileSync(REFINE_PATH, "utf8");
      const decomposeOpenIdx = src.indexOf('if (type === "decompose")');
      const decomposeReturnIdx = src.indexOf("decomposed: true,\n          problemId: problemId");
      expect(decomposeOpenIdx).toBeGreaterThan(-1);
      expect(decomposeReturnIdx).toBeGreaterThan(decomposeOpenIdx);

      const decomposeWindow = src.slice(decomposeOpenIdx, decomposeReturnIdx);
      expect(decomposeWindow).toMatch(/parentFm\.phase\s*=\s*["']decomposed["']/);
      expect(decomposeWindow).not.toMatch(/arch-approved/);
    });

    it("planner-persistence.mjs no longer contains the synthetic { phase: 'ready', targetFiles } stub", () => {
      // AC3 invariant: the synthetic stub is removed. Companion shipped the
      // initial replacement (on-disk phase read). R1.3e then delegated the
      // entire validateTransition site to advancePhase("exec_start"), so the
      // call moved out of persistAndFinalize. Pin the underlying invariant —
      // the synthetic literal pattern is absent from the file.
      const src = fs.readFileSync(PERSISTENCE_PATH, "utf8");
      expect(src).not.toMatch(/phase:\s*["']ready["']\s*,\s*targetFiles/);
    });

    it("PHASE_MACHINE.transitions['plan'] from-array and legacyAcceptedOperations.plan are unchanged", () => {
      // AC8.b: runtime introspection.
      const planOp = OPERATION_TRANSITIONS.plan;
      expect(planOp).toBeDefined();
      expect(new Set(planOp.from)).toEqual(new Set(["ready", "arch-approved", "planned", "executed"]));
      expect(planOp.to).toBe("planned");
      expect(PHASE_MACHINE.legacyAcceptedOperations.plan).toBe("exec_start");

      // AC8.a: source-grep guard against silent edits.
      const src = fs.readFileSync(PHASES_PATH, "utf8");
      expect(src).toMatch(/name:\s*["']plan["']/);
      expect(src).toMatch(/legacyAcceptedOperations:\s*\{[\s\S]*?plan:\s*["']exec_start["']/);
    });
  });

  describe("AC1.b / AC1.c — non-decompose runtime", () => {
    it("story at phase=planned ends at phase=arch-approved after add_target_files", async () => {
      const problemId = "test.non-decompose-planned";
      makeStory(projectRoot, problemId, {
        id: problemId,
        title: "Non-decompose from planned",
        phase: "planned",
        targetFiles: [{ path: "src/target.mjs", op: "edit", desc: "Modify target file" }],
      });

      const applyResult = await runRefineApplyTool({
        projectRoot,
        problemId,
        refinements: [{ type: "clarify_ac", data: { criteria: ["Target is modified correctly"] } }],
      });
      expect(applyResult.ok).toBe(true);
      expect(applyResult.decomposed).toBeFalsy();

      const fm = readDiskFm(path.join(projectRoot, "notes", problemId + ".md"));
      expect(fm.phase).toBe("arch-approved");
    });

    it("story at phase=executed ends at phase=arch-approved after non-decompose amendment", async () => {
      const problemId = "test.non-decompose-executed";
      makeStory(projectRoot, problemId, {
        id: problemId,
        title: "Non-decompose from executed",
        phase: "executed",
        targetFiles: [{ path: "src/target.mjs", op: "edit", desc: "Modify target file" }],
      });

      const applyResult = await runRefineApplyTool({
        projectRoot,
        problemId,
        refinements: [{ type: "clarify_ac", data: { criteria: ["AC clarified after exec failure"] } }],
      });
      expect(applyResult.ok).toBe(true);
      expect(applyResult.decomposed).toBeFalsy();

      const fm = readDiskFm(path.join(projectRoot, "notes", problemId + ".md"));
      expect(fm.phase).toBe("arch-approved");
    });
  });

  describe("AC2.b / AC5.a / AC5.b — decompose path preserved", () => {
    it("decompose refinement leaves parent at phase=decomposed and creates children", async () => {
      const problemId = "test.decompose-preserved";
      // Need enough ACs to trigger decomposition (>maxPerChild = 4 by default).
      const acLines = Array.from({ length: 12 }, (_, i) => "- [ ] AC" + (i + 1) + ": criterion " + (i + 1)).join("\n");
      const body = "\n# Decompose Preserved\n\n## Acceptance Criteria\n\n" + acLines + "\n";
      const fmYaml = yaml.dump({
        id: problemId,
        title: "Parent for decompose",
        phase: "planned",
        targetFiles: [{ path: "src/target.mjs", op: "edit", desc: "target" }],
      }, { lineWidth: -1, quotingType: '"', forceQuotes: true }).trim();
      writeFile(path.join(projectRoot, "notes", problemId + ".md"), "---\n" + fmYaml + "\n---\n" + body);

      const applyResult = await runRefineApplyTool({
        projectRoot,
        problemId,
        refinements: [{
          type: "decompose",
          data: {
            maxAcPerChild: 4,
            children: [
              { slug: "first-half", independentValue: true },
              { slug: "second-half", independentValue: true },
              { slug: "third-part", independentValue: true },
            ],
          },
        }],
      });

      // DECOMPOSE-PRESERVATION GATE: confirm we actually exercised the decompose branch.
      expect(applyResult.ok).toBe(true);
      expect(applyResult.decomposed).toBe(true);

      const parentFm = readDiskFm(path.join(projectRoot, "notes", problemId + ".md"));
      expect(parentFm.phase).toBe("decomposed");
      expect(parentFm.decomposed).toBe(true);
      expect(Array.isArray(parentFm.childStories)).toBe(true);
      expect(parentFm.childStories.length).toBeGreaterThan(0);

      // AC5.b: each child was created with phase from the decompose loop (currently "draft"),
      // NOT accidentally set to "arch-approved" by the new non-decompose write.
      for (const childId of parentFm.childStories) {
        const childFm = readDiskFm(path.join(projectRoot, "notes", childId + ".md"));
        expect(childFm.phase).not.toBe("arch-approved");
      }
    });
  });

  describe("AC6.a — governor-build.md presence check", () => {
    it("governor-build.md still contains the refine and re-plan instructions", () => {
      const src = fs.readFileSync(GOVERNOR_BUILD_PATH, "utf8");
      expect(src).toContain("rks_refine_apply");
      expect(src).toContain("rks_plan");
      expect(src).toMatch(/Re-plan/i);
    });
  });
});
