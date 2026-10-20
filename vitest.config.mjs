import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.base.mjs";

// Root config — the file vitest resolves for a bare `npx vitest run` (no --config).
// It is NOT a runnable gate: its globalSetup refuses the run and names the supported
// commands (backlog.fix.root-vitest-setupfiles-gate, ARCH Option B). It must stay
// importable, because tests read its effective config. `npm test` runs smoke, not vitest.
//
// Per backlog.fix.vitest-config-drift-reconcile (B5): extends vitest.config.base.mjs.
// Tier-specific overrides below carry `// OVERRIDE-REASON:` comments.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["tests/**/*.test.*", "tests/**/*.spec.*"],
      // OVERRIDE-REASON: root config only — a bare `vitest run` resolves this file and must REFUSE rather than run every tier with no per-tier settings; a run-time throw keeps a plain import() of this config safe. NEVER move this to vitest.config.base.mjs, which would refuse every tier.
      globalSetup: ["tests/_helpers/refuse-bare-root-run.mjs"],
      poolOptions: {
        forks: {
          // OVERRIDE-REASON: fallback tier — this include is the ONLY one sweeping unit + integration + e2e + *.workflow.test.* together, so it runs every heavy git/CLI spawner in the repo, not the unit tier's alone; 4 forks caps that spawn load (backlog.fix.test-fixture-repo-containment corrected the prior claim that the spawners were absent here).
          maxForks: 4,
        },
      },
    },
  }),
);
