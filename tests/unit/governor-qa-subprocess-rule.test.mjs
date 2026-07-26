import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../../..");
const QA_PROMPT = readFileSync(join(ROOT, ".rks/prompts/governor-qa.md"), "utf8");

describe("governor-qa.md subprocess timeout rule", () => {
  it("contains a Subprocess Timeout Rule section", () => {
    expect(QA_PROMPT).toContain("## Subprocess Timeout Rule (Path 2)");
  });

  it("Subprocess Timeout Rule section appears before ## Rules", () => {
    const subprocessIdx = QA_PROMPT.indexOf("## Subprocess Timeout Rule (Path 2)");
    const rulesIdx = QA_PROMPT.indexOf("## Rules");
    expect(subprocessIdx).toBeGreaterThan(-1);
    expect(rulesIdx).toBeGreaterThan(-1);
    expect(subprocessIdx).toBeLessThan(rulesIdx);
  });

  it("names all three subprocess API variants: spawnSync, spawn, execa", () => {
    expect(QA_PROMPT).toContain("spawnSync");
    expect(QA_PROMPT).toContain("`spawn`");
    expect(QA_PROMPT).toContain("execa");
  });

  it("includes the concrete timeout: 15_000 example for spawnSync", () => {
    expect(QA_PROMPT).toContain("timeout: 15_000");
  });

  it("includes the setTimeout kill guard pattern for spawn/execa", () => {
    expect(QA_PROMPT).toContain("setTimeout");
    expect(QA_PROMPT).toContain("clearTimeout");
    expect(QA_PROMPT).toContain("proc.kill()");
  });

  it("instructs QA Governor to add a testRequirement for subprocess timeout guards", () => {
    expect(QA_PROMPT).toContain("TestRequirement to add");
    expect(QA_PROMPT).toContain("subprocess");
  });

  it("all existing sections remain present and unmodified", () => {
    expect(QA_PROMPT).toContain("## Verbosity");
    expect(QA_PROMPT).toContain("## Path Selection");
    expect(QA_PROMPT).toContain("## Path 1 — Post-Build Validation");
    expect(QA_PROMPT).toContain("## Path 2 — Story Review");
    expect(QA_PROMPT).toContain("## Decomposed Child — Test Coverage Rule (Path 2)");
    expect(QA_PROMPT).toContain("## Rules");
    expect(QA_PROMPT).toContain("## Tool Allowlist");
  });
});
