/**
 * Witness for backlog.fix.shell-self-sync-skill-wipe-health-gate — the manifest is honest.
 *
 * `.routekit/skills-manifest.json` is what preflight checks presence against and what sync/bootstrap
 * exclude the shell-only skills by. If it can drift from the filesystem, the health check silently
 * stops covering whatever drifted — a skill added and never listed is a skill nobody notices the
 * loss of, which is precisely the failure mode this whole story exists to close.
 *
 * THIS TEST DELIBERATELY CONTAINS NO LIST OF SKILLS. Asserting the manifest against a hardcoded array
 * here would just mirror one hardcoded list with another: both could be wrong together, and the test
 * would be green the whole time. (That is exactly the debt v0.27.1 paid down in the planner, and the
 * research paper for THIS story got the skill list wrong while asserting it confidently — it claimed
 * HEAD had no `build` skill. It does.) The filesystem is the ground truth; the manifest is the claim;
 * this compares them, in BOTH directions.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsManifest, findMissingSkills } from "../../packages/mcp-rks/src/shared/skills-manifest.mjs";
import { loadSkillsExclude } from "../../packages/cli/src/project/skills-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Ground truth: every directory under .claude/skills that actually holds a SKILL.md. */
function skillsOnDisk() {
  const dir = path.join(ROOT, ".claude", "skills");
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

describe("skills-manifest.json is in lockstep with the filesystem", () => {
  it("loads", () => {
    const m = loadSkillsManifest(ROOT);
    expect(m.ok).toBe(true);
    expect(m.skills.length).toBeGreaterThan(0);
  });

  it("declares EXACTLY the skills that exist on disk — no more, no less", () => {
    const m = loadSkillsManifest(ROOT);
    const onDisk = skillsOnDisk();
    const declared = [...m.skills].sort();

    // Both directions, reported separately so a failure says WHICH way it drifted.
    const undeclared = onDisk.filter((s) => !m.skills.includes(s));
    const phantom = m.skills.filter((s) => !onDisk.includes(s));

    expect(undeclared, "skill dirs on disk that the manifest does not declare").toEqual([]);
    expect(phantom, "skills the manifest declares that are not on disk").toEqual([]);
    expect(declared).toEqual(onDisk);
  });

  it("every declared skill is actually present (findMissingSkills is clean on a healthy tree)", () => {
    const m = loadSkillsManifest(ROOT);
    expect(findMissingSkills(ROOT, m.skills)).toEqual([]);
  });

  it("shellOnly is a subset of skills, and is what the CLI excludes from distribution", () => {
    const m = loadSkillsManifest(ROOT);
    for (const s of m.shellOnly) expect(m.skills).toContain(s);

    // The exclusion rule sync/bootstrap apply IS the manifest's shellOnly — not a second hardcoded
    // Set living in two files, free to disagree with each other and with this.
    const exclude = loadSkillsExclude(ROOT);
    expect([...exclude].sort()).toEqual([...m.shellOnly].sort());

    // distributable is the complement, and it is what a child is expected to carry.
    expect(m.distributable).toEqual(m.skills.filter((s) => !m.shellOnly.includes(s)));
    expect(m.distributable.length).toBe(m.skills.length - m.shellOnly.length);
  });

  it("findMissingSkills reports an empty SKILL.md as MISSING, not present", () => {
    // The wipe leaves empty directories behind, so "the directory exists" is not evidence of a skill.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-manifest-"));
    try {
      const dir = path.join(tmp, ".claude", "skills", "arch");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), ""); // empty — a husk, not a skill
      expect(findMissingSkills(tmp, ["arch"])).toEqual(["arch"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
