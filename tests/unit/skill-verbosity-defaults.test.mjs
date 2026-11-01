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
  whitepaper: "heartbeat",
};

// backlog.fix.mirror-ci-green-unship-doc-integrity-tests — AC5.
//
// `.claude/skills/whitepaper/**` is EXCLUDED from the publish set (publish-profiles.yaml
// GROUP 3: its executable, `packages/whitepaper/**`, is excluded too, so the mirror would
// otherwise ship a skill whose binary is deliberately absent). A roster hardcoded to eleven
// entries therefore asserted the existence of a skill that cannot be there, and threw ENOENT
// on the mirror for all three cases below.
//
// CONDITION-SCOPED, NOT DISABLED: every skill that IS present is still asserted in full, and
// the floor below fails the suite if the roster ever collapses to a trivial subset — so this
// cannot degrade into a test that passes by checking nothing.
const skillPresent = (skill) => fs.existsSync(path.join(SKILLS_DIR, skill, "SKILL.md"));
const presentSkills = Object.keys(EXPECTED_VERBOSITY).filter(skillPresent);

describe("SKILL.md verbosity defaults", () => {
  it("the roster resolves to a substantial set of real skills (non-vacuity floor)", () => {
    // Upstream this is 11; the published mirror drops `whitepaper` and has 10. A roster that
    // shrank below this floor would mean the gate had stopped gating.
    expect(presentSkills.length).toBeGreaterThanOrEqual(10);
  });

  for (const [skill, expected] of Object.entries(EXPECTED_VERBOSITY)) {
    // skipIf rather than filtering the loop: a skipped case is VISIBLE in the reporter,
    // whereas a filtered one silently ceases to exist.
    it.skipIf(!skillPresent(skill))(`${skill}/SKILL.md has verbosity: ${expected}`, () => {
      const fm = readFrontmatter(skill);
      expect(fm.verbosity).toBe(expected);
    });
  }

  it("every present SKILL.md has the verbosity field — none are missing it", () => {
    for (const skill of presentSkills) {
      const fm = readFrontmatter(skill);
      expect(fm.verbosity, `${skill}/SKILL.md is missing verbosity`).toBeDefined();
    }
  });

  it("existing frontmatter fields are present and unchanged in every present SKILL.md", () => {
    for (const skill of presentSkills) {
      const fm = readFrontmatter(skill);
      expect(fm.name, `${skill}/SKILL.md missing name`).toBeDefined();
      expect(fm["user-invocable"], `${skill}/SKILL.md missing user-invocable`).toBe("true");
      expect(fm["disable-model-invocation"], `${skill}/SKILL.md missing disable-model-invocation`).toBe("false");
    }
  });
});
