import { defineConfig } from "vitest/config";

/**
 * Base vitest config for projects scaffolded from this rks template.
 *
 * The sibling `vitest.config.unit.mjs` shim re-exports this file's default so
 * that `rks exec --config vitest.config.unit.mjs` (and `vitest run`) resolve out
 * of the box, BEFORE a freshly-scaffolded child project authors its own config.
 *
 * Kept intentionally minimal and self-contained: it must NOT reference files
 * that only exist in the rks shell repo (e.g. `tests/setup.mjs`,
 * `tests/_helpers/with-temp-dir.mjs`). The shell's own `vitest.config.base.mjs`
 * is shell-specific and is deliberately NOT reused here — this template base is
 * the child-safe canonical source, single-sourced into child projects by both
 * `ensureVitestRunner()` (packages/cli/src/project/bootstrap.mjs) and
 * `scripts/vendor-rks.sh`.
 *
 * Child projects may extend or replace this file freely (e.g. add their own
 * `setupFiles`, `include` globs, or `mergeConfig` against it).
 *
 * See notes/research.2026.06.28.uat-findings.md Finding 1 for why this exists.
 */
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
      },
    },
    include: ["tests/**/*.test.*", "tests/**/*.spec.*"],
    exclude: ["**/node_modules/**", "tests/.tmp/**"],
    clearMocks: true,
    env: {
      NODE_NO_WARNINGS: "1",
    },
  },
});
