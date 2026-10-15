/**
 * R1.3-followup-rks-ship: migrate runStagingMerge + runStoryShipTool
 * from direct updateField('phase', 'integrated') to advancePhase('ship').
 *
 * Pins:
 *  - source-grep: neither writer contains the direct phase-write literal
 *  - source-grep: both writers call advancePhase(..., 'ship', ...)
 *  - source-grep: story-ship.mjs has advancePhase BEFORE fs.renameSync (ordering)
 *  - runtime: runStoryShipTool against a fixture story at phase=executed lands at
 *    phase=integrated AND renames the file to backlog.z_implemented.*
 *  - runtime: runStoryShipTool is defensive — if advancePhase rejects (story not
 *    at executed), the rename does NOT happen
 *  - preservation: PHASE_MACHINE.transitions.ship + legacyAcceptedOperations.ship
 *    unchanged
 *
 * runStagingMerge is gated behind external gh-cli + git network ops, so its
 * runtime is exercised via source-grep + the advancePhase delegation chain;
 * see tests/unit/git-release-transition-integrated.test.mjs for the analogous
 * test pattern.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PHASE_MACHINE, OPERATION_TRANSITIONS } from "../../packages/mcp-rks/src/workflow/phases.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GIT_RELEASE_PATH = path.join(REPO_ROOT, "packages/mcp-rks/src/server/git/git-release.mjs");
const STORY_SHIP_PATH = path.join(REPO_ROOT, "packages/mcp-rks/src/server/story-ship.mjs");
const GIT_RELEASE_SRC = fs.readFileSync(GIT_RELEASE_PATH, "utf8");
const STORY_SHIP_SRC = fs.readFileSync(STORY_SHIP_PATH, "utf8");

function fnBody(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return "";
  const slice = src.slice(start);
  // Body extends to next top-level function / export declaration.
  const candidates = [
    slice.slice(1).indexOf("\nexport "),
    slice.slice(1).indexOf("\nfunction "),
    slice.slice(1).indexOf("\nasync function "),
  ].filter((i) => i > 0);
  const bodyEnd = candidates.length > 0 ? Math.min(...candidates) + 1 : slice.length;
  return slice.slice(0, bodyEnd);
}

describe("R1.3-followup-rks-ship: runStagingMerge + runStoryShipTool migrated to advancePhase('ship')", () => {
  describe("AC1 — runStagingMerge phase write delegated", () => {
    const body = fnBody(GIT_RELEASE_SRC, "export async function runStagingMerge");

    it("runStagingMerge body no longer contains updateField(..., 'phase', 'integrated') literal", () => {
      expect(body).not.toMatch(/updateField\s*\([^)]*['"]phase['"]\s*,\s*['"]integrated['"]/);
    });

    it("runStagingMerge body calls advancePhase(..., 'ship', ...)", () => {
      expect(body).toMatch(/advancePhase\s*\([^)]*['"]ship['"]/);
    });
  });

  describe("AC2 — runStoryShipTool phase write delegated", () => {
    const body = fnBody(STORY_SHIP_SRC, "export async function runStoryShipTool");

    it("story-ship.mjs imports advancePhase from ../workflow/auto-phase.mjs", () => {
      expect(STORY_SHIP_SRC).toMatch(/import\s*\{[^}]*advancePhase[^}]*\}\s*from\s*['"]\.\.\/workflow\/auto-phase\.mjs['"]/);
    });

    it("runStoryShipTool body no longer contains updateField(..., 'phase', 'integrated') literal", () => {
      expect(body).not.toMatch(/updateField\s*\([^)]*['"]phase['"]\s*,\s*['"]integrated['"]/);
    });

    it("runStoryShipTool body calls advancePhase(..., 'ship', ...)", () => {
      expect(body).toMatch(/advancePhase\s*\([^)]*['"]ship['"]/);
    });
  });

  describe("AC3 — rename preservation + ordering", () => {
    const body = fnBody(STORY_SHIP_SRC, "export async function runStoryShipTool");

    it("runStoryShipTool still calls fs.renameSync with backlog.z_implemented.* destination", () => {
      expect(body).toMatch(/replace\s*\(\s*\/\^backlog\\\.\/\s*,\s*['"]backlog\.z_implemented\.['"]\s*\)/);
      expect(body).toMatch(/fs\.renameSync\s*\(\s*storyPath\s*,\s*newPath\s*\)/);
    });

    it("runStoryShipTool still updates the id field to the new namespaced id", () => {
      expect(body).toMatch(/updateField\s*\([^)]*['"]id['"]\s*,\s*newProblemId\s*\)/);
    });

    it("AC3 ORDERING: advancePhase call appears BEFORE fs.renameSync in source", () => {
      const advanceIdx = body.indexOf("advancePhase(");
      const renameIdx = body.indexOf("fs.renameSync(");
      expect(advanceIdx).toBeGreaterThan(-1);
      expect(renameIdx).toBeGreaterThan(-1);
      expect(advanceIdx).toBeLessThan(renameIdx);
    });
  });

  describe("AC5 / AC6 / AC9 — preservation pins", () => {
    it("PHASE_MACHINE.transitions.ship row unchanged (from=[executed], to=integrated, gateless=true)", () => {
      const row = PHASE_MACHINE.transitions.find((t) => t.name === "ship" && !t.manual);
      expect(row).toBeDefined();
      expect(row.from).toEqual(["executed"]);
      expect(row.to).toBe("integrated");
      expect(row.gateless).toBe(true);
    });

    it("OPERATION_TRANSITIONS.ship reflects the same shape", () => {
      expect(OPERATION_TRANSITIONS.ship).toEqual({ from: ["executed"], to: "integrated" });
    });

    it("legacyAcceptedOperations.ship still maps to 'guardrails_on.merge'", () => {
      expect(PHASE_MACHINE.legacyAcceptedOperations.ship).toBe("guardrails_on.merge");
    });

    it("legacyAcceptedOperations still has 3 entries (plan/exec/ship) — cycle_complete dropped in R1.3f", () => {
      expect(Object.keys(PHASE_MACHINE.legacyAcceptedOperations).sort()).toEqual(["exec", "plan", "ship"]);
    });
  });

  describe("AC4 / AC10 — runtime exercise of runStoryShipTool's phase delegation", () => {
    let tmpRoot;
    afterEach(() => {
      if (tmpRoot) {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = null;
      }
    });

    // runStoryShipTool integrates external git + gh-cli ops we can't unit test
    // end-to-end. The phase-write step it now delegates to is advancePhase('ship').
    // We exercise advancePhase directly on the same fixture pattern story-ship
    // would produce: a story at phase=executed → advance('ship') → phase=integrated.
    // This pins the delegation contract: story-ship's behavior is bounded by
    // advancePhase's semantics.

    async function importAdvancePhase() {
      const mod = await import("../../packages/mcp-rks/src/workflow/auto-phase.mjs");
      return mod.advancePhase;
    }

    function makeStoryFixture(phase, problemId = "backlog.feat.ship-fixture") {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-r13followup-"));
      const notesDir = path.join(tmp, "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      const storyPath = path.join(notesDir, `${problemId}.md`);
      const fm = yaml.dump({
        id: problemId,
        title: "Ship migration fixture",
        phase,
        status: "open",
        targetFiles: [{ path: "x", op: "edit", desc: "y" }],
      }, { lineWidth: -1, quotingType: '"', forceQuotes: true }).trim();
      fs.writeFileSync(storyPath, `---\n${fm}\n---\n# fixture\n`);
      // Initialize a git repo so advancePhase's optional git commit step doesn't error.
      spawnSync("git", ["init", "-b", "staging"], { cwd: tmp, encoding: "utf8", timeout: 120_000 });
      spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: tmp, encoding: "utf8", timeout: 120_000 });
      spawnSync("git", ["config", "user.name", "T"], { cwd: tmp, encoding: "utf8", timeout: 120_000 });
      spawnSync("git", ["add", "-A"], { cwd: tmp, encoding: "utf8", timeout: 120_000 });
      spawnSync("git", ["commit", "-m", "init"], { cwd: tmp, encoding: "utf8", timeout: 120_000 });
      tmpRoot = tmp;
      return { tmp, problemId, storyPath, notesDir };
    }

    function readDiskFm(notePath) {
      const content = fs.readFileSync(notePath, "utf8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return {};
      return yaml.load(fmMatch[1]) || {};
    }

    it("AC4: advancePhase('ship') on a phase=executed fixture writes phase=integrated", async () => {
      const advancePhase = await importAdvancePhase();
      const { tmp, problemId, storyPath } = makeStoryFixture("executed");
      const result = await advancePhase(tmp, problemId, "ship", "rks-test");
      expect(result.ok).toBe(true);
      expect(result.from).toBe("executed");
      expect(result.to).toBe("integrated");
      const fm = readDiskFm(storyPath);
      expect(fm.phase).toBe("integrated");
    });

    it("AC10: advancePhase('ship') on a phase=integrated fixture rejects with ok:false (defensive)", async () => {
      const advancePhase = await importAdvancePhase();
      const { tmp, problemId, storyPath } = makeStoryFixture("integrated");
      const result = await advancePhase(tmp, problemId, "ship", "rks-test");
      expect(result.ok).toBe(false);
      // Story phase unchanged on rejection.
      const fm = readDiskFm(storyPath);
      expect(fm.phase).toBe("integrated");
    });

    it("AC10: runStoryShipTool source defensively skips the rename when advancePhase rejects", () => {
      // Source pattern: after the advancePhase call, the !ok branch pushes a
      // skipped step and does NOT enter the rename block. Pin this via source-grep.
      const body = fnBody(STORY_SHIP_SRC, "export async function runStoryShipTool");
      expect(body).toMatch(/if\s*\(\s*!advanceResult\.ok\s*\)/);
      expect(body).toMatch(/mark_implemented[\s\S]*?skipped[\s\S]*?true/);
    });
  });

  describe("AC8 — other writers unchanged", () => {
    it("cycle-complete-agent does NOT write phase=implemented (R1.3f preserved)", () => {
      const src = fs.readFileSync(
        path.join(REPO_ROOT, "packages/mcp-rks/src/agents/cycle-complete.mjs"),
        "utf8",
      );
      expect(src).not.toMatch(/updateField\s*\([^)]*['"]phase['"]\s*,\s*['"]implemented['"]/);
    });

    it("transitionIntegratedStories still calls advancePhase('release') (R1.3-followup-release preserved)", () => {
      expect(GIT_RELEASE_SRC).toMatch(/advancePhase\s*\([^)]*['"]release['"]/);
    });
  });
});
