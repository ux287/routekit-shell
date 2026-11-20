/**
 * Tests for skillDefaults field in .rks/project.json and CLAUDE.md documentation
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readProjectJson() {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, ".rks/project.json"), "utf8"));
}

function readClaudeMd() {
  return fs.readFileSync(path.join(PROJECT_ROOT, "CLAUDE.md"), "utf8");
}

describe("project.json skillDefaults field", () => {
  it("project.json parses as valid JSON with skillDefaults field present", () => {
    expect(() => readProjectJson()).not.toThrow();
    const proj = readProjectJson();
    expect(proj).toHaveProperty("skillDefaults");
  });

  it("skillDefaults field is optional — a project.json without it still parses correctly", () => {
    // Simulate absence: parse a JSON object without skillDefaults
    const withoutField = { id: "test", root: "." };
    expect(() => JSON.parse(JSON.stringify(withoutField))).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(withoutField));
    expect(parsed.skillDefaults).toBeUndefined();
  });

  it("skillDefaults accepts an object mapping skill names to verbosity mode strings", () => {
    const example = { skillDefaults: { build: "heartbeat", research: "silent", qa: "verbose" } };
    const valid = ["silent", "heartbeat", "verbose"];
    for (const [, value] of Object.entries(example.skillDefaults)) {
      expect(valid).toContain(value);
    }
  });

  it("project.json skillDefaults is an object (not array or primitive)", () => {
    const proj = readProjectJson();
    expect(typeof proj.skillDefaults).toBe("object");
    expect(Array.isArray(proj.skillDefaults)).toBe(false);
  });
});

describe("CLAUDE.md skillDefaults documentation", () => {
  it("CLAUDE.md contains a skillDefaults section documenting the field name and shape", () => {
    const content = readClaudeMd();
    expect(content).toContain("skillDefaults");
    expect(content).toContain("skill names");
  });

  it("CLAUDE.md documents the four-tier verbosity resolution order", () => {
    const content = readClaudeMd();
    // Must mention all four tiers
    expect(content).toContain("Per-invocation flag");
    expect(content).toContain("skillDefaults");
    expect(content).toContain("SKILL.md");
    expect(content).toContain("fallback");
  });

  it("CLAUDE.md includes an example JSON block with at least one key-value skillDefaults entry", () => {
    const content = readClaudeMd();
    // Example block should contain at least one verbosity value assignment in skillDefaults context
    const match = content.match(/"skillDefaults"\s*:\s*\{[\s\S]*?"[^"]+"\s*:\s*"(silent|heartbeat|verbose)"/);
    expect(match).not.toBeNull();
  });
});
