import { defineConfig } from "vitest/config";

/**
 * Shared base for all vitest tiers — unit, mock, e2e, fallback.
 *
 * Per backlog.fix.vitest-config-drift-reconcile (B5): captures cross-tier
 * invariants. Tier-specific configs MUST extend this via `mergeConfig(base, ...)`
 * with explicit `// OVERRIDE-REASON: <id>: <rationale>` comments for any field
 * that differs from the base.
 *
 * mergeConfig semantics that matter here:
 *   - Arrays CONCAT (not replace). A tier declaring `exclude: ["foo"]` ends up
 *     with merged exclude `["tests/.tmp/**", "foo"]`. Same for include.
 *   - Plain objects DEEP-MERGE. A tier setting `poolOptions.forks.maxForks: 2`
 *     leaves base's `minForks: 1` intact and adds maxForks.
 *   - Primitives OVERRIDE. A tier setting `bail: 1` adds it; base has no bail.
 *
 * What lives HERE (truly universal):
 *   - pool: "forks"                             — all 4 tiers fork
 *   - poolOptions.forks.minForks: 1             — all 4 tiers agree
 *   - setupFiles: ["tests/setup.mjs"]           — all 4 tiers
 *   - clearMocks: true                          — all 4 tiers
 *   - env.NODE_NO_WARNINGS = "1"                — all 4 tiers
 *   - env.ROUTEKIT_SKIP_GLOBAL_CONFIG = "true"  — all 4 tiers
 *   - exclude: ["tests/.tmp/**"]                — all 4 tiers
 *
 * What stays TIER-SPECIFIC (intentionally NOT in base):
 *   - include                — each tier has its own glob set
 *   - bail                   — unit/mock/e2e have it; fallback doesn't
 *   - isolate                — unit/mock/e2e have it; fallback doesn't
 *   - maxForks               — unit/e2e=2 (Hotfix #10 + e2e LLM rate-limit), mock/fallback=4
 *   - hookTimeout            — only unit (beforeEach + makeTempDir/git init)
 *   - testTimeout            — only e2e (LLM API roundtrips)
 *   - additional excludes    — unit excludes git-release.test.mjs (B4-followup-D);
 *                              mock excludes *.workflow.test.* (B3)
 *
 * Putting isolate/bail/maxForks in base would silently CHANGE fallback's behavior.
 * Keep tier-specific.
 */
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
      },
    },
    setupFiles: ["tests/setup.mjs"],
    clearMocks: true,
    exclude: ["tests/.tmp/**"],
    env: {
      NODE_NO_WARNINGS: "1",
      ROUTEKIT_SKIP_GLOBAL_CONFIG: "true",
    },
  },
});
