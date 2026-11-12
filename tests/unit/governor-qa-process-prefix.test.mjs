// governor-qa.md emits the '[process] ' prefix (AC11). Durable-phrase toContain only. No subprocess.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../../..");
const QA_PROMPT = readFileSync(join(ROOT, ".rks/prompts/governor-qa.md"), "utf8");

describe("governor-qa.md [process] prefix", () => {
  it("prescribes the subprocess-timeout requirement with the [process] prefix", () => {
    expect(QA_PROMPT).toContain("[process] All subprocess spawns in test file use explicit timeout");
    // The unprefixed prescription is gone: every occurrence of the requirement text carries the prefix.
    const occurrences = QA_PROMPT.split("All subprocess spawns in test file use explicit timeout").length - 1;
    const prefixed = QA_PROMPT.split("[process] All subprocess spawns in test file use explicit timeout").length - 1;
    expect(occurrences).toBeGreaterThan(0);
    expect(prefixed).toBe(occurrences);
  });

  it("defines the prefix rule for constraint and pre-existing-tests-pass requirements; no mapped test needed (AC11)", () => {
    // The rule names the literal prefix, including its trailing space.
    expect(QA_PROMPT).toContain('"[process] "');
    expect(QA_PROMPT).toContain("Process requirements");
    // Who carries it: constraint requirements and pre-existing-tests-pass (regression) requirements.
    expect(QA_PROMPT).toContain("constraint requirements");
    expect(QA_PROMPT).toContain("pre-existing-tests-pass (regression) requirements");
    // What it means: no mapped test.
    expect(QA_PROMPT).toContain("A process requirement needs no mapped test");
    // A worked regression example carries the prefix.
    expect(QA_PROMPT).toContain('"[process] Every pre-existing test in the regression witness files listed in targetFiles passes"');
    // The rule sits in Path 2 step 3, where testRequirements are generated, before the regression-witness scan.
    const step3 = QA_PROMPT.indexOf("3. Generate testRequirements from acceptance criteria:");
    const step4 = QA_PROMPT.indexOf("4. Identify test file targets");
    const rule = QA_PROMPT.indexOf("Process requirements");
    expect(step3).toBeGreaterThan(-1);
    expect(rule).toBeGreaterThan(step3);
    expect(rule).toBeLessThan(step4);
  });
});
