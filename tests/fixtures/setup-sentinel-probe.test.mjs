// backlog.fix.root-vitest-setupfiles-gate — a refusal TARGET, not a suite member.
//
// tests/unit/root-vitest-config-gate.test.mjs scopes a spawned bare `vitest run` to this one
// named file. Under the fixed root config that run refuses in globalSetup, so this file is
// never expected to execute there. The gate test's positive control runs it once under
// vitest.config.base.mjs (setup loaded, no globalSetup), where it must pass. Its path is matched by the root include
// (tests/**/*.test.*) and by NO tier include (unit: tests/unit/** and tests/*; mock:
// tests/integration/**; e2e: tests/e2e/**; workflow: tests/integration/**/*.workflow.test.*),
// so no tier suite collects it. Do NOT list it in a story's testFiles: exec routes such a
// path to vitest.config.unit.mjs, which does not collect tests/fixtures/**.
//
// If it ever does execute, it fails unless tests/setup.mjs ran first.
import { describe, it, expect } from "vitest";

describe("setup sentinel probe", () => {
  it("tests/setup.mjs executed before this file", () => {
    expect(globalThis.__RKS_SETUP_LOADED__).toBe(true);
  });
});
