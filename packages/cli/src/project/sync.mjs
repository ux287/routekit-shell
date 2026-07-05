import fs from "node:fs";
import path from "node:path";

const SKILLS_EXCLUDE = new Set(["promote"]);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDirOverwriteTracked(srcDir, destDir, projectRoot, updated) {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return;
  ensureDir(destDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirOverwriteTracked(src, dest, projectRoot, updated);
    } else if (entry.isFile()) {
      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
      updated.push(path.relative(projectRoot, dest));
    }
  }
}

export function syncProject({ projectRoot, projectId, shellRoot }) {
  const updated = [];

  // 1. Hooks — overwrite from generic template
  const srcHooks = path.join(shellRoot, "templates", "generic", ".routekit", "hooks");
  const destHooks = path.join(projectRoot, ".routekit", "hooks");
  copyDirOverwriteTracked(srcHooks, destHooks, projectRoot, updated);

  // 2. Governor prompts — overwrite
  const srcPrompts = path.join(shellRoot, ".rks", "prompts");
  if (fs.existsSync(srcPrompts)) {
    const destPrompts = path.join(projectRoot, ".rks", "prompts");
    ensureDir(destPrompts);
    for (const file of fs.readdirSync(srcPrompts)) {
      if (!file.startsWith("governor-") || !file.endsWith(".md")) continue;
      fs.copyFileSync(path.join(srcPrompts, file), path.join(destPrompts, file));
      updated.push(path.relative(projectRoot, path.join(destPrompts, file)));
    }
  }

  // 3. Skills — overwrite with projectId substitution
  const srcSkills = path.join(shellRoot, ".claude", "skills");
  if (fs.existsSync(srcSkills)) {
    const destSkills = path.join(projectRoot, ".claude", "skills");
    ensureDir(destSkills);
    for (const entry of fs.readdirSync(srcSkills, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKILLS_EXCLUDE.has(entry.name)) continue;
      const destSkill = path.join(destSkills, entry.name);
      if (fs.existsSync(destSkill)) fs.rmSync(destSkill, { recursive: true, force: true });
      copyDirOverwriteTracked(path.join(srcSkills, entry.name), destSkill, projectRoot, updated);
      if (projectId && projectId !== "routekit-shell") {
        for (const f of fs.readdirSync(destSkill).filter(n => n.endsWith(".md"))) {
          const fp = path.join(destSkill, f);
          const content = fs.readFileSync(fp, "utf8");
          const replaced = content.replace(/routekit-shell/g, projectId);
          if (replaced !== content) fs.writeFileSync(fp, replaced);
        }
      }
    }
  }

  // 4. Agent definitions — overwrite (flat .md files; no projectId substitution — they
  //    declare Claude Code subagents by tool allowlist, not project identity). Mirrors the
  //    bootstrap seed so `project upgrade` repairs children scaffolded before agents shipped.
  const srcAgents = path.join(shellRoot, ".claude", "agents");
  if (fs.existsSync(srcAgents)) {
    const destAgents = path.join(projectRoot, ".claude", "agents");
    ensureDir(destAgents);
    for (const file of fs.readdirSync(srcAgents)) {
      if (!file.endsWith(".md")) continue;
      fs.copyFileSync(path.join(srcAgents, file), path.join(destAgents, file));
      updated.push(path.relative(projectRoot, path.join(destAgents, file)));
    }
  }

  return updated;
}
