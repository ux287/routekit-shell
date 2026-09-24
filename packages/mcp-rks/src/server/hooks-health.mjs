import fs from "fs";
import path from "path";

/**
 * Check if there's an active off-rail session (guardrails-off)
 * If so, hooks are intentionally moved to hooks.bak
 */
export function hasActiveOffRailSession(projectRoot) {
  const scopeFile = path.join(projectRoot, ".rks", "active-scope.json");
  if (!fs.existsSync(scopeFile)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(scopeFile, "utf8"));
    // If scope file exists and has a sessionId, there's an active session
    return !!data.sessionId;
  } catch {
    return false;
  }
}

/**
 * Check if hooks directory exists
 * Returns true if:
 * - hooks/ exists, OR
 * - there's an active off-rail session (hooks intentionally moved to hooks.bak)
 */
export function hasHooksBak(projectRoot) {
  const hooksBakPath = path.join(projectRoot, ".routekit", "hooks.bak");
  return fs.existsSync(hooksBakPath);
}

export function verifyHooksPresent(projectRoot) {
  // If there's an active off-rail session, hooks are intentionally absent
  if (hasActiveOffRailSession(projectRoot)) {
    return true;
  }
  // If hooks.bak exists, guardrails are intentionally off — skip auto-restore
  if (hasHooksBak(projectRoot)) {
    return true;
  }
  const hooksPath = path.join(projectRoot, ".routekit", "hooks");
  return fs.existsSync(hooksPath);
}

/**
 * Get template hooks path
 */
function getTemplatePath(projectRoot) {
  return path.join(projectRoot, "templates", "generic", ".routekit", "hooks");
}

/**
 * Check if hooks can be restored from template
 */
export function canRestoreFromTemplate(projectRoot) {
  const templatePath = getTemplatePath(projectRoot);
  return fs.existsSync(templatePath);
}

/**
 * Restore hooks from template directory
 */
export function restoreHooksFromTemplate(projectRoot) {
  const templatePath = getTemplatePath(projectRoot);
  const hooksPath = path.join(projectRoot, ".routekit", "hooks");

  if (!fs.existsSync(templatePath)) {
    return { ok: false, error: "Template hooks not found" };
  }

  try {
    // Ensure .routekit exists
    const routekitPath = path.join(projectRoot, ".routekit");
    if (!fs.existsSync(routekitPath)) {
      fs.mkdirSync(routekitPath, { recursive: true });
    }

    // Copy hooks directory
    fs.cpSync(templatePath, hooksPath, { recursive: true });
    return { ok: true, restored: true, from: templatePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get comprehensive hooks health status
 */
export function getHooksHealth(projectRoot) {
  const hooksPath = path.join(projectRoot, ".routekit", "hooks");
  const templatePath = getTemplatePath(projectRoot);

  const present = fs.existsSync(hooksPath);
  const restorable = fs.existsSync(templatePath);

  let hookCount = 0;
  let templateCount = 0;
  let projectHooks = [];
  let templateHooks = [];

  if (present) {
    try {
      for (const tier of ['system', 'write', 'read']) {
        const tierDir = path.join(hooksPath, tier);
        if (fs.existsSync(tierDir)) {
          projectHooks.push(...fs.readdirSync(tierDir).filter(f => f.endsWith('.mjs')));
        }
      }
      hookCount = projectHooks.length;
    } catch (e) { /* ignore */ }
  }

  if (restorable) {
    try {
      for (const tier of ['system', 'write', 'read']) {
        const tierDir = path.join(templatePath, tier);
        if (fs.existsSync(tierDir)) {
          templateHooks.push(...fs.readdirSync(tierDir).filter(f => f.endsWith('.mjs')));
        }
      }
      templateCount = templateHooks.length;
    } catch (e) { /* ignore */ }
  }

  const missingHooks = templateHooks.filter(h => !projectHooks.includes(h));
  const extraHooks = projectHooks.filter(h => !templateHooks.includes(h));

  return {
    present,
    restorable,
    hookCount,
    templateCount,
    mismatch: present && restorable && (missingHooks.length > 0 || extraHooks.length > 0),
    missingHooks,
    extraHooks,
  };
}
