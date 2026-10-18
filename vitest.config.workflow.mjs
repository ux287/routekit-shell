import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.base.mjs";

// Workflow tier — the explicit, supported route for workflow-driven tests
// (tests/integration/**/*.workflow.test.*, the B3 filename-suffix convention).
// Those files are EXCLUDED from `npm run test:mock` (vitest.config.mock.mjs) because they
// need a workflow step to build their prereqs first, and a bare `npx vitest run` refuses
// (vitest.config.mjs globalSetup). Invoke one file at a time, from its workflow YAML:
//   npx vitest run --config vitest.config.workflow.mjs <path>
// e.g. .github/workflows/release-smoke.yml.
//
// Per backlog.fix.vitest-config-drift-reconcile (B5): extends vitest.config.base.mjs, so
// tests/setup.mjs loads. Declares NO globalSetup (backlog.fix.root-vitest-setupfiles-gate).
// Tier-specific overrides below carry `// OVERRIDE-REASON:` comments.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      // OVERRIDE-REASON: workflow tier — collects ONLY workflow-driven files, each run from the workflow that builds its prereqs.
      include: ["tests/integration/**/*.workflow.test.*"],
    },
  }),
);
