import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * Child-safe test setup for the web-vite-rag-agency DOM stack.
 *
 * Referenced by `./vitest.config.base.mjs` setupFiles. References NO shell-only
 * path, so it is safe to ship into a scaffolded child.
 *
 *  - `@testing-library/jest-dom/vitest` registers the jest-dom matchers on
 *    vitest's `expect` (e.g. `toBeInTheDocument`).
 *  - `afterEach(cleanup)` unmounts React trees after each test so queries like
 *    `getByText` do not collide across tests.
 */
afterEach(() => {
  cleanup();
});
