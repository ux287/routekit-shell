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

describe("ci.yml — sharding comment accuracy", () => {
  // PERMANENT. These two assertions guard the comment correction, which survives the
  // revert of the temporary diagnostic instrumentation. That instrumentation and its
  // dedicated test file were removed together by
  // backlog.fix.revert-ci-unit-shard-probe, once the allocator behind the
  // unit-shard SIGTERM was identified by 54602ef4.
  it("no longer claims the unit suite shards alphabetically", () => {
    expect(ciSrc).not.toContain("alphabetically");
    expect(ciSrc).toContain("The unit suite is sharded 2-way.");
  });

  it("cites run 31462012004 as the disproof and states the partition rule is not established", () => {
    expect(ciSrc).toContain("31462012004");
    expect(ciSrc).toMatch(/not established/i);
  });
});

describe("ci.yml — unit-tests run block structural integrity", () => {
  // RE-HOMED from the deleted diagnostic test file, which held the only assertion
  // that this workflow parses at all. Removing multi-line shell (nested single and
  // double quotes) from a `run:` block is the highest-probability mechanical
  // failure of that revert, so the guard must outlive the thing it guarded.
  //
  // The module-scope yaml.load above would already throw on a broken file and redden
  // this whole suite — this states the guarantee explicitly rather than leaving it
  // incidental to import order.
  const unitStep = () =>
    ci.jobs["unit-tests"].steps.find((s) => s.run && s.run.includes("vitest-runner.mjs"));

  it("parses as YAML and resolves a non-empty unit-tests steps array", () => {
    expect(() => yaml.load(ciSrc)).not.toThrow();
    const steps = ci.jobs["unit-tests"].steps;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
  });

  it("leaves no orphaned subshell or backgrounding operator behind", () => {
    const step = unitStep();
    expect(step).toBeDefined();
    // The removed loop was wrapped in a `(` ... `) &` pair sitting ~17 lines apart.
    // Orphaning either half is the specific way this edit breaks the step.
    const opens = (step.run.match(/\(/g) || []).length;
    const closes = (step.run.match(/\)/g) || []).length;
    expect(opens).toBe(closes);
    expect(step.run).not.toMatch(/\)\s*&\s*$/m);
  });

  it("carries no residue of the removed diagnostic instrumentation", () => {
    const run = unitStep().run;
    expect(run).not.toContain("[probe]");
    expect(run).not.toMatch(/while\s+true/);
    expect(run).not.toMatch(/ps\s+-eo/);
    expect(run).not.toMatch(/pgrep/);
    expect(run).not.toMatch(/free\s+-m/);
    // The shard stagger existed ONLY to separate the two shards' sampling curves.
    // With no sampling it is pure CI latency — ~180s on shard 2 against a 17s suite.
    expect(ciSrc).not.toMatch(/\*\s*180/);
  });

  it("preserves the vitest JSON report plumbing the /ci skill depends on", () => {
    const steps = ci.jobs["unit-tests"].steps;
    expect(unitStep().env?.ROUTEKIT_VITEST_JSON_OUTPUT).toBeTruthy();
    const summary = steps.find((s) => s.run && s.run.includes("analyze-vitest-report.mjs"));
    expect(summary).toBeDefined();
    const upload = steps.find((s) => s.name === "Upload vitest JSON report");
    expect(upload).toBeDefined();
    expect(upload.with.name).toContain("vitest-unit-report");
    expect(upload.with.path).toContain(".rks/test-reports/");
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
