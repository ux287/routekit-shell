import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.base.mjs";

// E2E tier — sweeps tests/e2e/**.
// Invoked by `npm run test:e2e` (the e2e-tests CI job, gated on vars.RKS_E2E_ENABLED).
//
// Per backlog.fix.vitest-config-drift-reconcile (B5): extends vitest.config.base.mjs.
// Tier-specific overrides below carry `// OVERRIDE-REASON:` comments.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [
        "tests/e2e/**/*.test.*",
        "tests/e2e/**/*.spec.*",
      ],
      // OVERRIDE-REASON: e2e tier — fast-fail on first failure (each test is expensive).
      bail: 1,
      // OVERRIDE-REASON: e2e tier — module-state isolation between tests.
      isolate: true,
      // OVERRIDE-REASON: e2e tier — tests include LLM API roundtrips (typical 30-60s wall-clock); 60s per-test timeout matches the ceiling of normal traffic.
      testTimeout: 60000,
      poolOptions: {
        forks: {
          // OVERRIDE-REASON: e2e tier — concurrent LLM API calls risk provider rate-limit; 2-way keeps RPS low.
          maxForks: 2,
        },
      },
    },
  }),
);
