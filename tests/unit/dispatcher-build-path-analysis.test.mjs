/**
 * Tests for dispatcher-build-path-analysis — verifies that CLAUDE.md
 * contains the Build Path Analysis section with actionable routing rules.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const src = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");

describe("CLAUDE.md — Build Path Analysis section", () => {
  it("contains a ## Build Path Analysis section heading", () => {
    expect(src).toMatch(/^## Build Path Analysis/m);
  });

  it("Build Path Analysis section appears after the Skills table", () => {
    const skillsIdx = src.indexOf("## Skills");
    const analysisIdx = src.indexOf("## Build Path Analysis");
    expect(skillsIdx).toBeGreaterThan(-1);
    expect(analysisIdx).toBeGreaterThan(-1);
    expect(analysisIdx).toBeGreaterThan(skillsIdx);
  });

  it("Build Path Analysis section appears before ## On Governor return", () => {
    const analysisIdx = src.indexOf("## Build Path Analysis");
    const governorIdx = src.indexOf("## On Governor return");
    expect(analysisIdx).toBeGreaterThan(-1);
    expect(governorIdx).toBeGreaterThan(-1);
    expect(analysisIdx).toBeLessThan(governorIdx);
  });

  it("names packages/mcp-rks/src/ as a guardrails-off trigger", () => {
    expect(src).toMatch(/packages\/mcp-rks\/src\//);
  });

  it("names .rks/prompts/ as a guardrails-off trigger", () => {
    expect(src).toMatch(/\.rks\/prompts\//);
  });

  it("names .routekit/hooks/ as a guardrails-off trigger", () => {
    expect(src).toMatch(/\.routekit\/hooks\//);
  });

  it("names .claude/ as a guardrails-off trigger", () => {
    expect(src).toMatch(/\.claude\//);
  });

  it("covers op: create condition", () => {
    expect(src).toMatch(/op.*create|create.*op/i);
  });

  it("covers off-rail build sequence with mandatory governor token", () => {
    expect(src).toMatch(/rks_governor_init|_governorToken/i);
  });

  it("states guardrails-off is the default for routekit-shell", () => {
    const analysisIdx = src.indexOf("## Build Path Analysis");
    const governorIdx = src.indexOf("## On Governor return");
    const section = src.slice(analysisIdx, governorIdx);
    expect(section).toMatch(/default/i);
    expect(section).toMatch(/guardrails-off/);
  });

  it("states Build Governor is appropriate only for application-layer / non-MCP stories", () => {
    const analysisIdx = src.indexOf("## Build Path Analysis");
    const governorIdx = src.indexOf("## On Governor return");
    const section = src.slice(analysisIdx, governorIdx);
    expect(section).toMatch(/Build Governor.*appropriate only|appropriate only.*Build Governor/i);
  });

  it("gives exact action: use guardrails-off with the story's problemId", () => {
    const analysisIdx = src.indexOf("## Build Path Analysis");
    const governorIdx = src.indexOf("## On Governor return");
    const section = src.slice(analysisIdx, governorIdx);
    expect(section).toMatch(/guardrails-off/);
    expect(section).toMatch(/problemId/);
  });

  it("includes an off-rail build sequence with rks_governor_init and rks_guardrails_off steps", () => {
    expect(src).toMatch(/rks_governor_init/);
    expect(src).toMatch(/rks_guardrails_off/);
    expect(src).toMatch(/rks_guardrails_on/);
  });
});
