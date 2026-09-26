import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const VITE_CONFIG_PATH = resolve(
  new URL(".", import.meta.url).pathname,
  "../../packages/telemetry-dashboard/vite.config.ts"
);

describe("telemetry-dashboard vite.config.ts", () => {
  const source = readFileSync(VITE_CONFIG_PATH, "utf8");

  it("server.port is set to 1337", () => {
    expect(source).toMatch(/port:\s*1337/);
  });

  it("server.port is not set to 5173", () => {
    expect(source).not.toMatch(/port:\s*5173/);
  });

  it("no file in the project hardcodes port 5173 for the dashboard server", () => {
    // This test verifies the source file itself — broader repo scan is in CI
    expect(source).not.toContain("5173");
  });
});
