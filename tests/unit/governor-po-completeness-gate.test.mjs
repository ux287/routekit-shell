/**
 * Source-based tests for po-governor-completeness-gate — verifies that
 * governor-po.md Chain section contains the mandatory completeness research
 * step with MANDATORY and MUST language.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const src = fs.readFileSync(path.join(ROOT, ".rks/prompts/governor-po.md"), "utf8");

// Extract the Chain section for targeted assertions
const chainStart = src.indexOf("## Chain");
const chainEnd = src.indexOf("\n## ", chainStart + 1);
const chainSection = chainStart > -1
  ? src.slice(chainStart, chainEnd > -1 ? chainEnd : undefined)
  : "";

describe("governor-po.md — completeness gate step", () => {
  it("Chain section contains a step between step 1b and step 2 (e.g. 1c)", () => {
    expect(chainSection).toMatch(/1c\./);
  });

  it("completeness step text contains the word MANDATORY (case-sensitive)", () => {
    expect(chainSection).toMatch(/MANDATORY/);
  });

  it("completeness step text contains the word MUST (case-sensitive)", () => {
    expect(chainSection).toMatch(/MUST/);
  });

  it("completeness step instructs calling rks_agent_research with a completeness query", () => {
    const stepIdx = chainSection.indexOf("1c.");
    const stepText = chainSection.slice(stepIdx, stepIdx + 600);
    expect(stepText).toMatch(/rks_agent_research/);
    expect(stepText).toMatch(/caller|consumer|dependent/i);
  });

  it("completeness step includes scope discipline: same-concern gaps added, different-concern gaps deferred", () => {
    const stepIdx = chainSection.indexOf("1c.");
    const stepText = chainSection.slice(stepIdx, stepIdx + 800);
    // Should mention adding gaps to targetFiles
    expect(stepText).toMatch(/targetFiles|target files/i);
    // Should mention deferring different-concern gaps
    expect(stepText).toMatch(/follow-up|defer|different concern/i);
  });
});
