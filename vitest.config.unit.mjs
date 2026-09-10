import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.base.mjs";

// Unit tier — sweeps tests/unit/** and root-level tests/*.test.*.
// Invoked by `npm run test:unit` (which routes through scripts/vitest-runner.mjs).
//
// Per backlog.fix.vitest-config-drift-reconcile (B5): extends vitest.config.base.mjs.
// Tier-specific overrides below carry `// OVERRIDE-REASON:` comments.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [
        "tests/unit/**/*.test.*",
        "tests/unit/**/*.spec.*",
        "tests/*.test.*",
        "tests/*.spec.*",
      ],
      // OVERRIDE-REASON: Tier-2 (backlog.feat.test-suite-tier-2-unit-tier-bloat-audit, AC3) — sweep tests/.tmp/ ONCE after every fork exits. Runs in the parent process, not inside the test runner, so it cannot race against parallel forks the way a setupFiles afterAll would. Implementation lives in tests/_helpers/with-temp-dir.mjs.
      globalTeardown: ["tests/_helpers/with-temp-dir.mjs"],
      // OVERRIDE-REASON: unit tier — fast-fail on first failure to surface signal quickly during the ~50min CI suite.
      bail: 1,
      // OVERRIDE-REASON: unit tier — module-state isolation between tests; many unit tests mutate process.env / globals.
      isolate: true,
      // OVERRIDE-REASON: unit tier — beforeEach hooks often run makeTempDir + git init; 30s gives headroom on cold CI runners.
      hookTimeout: 30000,
      // OVERRIDE-REASON: tier-1 audit §6 — vitest's 5s default flakes on cold-import + subprocess tests in CI; 60s covers the ~28 subprocess-using files. See notes/research.2026.06.15.test-suite-bloat-audit-and-tier-redesign.md.
      testTimeout: 60_000,
      poolOptions: {
        forks: {
          // OVERRIDE-REASON: Hotfix #10 — subprocess-spawning tests (project-doctor, vendor-rks-distribution) hit spawnSync ETIMEDOUT under 4-way parallelism on CI runners.
          maxForks: 2,
        },
      },
    },
  }),
);
