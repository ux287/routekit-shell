import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptPath = path.resolve(__dirname, "../../.rks/prompts/governor-arch.md");
const content = fs.readFileSync(promptPath, "utf8");

describe("governor-arch.md — structural requirements", () => {
  it("file exists at .rks/prompts/governor-arch.md", () => {
    expect(fs.existsSync(promptPath)).toBe(true);
  });

  it("contains __PROJECT_ID__ substitution variable", () => {
    expect(content).toContain("__PROJECT_ID__");
  });

  it("contains __STORY_IDS__ substitution variable", () => {
    expect(content).toContain("__STORY_IDS__");
  });

  it("does NOT contain __PROBLEM_ID__ (single-story var replaced by batch var)", () => {
    expect(content).not.toContain("__PROBLEM_ID__");
  });

  it("calls rks_governor_init with no problemId (open flow)", () => {
    expect(content).toMatch(/rks_governor_init\(\{[^}]*projectId[^}]*\}\)/);
    const initCall = content.match(/rks_governor_init\(\{[^}]*\}\)/)?.[0] ?? "";
    expect(initCall).not.toContain("problemId");
  });

  it("calls rks_agent_research for each storyId in the batch", () => {
    expect(content).toContain("rks_agent_research");
    expect(content).toContain("storyId");
  });

  it("includes all 8 ARCH checklist items", () => {
    expect(content).toContain("Correct function/variable/condition");
    expect(content).toContain("Secondary firing paths");
    expect(content).toContain("Tests to delete vs. update");
    expect(content).toContain("Frontmatter consistency");
    expect(content).toContain("Left-side/right-side imbalance");
    expect(content).toContain("Wrong-phase validation");
    expect(content).toContain("Circular dogfood dependency");
    expect(content).toContain("Stale active/target scope");
  });

  it("calls dendron_update_field to write arch_guidance per story", () => {
    expect(content).toContain("dendron_update_field");
    expect(content).toContain("arch_guidance");
  });

  it("specifies approved return format with findings array", () => {
    expect(content).toContain("status: 'approved'");
    expect(content).toContain("findings");
  });

  it("specifies needs-revision return format with storyId/item/file/detail shape", () => {
    expect(content).toContain("needs-revision");
    expect(content).toContain("storyId");
    expect(content).toContain("item");
    expect(content).toContain("detail");
  });

  it("includes graceful degradation path for RAG unavailable", () => {
    expect(content).toContain("SKIPPED: RAG unavailable");
    expect(content).toContain("approved");
  });

  it("includes cross-story stale-snapshot hazard check", () => {
    expect(content).toContain("stale-snapshot");
  });
});
