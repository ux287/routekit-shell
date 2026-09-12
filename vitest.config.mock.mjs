import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.base.mjs";

// Mock / integration tier — sweeps self-contained tests under tests/integration/.
// Invoked by `npm run test:mock` (the integration-tests CI job).
//
// Filename-suffix convention per backlog.fix.integration-suite-sweeps-tests-with-implicit-prereqs (B3):
// - tests/integration/*.test.mjs        — self-contained; swept by this config
// - tests/integration/*.workflow.test.mjs — workflow-driven; EXCLUDED here, invoked
//   directly from a specific GH Actions workflow that sets up prereqs.
// tests/unit/integration-suite-convention.test.mjs enforces this contract.
//
// Per backlog.fix.vitest-config-drift-reconcile (B5): extends vitest.config.base.mjs.
// Tier-specific overrides below carry `// OVERRIDE-REASON:` comments.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [
        "tests/integration/**/*.test.*",
        "tests/integration/**/*.spec.*",
      ],
      // OVERRIDE-REASON: B3 filename-suffix convention — workflow-driven tests excluded from npm run test:mock; invoked directly from their workflow YAML.
      exclude: ["tests/integration/**/*.workflow.test.*"],
      // OVERRIDE-REASON: mock tier — fast-fail on first failure.
      bail: 1,
      // OVERRIDE-REASON: mock tier — module-state isolation between tests.
      isolate: true,
      poolOptions: {
        forks: {
          // OVERRIDE-REASON: mock tier — integration tests are less subprocess-intensive than unit; 4-way parallelism is safe and faster. NOT subject to Hotfix #10's contention pattern.
          maxForks: 4,
        },
      },
    },
  }),
);
