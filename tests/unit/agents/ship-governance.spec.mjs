/**
 * Tests for Ship Agent governance — config-driven shipping
 *
 * Verifies:
 * - baseBranch is NOT in ShipInputSchema (removed for governance)
 * - createShipAgent reads target from project config
 * - Ship Agent hard-rejects main/master targets
 * - PR title and branch derived from storyId
 *
 * @see backlog.agents.ship-agent-config-driven
 * @see backlog.agents.dispatcher-minimal-params
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { ShipInputSchema, createShipAgent } from "../../../packages/mcp-rks/src/agents/ship.mjs";
import { DeliveryInputSchema } from "../../../packages/mcp-rks/src/agents/delivery.mjs";

// Mock agent config loader
vi.mock("../../../packages/mcp-rks/src/agents/config.mjs", () => ({
  loadAgentConfig: () => ({
    model: "claude-sonnet-4-20250514",
    maxTurns: 8,
    timeoutMs: 120000,
    prompt: null,
  }),
}));

// Mock git-tools to avoid real git calls
vi.mock("../../../packages/mcp-rks/src/server/git-tools.mjs", () => ({
  runGitPR: vi.fn(),
  runStagingMerge: vi.fn(),
  runPromote: vi.fn(),
}));

// Mock git utils
vi.mock("../../../packages/mcp-rks/src/utils/git.mjs", () => ({
  runGit: vi.fn(),
}));

describe("Ship Agent governance", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("ShipInputSchema", () => {
    it("does NOT accept baseBranch parameter", () => {
      const shape = ShipInputSchema.shape;
      expect(shape.baseBranch).toBeUndefined();
    });

    it("requires only projectId", () => {
      const result = ShipInputSchema.safeParse({ projectId: "test" });
      expect(result.success).toBe(true);
    });

    it("accepts optional storyId", () => {
      const result = ShipInputSchema.safeParse({
        projectId: "test",
        storyId: "backlog.agents.my-story",
      });
      expect(result.success).toBe(true);
    });

    it("accepts optional title", () => {
      const result = ShipInputSchema.safeParse({
        projectId: "test",
        title: "Custom PR title",
      });
      expect(result.success).toBe(true);
    });

    it("rejects unknown properties in strict mode", () => {
      // baseBranch is stripped if passed, not causing a validation error in default Zod mode
      const result = ShipInputSchema.safeParse({
        projectId: "test",
        baseBranch: "main",
      });
      // In default Zod (strip), unknown keys are silently removed
      expect(result.success).toBe(true);
      expect(result.data.baseBranch).toBeUndefined();
    });
  });

  describe("DeliveryInputSchema", () => {
    it("does NOT accept baseBranch parameter", () => {
      const shape = DeliveryInputSchema.shape;
      expect(shape.baseBranch).toBeUndefined();
    });

    it("requires only projectId", () => {
      const result = DeliveryInputSchema.safeParse({ projectId: "test" });
      expect(result.success).toBe(true);
    });

    it("title is optional", () => {
      const result = DeliveryInputSchema.safeParse({ projectId: "test" });
      expect(result.success).toBe(true);
      expect(result.data.title).toBeUndefined();
    });
  });

  describe("createShipAgent — target branch resolution", () => {
    it("reads target branch from project config", () => {
      const rkDir = path.join(tmpDir, "routekit");
      fs.mkdirSync(rkDir, { recursive: true });
      fs.writeFileSync(
        path.join(rkDir, "project.json"),
        JSON.stringify({ id: "test", baseBranch: "staging" })
      );

      const config = createShipAgent({
        projectId: "test",
        projectRoot: tmpDir,
      });

      expect(config.name).toBe("ship");
      // The userMessage should contain the target branch
      expect(config.userMessage).toContain("staging");
      // Should have tools (not the error path)
      expect(config.tools.length).toBeGreaterThan(0);
    });

    it("hard-rejects main as target", () => {
      const rkDir = path.join(tmpDir, "routekit");
      fs.mkdirSync(rkDir, { recursive: true });
      fs.writeFileSync(
        path.join(rkDir, "project.json"),
        JSON.stringify({ id: "test", baseBranch: "main" })
      );

      const config = createShipAgent({
        projectId: "test",
        projectRoot: tmpDir,
      });

      // Returns a config that immediately fails
      expect(config.tools).toEqual([]);
      expect(config.maxTurns).toBe(1);
      expect(config.userMessage).toContain("main");
      expect(config.userMessage).toContain("production branch");
    });

    it("hard-rejects master as target", () => {
      const rkDir = path.join(tmpDir, "routekit");
      fs.mkdirSync(rkDir, { recursive: true });
      fs.writeFileSync(
        path.join(rkDir, "project.json"),
        JSON.stringify({ id: "test", baseBranch: "master" })
      );

      const config = createShipAgent({
        projectId: "test",
        projectRoot: tmpDir,
      });

      expect(config.tools).toEqual([]);
      expect(config.userMessage).toContain("master");
    });

    it("defaults to staging when no config exists", () => {
      const config = createShipAgent({
        projectId: "test",
        projectRoot: tmpDir,
      });

      expect(config.tools.length).toBeGreaterThan(0);
      expect(config.userMessage).toContain("staging");
    });
  });

  describe("createShipAgent — title/branch derivation", () => {
    it("derives PR title from story note", () => {
      const rkDir = path.join(tmpDir, "routekit");
      const notesDir = path.join(tmpDir, "notes");
      fs.mkdirSync(rkDir, { recursive: true });
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(
        path.join(rkDir, "project.json"),
        JSON.stringify({ id: "test", baseBranch: "staging" })
      );
      fs.writeFileSync(
        path.join(notesDir, "backlog.agents.my-feature.md"),
        `---\ntitle: 'Add cool feature'\nstatus: not-implemented\n---\n`
      );

      const config = createShipAgent({
        projectId: "test",
        storyId: "backlog.agents.my-feature",
        projectRoot: tmpDir,
      });

      // PR title should be derived from story note
      expect(config.userMessage).toContain("feat(agents): Add cool feature");
    });

    it("uses explicit title override when provided", () => {
      const rkDir = path.join(tmpDir, "routekit");
      fs.mkdirSync(rkDir, { recursive: true });
      fs.writeFileSync(
        path.join(rkDir, "project.json"),
        JSON.stringify({ id: "test", baseBranch: "staging" })
      );

      const config = createShipAgent({
        projectId: "test",
        title: "Custom Title Override",
        storyId: "backlog.agents.my-feature",
        projectRoot: tmpDir,
      });

      expect(config.userMessage).toContain("Custom Title Override");
    });

    it("falls back to generic title when no storyId or title", () => {
      const rkDir = path.join(tmpDir, "routekit");
      fs.mkdirSync(rkDir, { recursive: true });
      fs.writeFileSync(
        path.join(rkDir, "project.json"),
        JSON.stringify({ id: "my-proj", baseBranch: "staging" })
      );

      const config = createShipAgent({
        projectId: "my-proj",
        projectRoot: tmpDir,
      });

      expect(config.userMessage).toContain("ship my-proj changes");
    });

    it("includes storyId in user message when provided", () => {
      const rkDir = path.join(tmpDir, "routekit");
      fs.mkdirSync(rkDir, { recursive: true });
      fs.writeFileSync(
        path.join(rkDir, "project.json"),
        JSON.stringify({ id: "test", baseBranch: "staging" })
      );

      const config = createShipAgent({
        projectId: "test",
        storyId: "backlog.agents.tracked-story",
        projectRoot: tmpDir,
      });

      expect(config.userMessage).toContain("backlog.agents.tracked-story");
    });
  });
});
