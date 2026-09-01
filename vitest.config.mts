import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.*", "tests/unit/**/*.spec.{js,mjs,ts,mts}"],
    exclude: ["tests/.tmp/**"],
    env: {
      NODE_NO_WARNINGS: "1",
      ROUTEKIT_SKIP_GLOBAL_CONFIG: "true",
    },
  },
});
