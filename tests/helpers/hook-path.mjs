import fs from "node:fs";
import path from "node:path";

/**
 * Resolve a deployed hook to a path that EXISTS in the repo's current state.
 *
 * During an off-rail session — `rks_guardrails_off` or manual "hooks in .bak" mode — the deployed
 * `.routekit/hooks/<tier>/` tree is moved to `.routekit/hooks.bak/`, so a test that hard-codes
 * `.routekit/hooks/<tier>/<name>` ENOENTs (and, if the read is at module/describe scope, takes the
 * whole test file down to 0 collected tests). This resolves, in priority order:
 *
 *   1. the live deployed tree      `.routekit/hooks/<tierRelPath>`
 *   2. the off-rail backup          `.routekit/hooks.bak/<tierRelPath>`
 *   3. the canonical source         `packages/hooks/<tierRelPath>`
 *
 * so a hook test exercises the SAME hook regardless of whether guardrails are currently on or off.
 * (guardrails-off/on move only the DEPLOYED copy; canonical is always present as a final fallback.)
 *
 * @param {string} tierRelPath e.g. "system/block-plan-mode.mjs" or "write/redirect-edit-to-governor.mjs"
 * @param {string} [root=process.cwd()] project root
 * @returns {string} absolute path to an existing hook file (falls back to the deployed candidate)
 */
export function resolveHookPath(tierRelPath, root = process.cwd()) {
  const candidates = [
    path.resolve(root, ".routekit/hooks", tierRelPath),
    path.resolve(root, ".routekit/hooks.bak", tierRelPath),
    path.resolve(root, "packages/hooks", tierRelPath),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

const HOOK_ROOTS = [".routekit/hooks", ".routekit/hooks.bak", "packages/hooks"];
// "" = the root of each hook tree (flat layout); the rest are the tier subdirs.
const HOOK_TIERS = ["", "system", "read", "write"];

/**
 * Resolve a hook by BARE NAME (e.g. "enforce-targetfile-scope.mjs") without knowing its tier.
 * Searches the live tree, the off-rail backup, and canonical — across every tier subdir — so a
 * system-tier hook that moved to `.routekit/hooks.bak/system/` during an off-rail session is still
 * found. (The older inline resolvers checked `hooks.bak/` but not `hooks.bak/system/`, so they
 * ENOENT'd in off-rail mode — this closes that gap in one place.)
 *
 * @param {string} hookName bare hook filename
 * @param {string} [root=process.cwd()] project root
 * @returns {string} absolute path to an existing hook file (falls back to the canonical system tier)
 */
export function resolveHookByName(hookName, root = process.cwd()) {
  for (const r of HOOK_ROOTS) {
    for (const tier of HOOK_TIERS) {
      const p = path.resolve(root, r, tier, hookName);
      if (fs.existsSync(p)) return p;
    }
  }
  return path.resolve(root, "packages/hooks/system", hookName);
}
