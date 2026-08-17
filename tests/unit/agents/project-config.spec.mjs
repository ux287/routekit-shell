/**
 * Tests for project-config.mjs — config-driven governance
 *
 * @see backlog.agents.ship-agent-config-driven
 * @see backlog.agents.dispatcher-minimal-params
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  loadProjectConfig,
  resolveShipTarget,
  deriveBranchName,
  derivePrTitle,
  deriveCommitMessage,
} from "../../../packages/mcp-rks/src/agents/project-config.mjs";

describe("project-config", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadProjectConfig", () => {
    it("loads from .rks/project.json", () => {
      const rksDir = path.join(tmpDir, ".rks");
      fs.mkdirSync(rksDir, { recursive: true });
      fs.writeFileSync(
        path.join(rksDir, "project.json"),
        JSON.stringify({ id: "test-project", baseBranch: "staging" })
      );

      const config = loadProjectConfig(tmpDir);
      expect(config.id).toBe("test-project");
      expect(config.baseBranch).toBe("staging");
    });

    it("loads from routekit/project.json as fallback", () => {
      const rkDir = path.join(tmpDir, "routekit");
      fs.mkdirSync(rkDir, { recursive: true });
      fs.writeFileSync(
        path.join(rkDir, "project.json"),
        JSON.stringify({ id: "rk-project", baseBranch: "develop" })
      );

      const config = loadProjectConfig(tmpDir);
      expect(config.id).toBe("rk-project");
      expect(config.baseBranch).toBe("develop");
    });

    it("prefers .rks/project.json over routekit/project.json", () => {
      const rksDir = path.join(tmpDir, ".rks");
      const rkDir = path.join(tmpDir, "routekit");
      fs.mkdirSync(rksDir, { recursive: true });
      fs.mkdirSync(rkDir, { recursive: true });
      fs.writeFileSync(
        path.join(rksDir, "project.json"),
        JSON.stringify({ id: "rks-wins", baseBranch: "staging" })
      );
      fs.writeFileSync(
        path.join(rkDir, "project.json"),
        JSON.stringify({ id: "rk-loses", baseBranch: "dev" })
      );

      const config = loadProjectConfig(tmpDir);
      expect(config.id).toBe("rks-wins");
    });

    it("returns safe defaults when no config found", () => {
      const config = loadProjectConfig(tmpDir);
      expect(config.id).toBe("unknown");
      expect(config.baseBranch).toBe("staging");
    });

    it("defaults baseBranch to staging when missing from config", () => {
      const rksDir = path.join(tmpDir, ".rks");
      fs.mkdirSync(rksDir, { recursive: true });
      fs.writeFileSync(
        path.join(rksDir, "project.json"),
        JSON.stringify({ id: "no-branch" })
      );

      const config = loadProjectConfig(tmpDir);
      expect(config.baseBranch).toBe("staging");
    });

    it("preserves additional fields from config", () => {
      const rksDir = path.join(tmpDir, ".rks");
      fs.mkdirSync(rksDir, { recursive: true });
      fs.writeFileSync(
        path.join(rksDir, "project.json"),
        JSON.stringify({ id: "extra", baseBranch: "staging", stack: "node", kgFile: "kg.yaml" })
      );

      const config = loadProjectConfig(tmpDir);
      expect(config.stack).toBe("node");
      expect(config.kgFile).toBe("kg.yaml");
    });
  });

  describe("resolveShipTarget", () => {
    it("returns ok:true for staging branch", () => {
      const rksDir = path.join(tmpDir, ".rks");
      fs.mkdirSync(rksDir, { recursive: true });
      fs.writeFileSync(
        path.join(rksDir, "project.json"),
        JSON.stringify({ id: "test", baseBranch: "staging" })
      );

      const result = resolveShipTarget(tmpDir);
      expect(result.ok).toBe(true);
      expect(result.branch).toBe("staging");
    });

    it("rejects main as target branch", () => {
      const rksDir = path.join(tmpDir, ".rks");
      fs.mkdirSync(rksDir, { recursive: true });
      fs.writeFileSync(
        path.join(rksDir, "project.json"),
        JSON.stringify({ id: "test", baseBranch: "main" })
      );

      const result = resolveShipTarget(tmpDir);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("main");
      expect(result.error).toContain("production branch");
      expect(result.error).toContain("rks_release");
    });

    it("rejects master as target branch", () => {
      const rksDir = path.join(tmpDir, ".rks");
      fs.mkdirSync(rksDir, { recursive: true });
      fs.writeFileSync(
        path.join(rksDir, "project.json"),
        JSON.stringify({ id: "test", baseBranch: "master" })
      );

      const result = resolveShipTarget(tmpDir);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("master");
    });

    it("allows develop as target branch", () => {
      const rksDir = path.join(tmpDir, ".rks");
      fs.mkdirSync(rksDir, { recursive: true });
      fs.writeFileSync(
        path.join(rksDir, "project.json"),
        JSON.stringify({ id: "test", baseBranch: "develop" })
      );

      const result = resolveShipTarget(tmpDir);
      expect(result.ok).toBe(true);
      expect(result.branch).toBe("develop");
    });

    it("defaults to staging when no config exists", () => {
      const result = resolveShipTarget(tmpDir);
      expect(result.ok).toBe(true);
      expect(result.branch).toBe("staging");
    });
  });

  describe("deriveBranchName", () => {
    it("strips backlog prefix and slugifies", () => {
      const name = deriveBranchName("backlog.agents.ship-agent-config-driven");
      expect(name).toBe("rks/agents-ship-agent-config-driven");
    });

    it("handles nested paths", () => {
      const name = deriveBranchName("backlog.hooks.agent-redirect-wiring");
      expect(name).toBe("rks/hooks-agent-redirect-wiring");
    });

    it("returns null for empty storyId", () => {
      expect(deriveBranchName(null)).toBe(null);
      expect(deriveBranchName("")).toBe(null);
      expect(deriveBranchName(undefined)).toBe(null);
    });

    it("lowercases the result", () => {
      const name = deriveBranchName("backlog.Core.UpperCase-Story");
      expect(name).toBe("rks/core-uppercase-story");
    });

    it("truncates long names to 60 chars", () => {
      const longId = "backlog.agents." + "a".repeat(100);
      const name = deriveBranchName(longId);
      // "rks/" prefix + 60-char slug
      expect(name.length).toBeLessThanOrEqual(64);
    });

    it("strips invalid characters", () => {
      const name = deriveBranchName("backlog.agents.some@weird#name!");
      expect(name).toBe("rks/agents-some-weird-name-");
    });
  });

  describe("derivePrTitle", () => {
    it("extracts title from story note", () => {
      const notesDir = path.join(tmpDir, "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(
        path.join(notesDir, "backlog.agents.my-story.md"),
        `---\ntitle: 'Ship Agent config-driven target branch'\nstatus: not-implemented\n---\nContent here.`
      );

      const title = derivePrTitle(tmpDir, "backlog.agents.my-story");
      expect(title).toBe("feat(agents): Ship Agent config-driven target branch");
    });

    it("derives scope from story path", () => {
      const notesDir = path.join(tmpDir, "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(
        path.join(notesDir, "backlog.hooks.redirect-wiring.md"),
        `---\ntitle: 'Wire hooks to agents'\nstatus: not-implemented\n---\n`
      );

      const title = derivePrTitle(tmpDir, "backlog.hooks.redirect-wiring");
      expect(title).toMatch(/^feat\(hooks\):/);
    });

    it("checks z_implemented path as fallback", () => {
      const notesDir = path.join(tmpDir, "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(
        path.join(notesDir, "backlog.z_implemented.agents.done-story.md"),
        `---\ntitle: 'Already implemented feature'\nstatus: implemented\n---\n`
      );

      const title = derivePrTitle(tmpDir, "backlog.agents.done-story");
      expect(title).toBe("feat(agents): Already implemented feature");
    });

    it("falls back to humanized storyId when note not found", () => {
      const title = derivePrTitle(tmpDir, "backlog.agents.some-feature");
      expect(title).toBe("feat: agents some feature");
    });

    it("returns null for empty storyId", () => {
      expect(derivePrTitle(tmpDir, null)).toBe(null);
      expect(derivePrTitle(tmpDir, "")).toBe(null);
    });
  });

  describe("deriveCommitMessage", () => {
    it("uses PR title as commit message", () => {
      const notesDir = path.join(tmpDir, "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(
        path.join(notesDir, "backlog.agents.test.md"),
        `---\ntitle: 'Test feature'\n---\n`
      );

      const msg = deriveCommitMessage(tmpDir, "backlog.agents.test");
      expect(msg).toBe("feat(agents): Test feature");
    });

    it("returns fallback when no story found", () => {
      const msg = deriveCommitMessage(tmpDir, "backlog.nonexistent.story");
      // Falls back to humanized storyId
      expect(msg).toContain("feat:");
    });

    it("returns generic fallback for null storyId", () => {
      const msg = deriveCommitMessage(tmpDir, null);
      expect(msg).toBe("feat: ship changes");
    });
  });
});
