/**
 * Tests for buildPrompt existing-file guard and uncoveredCreatePaths filtering.
 *
 * Verifies:
 * 1. CRITICAL block is injected when editableTargets have liveContent
 * 2. CRITICAL block contains path(s) with liveContent
 * 3. CRITICAL block forbids create_file
 * 4. CRITICAL block is positioned after editableSection and before contextualSection
 * 5. liveContent paths are excluded from REQUIRED CREATE_FILE STEPS even when in uncoveredCreatePaths
 * 6. No CRITICAL block when no editableTargets have liveContent
 * 7. REQUIRED CREATE_FILE STEPS fires normally for uncoveredCreatePaths without liveContent
 * 8. Mixed case: only new path appears in REQUIRED CREATE_FILE STEPS
 */
import { describe, it, expect } from "vitest";
import { buildPrompt } from "../../packages/mcp-rks/src/llm/planner.mjs";

const BASE_ARGS = {
  requirements: "Add a method to the service",
  editableTargets: [],
  contextualRefs: [],
  uncoveredCreatePaths: [],
};

const EXISTING_TARGET = {
  path: "services/sqliteService.ts",
  summary: "(existing file - use search_replace for edits)",
  liveContent: {
    source: "full-file",
    content: "export class SQLiteService {}\n",
    totalLines: 1,
  },
};

const NEW_TARGET = {
  path: "services/newService.ts",
  summary: "(new file - to be created)",
};

describe("buildPrompt — CRITICAL existing-file guard", () => {
  it("injects a CRITICAL block when at least one editableTarget has a liveContent field", () => {
    const prompt = buildPrompt({
      ...BASE_ARGS,
      editableTargets: [EXISTING_TARGET],
    });
    expect(prompt).toContain("CRITICAL — MUST USE search_replace");
  });

  it("the CRITICAL block contains the path of each editableTarget with liveContent", () => {
    const prompt = buildPrompt({
      ...BASE_ARGS,
      editableTargets: [EXISTING_TARGET],
    });
    const criticalIdx = prompt.indexOf("CRITICAL — MUST USE search_replace");
    expect(criticalIdx).toBeGreaterThan(-1);
    const criticalSection = prompt.slice(criticalIdx, criticalIdx + 500);
    expect(criticalSection).toContain("services/sqliteService.ts");
  });

  it("the CRITICAL block states create_file is FORBIDDEN", () => {
    const prompt = buildPrompt({
      ...BASE_ARGS,
      editableTargets: [EXISTING_TARGET],
    });
    const criticalIdx = prompt.indexOf("CRITICAL — MUST USE search_replace");
    expect(criticalIdx).toBeGreaterThan(-1);
    const criticalSection = prompt.slice(criticalIdx, criticalIdx + 600);
    expect(criticalSection).toMatch(/FORBIDDEN/);
    expect(criticalSection.toLowerCase()).toContain("create_file");
  });

  it("CRITICAL block is positioned after Editable Code Targets section and before Contextual References section", () => {
    const prompt = buildPrompt({
      ...BASE_ARGS,
      editableTargets: [EXISTING_TARGET],
      contextualRefs: [{ path: "some/ref.ts", content: "// ref" }],
    });
    const editableIdx = prompt.indexOf("Editable Code Targets:");
    const criticalIdx = prompt.indexOf("CRITICAL — MUST USE search_replace");
    const contextualIdx = prompt.indexOf("Contextual References (read-only):");

    expect(editableIdx).toBeGreaterThan(-1);
    expect(criticalIdx).toBeGreaterThan(-1);
    expect(contextualIdx).toBeGreaterThan(-1);
    expect(criticalIdx).toBeGreaterThan(editableIdx);
    expect(criticalIdx).toBeLessThan(contextualIdx);
  });

  it("does NOT inject a CRITICAL block when no editableTargets have liveContent", () => {
    const prompt = buildPrompt({
      ...BASE_ARGS,
      editableTargets: [NEW_TARGET],
    });
    expect(prompt).not.toContain("CRITICAL — MUST USE search_replace");
  });

  it("does NOT inject CRITICAL block when editableTargets is empty", () => {
    const prompt = buildPrompt({ ...BASE_ARGS });
    expect(prompt).not.toContain("CRITICAL — MUST USE search_replace");
  });
});

describe("buildPrompt — uncoveredCreatePaths filtering", () => {
  it("a liveContent path in uncoveredCreatePaths does NOT appear in REQUIRED CREATE_FILE STEPS", () => {
    const prompt = buildPrompt({
      ...BASE_ARGS,
      editableTargets: [EXISTING_TARGET],
      uncoveredCreatePaths: ["services/sqliteService.ts"],
    });
    // The REQUIRED block should not be emitted (path was filtered out)
    expect(prompt).not.toContain("REQUIRED CREATE_FILE STEPS");
  });

  it("still emits REQUIRED CREATE_FILE STEPS for uncoveredCreatePaths paths without liveContent", () => {
    const prompt = buildPrompt({
      ...BASE_ARGS,
      editableTargets: [],
      uncoveredCreatePaths: ["services/brandNew.ts"],
    });
    expect(prompt).toContain("REQUIRED CREATE_FILE STEPS");
    expect(prompt).toContain("services/brandNew.ts");
  });

  it("mixed case: only the genuinely-new path appears in REQUIRED CREATE_FILE STEPS", () => {
    const prompt = buildPrompt({
      ...BASE_ARGS,
      editableTargets: [EXISTING_TARGET],
      uncoveredCreatePaths: ["services/sqliteService.ts", "services/brandNew.ts"],
    });
    expect(prompt).toContain("REQUIRED CREATE_FILE STEPS");
    expect(prompt).toContain("services/brandNew.ts");
    // The existing-file path must not be in the REQUIRED block
    const requiredIdx = prompt.indexOf("REQUIRED CREATE_FILE STEPS");
    const afterRequired = prompt.slice(requiredIdx);
    // Find the end of the REQUIRED section (next \n\n or end of string before Requirements)
    const requirementsIdx = afterRequired.indexOf("\nContext:");
    const requiredSection = afterRequired.slice(0, requirementsIdx > -1 ? requirementsIdx : undefined);
    expect(requiredSection).not.toContain("services/sqliteService.ts");
  });
});
