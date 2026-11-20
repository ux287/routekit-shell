// Pure-helper tests for backlog.fix.exec-test-requirements-coverage-gate (exec/test-results.mjs).
// No subprocess, no file system: per-test results objects are built inline.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import * as tr from "../../packages/mcp-rks/src/exec/test-results.mjs";
import { parseFrontmatter, spliceNoteFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";

const POLICY_SOURCE = ".rks/project.json#testRequirementCoverage.acceptUnverified";
const A = "tests/unit/a.test.mjs";

/** A vitest JSON report with one file; each assertion is { titles: [...describe, title], status }. */
function vitestResults(files) {
  const report = {
    testResults: Object.entries(files).map(([name, assertions]) => ({
      name,
      status: assertions.some((a) => a.status === "failed") ? "failed" : "passed",
      assertionResults: assertions.map((a) => ({ ancestorTitles: a.titles.slice(0, -1), title: a.titles[a.titles.length - 1], status: a.status })),
    })),
  };
  return tr.parseVitestJsonReport(report, null);
}

const evaluate = (over) => tr.evaluateRequirementCoverage({
  testRequirements: ["req zero"],
  requirementCoverage: [{ index: 0, testFile: A, path: "suite > does x" }],
  verificationSkipped: false,
  ...over,
});

describe("isProcessRequirement", () => {
  it("true only for the literal '[process] ' prefix (AC4)", () => {
    expect(tr.isProcessRequirement("[process] Every pre-existing test passes")).toBe(true);
    expect(tr.isProcessRequirement("[process] x")).toBe(true);
    expect(tr.isProcessRequirement("process x")).toBe(false);
    expect(tr.isProcessRequirement("[Process] x")).toBe(false);
    expect(tr.isProcessRequirement(" [process] x")).toBe(false);
    expect(tr.isProcessRequirement("[process]x")).toBe(false);
    expect(tr.isProcessRequirement("")).toBe(false);
    expect(tr.isProcessRequirement(null)).toBe(false);
    expect(tr.isProcessRequirement(undefined)).toBe(false);
    expect(tr.isProcessRequirement(42)).toBe(false);
    expect(tr.isProcessRequirement({ text: "[process] x" })).toBe(false);
  });
});

describe("requirement resolution - vitest", () => {
  it("covered when remainder equals path or ends with ' > ' + path (AC2)", () => {
    const exact = evaluate({ results: vitestResults({ [A]: [{ titles: ["suite", "does x"], status: "passed" }] }) });
    expect(exact.ok).toBe(true);
    expect(exact.outcome).toBe("covered");
    expect(exact.entries[0]).toMatchObject({ index: 0, kind: "test", coverage: "covered", observedId: `${A} > suite > does x`, observedStatus: "passed" });

    const nested = evaluate({ results: vitestResults({ [A]: [{ titles: ["outer", "suite", "does x"], status: "passed" }] }) });
    expect(nested.ok).toBe(true);
    expect(nested.entries[0].observedId).toBe(`${A} > outer > suite > does x`);

    expect(tr.observedIdMatchesEntry(`${A} > suite > does x`, { index: 0, testFile: A, path: "suite > does x" }, "vitest")).toBe(true);
    expect(tr.observedIdMatchesEntry(`${A} > outer > suite > does x`, { index: 0, testFile: A, path: "suite > does x" }, "vitest")).toBe(true);
  });

  it("not_observed off a ' > ' boundary or in another file (AC2)", () => {
    const offBoundary = tr.evaluateRequirementCoverage({
      testRequirements: ["r"],
      requirementCoverage: [{ index: 0, testFile: A, path: "does x" }],
      results: vitestResults({ [A]: [{ titles: ["also does x"], status: "passed" }] }),
    });
    expect(offBoundary.ok).toBe(false);
    expect(offBoundary.status).toBe("test_requirements_uncovered");
    expect(offBoundary.uncoveredRequirements).toEqual([{ index: 0, text: "r", cause: "not_observed" }]);

    const otherFile = evaluate({ results: vitestResults({ "tests/unit/b.test.mjs": [{ titles: ["suite", "does x"], status: "passed" }] }) });
    expect(otherFile.ok).toBe(false);
    expect(otherFile.uncoveredRequirements).toEqual([{ index: 0, text: "req zero", cause: "not_observed" }]);
  });

  it("failed / skipped / pending / todo / disabled candidates are uncovered (AC2)", () => {
    const failed = evaluate({ results: vitestResults({ [A]: [{ titles: ["suite", "does x"], status: "failed" }] }) });
    expect(failed.ok).toBe(false);
    expect(failed.uncoveredRequirements[0].cause).toBe("failed");
    for (const status of ["skipped", "pending", "todo", "disabled"]) {
      const r = evaluate({ results: vitestResults({ [A]: [{ titles: ["suite", "does x"], status }] }) });
      expect(r.ok, status).toBe(false);
      expect(r.status, status).toBe("test_requirements_uncovered");
      expect(r.uncoveredRequirements[0].cause, status).toBe("skipped");
    }
    // Derived from the outcome lists when no raw assertion list exists (e.g. merged partitions).
    const listsOnly = { available: true, runner: "vitest", passed: [], failed: [`${A} > suite > does x`], failing: [`${A} > suite > does x`], error: [], skipped: [] };
    expect(evaluate({ results: listsOnly }).uncoveredRequirements[0].cause).toBe("failed");
  });

  it("ambiguous counted from raw assertions, not the uniq list (AC2)", () => {
    const dup = vitestResults({ [A]: [{ titles: ["suite", "does x"], status: "passed" }, { titles: ["suite", "does x"], status: "passed" }] });
    // The de-duplicated list holds ONE id; the raw list holds two.
    expect(dup.passed).toEqual([`${A} > suite > does x`]);
    expect(dup.assertions).toHaveLength(2);
    const r = evaluate({ results: dup });
    expect(r.ok).toBe(false);
    expect(r.uncoveredRequirements).toEqual([{ index: 0, text: "req zero", cause: "ambiguous" }]);

    const twoDistinct = evaluate({ results: vitestResults({ [A]: [{ titles: ["one", "suite", "does x"], status: "passed" }, { titles: ["two", "suite", "does x"], status: "passed" }] }) });
    expect(twoDistinct.ok).toBe(false);
    expect(twoDistinct.uncoveredRequirements[0].cause).toBe("ambiguous");
  });

  it("unmapped requirement; uncovered entry carries index, verbatim text, cause (AC1/AC2)", () => {
    const reqs = ["first: does x", "second  with  odd   spacing > and > arrows", "[process] constraint"];
    const r = tr.evaluateRequirementCoverage({
      testRequirements: reqs,
      requirementCoverage: [{ index: 0, testFile: A, path: "suite > does x" }],
      results: vitestResults({ [A]: [{ titles: ["suite", "does x"], status: "passed" }] }),
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("test_requirements_uncovered");
    expect(r.uncoveredRequirements).toEqual([{ index: 1, text: reqs[1], cause: "unmapped" }]);
    // An entry with an empty testFile or path is not a mapping.
    const empty = tr.evaluateRequirementCoverage({
      testRequirements: ["r"],
      requirementCoverage: [{ index: 0, testFile: "", path: "suite > does x" }, { index: 0, testFile: A, path: "" }],
      results: vitestResults({ [A]: [{ titles: ["suite", "does x"], status: "passed" }] }),
    });
    expect(empty.uncoveredRequirements).toEqual([{ index: 0, text: "r", cause: "unmapped" }]);
  });
});

describe("requirement resolution - pytest", () => {
  it("covered only on testFile + '::' + path segments joined by '::' (AC2)", () => {
    const pyEntry = { index: 0, testFile: "tests/test_a.py", path: "TestA > test_x" };
    const pyResults = (passed) => ({ available: true, runner: "pytest", passed, failed: [], error: [], failing: [], xfailed: [], xpassed: [], skipped: [] });
    const ok = tr.evaluateRequirementCoverage({ testRequirements: ["r"], requirementCoverage: [pyEntry], results: pyResults(["tests/test_a.py::TestA::test_x"]) });
    expect(ok.ok).toBe(true);
    expect(ok.entries[0]).toMatchObject({ coverage: "covered", observedId: "tests/test_a.py::TestA::test_x", observedStatus: "passed" });
    for (const other of ["tests/test_a.py::test_x", "tests/test_a.py::Outer::TestA::test_x", "tests/test_b.py::TestA::test_x", "tests/test_a.py > TestA > test_x"]) {
      const r = tr.evaluateRequirementCoverage({ testRequirements: ["r"], requirementCoverage: [pyEntry], results: pyResults([other]) });
      expect(r.ok, other).toBe(false);
      expect(r.uncoveredRequirements[0].cause, other).toBe("not_observed");
    }
  });
});

describe("process requirements and unavailable results", () => {
  it("process requirements excluded, recorded kind process; all-process story covered (AC4)", () => {
    const reqs = ["[process] Every pre-existing test passes", "does x"];
    const r = tr.evaluateRequirementCoverage({
      testRequirements: reqs,
      requirementCoverage: [{ index: 1, testFile: A, path: "suite > does x" }],
      results: vitestResults({ [A]: [{ titles: ["suite", "does x"], status: "passed" }] }),
    });
    expect(r.ok).toBe(true);
    expect(r.entries[0]).toEqual({ index: 0, kind: "process", coverage: "process" });
    expect(r.entries[1].kind).toBe("test");

    // Unmapped process requirement plus an uncovered test requirement: only the test one is named.
    const miss = tr.evaluateRequirementCoverage({ testRequirements: reqs, requirementCoverage: [], results: vitestResults({ [A]: [] }) });
    expect(miss.uncoveredRequirements.map((u) => u.index)).toEqual([1]);

    // All-process: covered with no map, no results, even with verification skipped.
    const allProcess = ["[process] a", "[process] b"];
    for (const input of [{ results: null }, { results: { ...tr.UNAVAILABLE("timeout"), runner: "vitest" } }, { results: null, verificationSkipped: true }]) {
      const ap = tr.evaluateRequirementCoverage({ testRequirements: allProcess, requirementCoverage: null, ...input });
      expect(ap.ok).toBe(true);
      expect(ap.outcome).toBe("covered");
      expect(ap.entries).toEqual([{ index: 0, kind: "process", coverage: "process" }, { index: 1, kind: "process", coverage: "process" }]);
    }
  });

  it("unavailable results or verificationSkipped -> unverifiable with adapter and reason (AC3)", () => {
    const cases = [
      [{ ...tr.UNAVAILABLE("runner_not_recognized"), runner: null }, "runner_not_recognized", null],
      [{ ...tr.UNAVAILABLE("timeout"), runner: "vitest" }, "timeout", "vitest"],
      [tr.parseVitestJsonReport(null, null), "report_missing", "vitest"],
      [tr.parseVitestJsonReport("{not json", null), "report_unparseable", "vitest"],
      [tr.parseVitestJsonReport({ nope: true }, null), "report_malformed", "vitest"],
    ];
    for (const [results, reason, adapter] of cases) {
      const r = evaluate({ results });
      expect(r.ok, reason).toBe(false);
      expect(r.status, reason).toBe("test_requirements_unverifiable");
      expect(r.reason, reason).toBe(reason);
      expect(r.adapter, reason).toBe(adapter);
      expect(r).not.toHaveProperty("entries");
      expect(JSON.stringify(r)).not.toContain('"covered"');
    }
    const skipped = evaluate({ results: vitestResults({ [A]: [{ titles: ["suite", "does x"], status: "passed" }] }), verificationSkipped: true });
    expect(skipped.ok).toBe(false);
    expect(skipped.status).toBe("test_requirements_unverifiable");
    expect(skipped.reason).toBe("verification_skipped");
    expect(skipped).not.toHaveProperty("entries");
  });

  it("QA/reviewer verdict input does not change the outcome (AC8)", () => {
    const uncoveredInput = { results: vitestResults({ [A]: [{ titles: ["suite", "does x"], status: "failed" }] }) };
    const unverifiableInput = { results: { ...tr.UNAVAILABLE("runner_not_recognized"), runner: null } };
    const baseU = evaluate(uncoveredInput);
    const baseV = evaluate(unverifiableInput);
    for (const verdict of ["pass", "warn"]) {
      const withU = evaluate({ ...uncoveredInput, qaVerdict: verdict, reviewerVerdict: verdict, verdict, qaResult: { verdict } });
      const withV = evaluate({ ...unverifiableInput, qaVerdict: verdict, reviewerVerdict: verdict, verdict, qaResult: { verdict } });
      expect(withU).toEqual(baseU);
      expect(withU.status).toBe("test_requirements_uncovered");
      expect(withV).toEqual(baseV);
      expect(withV.status).toBe("test_requirements_unverifiable");
    }
  });
});

describe("coverage record", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("observedId/observedStatus from results; digest sha256(JSON.stringify(testRequirements)); commit equals the supplied sha (AC5)", () => {
    const reqs = ["does x", "[process] constraint"];
    // The plan map deliberately carries decoy observed fields: the record must not read them.
    const map = [{ index: 0, testFile: A, path: "does x", observedId: "DECOY", observedStatus: "DECOY" }];
    const results = vitestResults({ [A]: [{ titles: ["outer", "does x"], status: "passed" }] });
    const evaluation = tr.evaluateRequirementCoverage({ testRequirements: reqs, requirementCoverage: map, results });
    const record = tr.buildRequirementCoverageRecord({ evaluation, testRequirements: reqs, runId: "run-1", commit: SHA, recordedAt: "2026-11-01T00:00:00.000Z" });
    expect(record.commit).toBe(SHA);
    expect(record.runId).toBe("run-1");
    expect(record.verification).toBe("observed");
    expect(record).not.toHaveProperty("unverified");
    expect(record.requirementsDigest).toBe(createHash("sha256").update(JSON.stringify(reqs)).digest("hex"));
    expect(record.requirements).toEqual([
      { index: 0, kind: "test", coverage: "covered", testFile: A, path: "does x", observedId: `${A} > outer > does x`, observedStatus: "passed" },
      { index: 1, kind: "process", coverage: "process" },
    ]);
    expect(results.passed).toContain(record.requirements[0].observedId);
  });

  it("no commit sha -> builder returns null; 40-hex record round-trips through shared/frontmatter.mjs with every top-level key; commit: null object reads back with no commit key (AC15)", () => {
    const reqs = ["does x"];
    const evaluation = tr.evaluateRequirementCoverage({ testRequirements: reqs, requirementCoverage: [{ index: 0, testFile: A, path: "does x" }], results: vitestResults({ [A]: [{ titles: ["does x"], status: "passed" }] }) });
    for (const commit of [undefined, null, ""]) {
      expect(tr.buildRequirementCoverageRecord({ evaluation, testRequirements: reqs, runId: "r", commit }), String(commit)).toBeNull();
    }
    const record = tr.buildRequirementCoverageRecord({ evaluation, testRequirements: reqs, runId: "run-9", commit: SHA });
    const note = `---\nid: "x"\nphase: "executing"\n---\n\nbody\n`;
    const written = spliceNoteFrontmatter(note, { requirementCoverageRecord: record });
    const back = parseFrontmatter(written).data.requirementCoverageRecord;
    expect(back).toEqual(record);
    for (const key of ["runId", "commit", "recordedAt", "requirementsDigest", "verification", "requirements"]) expect(back, key).toHaveProperty(key);
    expect(back.commit).toBe(SHA);
    // The frontmatter.mjs:187 witness: a top-level null inside a plain-object value is dropped.
    const nullCommit = spliceNoteFrontmatter(note, { requirementCoverageRecord: { ...record, commit: null } });
    const nullBack = parseFrontmatter(nullCommit).data.requirementCoverageRecord;
    expect(nullBack).not.toHaveProperty("commit");
    expect(nullBack.runId).toBe("run-9");
  });

  it("waiver path record: verification unverified, no entry covered (AC12)", () => {
    const reqs = ["does x", "does y", "[process] constraint"];
    const map = [{ index: 0, testFile: A, path: "suite > does x" }, { index: 1, testFile: "tests/unit/b.test.mjs", path: "does y" }];
    for (const [results, adapter] of [[{ ...tr.UNAVAILABLE("runner_not_recognized"), runner: null }, null], [{ ...tr.UNAVAILABLE("timeout"), runner: "vitest" }, "vitest"]]) {
      const evaluation = tr.evaluateRequirementCoverage({ testRequirements: reqs, requirementCoverage: map, results, policy: { acceptUnverified: true, reason: "enabled", source: POLICY_SOURCE } });
      expect(evaluation.ok).toBe(true);
      expect(evaluation.outcome).toBe("unverified");
      const record = tr.buildRequirementCoverageRecord({ evaluation, testRequirements: reqs, runId: "r", commit: "abc1234" });
      expect(record.verification).toBe("unverified");
      expect(record.unverified).toEqual({ reason: results.reason, adapter, policySource: POLICY_SOURCE });
      expect(record.requirements).toEqual([
        { index: 0, kind: "test", coverage: "unverified", testFile: A, path: "suite > does x", observedId: null, observedStatus: null },
        { index: 1, kind: "test", coverage: "unverified", testFile: "tests/unit/b.test.mjs", path: "does y", observedId: null, observedStatus: null },
        { index: 2, kind: "process", coverage: "process" },
      ]);
      expect(record.requirements.some((e) => e.coverage === "covered")).toBe(false);
    }
  });

  it("waiver waives nothing else: unmapped, observed failures, verificationSkipped (AC13)", () => {
    const policy = { acceptUnverified: true, reason: "enabled", source: POLICY_SOURCE };
    // Unmapped, with results unavailable.
    const unmapped = tr.evaluateRequirementCoverage({ testRequirements: ["a", "b"], requirementCoverage: [{ index: 0, testFile: A, path: "a" }], results: { ...tr.UNAVAILABLE("runner_not_recognized"), runner: null }, policy });
    expect(unmapped.status).toBe("test_requirements_uncovered");
    expect(unmapped.uncoveredRequirements).toEqual([{ index: 1, text: "b", cause: "unmapped" }]);
    // Available results with a bad candidate still refuse.
    const cases = [
      [[{ titles: ["suite", "does x"], status: "failed" }], "failed"],
      [[{ titles: ["suite", "does x"], status: "skipped" }], "skipped"],
      [[{ titles: ["suite", "does x"], status: "todo" }], "skipped"],
      [[{ titles: ["suite", "does x"], status: "pending" }], "skipped"],
      [[{ titles: ["suite", "does x"], status: "disabled" }], "skipped"],
      [[{ titles: ["suite", "other"], status: "passed" }], "not_observed"],
      [[{ titles: ["suite", "does x"], status: "passed" }, { titles: ["suite", "does x"], status: "passed" }], "ambiguous"],
    ];
    for (const [assertions, cause] of cases) {
      const r = evaluate({ results: vitestResults({ [A]: assertions }), policy });
      expect(r.ok, cause).toBe(false);
      expect(r.status, cause).toBe("test_requirements_uncovered");
      expect(r.uncoveredRequirements[0].cause, cause).toBe(cause);
    }
    // Unmapped with available results.
    expect(tr.evaluateRequirementCoverage({ testRequirements: ["a"], requirementCoverage: [], results: vitestResults({ [A]: [] }), policy }).uncoveredRequirements[0].cause).toBe("unmapped");
    // verificationSkipped is never waived.
    const skipped = evaluate({ results: null, verificationSkipped: true, policy });
    expect(skipped.ok).toBe(false);
    expect(skipped.status).toBe("test_requirements_unverifiable");
    // A policy that does not accept leaves the unavailable refusal in place, carrying field/detail when misconfigured.
    const misconfigured = evaluate({ results: { ...tr.UNAVAILABLE("runner_not_recognized"), runner: null }, policy: { acceptUnverified: false, misconfigured: true, reason: "misconfigured", field: "testRequirementCoverage.acceptUnverified", detail: "must be a boolean" } });
    expect(misconfigured.status).toBe("test_requirements_unverifiable");
    expect(misconfigured.field).toBe("testRequirementCoverage.acceptUnverified");
    expect(misconfigured.detail).toBe("must be a boolean");
  });
});
