import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = join(fileURLToPath(import.meta.url), "../../..");
const ciSrc = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const ci = yaml.load(ciSrc);

describe("ci.yml — unit-tests job", () => {
  it("has a unit-tests job", () => {
    expect(ci.jobs["unit-tests"]).toBeDefined();
  });

  it("unit-tests job runs the vitest unit config via scripts/vitest-runner.mjs", () => {
    // Tier 1 (notes/research.2026.06.15.test-suite-bloat-audit-and-tier-redesign.md §6):
    // the step previously ran `npm run test:unit` (which invoked the runner) but
    // now invokes the runner directly so the matrix shard arg can be passed via
    // `--shard=${{ matrix.shard }}/2`. We pin the runner + the unit config + the
    // shard flag, all of which together prove the unit suite is being executed.
    const steps = ci.jobs["unit-tests"].steps;
    const testStep = steps.find(s => s.run && s.run.includes("vitest-runner.mjs"));
    expect(testStep).toBeDefined();
    expect(testStep.run).toContain("scripts/vitest-runner.mjs");
    expect(testStep.run).toContain("vitest.config.unit.mjs");
    expect(testStep.run).toContain("--shard=");
  });

  it("unit-tests job triggers on push and PR to main and staging", () => {
    const branches = [
      ...(ci.on?.push?.branches ?? []),
      ...(ci.on?.pull_request?.branches ?? []),
    ];
    expect(branches).toContain("main");
    expect(branches).toContain("staging");
  });
});

describe("ci.yml — integration-tests job", () => {
  it("has an integration-tests job", () => {
    expect(ci.jobs["integration-tests"]).toBeDefined();
  });

  it("integration-tests job runs npm run test:mock", () => {
    const steps = ci.jobs["integration-tests"].steps;
    const testStep = steps.find(s => s.run && s.run.includes("test:mock"));
    expect(testStep).toBeDefined();
    expect(testStep.run).toContain("npm run test:mock");
  });

  it("integration-tests declares needs: unit-tests", () => {
    const needs = ci.jobs["integration-tests"].needs;
    const needsArr = Array.isArray(needs) ? needs : [needs];
    expect(needsArr).toContain("unit-tests");
  });

  it("integration-tests is scoped to staging branch events via if condition", () => {
    const ifCond = ci.jobs["integration-tests"].if ?? "";
    expect(String(ifCond)).toMatch(/staging/);
  });
});

describe("ci.yml — triggers", () => {
  it("has workflow_dispatch trigger", () => {
    expect(ci.on.workflow_dispatch).toBeDefined();
  });

  it("has schedule cron trigger", () => {
    expect(ci.on.schedule).toBeDefined();
    const crons = ci.on.schedule.map(s => s.cron);
    expect(crons.length).toBeGreaterThan(0);
    expect(crons[0]).toMatch(/^\d+ \d+ /);
  });
});

describe("ci.yml — e2e-tests job", () => {
  it("has an e2e-tests job", () => {
    expect(ci.jobs["e2e-tests"]).toBeDefined();
  });

  it("e2e-tests job is conditional on secrets.RKS_E2E_ENABLED", () => {
    const ifCond = String(ci.jobs["e2e-tests"].if ?? "");
    expect(ifCond).toContain("RKS_E2E_ENABLED");
  });
});

describe("how-to.test-tiers.e2e-invocation.md", () => {
  const howTo = readFileSync(
    join(ROOT, "notes/how-to.test-tiers.e2e-invocation.md"),
    "utf8"
  );

  it("documents manual invocation via gh workflow run", () => {
    expect(howTo).toContain("gh workflow run");
  });

  it("documents required secrets and environment variables", () => {
    expect(howTo).toContain("RKS_E2E_ENABLED");
    expect(howTo).toContain("ANTHROPIC_API_KEY");
  });

  it("documents local npm run test:e2e command", () => {
    expect(howTo).toContain("npm run test:e2e");
  });

  it("documents trigger conditions (nightly, Tier-2 failure, bug report)", () => {
    expect(howTo).toMatch(/nightly/i);
    expect(howTo).toMatch(/tier 2|mock.*fail|fail.*mock/i);
    expect(howTo).toMatch(/bug/i);
  });
});
