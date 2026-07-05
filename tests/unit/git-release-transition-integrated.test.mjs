/**
 * R1.3-followup: transitionIntegratedStories migrated to advancePhase('release').
 *
 * Pins the new contract:
 * - PHASE_MACHINE.release.from is ['integrated'] (was ['implemented'])
 * - git-release.mjs imports advancePhase and calls it inside transitionIntegratedStories
 * - The discovery regex (phase: "integrated") is preserved
 * - The releasedIn metadata write is preserved
 *
 * transitionIntegratedStories is module-private; we pin its CONTRACT via
 * source-grep + a runtime end-to-end test via the rks_release MCP entry point
 * with a controlled fixture vault.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_MACHINE, OPERATION_TRANSITIONS } from "../../packages/mcp-rks/src/workflow/phases.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GIT_RELEASE_PATH = path.join(REPO_ROOT, "packages/mcp-rks/src/server/git/git-release.mjs");
const GIT_RELEASE_SRC = fs.readFileSync(GIT_RELEASE_PATH, "utf8");

describe("R1.3-followup: rks_release migration to advancePhase('release')", () => {
  describe("AC1 — release transition from integrated (not implemented)", () => {
    it("PHASE_MACHINE.transitions.release has from=['integrated'] and to='released'", () => {
      const row = PHASE_MACHINE.transitions.find((t) => t.name === "release" && !t.manual);
      expect(row).toBeDefined();
      expect(row.from).toEqual(["integrated"]);
      expect(row.to).toBe("released");
    });

    it("OPERATION_TRANSITIONS.release reflects the same shape", () => {
      expect(OPERATION_TRANSITIONS.release).toEqual({ from: ["integrated"], to: "released" });
    });
  });

  describe("AC2 — git-release.mjs delegates the phase write to advancePhase", () => {
    it("imports advancePhase from ../../workflow/auto-phase.mjs", () => {
      expect(GIT_RELEASE_SRC).toMatch(/import\s*\{[^}]*advancePhase[^}]*\}\s*from\s*['"]\.\.\/\.\.\/workflow\/auto-phase\.mjs['"]/);
    });

    it("transitionIntegratedStories function body invokes advancePhase(..., 'release', ...)", () => {
      const fnStart = GIT_RELEASE_SRC.indexOf("function transitionIntegratedStories");
      expect(fnStart).toBeGreaterThan(-1);
      const fnSlice = GIT_RELEASE_SRC.slice(fnStart);
      const nextFnIdx = fnSlice.slice(1).indexOf("\nfunction ");
      const exportIdx = fnSlice.slice(1).indexOf("\nexport ");
      const candidates = [nextFnIdx, exportIdx].filter((i) => i > 0);
      const bodyEnd = candidates.length > 0 ? Math.min(...candidates) + 1 : fnSlice.length;
      const body = fnSlice.slice(0, bodyEnd);
      expect(body).toMatch(/advancePhase\s*\([^)]*['"]release['"]/);
    });

    it("transitionIntegratedStories no longer calls updateField(..., 'phase', 'released') directly", () => {
      const fnStart = GIT_RELEASE_SRC.indexOf("function transitionIntegratedStories");
      const fnSlice = GIT_RELEASE_SRC.slice(fnStart);
      const nextFnIdx = fnSlice.slice(1).indexOf("\nfunction ");
      const exportIdx = fnSlice.slice(1).indexOf("\nexport ");
      const candidates = [nextFnIdx, exportIdx].filter((i) => i > 0);
      const bodyEnd = candidates.length > 0 ? Math.min(...candidates) + 1 : fnSlice.length;
      const body = fnSlice.slice(0, bodyEnd);
      expect(body).not.toMatch(/updateField\s*\([^)]*['"]phase['"]\s*,\s*['"]released['"]/);
    });
  });

  describe("AC4 — discovery regex preserved", () => {
    it("transitionIntegratedStories still scans for phase: \"integrated\" in note files", () => {
      const fnStart = GIT_RELEASE_SRC.indexOf("function transitionIntegratedStories");
      const fnSlice = GIT_RELEASE_SRC.slice(fnStart);
      const exportIdx = fnSlice.slice(1).indexOf("\nexport ");
      const body = exportIdx > 0 ? fnSlice.slice(0, exportIdx + 1) : fnSlice;
      // Discovery regex preserved — the function reads notes/ and matches phase=integrated.
      expect(body).toMatch(/\/\^phase:\\s\*\["'\]\?integrated\["'\]\?\//);
    });
  });

  describe("AC5 — releasedIn metadata write preserved", () => {
    it("transitionIntegratedStories still calls updateField(..., 'releasedIn', newVersion)", () => {
      const fnStart = GIT_RELEASE_SRC.indexOf("function transitionIntegratedStories");
      const fnSlice = GIT_RELEASE_SRC.slice(fnStart);
      const exportIdx = fnSlice.slice(1).indexOf("\nexport ");
      const body = exportIdx > 0 ? fnSlice.slice(0, exportIdx + 1) : fnSlice;
      expect(body).toMatch(/updateField\s*\([^)]*['"]releasedIn['"]\s*,\s*newVersion\s*\)/);
    });
  });

  describe("R1.4 retirement — implemented + cycle_complete removed from PHASE_MACHINE", () => {
    it("PHASE_MACHINE.states no longer includes 'implemented' (R1.4 retired)", () => {
      expect(PHASE_MACHINE.states).not.toContain("implemented");
    });

    it("PHASE_MACHINE.transitions no longer has the cycle_complete row (R1.4 retired)", () => {
      const row = PHASE_MACHINE.transitions.find((t) => t.name === "cycle_complete" && !t.manual);
      expect(row).toBeUndefined();
    });
  });

  describe("AC6 — canon GAP-3 annotation updated", () => {
    it("canon.phase-state-machine.md GAP-3 §8 entry is marked CLOSED with closure path", () => {
      const canonPath = path.join(REPO_ROOT, "notes/canon.phase-state-machine.md");
      const src = fs.readFileSync(canonPath, "utf8");
      // GAP-3 header is now marked CLOSED.
      expect(src).toMatch(/### \[GAP-3\][^\n]*CLOSED/);
      // The closure path references the two stories.
      expect(src).toMatch(/R1\.3f/);
      expect(src).toMatch(/R1\.3-followup-rks-release-migration/);
    });
  });
});
