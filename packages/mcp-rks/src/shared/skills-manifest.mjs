import fs from "node:fs";
import path from "node:path";

/**
 * Reader for .routekit/skills-manifest.json — the canonical inventory of the shell's skills.
 *
 * There are two readers (this one for mcp-rks, packages/cli/src/project/skills-manifest.mjs for the
 * CLI) because nothing in mcp-rks/src imports from cli/src — the same reason loadHookManifest is
 * duplicated. Only the trivial reader is duplicated; THE LIST IS NOT. Both parse this one JSON file,
 * so the distribution rule and the health check cannot drift apart — which is exactly how a hardcoded
 * SKILLS_EXCLUDE in one file and a hardcoded expectation in another were free to disagree.
 */
export function loadSkillsManifest(shellRoot) {
  const manifestPath = path.join(shellRoot, ".routekit", "skills-manifest.json");
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: false, reason: "manifest_missing", path: manifestPath };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: "manifest_unparseable", path: manifestPath, error: err?.message };
  }
  if (!Array.isArray(parsed?.skills) || parsed.skills.length === 0) {
    return { ok: false, reason: "manifest_malformed", path: manifestPath };
  }
  const shellOnly = Array.isArray(parsed.shellOnly) ? parsed.shellOnly : [];
  return {
    ok: true,
    path: manifestPath,
    skills: parsed.skills,
    shellOnly,
    // What a CHILD is expected to carry: everything the shell has, minus the shell-only skills.
    distributable: parsed.skills.filter((s) => !shellOnly.includes(s)),
  };
}

/**
 * The skills the manifest declares but that are absent (or empty) on disk under `root`.
 * A skill is PRESENT iff <root>/.claude/skills/<name>/SKILL.md exists and is non-empty — an
 * empty SKILL.md is not a skill, and the wipe this guards against leaves empty dirs behind.
 */
export function findMissingSkills(root, expected) {
  const missing = [];
  for (const name of expected) {
    const skillMd = path.join(root, ".claude", "skills", name, "SKILL.md");
    let stat;
    try {
      stat = fs.statSync(skillMd);
    } catch {
      missing.push(name);
      continue;
    }
    if (!stat.isFile() || stat.size === 0) missing.push(name);
  }
  return missing;
}
