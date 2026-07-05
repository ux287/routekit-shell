import { defineConfig } from "vitest/config";

/**
 * DOM-stack vitest base config for the web-vite-rag-agency template.
 *
 * Lives UNDER skeleton/ so the per-stack skeleton copy (init-stack.js) delivers
 * it to a scaffolded child's root. The child's `vitest.config.unit.mjs` shim
 * re-exports `./vitest.config.base.mjs`, which resolves to this file. Because
 * the skeleton copy runs before `ensureVitestRunner()`'s no-overwrite guard,
 * this jsdom base WINS over the generic, stack-neutral `templates/base` config.
 *
 * `environment: 'jsdom'` is the default, so component tests render a DOM with
 * NO per-file `// @vitest-environment jsdom` pragma. `setupFiles` wires the
 * child-safe `./vitest.setup.mjs` (afterEach cleanup + jest-dom matchers).
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.mjs"],
    include: [
      "src/**/*.{test,spec}.{ts,tsx,js,jsx,mjs}",
      "tests/**/*.{test,spec}.{ts,tsx,js,jsx,mjs}",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    clearMocks: true,
  },
});
