/**
 * Witness for backlog.feat.default-models-haiku-sonnet-5-5 (AC1, AC3, AC5, AC9).
 * Unit tier: reads source and config text and calls loadReviewPolicy on a temp root.
 * No network call, no subprocess, no LLM client.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HAIKU_MODEL, DEFAULT_SONNET_MODEL } from "../../packages/mcp-rks/src/shared/default-models.mjs";
import { loadReviewPolicy } from "../../packages/mcp-rks/src/server/review.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const OLD_HAIKU = "claude-haiku-4-5-20251001";
const OLD_SONNET = "claude-sonnet-4-6";
const RETIRED = "claude-sonnet-4-20250514";
const AC1_FILES = [
  "packages/mcp-rks/src/agents/config.mjs",
  "packages/mcp-rks/src/agents/runner.mjs",
  "packages/mcp-rks/src/server/qa-agent.mjs",
  "packages/mcp-rks/src/agents/visual.mjs",
  "packages/mcp-rks/src/server/review.mjs",
];

describe("default-models module (AC3)", () => {
  it("exports the 5.5 IDs", () => {
    expect(DEFAULT_HAIKU_MODEL).toBe("claude-haiku-5-5");
    expect(DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5-5");
  });
  for (const rel of AC1_FILES) {
    it(`${rel} imports from shared/default-models.mjs`, () => {
      expect(read(rel)).toMatch(/from ['"]\.\.\/shared\/default-models\.mjs['"]/);
    });
  }
});

describe("no 4.x default literals remain (AC1, AC9)", () => {
  for (const rel of AC1_FILES) {
    it(`${rel} contains no 4.x or retired default ID`, () => {
      const src = read(rel);
      expect(src).not.toContain(OLD_HAIKU);
      expect(src).not.toContain(OLD_SONNET);
      expect(src).not.toContain(RETIRED);
    });
  }
});

describe("review policy default (AC1)", () => {
  it("loadReviewPolicy on a root with no review-policy.yaml resolves claude-sonnet-5-5", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "default-models-"));
    try {
      expect(loadReviewPolicy(root).model).toBe("claude-sonnet-5-5");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("repo config uses the 5.5 IDs (AC5)", () => {
  it(".rks/agents.yaml pins no 4.x model", () => {
    const y = read(".rks/agents.yaml");
    expect(y).not.toContain(OLD_HAIKU);
    expect(y).not.toContain(OLD_SONNET);
    expect(y).toContain("model: claude-haiku-5-5");
    expect(y).toContain("fallbackModel: claude-sonnet-5-5");
  });
  it(".rks/review-policy.yaml reviewer model is claude-sonnet-5-5", () => {
    expect(read(".rks/review-policy.yaml")).toMatch(/^model: claude-sonnet-5-5$/m);
  });
  it("templates/generic/.rks/review-policy.yaml no longer ships the retired ID", () => {
    const t = read("templates/generic/.rks/review-policy.yaml");
    expect(t).not.toContain(RETIRED);
    expect(t).toMatch(/^model: claude-sonnet-5-5$/m);
  });
  it(".env.example recommends claude-sonnet-5-5", () => {
    const e = read(".env.example");
    expect(e).toContain("ROUTEKIT_LLM_MODEL=claude-sonnet-5-5");
    expect(e).not.toContain(OLD_SONNET);
  });
});
