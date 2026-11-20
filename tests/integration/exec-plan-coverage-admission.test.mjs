// backlog.fix.exec-refuse-plan-without-requirement-coverage-map: a story-linked exec whose plan lacks a
// complete requirementCoverage map is refused BEFORE apply, and every coverage refusal is persisted in the
// run folder. Real git in temp projects; every spawn carries a timeout.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TEMP_BASE } from "../helpers/tmp.mjs";
import { runExecTool, writeCoverageGateRecord } from "../../packages/mcp-rks/src/server/exec.mjs";

// backlog.fix.exec-coverage-gate-behavioral-test-gaps: the post-apply coverage gate needs a passing
// verification run with controlled per-test results. runProjectTests is a pass-through to the real
// runner unless a test sets fakeTests.result; nothing is spawned while the fake is active.
const fakeTests = vi.hoisted(() => ({ result: null, calls: 0 }));
vi.mock("../../packages/mcp-rks/src/exec/command-runner.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runProjectTests: (projectRoot, options) => {
      if (!fakeTests.result) return actual.runProjectTests(projectRoot, options);
      fakeTests.calls += 1;
      return fakeTests.result;
    },
  };
});
// Collaborator stub: the apply phase toggles guardrails on the temp project; hook relocation is not under test.
vi.mock("../../packages/mcp-rks/src/server/guardrails-audit.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  guardrailsOff: vi.fn(async () => ({ ok: true })),
  guardrailsOn: vi.fn(async () => ({ ok: true })),
}));

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, stdio: "pipe", timeout: 30000 }).toString();
}

const TARGET_REL = "src/example.js";
const TARGET_CONTENT = 'export const value = "before";\n';
const PROBLEM_ID = "backlog.fix.coverage-admission-fixture";
const REQS = ["does a", "[process] every witness passes", "does b", "does c"];
const T = "tests/unit/fixture.test.mjs";

let registryDir;
let registryPath;
let originalRegistryEnv;
let errSpy;
const cleanup = [];

function noteFor(testRequirements) {
  const reqs = testRequirements.length ? `testRequirements:\n${testRequirements.map((r) => `  - ${JSON.stringify(r)}`).join("\n")}\n` : "";
  return `---\nid: "${PROBLEM_ID}"\nphase: "executing"\n${reqs}---\n\n## Problem\n\nfixture\n`;
}

/** A registered temp git project on staging, story note committed, clean tree. */
function setupProject(tag, testRequirements) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectId = `exec-cov-admission-${tag}-${stamp}`;
  const projectRoot = path.join(TEMP_BASE, `exec-cov-admission-${stamp}`);
  cleanup.push(projectRoot);
  fs.mkdirSync(path.join(projectRoot, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "routekit", "project.json"), JSON.stringify({ id: projectId, baseBranch: "staging", kgFile: "routekit/kg.yaml" }, null, 2));
  fs.writeFileSync(path.join(projectRoot, "routekit", "kg.yaml"), "code_roots: [src]\n");
  fs.writeFileSync(path.join(projectRoot, TARGET_REL), TARGET_CONTENT);
  fs.writeFileSync(path.join(projectRoot, "notes", `${PROBLEM_ID}.md`), noteFor(testRequirements));
  fs.writeFileSync(path.join(projectRoot, ".gitignore"), ".rks/\n");
  git(projectRoot, "init -q");
  git(projectRoot, "config user.email test@example.com");
  git(projectRoot, "config user.name 'Test User'");
  git(projectRoot, "checkout -q -b staging");
  git(projectRoot, "add -A");
  git(projectRoot, "commit -q -m chore:baseline");
  const existing = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, "utf8").trim().split("\n").filter(Boolean) : [];
  fs.writeFileSync(registryPath, [...existing, JSON.stringify({ id: projectId, root: projectRoot })].join("\n") + "\n");
  return { projectId, projectRoot };
}

/** A hand-written plan.json in .rks/runs/<ts>_<slug>/; returns the run folder. */
function writePlan(projectRoot, slug, extra) {
  const runDir = path.join(projectRoot, ".rks", "runs", `2026-11-01T00-00-00-000Z_${slug}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({
    slug,
    status: "executable",
    problemId: PROBLEM_ID,
    steps: [{ action: "search_replace", path: TARGET_REL, title: "flip", edits: [{ search: 'export const value = "before";', replace: 'export const value = "after";' }] }],
    ...extra,
  }, null, 2));
  return runDir;
}

const mapFor = (indices) => indices.map((index) => ({ index, testFile: T, path: `fixture > case ${index}` }));
const rksBranches = (projectRoot) => git(projectRoot, "branch --list rks/*").trim();
const errLines = () => errSpy.mock.calls.map((c) => c.map(String).join(" "));
const readGateRecord = (runDir) => JSON.parse(fs.readFileSync(path.join(runDir, "coverage-gate.json"), "utf8"));
/** Result or thrown error, so a later gate's throw does not fail an "unaffected" assertion. */
const settle = (p) => p.then((result) => ({ result, error: null }), (error) => ({ result: null, error }));

function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (ch === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { i = src.indexOf(ch, i + 1); continue; }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") { depth--; if (depth === 0) return i; }
  }
  return -1;
}
const idx = (literal, from = 0) => { const i = EXEC_SRC.indexOf(literal, from); expect(i, literal).toBeGreaterThan(-1); return i; };

beforeEach(() => {
  originalRegistryEnv = process.env.RKS_REGISTRY_PATH;
  registryDir = fs.mkdtempSync(path.join(TEMP_BASE, "exec-cov-admission-registry-"));
  registryPath = path.join(registryDir, "index.jsonl");
  process.env.RKS_REGISTRY_PATH = registryPath;
  errSpy = vi.spyOn(console, "error");
});

afterEach(() => {
  fakeTests.result = null;
  fakeTests.calls = 0;
  errSpy?.mockRestore();
  if (originalRegistryEnv === undefined) delete process.env.RKS_REGISTRY_PATH;
  else process.env.RKS_REGISTRY_PATH = originalRegistryEnv;
  fs.rmSync(registryDir, { recursive: true, force: true });
  for (const p of cleanup.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("exec plan admission: requirementCoverage completeness", () => {
  it("mapless plan is refused before apply with planRequirementCoverage absent", async () => {
    const { projectId, projectRoot } = setupProject("absent", REQS);
    writePlan(projectRoot, "absent", {});
    const result = await runExecTool({ projectId, label: "absent", skipTests: false });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("test_requirements_uncovered");
    expect(result.reason).toBe("plan_requirement_coverage_incomplete");
    expect(result.planRequirementCoverage).toBe("absent");
  });

  it("mapless refusal names every non-process index with verbatim text and cause unmapped", async () => {
    const { projectId, projectRoot } = setupProject("names", REQS);
    writePlan(projectRoot, "names", {});
    const result = await runExecTool({ projectId, label: "names", skipTests: false });
    expect(result.missingIndices).toEqual([0, 2, 3]);
    expect(result.uncoveredRequirements).toEqual([0, 2, 3].map((index) => ({ index, text: REQS[index], cause: "unmapped" })));
  });

  it("mapless refusal leaves the repository untouched and runs no baseline", async () => {
    const { projectId, projectRoot } = setupProject("untouched", REQS);
    writePlan(projectRoot, "untouched", {});
    const before = fs.readFileSync(path.join(projectRoot, TARGET_REL));
    await runExecTool({ projectId, label: "untouched", skipTests: false });
    expect(rksBranches(projectRoot)).toBe("");
    expect(git(projectRoot, "rev-parse --abbrev-ref HEAD").trim()).toBe("staging");
    expect(fs.readFileSync(path.join(projectRoot, TARGET_REL)).equals(before)).toBe(true);
    expect(errLines().some((l) => l.includes("[rks.exec] Running baseline tests"))).toBe(false);
  });

  it("partial map is refused before apply naming exactly the unmapped indices", async () => {
    const { projectId, projectRoot } = setupProject("partial", REQS);
    writePlan(projectRoot, "partial", { requirementCoverage: mapFor([0, 3]) });
    const before = fs.readFileSync(path.join(projectRoot, TARGET_REL));
    const result = await runExecTool({ projectId, label: "partial", skipTests: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("plan_requirement_coverage_incomplete");
    expect(result.planRequirementCoverage).toBe("incomplete");
    expect(result.missingIndices).toEqual([2]);
    expect(rksBranches(projectRoot)).toBe("");
    expect(fs.readFileSync(path.join(projectRoot, TARGET_REL)).equals(before)).toBe(true);
  });

  it("the refusal logs plan_requirement_coverage_incomplete and the missing indices", async () => {
    const { projectId, projectRoot } = setupProject("log", REQS);
    writePlan(projectRoot, "log", { requirementCoverage: mapFor([0]) });
    await runExecTool({ projectId, label: "log", skipTests: false });
    const line = errLines().find((l) => l.includes("plan_requirement_coverage_incomplete"));
    expect(line).toBeDefined();
    expect(line).toMatch(/\b2\b/);
    expect(line).toMatch(/\b3\b/);
  });

  it("stories with no testRequirements or only process requirements are not refused by the new check", async () => {
    for (const [tag, reqs] of [["none", []], ["process-only", ["[process] every witness passes"]]]) {
      const { projectId, projectRoot } = setupProject(tag, reqs);
      writePlan(projectRoot, tag, { qualityReview: { hash: "0".repeat(64) } });
      const { result, error } = await settle(runExecTool({ projectId, label: tag, skipTests: true }));
      // Observed outcome (both cases): the fixture's placeholder qualityReview hash does not match the plan,
      // so exec refuses at the plan-integrity check that follows admission and the skipTests chain. It is
      // returned, not thrown, and it is not the coverage-admission refusal.
      expect(error, tag).toBeNull();
      expect(result.ok, tag).toBe(false);
      expect(result.status, tag).toBe("integrity_failed");
      expect(result.reason, tag).toBeUndefined();
      expect(result.message, tag).toBe("Plan modified after quality review. Re-run rks.plan.");
      expect(result.expectedHash, tag).toBe("0".repeat(64));
    }
  });

  it("a mapless plan with skipTests true is refused by plan admission, not by the skipTests check", async () => {
    const { projectId, projectRoot } = setupProject("mapless-skip", REQS);
    writePlan(projectRoot, "mapless-skip", {});
    const result = await runExecTool({ projectId, label: "mapless-skip", skipTests: true });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("test_requirements_uncovered");
    expect(result.reason).toBe("plan_requirement_coverage_incomplete");
    expect(result.reason).not.toBe("skip_tests");
    expect(result.planRequirementCoverage).toBe("absent");
  });

  it("a present but non-array requirementCoverage is refused with planRequirementCoverage incomplete, not absent", async () => {
    for (const [tag, requirementCoverage] of [["object", { 0: mapFor([0])[0] }], ["string", "tests/unit/fixture.test.mjs"]]) {
      const { projectId, projectRoot } = setupProject(`nonarray-${tag}`, REQS);
      writePlan(projectRoot, `nonarray-${tag}`, { requirementCoverage });
      const before = fs.readFileSync(path.join(projectRoot, TARGET_REL));
      const result = await runExecTool({ projectId, label: `nonarray-${tag}`, skipTests: false });
      expect(result.ok, tag).toBe(false);
      expect(result.status, tag).toBe("test_requirements_uncovered");
      expect(result.reason, tag).toBe("plan_requirement_coverage_incomplete");
      expect(result.planRequirementCoverage, tag).toBe("incomplete");
      expect(result.missingIndices, tag).toEqual([0, 2, 3]);
      expect(rksBranches(projectRoot), tag).toBe("");
      expect(fs.readFileSync(path.join(projectRoot, TARGET_REL)).equals(before), tag).toBe(true);
    }
  });

  it("a complete map passes the new check and reaches the skipTests refusal", async () => {
    const { projectId, projectRoot } = setupProject("complete", REQS);
    writePlan(projectRoot, "complete", { requirementCoverage: mapFor([0, 2, 3]) });
    const result = await runExecTool({ projectId, label: "complete", skipTests: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("skip_tests");
  });

  it("the pre-apply refusal is persisted in the run folder", async () => {
    const { projectId, projectRoot } = setupProject("persist", REQS);
    const runDir = writePlan(projectRoot, "persist", {});
    const result = await runExecTool({ projectId, label: "persist", skipTests: false });
    expect(result.coverageGateWriteError).toBeUndefined();
    const record = readGateRecord(runDir);
    expect(record.status).toBe("test_requirements_uncovered");
    expect(record.reason).toBe("plan_requirement_coverage_incomplete");
    expect(record.stage).toBe("plan_admission");
    expect(record.runId).toBe(path.basename(runDir));
    expect(Number.isNaN(Date.parse(record.recordedAt))).toBe(false);
    expect(record.uncoveredRequirements.map((u) => [u.index, u.cause])).toEqual([[0, "unmapped"], [2, "unmapped"], [3, "unmapped"]]);
  });
});

/** A passing verification run whose per-test results are `testResults` (fed through fakeTests). */
const passingRun = (testResults) => ({ passed: true, skipped: false, exitCode: 0, executedCount: 1, summary: "1 passed", output: "fixture: 1 passed\n", testResults });
// Observed, passing, but matching none of the mapped `fixture > case N` paths: every mapped index is not_observed.
const UNRELATED_RESULTS = { available: true, runner: "vitest", assertions: [{ id: `${T} > fixture > unrelated`, status: "passed" }] };
const UNAVAILABLE_RESULTS = { available: false, runner: "vitest", reason: "fixture_report_missing" };

const POST_APPLY_CASES = [
  {
    status: "test_requirements_uncovered",
    results: UNRELATED_RESULTS,
    reason: "test_requirements_uncovered",
  },
  {
    status: "test_requirements_unverifiable",
    results: UNAVAILABLE_RESULTS,
    reason: "fixture_report_missing",
  },
];

describe("exec post-apply coverage gate: refusals persist coverage-gate.json (runExecTool)", () => {
  for (const c of POST_APPLY_CASES) {
    it(`a complete map that reaches a post-apply ${c.status} refusal rolls back and leaves a matching coverage-gate.json`, async () => {
      const tag = c.status.replace("test_requirements_", "post-");
      const { projectId, projectRoot } = setupProject(tag, REQS);
      const runDir = writePlan(projectRoot, tag, { requirementCoverage: mapFor([0, 2, 3]) });
      fakeTests.result = passingRun(c.results);
      const result = await runExecTool({ projectId, label: tag, skipTests: false });
      // The verification run was reached (apply happened), so this is the post-apply gate, not admission.
      expect(fakeTests.calls).toBeGreaterThan(0);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(c.status);
      expect(result.reason).toBe(c.reason);
      expect(result.stepsApplied).toBe(1);
      expect(result.appliedFiles).toEqual([TARGET_REL]);
      // Rolled back: the target is byte-identical to its baseline content and HEAD is the base branch again.
      expect(fs.readFileSync(path.join(projectRoot, TARGET_REL), "utf8")).toBe(TARGET_CONTENT);
      expect(git(projectRoot, "rev-parse --abbrev-ref HEAD").trim()).toBe("staging");
      expect(result.coverageGateWriteError).toBeUndefined();
      expect(result.coverageGateRecordPath).toBe(path.join(runDir, "coverage-gate.json"));
      const record = readGateRecord(runDir);
      expect(record.stage).toBe("coverage_gate");
      expect(record.status).toBe(result.status);
      expect(record.reason).toBe(result.reason);
      expect(record.runId).toBe(path.basename(runDir));
      if (c.status === "test_requirements_uncovered") {
        expect(record.outcome).toBe("uncovered");
        expect(record.uncoveredRequirements).toEqual(result.uncoveredRequirements);
        expect(result.uncoveredRequirements.map((u) => [u.index, u.cause])).toEqual([[0, "not_observed"], [2, "not_observed"], [3, "not_observed"]]);
      } else {
        expect(record.outcome).toBe("unverifiable");
      }
    });
  }

  for (const c of POST_APPLY_CASES) {
    it(`a coverage-gate write forced to fail during a post-apply ${c.status} refusal surfaces coverageGateWriteError and no record path`, async () => {
      const tag = c.status.replace("test_requirements_", "writefail-");
      const { projectId, projectRoot } = setupProject(tag, REQS);
      const runDir = writePlan(projectRoot, tag, { requirementCoverage: mapFor([0, 2, 3]) });
      // A directory already occupies the record's path, so writeFileSync fails (EISDIR).
      fs.mkdirSync(path.join(runDir, "coverage-gate.json"));
      fakeTests.result = passingRun(c.results);
      const { result, error } = await settle(runExecTool({ projectId, label: tag, skipTests: false }));
      expect(error).toBeNull();
      expect(result.ok).toBe(false);
      expect(result.status).toBe(c.status);
      expect(result.reason).toBe(c.reason);
      expect(result.coverageGateWriteError).toBeDefined();
      expect(String(result.coverageGateWriteError.error || "").length).toBeGreaterThan(0);
      expect(String(result.coverageGateWriteError.detail || "").length).toBeGreaterThan(0);
      expect("coverageGateRecordPath" in result).toBe(false);
      expect(fs.statSync(path.join(runDir, "coverage-gate.json")).isDirectory()).toBe(true);
    });
  }
});

describe("exec plan admission: source wiring", () => {
  it("admission check uses isRequirementCoverageComplete, guarded by nonProcessRequirementCount, after story load and before skipTests, baseline and apply", () => {
    expect(EXEC_SRC).toMatch(/import \{[^}]*\bisRequirementCoverageComplete\b[^}]*\} from "\.\.\/exec\/test-results\.mjs";/);
    const loadAt = idx("if (earlyProblemId) {");
    const loadEnd = matchBrace(EXEC_SRC, EXEC_SRC.indexOf("{", loadAt));
    const call = idx("isRequirementCoverageComplete(", loadEnd);
    expect(call).toBeLessThan(idx("if (skipTests) {", loadEnd));
    expect(call).toBeLessThan(idx("runPreApplyBaseline("));
    expect(call).toBeLessThan(idx("await runApplyTool({"));
    expect(EXEC_SRC.slice(loadEnd, call)).toContain("nonProcessRequirementCount > 0");
  });

  it("exactly one ctx.terminalDetail carries plan_requirement_coverage_incomplete with stage plan_admission, followed by return", () => {
    const details = [...EXEC_SRC.matchAll(/ctx\.terminalDetail = \{/g)].map((m) => {
      const open = m.index + "ctx.terminalDetail = ".length;
      const close = matchBrace(EXEC_SRC, open);
      return { index: m.index, text: EXEC_SRC.slice(open, close + 1), after: close + 1 };
    }).filter((d) => d.text.includes('reason: "plan_requirement_coverage_incomplete"'));
    expect(details).toHaveLength(1);
    expect(details[0].text).toContain('stage: "plan_admission"');
    expect(EXEC_SRC.slice(details[0].after)).toMatch(/^;\s*return\b/);
  });

  it("the plan-admission refusal path calls no rollback", () => {
    const detailAt = idx('reason: "plan_requirement_coverage_incomplete"');
    const blockStart = EXEC_SRC.lastIndexOf("isRequirementCoverageComplete(", detailAt);
    const retAt = EXEC_SRC.indexOf("return {", detailAt);
    const retEnd = matchBrace(EXEC_SRC, EXEC_SRC.indexOf("{", retAt));
    expect(EXEC_SRC.slice(blockStart, retEnd)).not.toContain("await rollback(");
  });

  it("both post-apply coverage refusals persist via writeCoverageGateRecord before returning and surface coverageGateWriteError", () => {
    const gate = idx("let requirementCoverageEvaluation = null;");
    for (const status of ['status: "test_requirements_uncovered"', 'status: "test_requirements_unverifiable"']) {
      const at = idx(status, gate);
      const retAt = EXEC_SRC.lastIndexOf("return {", at);
      const ret = EXEC_SRC.slice(retAt, matchBrace(EXEC_SRC, EXEC_SRC.indexOf("{", retAt)) + 1);
      // One shared call before the outcome branch, or one per branch, both satisfy this.
      const lead = EXEC_SRC.slice(gate, retAt);
      expect(lead, status).toContain("writeCoverageGateRecord(");
      expect(ret, status).toContain("coverageGateWriteError");
    }
  });
});

describe("writeCoverageGateRecord", () => {
  const dirs = [];
  afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

  it("writes a record that reads back deep-equal and returns ok with the path", () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-cov-gate-"));
    dirs.push(runDir);
    const record = {
      status: "test_requirements_uncovered",
      reason: "test_requirements_uncovered",
      adapter: "vitest_json",
      stage: "coverage_gate",
      runId: path.basename(runDir),
      recordedAt: "2026-11-08T00:00:00.000Z",
      uncoveredRequirements: [{ index: 0, text: "does a", cause: "not_observed" }, { index: 2, text: "does b", cause: "failed" }],
    };
    const res = writeCoverageGateRecord({ runDir, record });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(res.path)).toBe(true);
    expect(path.dirname(res.path)).toBe(runDir);
    expect(JSON.parse(fs.readFileSync(res.path, "utf8"))).toEqual(record);
  });

  it("an unwritable runDir is reported, never thrown", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "rks-cov-gate-bad-"));
    dirs.push(base);
    const asFile = path.join(base, "not-a-dir");
    fs.writeFileSync(asFile, "x");
    let res;
    expect(() => { res = writeCoverageGateRecord({ runDir: path.join(asFile, "run"), record: { status: "x" } }); }).not.toThrow();
    expect(res.ok).toBe(false);
    expect(String(res.error || "").length).toBeGreaterThan(0);
    expect(String(res.detail || "").length).toBeGreaterThan(0);
  });
});
