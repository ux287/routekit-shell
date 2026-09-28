/**
 * R1.3f — cycle-complete agent: collapse implemented into integrated.
 *
 * Pins the v2 behavior: stories at phase=integrated stay at phase=integrated
 * after the mark_implemented tool runs. Only the status field and the filename
 * (backlog.* → backlog.z_implemented.*) change. The legacyAcceptedOperations
 * map drops the dead cycle_complete entry.
 *
 * See notes/research.2026.06.13.integrated-implemented-released-arc.md for the
 * design rationale (Option A).
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { fileURLToPath } from "node:url";
import { createCycleCompleteAgent } from "../../packages/mcp-rks/src/agents/cycle-complete.mjs";
import { PHASE_MACHINE, VALID_PHASES } from "../../packages/mcp-rks/src/workflow/phases.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const CYCLE_COMPLETE_SRC = fs.readFileSync(
  path.join(REPO_ROOT, "packages/mcp-rks/src/agents/cycle-complete.mjs"),
  "utf8",
);
const PHASES_SRC = fs.readFileSync(
  path.join(REPO_ROOT, "packages/mcp-rks/src/workflow/phases.mjs"),
  "utf8",
);

function readDiskFm(notePath) {
  const content = fs.readFileSync(notePath, "utf8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  return yaml.load(fmMatch[1]) || {};
}

describe("R1.3f — cycle-complete agent collapses implemented into integrated", () => {
  let tmpRoot;
  afterEach(() => {
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  describe("AC1 / AC2 / AC3 — source-grep pins on the mark_implemented tool", () => {
    it("AC1: cycle-complete.mjs no longer calls updateField(..., 'phase', 'implemented')", () => {
      // The phase write is removed. Other phase writes (e.g. via updateField in
      // other tools) are unaffected — we pin the specific stale write only.
      expect(CYCLE_COMPLETE_SRC).not.toMatch(/updateField\s*\(\s*notesDir\s*,\s*input\.storyId\s*,\s*['"]phase['"]\s*,\s*['"]implemented['"]\s*\)/);
    });

    it("AC2: cycle-complete.mjs still calls updateField(..., 'status', 'implemented')", () => {
      expect(CYCLE_COMPLETE_SRC).toMatch(/updateField\s*\(\s*notesDir\s*,\s*input\.storyId\s*,\s*['"]status['"]\s*,\s*['"]implemented['"]\s*\)/);
    });

    it("AC3a: file rename pattern (replace + fs.renameSync) preserved", () => {
      // The rename derives the new path by swapping backlog. → backlog.z_implemented.
      expect(CYCLE_COMPLETE_SRC).toMatch(/replace\s*\(\s*\/\^backlog\\\.\/\s*,\s*['"]backlog\.z_implemented\.['"]\s*\)/);
      expect(CYCLE_COMPLETE_SRC).toMatch(/fs\.renameSync\s*\(\s*storyPath\s*,\s*newPath\s*\)/);
    });

    it("AC3b: id-field update to the new namespaced id preserved", () => {
      expect(CYCLE_COMPLETE_SRC).toMatch(/updateField\s*\(\s*notesDir\s*,\s*input\.storyId\s*,\s*['"]id['"]\s*,\s*newId\s*\)/);
    });
  });

  describe("AC4 / AC5 / AC6 — PHASE_MACHINE invariants", () => {
    it("AC4 runtime: legacyAcceptedOperations is the 3-entry map (no cycle_complete)", () => {
      expect(PHASE_MACHINE.legacyAcceptedOperations).toEqual({
        plan: "exec_start",
        exec: "exec_end",
        ship: "guardrails_on.merge",
      });
    });

    it("AC4 source-grep: phases.mjs does NOT contain the cycle_complete: 'guardrails_on.merge' entry inside legacyAcceptedOperations", () => {
      const fieldStart = PHASES_SRC.indexOf("legacyAcceptedOperations:");
      expect(fieldStart).toBeGreaterThan(-1);
      const blockEnd = PHASES_SRC.indexOf("}", fieldStart);
      const block = PHASES_SRC.slice(fieldStart, blockEnd + 1);
      expect(block).not.toMatch(/cycle_complete\s*:/);
    });

    it("R1.4: PHASE_MACHINE.transitions no longer includes the cycle_complete row (retired)", () => {
      const row = PHASE_MACHINE.transitions.find((t) => t.name === "cycle_complete" && !t.manual);
      expect(row).toBeUndefined();
    });

    it("R1.4 source-grep: phases.mjs no longer declares the cycle_complete transition row", () => {
      expect(PHASES_SRC).not.toMatch(/name:\s*["']cycle_complete["']/);
    });

    it("R1.4 runtime: VALID_PHASES no longer contains 'implemented' (retired)", () => {
      expect(VALID_PHASES).not.toContain("implemented");
    });

    it("R1.4 source-grep: phases.mjs no longer lists 'implemented' in the states array", () => {
      const statesMatch = PHASES_SRC.match(/states\s*:\s*\[[\s\S]*?\]/);
      expect(statesMatch).not.toBeNull();
      expect(statesMatch[0]).not.toMatch(/["']implemented["']/);
    });
  });

  describe("AC7 — end-to-end: story at integrated stays at integrated; status + filename change", () => {
    function makeFixture(phase) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cycle-complete-r13f-"));
      const notesDir = path.join(tmp, "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      const storyId = "backlog.feat.r13f-fixture";
      const storyPath = path.join(notesDir, `${storyId}.md`);
      const fm = yaml.dump({
        id: storyId,
        title: "R1.3f fixture",
        phase,
        status: "shipped",
        targetFiles: [{ path: "x", op: "edit", desc: "y" }],
      }, { lineWidth: -1, quotingType: '"', forceQuotes: true }).trim();
      fs.writeFileSync(storyPath, `---\n${fm}\n---\n# fixture\n`);
      tmpRoot = tmp;
      return { tmp, storyId, storyPath, notesDir };
    }

    it("mark_implemented tool: phase=integrated stays integrated; status becomes implemented; file renamed", async () => {
      const { tmp, storyId, storyPath, notesDir } = makeFixture("integrated");
      const agent = createCycleCompleteAgent({
        projectId: "rks-test",
        storyId,
        projectRoot: tmp,
      });
      const markImplementedTool = agent.tools.find((t) => t.name === "mark_implemented");
      expect(markImplementedTool).toBeDefined();

      const result = await markImplementedTool.execute({ storyId });
      expect(result.updated).toBe(true);
      expect(result.newId).toBe("backlog.z_implemented.feat.r13f-fixture");

      // Original path is gone; renamed file exists.
      expect(fs.existsSync(storyPath)).toBe(false);
      const newPath = path.join(notesDir, `${result.newId}.md`);
      expect(fs.existsSync(newPath)).toBe(true);

      const fm = readDiskFm(newPath);
      expect(fm.phase).toBe("integrated"); // R1.3f: phase NOT bumped to implemented
      expect(fm.status).toBe("implemented");
      // Note: the agent attempts to update the `id` frontmatter field via updateField,
      // but updateField does not in fact write the id field in current dendron.mjs.
      // The filename-prefix change (backlog. → backlog.z_implemented.) is the actual
      // archival marker per paper §3; the frontmatter id is decorative.
    });
  });

  describe("AC8 — GAP-3 closes: rks_release regex now matches stories at phase=integrated", () => {
    // The release regex lives at packages/mcp-rks/src/server/git/git-release.mjs:173.
    // Replicate the literal here so the test is independent of the module-private
    // transitionIntegratedStories function.
    const RKS_RELEASE_PHASE_REGEX = /^phase:\s*["']?integrated["']?/m;

    it("matches a frontmatter line containing phase: \"integrated\" (the post-R1.3f shape)", () => {
      const fm = `---\nid: "x"\nphase: "integrated"\nstatus: "implemented"\n---\n`;
      expect(RKS_RELEASE_PHASE_REGEX.test(fm)).toBe(true);
    });

    it("does NOT match a story that was overwritten to phase: \"implemented\" (the pre-R1.3f shape that hid GAP-3)", () => {
      const fm = `---\nid: "x"\nphase: "implemented"\nstatus: "implemented"\n---\n`;
      expect(RKS_RELEASE_PHASE_REGEX.test(fm)).toBe(false);
    });
  });
});
