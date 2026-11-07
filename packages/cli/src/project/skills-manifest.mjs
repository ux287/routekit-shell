import fs from "node:fs";
import path from "node:path";

/**
 * CLI-side reader for .routekit/skills-manifest.json.
 *
 * Duplicated from packages/mcp-rks/src/shared/skills-manifest.mjs because nothing in mcp-rks/src
 * imports from cli/src (same precedent as loadHookManifest). The trivial READER is duplicated; the
 * LIST is not — both parse the one JSON file, so the distribution rule (sync/bootstrap) and the
 * health check (preflight) cannot drift apart.
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
    distributable: parsed.skills.filter((s) => !shellOnly.includes(s)),
  };
}

/**
 * The set of skills a CHILD must NOT receive — the shell-only skills.
 *
 * This REPLACES the hardcoded `const SKILLS_EXCLUDE = new Set(["promote"])` that used to live,
 * separately and identically, in BOTH sync.mjs and bootstrap.mjs. Two hardcoded copies of a list is
 * how the list and the health check were free to disagree; there is now one list, in the manifest.
 * Falls back to the historical value only if the manifest is unreadable, so a missing manifest
 * degrades to today's behavior rather than distributing a shell-only skill.
 */
export function loadSkillsExclude(shellRoot) {
  const manifest = loadSkillsManifest(shellRoot);
  if (!manifest.ok) return new Set(["promote"]);
  return new Set(manifest.shellOnly);
}
