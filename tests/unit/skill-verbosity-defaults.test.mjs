/**
 * Tests for verbosity frontmatter field in all SKILL.md files
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKILLS_DIR = path.join(PROJECT_ROOT, ".claude/skills");

function readFrontmatter(skillName) {
  const content = fs.readFileSync(path.join(SKILLS_DIR, skillName, "SKILL.md"), "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`No frontmatter found in ${skillName}/SKILL.md`);
  const fm = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0 && !line.startsWith(" ")) {
      fm[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
    }
  }
  return fm;
}

const EXPECTED_VERBOSITY = {
  research: "heartbeat",
  po: "heartbeat",
  qa: "heartbeat",
  telemetry: "silent",
  ship: "heartbeat",
  release: "heartbeat",
  build: "heartbeat",
  pipeline: "heartbeat",
  ops: "heartbeat",
  ci: "heartbeat",
};

describe("SKILL.md verbosity defaults", () => {
  for (const [skill, expected] of Object.entries(EXPECTED_VERBOSITY)) {
    it(`${skill}/SKILL.md has verbosity: ${expected}`, () => {
      const fm = readFrontmatter(skill);
      expect(fm.verbosity).toBe(expected);
    });
  }

  it("all 10 SKILL.md files have the verbosity field — none are missing it", () => {
    const skills = Object.keys(EXPECTED_VERBOSITY);
    for (const skill of skills) {
      const fm = readFrontmatter(skill);
      expect(fm.verbosity, `${skill}/SKILL.md is missing verbosity`).toBeDefined();
    }
  });

  it("existing frontmatter fields are present and unchanged in all 10 SKILL.md files", () => {
    const skills = Object.keys(EXPECTED_VERBOSITY);
    for (const skill of skills) {
      const fm = readFrontmatter(skill);
      expect(fm.name, `${skill}/SKILL.md missing name`).toBeDefined();
      expect(fm["user-invocable"], `${skill}/SKILL.md missing user-invocable`).toBe("true");
      expect(fm["disable-model-invocation"], `${skill}/SKILL.md missing disable-model-invocation`).toBe("false");
    }
  });
});
