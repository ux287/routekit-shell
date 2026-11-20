import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectTestRunner } from "../../packages/mcp-rks/src/exec/command-runner.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "../../..");

function readFile(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

// B5 hotfix: dynamic-import-per-test of the vitest configs was timing out in
// CI (~5734ms vs the 5000ms default test timeout). Importing your own running
// vitest config from within a test triggers Vite re-resolution which is slow
// under CI fork-contention. Load all 4 tier configs ONCE in beforeAll, cache
// in module-level vars, individual tests read from the cache.
let CFG_UNIT, CFG_MOCK, CFG_E2E, CFG_FALLBACK;

beforeAll(async () => {
  [CFG_UNIT, CFG_MOCK, CFG_E2E, CFG_FALLBACK] = await Promise.all([
    import("../../vitest.config.unit.mjs").then((m) => m.default),
    import("../../vitest.config.mock.mjs").then((m) => m.default),
    import("../../vitest.config.e2e.mjs").then((m) => m.default),
    import("../../vitest.config.mjs").then((m) => m.default),
  ]);
}, 60_000);

describe("vitest tier configs", () => {
  // B3 update: assertions now introspect the actual config OBJECT (via dynamic
  // import) rather than raw-string-contain the source. The raw-string form was
  // fragile — adding a doc comment referencing other tiers' paths would trip the
  // `not.toContain("tests/unit/")` form even when the include/exclude arrays
  // were unaffected. The new form checks the resolved include/exclude arrays
  // for each tier's expected paths.
  it("vitest.config.unit.mjs covers tests/unit/** and root tests/*.test.*", () => {
    const include = CFG_UNIT.test?.include ?? [];
    expect(include.some((p) => p.includes("tests/unit/"))).toBe(true);
    expect(include.some((p) => p.includes("tests/*.test."))).toBe(true);
  });

  it("vitest.config.mock.mjs covers only tests/integration/** and excludes *.workflow.test.*", () => {
    const include = CFG_MOCK.test?.include ?? [];
    const exclude = CFG_MOCK.test?.exclude ?? [];
    // Include sweeps tests/integration/, NOT tests/unit/ or tests/e2e/.
    expect(include.some((p) => p.includes("tests/integration/"))).toBe(true);
    expect(include.every((p) => !p.includes("tests/unit/"))).toBe(true);
    expect(include.every((p) => !p.includes("tests/e2e/"))).toBe(true);
    // B3 filename-suffix convention: workflow-driven tests are excluded.
    expect(exclude.some((p) => p.includes("*.workflow.test."))).toBe(true);
  });

  it("vitest.config.e2e.mjs covers only tests/e2e/**", () => {
    const include = CFG_E2E.test?.include ?? [];
    expect(include.some((p) => p.includes("tests/e2e/"))).toBe(true);
    expect(include.every((p) => !p.includes("tests/unit/"))).toBe(true);
    expect(include.every((p) => !p.includes("tests/integration/"))).toBe(true);
  });

  // B5 update: assert effective merged config (post mergeConfig), not raw source.
  // The base settings (pool, clearMocks) live in vitest.config.base.mjs after B5
  // and are merged in via mergeConfig; raw substrings only appear in the base.
  // isolate is tier-specific (unit/mock/e2e: true; fallback: not set).
  it("unit tier has pool: forks, isolate: true, clearMocks: true (via merged config)", () => {
    expect(CFG_UNIT.test?.pool).toBe("forks");
    expect(CFG_UNIT.test?.isolate).toBe(true);
    expect(CFG_UNIT.test?.clearMocks).toBe(true);
  });

  it("mock tier has pool: forks, isolate: true, clearMocks: true (via merged config)", () => {
    expect(CFG_MOCK.test?.pool).toBe("forks");
    expect(CFG_MOCK.test?.isolate).toBe(true);
    expect(CFG_MOCK.test?.clearMocks).toBe(true);
  });

  it("e2e tier has pool: forks, isolate: true, clearMocks: true (via merged config)", () => {
    expect(CFG_E2E.test?.pool).toBe("forks");
    expect(CFG_E2E.test?.isolate).toBe(true);
    expect(CFG_E2E.test?.clearMocks).toBe(true);
  });
});

describe("vitest-runner.mjs", () => {
  const src = readFile("scripts/vitest-runner.mjs");

  it("delegates process-group spawn to spawnManagedInherit", () => {
    expect(src).toContain("spawnManagedInherit");
  });

  it("accepts --config CLI flag and forwards to vitest", () => {
    expect(src).toContain("config");
    expect(src).toContain("configArg");
    expect(src).toContain(`"--config"`);
  });

  it("accepts --timeout CLI flag and uses it as the hard wall-clock timeout", () => {
    expect(src).toContain("flags.timeout");
    expect(src).toContain("timeoutMs");
  });

  it("exits with the vitest exit code on clean completion", () => {
    expect(src).toContain("process.exit(code");
  });
});

describe("spawn-managed.mjs", () => {
  const src = readFile("scripts/lib/spawn-managed.mjs");

  it("spawns with detached: true for process-group management", () => {
    expect(src).toContain("detached: true");
  });

  it("installs SIGTERM, SIGINT, and exit handlers that call process.kill(-pgid)", () => {
    expect(src).toContain(`process.kill(-pgid`);
    expect(src).toContain(`SIGTERM`);
    expect(src).toContain(`SIGINT`);
    expect(src).toContain(`child.on("exit"`);
  });

  it("enforces a hard wall-clock timeout that kills the process group", () => {
    expect(src).toContain("setTimeout");
    expect(src).toContain("timeoutMs");
    expect(src).toContain("120_000");
  });
});

describe("package.json scripts", () => {
  const pkg = JSON.parse(readFile("package.json"));

  it("test:unit uses vitest-runner.mjs with vitest.config.unit.mjs", () => {
    expect(pkg.scripts["test:unit"]).toBe(
      "node scripts/vitest-runner.mjs --timeout 3600000 --config vitest.config.unit.mjs"
    );
  });

  it("test:mock uses vitest-runner.mjs with vitest.config.mock.mjs", () => {
    expect(pkg.scripts["test:mock"]).toBe(
      "node scripts/vitest-runner.mjs --timeout 3600000 --config vitest.config.mock.mjs"
    );
  });

  it("test:e2e uses vitest-runner.mjs with vitest.config.e2e.mjs", () => {
    expect(pkg.scripts["test:e2e"]).toBe(
      "node scripts/vitest-runner.mjs --timeout 3600000 --config vitest.config.e2e.mjs"
    );
  });
});

describe("detectTestRunner regression", () => {
  it("still resolves test:unit as first-priority script", () => {
    const result = detectTestRunner(ROOT);
    expect(result).toEqual({ cmd: "npm", args: ["run", "test:unit"] });
  });
});
