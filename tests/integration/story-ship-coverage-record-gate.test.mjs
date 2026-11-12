// rks_story_ship coverage-record gate (backlog.fix.ship-archive-requires-exec-coverage-record, AC1-AC14).
// Harness pattern: tests/integration/story-ship-commit-sha.test.mjs — temp git repo built with
// execFileSync git (explicit timeout on every call), story note at phase executed, mocks for
// project.mjs, git-tools.mjs, branch-protection.mjs and review.mjs; auto-phase.mjs is NOT mocked,
// so a refusal is witnessed by the note staying at its path and phase, and delivery is the REAL
// localMerge (the working branch has no origin, so the 3-branch-style local merge arm runs).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTelemetryStorage } from "@routekit/telemetry";

let mockRoot = null;

const h = vi.hoisted(() => ({
  reviewPolicy: { enabled: false },
  reviewVerdict: "pass",
}));

vi.mock("../../packages/mcp-rks/src/server/project.mjs", () => ({
  loadContext: vi.fn(async () => ({
    record: { root: mockRoot, id: "test-project" },
    projectJson: { branches: { working: "staging", integration: "staging", production: "main" } },
  })),
  getBranchConfig: vi.fn(() => ({ working: "staging", integration: "staging", production: "main" })),
  getWorkflowConfig: vi.fn(() => ({ autoMergeIntegration: false })),
}));

vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", () => ({
  runGitPR: vi.fn().mockResolvedValue({ ok: true, url: "https://github.com/test/pr/1", number: 1 }),
  runStagingMerge: vi.fn().mockResolvedValue({ ok: true, commitId: "abc123" }),
  runCycleComplete: vi.fn().mockResolvedValue({ ok: true, branch: "staging" }),
  runPromote: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../packages/mcp-rks/src/server/branch-protection.mjs", () => ({
  assertNotOnProtectedBranch: vi.fn(),
}));

vi.mock("../../packages/mcp-rks/src/server/review.mjs", () => ({
  runReview: vi.fn(async () => ({ ok: true, verdict: h.reviewVerdict, summary: "mocked", findings: [] })),
  loadReviewPolicy: vi.fn(() => h.reviewPolicy),
  redactReview: vi.fn((r) => r),
}));

import { runStoryShipTool, evaluateCoverageRecordGate } from "../../packages/mcp-rks/src/server/story-ship.mjs";
import { parseFrontmatter } from "../../packages/mcp-rks/src/dendron.mjs";
import { formatWithFrontmatter, spliceNoteFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";

const STORY_ID = "backlog.feat.test";
const ARCHIVED_ID = "backlog.z_implemented.feat.test";
const GIT_TIMEOUT_MS = 15_000;
const HERE = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(HERE), "../..");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS }).trim();
}
function digest(testRequirements) {
  return createHash("sha256").update(JSON.stringify(testRequirements)).digest("hex");
}

const REQS = [
  "AC1: first behaviour is asserted",
  "AC2: second behaviour is asserted",
  "[process] the suite passes",
];

/** A complete, current, observed record for `reqs`, pinned to `commit`. */
function observedRecord(reqs, commit, overrides = {}) {
  return {
    runId: "run-1",
    commit,
    recordedAt: "2026-11-01T00:00:00.000Z",
    requirementsDigest: digest(reqs),
    verification: "observed",
    requirements: reqs.map((text, index) => (text.startsWith("[process] ")
      ? { index, kind: "process", coverage: "process" }
      : { index, kind: "test", coverage: "covered", testFile: "tests/a.test.mjs", path: `case ${index}`, observedId: `tests/a.test.mjs > case ${index}`, observedStatus: "passed" })),
    ...overrides,
  };
}

/** The unverified record exec writes on the waiver path. */
function unverifiedRecord(reqs, commit, overrides = {}) {
  return {
    runId: "run-1",
    commit,
    recordedAt: "2026-11-01T00:00:00.000Z",
    requirementsDigest: digest(reqs),
    verification: "unverified",
    unverified: { reason: "runner_not_recognized", adapter: "none", policySource: ".rks/project.json#testRequirementCoverage.acceptUnverified" },
    requirements: reqs.map((text, index) => (text.startsWith("[process] ")
      ? { index, kind: "process", coverage: "process" }
      : { index, kind: "test", coverage: "unverified", testFile: "tests/a.test.mjs", path: `case ${index}`, observedId: null, observedStatus: null })),
    ...overrides,
  };
}

/**
 * staging (init, story note without a record) -> rks/test-branch carrying the exec commit, then
 * (when `record` is given) a second commit writing requirementCoverageRecord onto the note, as
 * rks_exec does. `record(execCommit, git)` builds the record; `reqsAtShip` replaces
 * testRequirements in that commit (to model an edit after exec). The worktree ends on the feature branch.
 */
function makeRepo({ phase = "executed", testRequirements = REQS, record = null, reqsAtShip, projectJson } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-coverage-gate-"));
  git(dir, ["init", "-q", "-b", "staging"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  const fm = { id: STORY_ID, status: "not-implemented", phase };
  if (testRequirements !== null) fm.testRequirements = testRequirements; // null = key absent
  fs.writeFileSync(path.join(dir, "notes", `${STORY_ID}.md`), formatWithFrontmatter(fm, "body\n"));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["checkout", "-q", "-b", "rks/test-branch"]);
  fs.writeFileSync(path.join(dir, "work.mjs"), "export const x = 1;\n");
  git(dir, ["add", "work.mjs"]);
  git(dir, ["commit", "-q", "-m", `feat(exec): ${STORY_ID}`, "-m", `Story: ${STORY_ID}`]);
  const execCommit = git(dir, ["rev-parse", "HEAD"]);
  let builtRecord;
  if (record || reqsAtShip) {
    const notePath = path.join(dir, "notes", `${STORY_ID}.md`);
    const updates = {};
    if (record) {
      builtRecord = record(execCommit, (args) => git(dir, args));
      updates.requirementCoverageRecord = builtRecord;
    }
    if (reqsAtShip) updates.testRequirements = reqsAtShip;
    fs.writeFileSync(notePath, spliceNoteFrontmatter(fs.readFileSync(notePath, "utf8"), updates));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", `chore(exec): record coverage for ${STORY_ID}`]);
  }
  if (projectJson !== undefined) {
    fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".rks", "project.json"), typeof projectJson === "string" ? projectJson : JSON.stringify(projectJson));
  }
  return { dir, execCommit, record: builtRecord };
}

/** A real commit that is not an ancestor of anything on staging or the feature branch. */
function orphanCommit(gitIn) {
  return gitIn(["commit-tree", "HEAD^{tree}", "-m", "orphan"]);
}

function eventsFor(type) {
  const calls = ensureTelemetryStorage(mockRoot).emit?.mock?.calls || [];
  return calls.filter(([t]) => t === type).map(([, , payload]) => payload || {}).filter((p) => p.storyId === STORY_ID);
}
const notePath = () => path.join(mockRoot, "notes", `${STORY_ID}.md`);
const archivedPath = () => path.join(mockRoot, "notes", `${ARCHIVED_ID}.md`);
const readFm = (p) => parseFrontmatter(fs.readFileSync(p, "utf8")).data;
const stepOf = (result, name) => (result.steps || []).find((s) => s.step === name);

async function ship() {
  return runStoryShipTool({ projectId: "test-project", problemId: STORY_ID });
}

/** Every pre-delivery refusal: the buildShipFailure shape, no delivery, note untouched. */
function expectRefusedBeforeDelivery(result, stagingBefore, { phase = "executed", reasonPattern } = {}) {
  expect(result.ok).toBe(false);
  expect(result.failedStep).toBe("coverage_record_gate");
  expect(result.worktreeBranch).toBe("rks/test-branch");
  expect(result.baseBranch).toBe("staging");
  expect(result.branchRestored).toBe(false);
  if (reasonPattern) expect(result.error).toMatch(reasonPattern);
  // No merge, no push: the working branch tip is unchanged and the worktree did not move.
  expect(git(mockRoot, ["rev-parse", "refs/heads/staging"])).toBe(stagingBefore);
  expect(git(mockRoot, ["branch", "--show-current"])).toBe("rks/test-branch");
  // Not archived.
  expect(fs.existsSync(notePath())).toBe(true);
  expect(fs.existsSync(archivedPath())).toBe(false);
  const fm = readFm(notePath());
  expect(fm.phase).toBe(phase);
  expect(fm.status).toBe("not-implemented");
  // Steps: a failed gate entry, and nothing from delivery or Step 3.
  const gate = stepOf(result, "coverage_record_gate");
  expect(gate, JSON.stringify(result.steps)).toBeTruthy();
  expect(gate.ok).toBe(false);
  for (const name of ["local_merge", "push_working", "mark_implemented"]) {
    expect(stepOf(result, name), `step ${name} must be absent`).toBeUndefined();
  }
}

/** Every accepted ship: delivered, archived, record preserved. */
function expectArchived(result, recordBefore) {
  expect(result.ok, JSON.stringify(result.steps)).toBe(true);
  const mark = stepOf(result, "mark_implemented");
  expect(mark.ok).toBe(true);
  expect(fs.existsSync(notePath())).toBe(false);
  expect(fs.existsSync(archivedPath())).toBe(true);
  const fm = readFm(archivedPath());
  expect(fm.status).toBe("implemented");
  expect(fm.phase).toBe("integrated");
  if (recordBefore) expect(fm.requirementCoverageRecord).toEqual(recordBefore);
  return mark;
}

describe("rks_story_ship coverage-record gate", { timeout: 60_000 }, () => {
  beforeEach(() => {
    h.reviewPolicy = { enabled: false };
    h.reviewVerdict = "pass";
    ensureTelemetryStorage("x").emit?.mockClear?.();
  });
  afterEach(() => {
    try { fs.rmSync(mockRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    mockRoot = null;
    vi.clearAllMocks();
  });

  describe("AC1: missing record", () => {
    it("executed story with testRequirements and no record is refused before delivery via buildShipFailure", async () => {
      ({ dir: mockRoot } = makeRepo());
      const stagingBefore = git(mockRoot, ["rev-parse", "refs/heads/staging"]);
      const result = await ship();
      expectRefusedBeforeDelivery(result, stagingBefore, { reasonPattern: /missing coverage record/i });
      expect(result.coverageRecordGate.reason).toBe("coverage_record_missing");
    });

    it("executing story with no record is refused before delivery and stays at executing (no reconcile)", async () => {
      ({ dir: mockRoot } = makeRepo({ phase: "executing" }));
      const stagingBefore = git(mockRoot, ["rev-parse", "refs/heads/staging"]);
      const result = await ship();
      expectRefusedBeforeDelivery(result, stagingBefore, { phase: "executing", reasonPattern: /missing coverage record/i });
    });

    for (const [label, value] of [["a string", "not-a-record"], ["a list", ["a", "b"]]]) {
      it(`a requirementCoverageRecord that is ${label} is refused with the missing-record reason`, async () => {
        ({ dir: mockRoot } = makeRepo({ record: () => value }));
        expect(readFm(notePath()).requirementCoverageRecord, `fixture for ${label}`).toEqual(value);
        const stagingBefore = git(mockRoot, ["rev-parse", "refs/heads/staging"]);
        const result = await ship();
        expectRefusedBeforeDelivery(result, stagingBefore, { reasonPattern: /missing coverage record/i });
        expect(result.coverageRecordGate.reason, `record is ${label}`).toBe("coverage_record_missing");
      });
    }

    it("a refusal emits story_ship.failed (coverage_record_gate, reason, worktreeBranch) and no story_ship.success", async () => {
      ({ dir: mockRoot } = makeRepo());
      const result = await ship();
      const failed = eventsFor("story_ship.failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].failedStep).toBe("coverage_record_gate");
      expect(failed[0].reason).toBe("coverage_record_missing");
      expect(failed[0].worktreeBranch).toBe("rks/test-branch");
      expect(eventsFor("story_ship.success")).toHaveLength(0);
      const gate = stepOf(result, "coverage_record_gate");
      expect(gate.ok).toBe(false);
      for (const name of ["local_merge", "push_working", "mark_implemented"]) {
        expect(stepOf(result, name), `step ${name} must be absent`).toBeUndefined();
      }
    });
  });

  it("AC2: a stale requirementsDigest (testRequirements edited after the record) is refused naming staleness", async () => {
    const edited = [...REQS.slice(0, 2), "AC3: a requirement added after exec", REQS[2]];
    ({ dir: mockRoot } = makeRepo({ record: (c) => observedRecord(REQS, c), reqsAtShip: edited }));
    expect(readFm(notePath()).testRequirements).toEqual(edited);
    const stagingBefore = git(mockRoot, ["rev-parse", "refs/heads/staging"]);
    const result = await ship();
    expectRefusedBeforeDelivery(result, stagingBefore, { reasonPattern: /stale/i });
    expect(result.coverageRecordGate.reason).toBe("coverage_record_stale");
  });

  it("AC3: a record with no entry for requirement index 1 is refused naming index 1", async () => {
    ({ dir: mockRoot } = makeRepo({
      record: (c) => {
        const r = observedRecord(REQS, c);
        return { ...r, requirements: r.requirements.filter((e) => e.index !== 1) };
      },
    }));
    const stagingBefore = git(mockRoot, ["rev-parse", "refs/heads/staging"]);
    const result = await ship();
    expectRefusedBeforeDelivery(result, stagingBefore, { reasonPattern: /incomplete.*index 1/i });
    expect(result.coverageRecordGate.index).toBe(1);
  });

  for (const status of ["failed", "skipped"]) {
    it(`AC3: an observed kind test entry with observedStatus ${status} is refused naming its index`, async () => {
      ({ dir: mockRoot } = makeRepo({
        record: (c) => {
          const r = observedRecord(REQS, c);
          return { ...r, requirements: r.requirements.map((e) => (e.index === 0 ? { ...e, observedStatus: status } : e)) };
        },
      }));
      const stagingBefore = git(mockRoot, ["rev-parse", "refs/heads/staging"]);
      const result = await ship();
      expectRefusedBeforeDelivery(result, stagingBefore, { reasonPattern: new RegExp(`index 0 has observedStatus "${status}"`) });
      expect(result.coverageRecordGate.index, `observedStatus ${status}`).toBe(0);
    });
  }

  it("AC4: a record with commit null (written as null, read back with no commit key) is refused naming unverifiable delivery", async () => {
    ({ dir: mockRoot } = makeRepo({ record: (c) => observedRecord(REQS, c, { commit: null }) }));
    expect(readFm(notePath()).requirementCoverageRecord).toBeTruthy();
    const stagingBefore = git(mockRoot, ["rev-parse", "refs/heads/staging"]);
    const result = await ship();
    expectRefusedBeforeDelivery(result, stagingBefore, { reasonPattern: /unverifiable delivery/i });
    expect(result.coverageRecordGate.reason).toBe("coverage_record_delivery_unverifiable");
  });

  it("AC4: a real commit that is not an ancestor of the feature-branch HEAD is refused naming the mismatch; staging unchanged", async () => {
    let orphan;
    ({ dir: mockRoot } = makeRepo({ record: (c, g) => { orphan = orphanCommit(g); return observedRecord(REQS, orphan); } }));
    expect(git(mockRoot, ["cat-file", "-t", orphan])).toBe("commit");
    const stagingBefore = git(mockRoot, ["rev-parse", "refs/heads/staging"]);
    const result = await ship();
    expectRefusedBeforeDelivery(result, stagingBefore, { reasonPattern: /mismatch/i });
    expect(result.coverageRecordGate.reason).toBe("coverage_record_commit_mismatch");
    expect(result.coverageRecordGate.recordCommit).toBe(orphan);
  });

  describe("AC4/AC14: evaluateCoverageRecordGate directly", () => {
    const fmWith = (record) => ({ testRequirements: REQS, requirementCoverageRecord: record });
    const sha = "a".repeat(40);

    it("a complete current observed record with targetCommit null refuses naming unverifiable delivery without calling isAncestor", () => {
      const isAncestor = vi.fn(() => true);
      const out = evaluateCoverageRecordGate({ frontmatter: fmWith(observedRecord(REQS, sha)), targetCommit: null, policy: null, isAncestor });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe("coverage_record_delivery_unverifiable");
      expect(out.error).toMatch(/unverifiable delivery/i);
      expect(isAncestor).not.toHaveBeenCalled();
    });

    it("a record with no commit key at all also refuses naming unverifiable delivery", () => {
      const isAncestor = vi.fn(() => true);
      const { commit: _dropped, ...noCommit } = observedRecord(REQS, sha);
      expect("commit" in noCommit).toBe(false);
      const out = evaluateCoverageRecordGate({ frontmatter: fmWith(noCommit), targetCommit: "b".repeat(40), policy: null, isAncestor });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe("coverage_record_delivery_unverifiable");
      expect(out.error).toMatch(/unverifiable delivery/i);
      expect(isAncestor).not.toHaveBeenCalled();
    });

    it("an unobservable feature-branch HEAD at the pre-delivery gate is this null-target case (source: observeHeadCommit returns null)", () => {
      const src = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server/story-ship.mjs"), "utf8");
      const fnStart = src.indexOf("export function observeHeadCommit(");
      const fnEnd = src.indexOf("\n}\n", fnStart);
      const body = src.slice(fnStart, fnEnd);
      expect(body).toContain("'rev-parse', '--verify', 'HEAD'");
      expect(body).toMatch(/\?\s*sha\s*:\s*null/);
      expect(body).toMatch(/catch\s*\{\s*return null;/);
    });
  });

  it("AC5/AC13: a complete current observed record with an ancestor commit is delivered and archived; gate step precedes local_merge and mark_implemented", async () => {
    let built;
    ({ dir: mockRoot, record: built } = makeRepo({ record: (c) => observedRecord(REQS, c) }));
    const result = await ship();
    expectArchived(result, built);
    const names = result.steps.map((s) => s.step);
    const gate = stepOf(result, "coverage_record_gate");
    expect(gate.ok).toBe(true);
    expect(gate.verification).toBe("observed");
    expect(names.indexOf("coverage_record_gate")).toBeLessThan(names.indexOf("local_merge"));
    expect(names.indexOf("coverage_record_gate")).toBeLessThan(names.indexOf("mark_implemented"));
    expect(eventsFor("story_ship.success")).toHaveLength(1);
  });

  describe("AC6: reviewer verdicts neither satisfy nor waive the gate", () => {
    for (const verdict of ["pass", "warn"]) {
      it(`review verdict ${verdict}: a missing record is still refused and not moved`, async () => {
        h.reviewPolicy = { enabled: true };
        h.reviewVerdict = verdict;
        ({ dir: mockRoot } = makeRepo());
        const stagingBefore = git(mockRoot, ["rev-parse", "refs/heads/staging"]);
        const result = await ship();
        expect(stepOf(result, "review")?.verdict, `verdict ${verdict}`).toBe(verdict);
        expectRefusedBeforeDelivery(result, stagingBefore, { reasonPattern: /missing coverage record/i });
      });

      it(`review verdict ${verdict}: an incomplete record is still refused and not moved`, async () => {
        h.reviewPolicy = { enabled: true };
        h.reviewVerdict = verdict;
        ({ dir: mockRoot } = makeRepo({
          record: (c) => {
            const r = observedRecord(REQS, c);
            return { ...r, requirements: r.requirements.filter((e) => e.index !== 0) };
          },
        }));
        const stagingBefore = git(mockRoot, ["rev-parse", "refs/heads/staging"]);
        const result = await ship();
        expect(stepOf(result, "review")?.verdict, `verdict ${verdict}`).toBe(verdict);
        expectRefusedBeforeDelivery(result, stagingBefore, { reasonPattern: /incomplete/i });
      });
    }
  });

  describe("AC7: no gate for absent or empty testRequirements", () => {
    for (const [label, reqs] of [["absent", null], ["an empty list", []]]) {
      it(`testRequirements ${label}, no record: archived as before with no coverage_record_gate step`, async () => {
        ({ dir: mockRoot } = makeRepo({ testRequirements: reqs }));
        const result = await ship();
        expectArchived(result);
        expect(stepOf(result, "coverage_record_gate"), `testRequirements ${label}`).toBeUndefined();
      });
    }
  });

  describe("AC9: unverified record accepted only when acceptUnverified is true at ship time", () => {
    it("is archived; mark_implemented and the gate step carry coverageVerification unverified and reason runner_not_recognized; record unchanged", async () => {
      let built;
      ({ dir: mockRoot, record: built } = makeRepo({
        record: (c) => unverifiedRecord(REQS, c),
        projectJson: { testRequirementCoverage: { acceptUnverified: true } },
      }));
      const result = await ship();
      const mark = expectArchived(result, built);
      expect(mark.coverageVerification).toBe("unverified");
      expect(mark.reason).toBe("runner_not_recognized");
      const gate = stepOf(result, "coverage_record_gate");
      expect(gate.ok).toBe(true);
      expect(gate.coverageVerification).toBe("unverified");
      expect(gate.reason).toBe("runner_not_recognized");
    });

    it("no field of the ship result reports the accepted unverified coverage as observed, verified or covered", async () => {
      ({ dir: mockRoot } = makeRepo({
        record: (c) => unverifiedRecord(REQS, c),
        projectJson: { testRequirementCoverage: { acceptUnverified: true } },
      }));
      const result = await ship();
      expect(result.ok, JSON.stringify(result.steps)).toBe(true);
      const offending = [];
      const walk = (v, where) => {
        if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${where}[${i}]`)); return; }
        if (v && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) {
            if (["verified", "covered", "observed"].includes(k) && x) offending.push(`${where}.${k}`);
            walk(x, `${where}.${k}`);
          }
          return;
        }
        if (typeof v === "string" && ["observed", "verified", "covered"].includes(v)) offending.push(`${where}=${v}`);
      };
      walk(result, "result");
      expect(offending).toEqual([]);
    });
  });

  describe("AC10: unverified record refused unless the ship-time policy accepts it", () => {
    const cases = [
      ["project.json absent", undefined, "not_configured"],
      ["project.json unparseable", "{ not json", "project_json_unreadable"],
      ["testRequirementCoverage key absent", {}, "not_configured"],
      ["acceptUnverified false", { testRequirementCoverage: { acceptUnverified: false } }, "disabled"],
      ["acceptUnverified the string true", { testRequirementCoverage: { acceptUnverified: "true" } }, "misconfigured"],
    ];
    for (const [label, projectJson, outcome] of cases) {
      it(`${label}: refused naming the unverified record and policy outcome ${outcome}`, async () => {
        ({ dir: mockRoot } = makeRepo({ record: (c) => unverifiedRecord(REQS, c), projectJson }));
        expect(readFm(notePath()).requirementCoverageRecord.unverified.policySource, label).toMatch(/acceptUnverified/);
        const stagingBefore = git(mockRoot, ["rev-parse", "refs/heads/staging"]);
        const result = await ship();
        expectRefusedBeforeDelivery(result, stagingBefore, { reasonPattern: /unverified coverage record refused/i });
        expect(result.coverageRecordGate.reason, label).toBe("coverage_record_unverified_not_accepted");
        expect(result.coverageRecordGate.policyOutcome, label).toBe(outcome);
        expect(result.error, label).toContain(`policy outcome: ${outcome}`);
      });
    }
  });

  describe("AC11: with acceptUnverified true, an unverified record still needs digest, indices and an ancestor commit", () => {
    const accept = { testRequirementCoverage: { acceptUnverified: true } };
    const cases = [
      ["stale digest", { record: (c) => unverifiedRecord(REQS, c, { requirementsDigest: digest(["something else"]) }) }, "coverage_record_stale"],
      ["missing index 1", { record: (c) => { const r = unverifiedRecord(REQS, c); return { ...r, requirements: r.requirements.filter((e) => e.index !== 1) }; } }, "coverage_record_incomplete"],
      ["commit null", { record: (c) => unverifiedRecord(REQS, c, { commit: null }) }, "coverage_record_delivery_unverifiable"],
      ["commit not an ancestor of the feature-branch HEAD", { record: (c, g) => unverifiedRecord(REQS, orphanCommit(g)) }, "coverage_record_commit_mismatch"],
    ];
    for (const [label, opts, reason] of cases) {
      it(`${label}: refused with ${reason}`, async () => {
        ({ dir: mockRoot } = makeRepo({ ...opts, projectJson: accept }));
        const stagingBefore = git(mockRoot, ["rev-parse", "refs/heads/staging"]);
        const result = await ship();
        expectRefusedBeforeDelivery(result, stagingBefore);
        expect(result.coverageRecordGate.reason, label).toBe(reason);
      });
    }
  });

  describe("AC12: the setting has no effect on observed records; process entries never refuse", () => {
    it("with acceptUnverified true, an observed record whose test entry is failed is still refused", async () => {
      ({ dir: mockRoot } = makeRepo({
        record: (c) => {
          const r = observedRecord(REQS, c);
          return { ...r, requirements: r.requirements.map((e) => (e.index === 1 ? { ...e, observedStatus: "failed" } : e)) };
        },
        projectJson: { testRequirementCoverage: { acceptUnverified: true } },
      }));
      const stagingBefore = git(mockRoot, ["rev-parse", "refs/heads/staging"]);
      const result = await ship();
      expectRefusedBeforeDelivery(result, stagingBefore, { reasonPattern: /index 1/ });
      expect(result.coverageRecordGate.reason).toBe("coverage_record_incomplete");
    });

    for (const [label, projectJson] of [["setting true", { testRequirementCoverage: { acceptUnverified: true } }], ["no testRequirementCoverage key", {}]]) {
      it(`a complete observed record is archived with ${label}`, async () => {
        let built;
        ({ dir: mockRoot, record: built } = makeRepo({ record: (c) => observedRecord(REQS, c), projectJson }));
        const result = await ship();
        expectArchived(result, built);
        expect(stepOf(result, "coverage_record_gate")?.verification, label).toBe("observed");
      });
    }

    it("a record entry with kind process and observedStatus null never causes a refusal", async () => {
      let built;
      ({ dir: mockRoot, record: built } = makeRepo({
        record: (c) => {
          const r = observedRecord(REQS, c);
          return { ...r, requirements: r.requirements.map((e) => (e.kind === "process" ? { ...e, observedStatus: null } : e)) };
        },
      }));
      const processEntry = built.requirements.find((e) => e.kind === "process");
      expect(processEntry.observedStatus).toBeNull();
      const result = await ship();
      expectArchived(result);
      // And directly: an all-process story's record with null statuses passes the evaluation.
      const reqs = ["[process] one", "[process] two"];
      const out = evaluateCoverageRecordGate({
        frontmatter: { testRequirements: reqs, requirementCoverageRecord: { ...observedRecord(reqs, "c".repeat(40)), requirements: reqs.map((_, index) => ({ index, kind: "process", coverage: "process", observedStatus: null })) } },
        targetCommit: "d".repeat(40),
        policy: null,
        isAncestor: () => true,
      });
      expect(out.ok).toBe(true);
    });
  });

  describe("AC13: placement and the already-delivered target", () => {
    const SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server/story-ship.mjs"), "utf8");
    const TOOL = SRC.indexOf("export async function runStoryShipTool(");

    it("the first evaluateCoverageRecordGate( call in runStoryShipTool follows the reviewErr catch and precedes the full-suite gate and both delivery arms", () => {
      expect(TOOL).toBeGreaterThan(-1);
      const reviewCatch = SRC.indexOf("} catch (reviewErr) {", TOOL);
      const gate = SRC.indexOf("evaluateCoverageRecordGate(", TOOL);
      const fullSuite = SRC.indexOf("runFull" + "SuiteGate(", TOOL);
      const merge = SRC.indexOf("localMerge(projectRoot, currentBranch, working)", TOOL);
      const deliver = SRC.indexOf("deliverFeatureBranch(", TOOL);
      for (const [name, idx] of [["reviewCatch", reviewCatch], ["fullSuite", fullSuite], ["merge", merge], ["deliver", deliver]]) {
        expect(idx, `${name} literal must be found`).toBeGreaterThan(-1);
      }
      expect(gate).toBeGreaterThan(reviewCatch);
      expect(gate).toBeLessThan(fullSuite);
      expect(gate).toBeLessThan(merge);
      expect(gate).toBeLessThan(deliver);
    });

    it("the pre-delivery target expression references deliveredEvidence.commit; the gate's git spawns carry explicit timeouts", () => {
      const gate = SRC.indexOf("evaluateCoverageRecordGate(", TOOL);
      const before = SRC.slice(SRC.lastIndexOf("\n\n", gate), gate);
      expect(before).toMatch(/deliveredEvidence \? deliveredEvidence\.commit : observeHeadCommit\(projectRoot\)/);
      for (const marker of ["'rev-parse', '--verify', 'HEAD'", "'merge-base', '--is-ancestor'"]) {
        const at = SRC.indexOf(marker);
        expect(at, marker).toBeGreaterThan(-1);
        const line = SRC.slice(SRC.lastIndexOf("\n", at), SRC.indexOf("\n", at));
        expect(line, marker).toMatch(/timeout: COVERAGE_GIT_TIMEOUT_MS/);
      }
      expect(SRC).toMatch(/const COVERAGE_GIT_TIMEOUT_MS = \d/);
    });

    /** Worktree on staging (no origin), the story commit carries the trailer, then a record commit. */
    function makeDeliveredRepo(record) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-coverage-delivered-"));
      git(dir, ["init", "-q", "-b", "staging"]);
      git(dir, ["config", "user.email", "test@test.com"]);
      git(dir, ["config", "user.name", "test"]);
      git(dir, ["config", "commit.gpgsign", "false"]);
      fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
      fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
      fs.writeFileSync(path.join(dir, "notes", `${STORY_ID}.md`), formatWithFrontmatter({ id: STORY_ID, status: "not-implemented", phase: "executed", testRequirements: REQS }, "body\n"));
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "init"]);
      fs.writeFileSync(path.join(dir, "work.mjs"), "export const x = 1;\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "feat: implement", "-m", `Story: ${STORY_ID}`]);
      const evidence = git(dir, ["rev-parse", "HEAD"]);
      const p = path.join(dir, "notes", `${STORY_ID}.md`);
      fs.writeFileSync(p, spliceNoteFrontmatter(fs.readFileSync(p, "utf8"), { requirementCoverageRecord: record(evidence, (args) => git(dir, args)) }));
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "chore(exec): record coverage"]);
      return { dir, evidence };
    }

    it("on the already-delivered path a record whose commit is the evidence commit passes and the story is archived", async () => {
      let evidence;
      ({ dir: mockRoot, evidence } = makeDeliveredRepo((c) => observedRecord(REQS, c)));
      const result = await ship();
      expect(stepOf(result, "check")?.evidence?.commit).toBe(evidence);
      expect(stepOf(result, "coverage_record_gate")?.ok).toBe(true);
      expectArchived(result);
    });

    it("on the already-delivered path a record whose commit is an ancestor of the evidence commit passes", async () => {
      ({ dir: mockRoot } = makeDeliveredRepo((c, g) => observedRecord(REQS, g(["rev-parse", `${c}~1`]))));
      const result = await ship();
      expect(stepOf(result, "coverage_record_gate")?.ok).toBe(true);
      expectArchived(result);
    });

    it("on the already-delivered path an orphan-branch commit is refused with failedStep coverage_record_gate", async () => {
      let evidence;
      ({ dir: mockRoot, evidence } = makeDeliveredRepo((c, g) => observedRecord(REQS, orphanCommit(g))));
      const stagingBefore = git(mockRoot, ["rev-parse", "refs/heads/staging"]);
      const result = await ship();
      expect(result.ok).toBe(false);
      expect(result.failedStep).toBe("coverage_record_gate");
      expect(result.coverageRecordGate.reason).toBe("coverage_record_commit_mismatch");
      expect(result.coverageRecordGate.targetCommit).toBe(evidence);
      expect(git(mockRoot, ["rev-parse", "refs/heads/staging"])).toBe(stagingBefore);
      expect(fs.existsSync(notePath())).toBe(true);
      expect(readFm(notePath()).phase).toBe("executed");
    });
  });

  describe("AC14: mark_implemented belt", () => {
    const SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server/story-ship.mjs"), "utf8");

    it("a second evaluateCoverageRecordGate( call sits after deliverFeatureBranch( and before reconcileExecutingBeforeShip(; its refusal pushes buildMarkImplementedFailure( and increments stepsSkipped without returning", () => {
      const tool = SRC.indexOf("export async function runStoryShipTool(");
      const first = SRC.indexOf("evaluateCoverageRecordGate(", tool);
      const deliver = SRC.indexOf("deliverFeatureBranch(", tool);
      const second = SRC.indexOf("evaluateCoverageRecordGate(", deliver);
      const reconcile = SRC.indexOf("reconcileExecutingBeforeShip(", tool);
      expect(first).toBeGreaterThan(tool);
      expect(deliver).toBeGreaterThan(first);
      expect(second).toBeGreaterThan(deliver);
      expect(reconcile).toBeGreaterThan(second);
      const refusal = SRC.indexOf("if (coverageBelt && !coverageBelt.ok) {", second);
      expect(refusal).toBeGreaterThan(second);
      expect(refusal).toBeLessThan(reconcile);
      const branch = SRC.slice(refusal, reconcile);
      expect(branch).toContain("steps.push(buildMarkImplementedFailure(");
      expect(branch).toContain("stepsSkipped++");
      expect(branch).not.toMatch(/\breturn\b/);
      // The belt targets the delivered commit.
      expect(SRC.slice(second, refusal)).toContain("targetCommit: deliveredCommitSha");
    });

    it("given a null target, the shared evaluation refuses naming unverifiable delivery", () => {
      const isAncestor = vi.fn(() => true);
      const out = evaluateCoverageRecordGate({
        frontmatter: { testRequirements: REQS, requirementCoverageRecord: observedRecord(REQS, "e".repeat(40)) },
        targetCommit: null,
        policy: { acceptUnverified: true },
        isAncestor,
      });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/unverifiable delivery/i);
      expect(isAncestor).not.toHaveBeenCalled();
    });
  });

  it("[process] every subprocess spawn in this test file passes an explicit timeout", () => {
    const self = fs.readFileSync(HERE, "utf8");
    const spawnName = "execFile" + "Sync(";
    const calls = [];
    for (let i = self.indexOf(spawnName); i !== -1; i = self.indexOf(spawnName, i + 1)) {
      const lineStart = self.lastIndexOf("\n", i) + 1;
      const line = self.slice(lineStart, self.indexOf("\n", i));
      if (line.trimStart().startsWith("import ")) continue;
      calls.push(line);
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const line of calls) expect(line, `spawn without timeout: ${line.trim()}`).toContain("timeout: GIT_TIMEOUT_MS");
    for (const banned of ["spawn" + "Sync(", "exec" + "Sync(", "exe" + "ca("]) expect(self, banned).not.toContain(banned);
  });
});
