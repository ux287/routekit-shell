import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.base.mjs";

// Fallback tier — sweeps tests/**/* with no tier-specific scoping.
// Used by `npm test` without an explicit --config flag.
//
// Per backlog.fix.vitest-config-drift-reconcile (B5): extends vitest.config.base.mjs.
// Tier-specific overrides below carry `// OVERRIDE-REASON:` comments.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["tests/**/*.test.*", "tests/**/*.spec.*"],
      poolOptions: {
        forks: {
          // OVERRIDE-REASON: fallback tier — this include is the ONLY one sweeping unit + integration + e2e + *.workflow.test.* together, so it runs every heavy git/CLI spawner in the repo, not the unit tier's alone; 4 forks caps that spawn load (backlog.fix.test-fixture-repo-containment corrected the prior claim that the spawners were absent here).
          maxForks: 4,
        },
      },
    },
  }),
);
