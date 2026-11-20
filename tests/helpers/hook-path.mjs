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
 * THE `.bak` CANDIDATE IS FOR SOURCE-TEXT READS ONLY — never for SPAWNING. A relocated hook lives
 * beside a partial tree: its relative imports (`../lib/…`, `../system/…`) resolve against
 * `hooks.bak/`, which carries only what guardrailsOff mirrored there. `readFileSync` does not care
 * about module resolution, so reading the source from `.bak` is sound; executing it is not, and a
 * spawn that fails this way exits non-zero with EMPTY stdout, which reads exactly like a hook that
 * ran and chose to stay silent. Use `canonicalHookPath` when the test intends to RUN the hook.
 * (backlog.fix.unit-tier-offrail-hermeticity)
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

/**
 * Resolve a hook to its CANONICAL source copy, for tests that SPAWN it.
 *
 * Canonical-only, and FAILS LOUD. It never falls back to `.routekit/hooks` or
 * `.routekit/hooks.bak`, and never returns a path that does not exist — because
 * both fallbacks are exactly what a spawning test must not silently accept:
 *
 *   - `.routekit/hooks.bak/<tier>/…` is a relocated hook whose relative imports
 *     resolve against a partial tree. It dies with ERR_MODULE_NOT_FOUND before any
 *     hook logic runs, producing empty stdout — indistinguishable from a hook that
 *     ran and stayed quiet.
 *   - `.routekit/hooks/…` is legitimately STALE during a hooks-editing session:
 *     sync-hooks refuses to regenerate it mid-session, so spawning it would
 *     exercise pre-change code and pass against the very edit under test.
 *
 * Throwing is the point. A test that cannot find the code it means to run must say
 * so, not quietly run something else. Established convention — four suites already
 * spawn canonical deliberately (provenance-hook-heartbeat, track-agent-provenance-
 * payload, agent-launch-telemetry-ledger, posttooluse-payload-contract).
 *
 * @param {string} tierRelPath e.g. "read/redirect-read-to-agent.mjs"
 * @param {string} [root=process.cwd()] project root
 * @returns {string} absolute path to an EXISTING canonical hook file
 * @throws {Error} named CanonicalHookMissing when the canonical file is absent
 */
export function canonicalHookPath(tierRelPath, root = process.cwd()) {
  const p = path.resolve(root, "packages/hooks", tierRelPath);
  if (!fs.existsSync(p)) {
    const err = new Error(
      `CanonicalHookMissing: no canonical hook at packages/hooks/${tierRelPath} `
      + `(resolved ${p}). Not falling back to .routekit/hooks or .routekit/hooks.bak — `
      + `a spawning test must run the canonical copy or fail loudly.`,
    );
    err.name = "CanonicalHookMissing";
    throw err;
  }
  return p;
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
