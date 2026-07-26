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
          // OVERRIDE-REASON: fallback tier — broader-than-unit parallelism; no Hotfix #10 trigger here because the heavy git/CLI spawners only run via the unit tier glob.
          maxForks: 4,
        },
      },
    },
  }),
);
