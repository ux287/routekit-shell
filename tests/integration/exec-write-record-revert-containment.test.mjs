/**
 * backlog.fix.exec-write-record-revert-and-containment-followups
 * (a) one deferred createdDirs cleanup pass after revert, (b) lstat-based nearestExisting,
 * (c) pre-flight containment over all steps, (d) applyFixPlan refusal in the exec result,
 * (e) non-regular-target refusal in resolvePlanTarget.
 *
 * Harness: tests/integration/exec-write-record-hardening.test.mjs. Every spawnSync passes an explicit timeout.
 * testRequirement -> test: each `it` title begins with [RCn], n = the story's nth testRequirement.
 *
 * Real modules: backup.mjs, exec.mjs, fix-planner.mjs (applyFixPlan), command-runner.mjs. Real git in a
 * temp repo. loadContext, embedScopedFiles and guardrailsOff/On are mocked (collaborators). runProjectTests,
 * applyFixPlan and generateFixPlan are wrapped: they delegate to the real function (or return null for
 * generateFixPlan, which would call an LLM) unless a test installs an override through `h`. runRefineTool
 * is stubbed (it would call an LLM on the tests-failed path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { makeTempDir } from "../helpers/tmp.mjs";

const h = vi.hoisted(() => ({ root: null, runTests: null, applyFix: null, genFix: null }));
vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  loadContext: vi.fn(async (projectId) => ({ record: { id: projectId, root: h.root }, projectJson: { baseBranch: "staging" } })),
}));
vi.mock("@routekit/rag", async (importOriginal) => ({
  ...(await importOriginal()),
  embedScopedFiles: vi.fn(async () => ({ ok: true, filesEmbedded: 0 })),
}));
vi.mock("../../packages/mcp-rks/src/server/guardrails-audit.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  guardrailsOff: vi.fn(async () => ({ ok: true })),
  guardrailsOn: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../packages/mcp-rks/src/exec/command-runner.mjs", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    runProjectTests: vi.fn((...args) => (h.runTests ? h.runTests(...args) : orig.runProjectTests(...args))),
  };
});
vi.mock("../../packages/mcp-rks/src/server/fix-planner.mjs", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    applyFixPlan: vi.fn((...args) => (h.applyFix ? h.applyFix(...args) : orig.applyFixPlan(...args))),
    generateFixPlan: vi.fn(async (...args) => (h.genFix ? h.genFix(...args) : null)),
  };
});
vi.mock("../../packages/mcp-rks/src/server/refine.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  runRefineTool: vi.fn(async () => null),
}));

const {
  resolvePlanTarget,
  beginWriteRecordAttempt,
  readWriteRecord,
  recordPlanPreImage,
  recordPlanPostWrite,
  revertPlanWrites,
} = await import("../../packages/mcp-rks/src/exec/backup.mjs");
const { runApplyTool, runExecTool } = await import("../../packages/mcp-rks/src/server/exec.mjs");
const { applyFixPlan, generateFixPlan } = await import("../../packages/mcp-rks/src/server/fix-planner.mjs");
const { runProjectTests } = await import("../../packages/mcp-rks/src/exec/command-runner.mjs");

const REPO = path.resolve(import.meta.dirname, "../..");
const EXEC_SRC_PATH = path.join(REPO, "packages/mcp-rks/src/server/exec.mjs");
const FIX_SRC_PATH = path.join(REPO, "packages/mcp-rks/src/server/fix-planner.mjs");

const GIT_TIMEOUT = 15_000;
const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const entriesOf = (runDir) => readWriteRecord(runDir)?.record?.entries ?? [];
const escRe = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

let root;
let runDir;
let outside;

beforeEach(() => {
  h.root = null;
  h.runTests = null;
  h.applyFix = null;
  h.genFix = null;
  vi.mocked(runProjectTests).mockClear();
  vi.mocked(applyFixPlan).mockClear();
  vi.mocked(generateFixPlan).mockClear();
  root = makeTempDir("wr-rc-root-");
  outside = makeTempDir("wr-rc-outside-");
  runDir = path.join(root, ".rks", "runs", "r1");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  beginWriteRecordAttempt(runDir, { attemptId: "A1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function makeRepo() {
  fs.writeFileSync(path.join(root, "notes", "b.md"), "# b\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".rks/*\n!.rks/plans/\n");
  git(root, ["init", "-q", "-b", "staging"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.hooksPath", ".git/hooks"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "baseline"]);
  h.root = root;
}

function writePlan(label, steps) {
  const dir = path.join(root, ".rks", "runs", `2026-11-08T00-00-00-000Z_${label}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ slug: label, status: "executable", steps }, null, 2));
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ projectId: "rc", timestamps: {}, telemetry: { outcome: "planned" } }));
  return dir;
}

/** Record + write + record, the order the writers use. */
function planCreate(rel, body) {
  recordPlanPreImage(root, runDir, rel);
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
  recordPlanPostWrite(root, runDir, rel);
}

const PASS = { passed: true, skipped: false, output: "1 passed", summary: "1 passed", exitCode: 0, executedCount: 1 };
const FAIL = { passed: false, skipped: false, output: "FAIL tests/x.test.mjs > x", summary: "1 failed", exitCode: 1, executedCount: 1 };

describe("(a) deferred createdDirs cleanup after revert", () => {
  it("[RC1] two create_file entries under one new directory: both files and the shared directory are gone after revert", () => {
    planCreate("notes/x/a.md", "a\n");
    planCreate("notes/x/b.md", "b\n");
    expect(entriesOf(runDir).find((e) => e.target === "notes/x/b.md").createdDirs).toEqual([]);
    const res = revertPlanWrites(root, runDir);
    expect(fs.existsSync(path.join(root, "notes", "x"))).toBe(false);
    expect(fs.statSync(path.join(root, "notes")).isDirectory()).toBe(true);
    expect(res.reverted.sort()).toEqual(["notes/x/a.md", "notes/x/b.md"]);
    expect(res.leftBehind).toEqual([]);
  });

  it("[RC2] an existed-false entry whose file is already absent at revert (atPreRun) is reverted and its createdDirs are removed", () => {
    planCreate("notes/y/z/a.md", "a\n");
    expect(entriesOf(runDir)[0].createdDirs).toEqual(["notes/y/z", "notes/y"]);
    fs.rmSync(path.join(root, "notes", "y", "z", "a.md"));
    const res = revertPlanWrites(root, runDir);
    expect(res.reverted).toEqual(["notes/y/z/a.md"]);
    expect(res.leftBehind).toEqual([]);
    expect(fs.existsSync(path.join(root, "notes", "y"))).toBe(false);
    expect(fs.statSync(path.join(root, "notes")).isDirectory()).toBe(true);
  });

  it("[RC3] nested new directories (notes/x and notes/x/y) are all removed after revert, deepest first, leaving notes/", () => {
    // b.md first: its entry records ["notes/x"]; a.md's then records only ["notes/x/y"]. Collected in
    // entry order that is [notes/x, notes/x/y], so only a deepest-first pass removes both.
    planCreate("notes/x/b.md", "b\n");
    planCreate("notes/x/y/a.md", "a\n");
    expect(entriesOf(runDir).map((e) => e.createdDirs)).toEqual([["notes/x"], ["notes/x/y"]]);
    const res = revertPlanWrites(root, runDir);
    expect(fs.existsSync(path.join(root, "notes", "x", "y"))).toBe(false);
    expect(fs.existsSync(path.join(root, "notes", "x"))).toBe(false);
    expect(fs.statSync(path.join(root, "notes")).isDirectory()).toBe(true);
    expect(res.reverted.sort()).toEqual(["notes/x/b.md", "notes/x/y/a.md"]);
    expect(res.leftBehind).toEqual([]);
  });

  it("[RC4] a shared new directory that gained an unrelated file is kept, the file intact, and not reported; symlink and outside-root createdDirs are never removed", () => {
    planCreate("notes/x/a.md", "a\n");
    planCreate("notes/x/b.md", "b\n");
    fs.writeFileSync(path.join(root, "notes", "x", "user.md"), "user\n");
    const res = revertPlanWrites(root, runDir);
    expect(fs.readFileSync(path.join(root, "notes", "x", "user.md"), "utf8")).toBe("user\n");
    expect(fs.existsSync(path.join(root, "notes", "x", "a.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "notes", "x", "b.md"))).toBe(false);
    expect(res.reverted.sort()).toEqual(["notes/x/a.md", "notes/x/b.md"]);
    expect(res.leftBehind).toEqual([]);

    // A createdDirs entry replaced by a symlink (to an empty in-root dir), and a hand-seeded
    // outside-root createdDirs entry: neither the link, its referent nor the outside directory is removed.
    beginWriteRecordAttempt(runDir, { attemptId: "A2" });
    planCreate("notes/s/a.md", "a\n");
    fs.rmSync(path.join(root, "notes", "s"), { recursive: true });
    const linkTarget = path.join(root, "notes", "linked");
    fs.mkdirSync(linkTarget);
    fs.symlinkSync(linkTarget, path.join(root, "notes", "s"), "dir");
    const rec = readWriteRecord(runDir).record;
    rec.entries[0].createdDirs.push(path.relative(root, outside).split(path.sep).join("/"));
    fs.writeFileSync(path.join(runDir, "apply", "write-record.json"), JSON.stringify(rec));
    const res2 = revertPlanWrites(root, runDir);
    expect(res2.reverted).toEqual(["notes/s/a.md"]);
    expect(fs.lstatSync(path.join(root, "notes", "s")).isSymbolicLink()).toBe(true);
    expect(fs.statSync(linkTarget).isDirectory()).toBe(true);
    expect(fs.statSync(outside).isDirectory()).toBe(true);
  });

  it("[RC5] the returned reverted / leftBehind equal the persisted revertOutcome, and the cleanup pass adds no entry to either", () => {
    planCreate("notes/x/a.md", "a\n");
    planCreate("notes/x/b.md", "b\n");
    planCreate("notes/x/c.md", "c\n");
    fs.writeFileSync(path.join(root, "notes", "x", "c.md"), "changed after the plan\n");
    const res = revertPlanWrites(root, runDir);
    expect(res.reverted.sort()).toEqual(["notes/x/a.md", "notes/x/b.md"]);
    expect(res.leftBehind.map((l) => l.path)).toEqual(["notes/x/c.md"]);
    // notes/x is kept (c.md is still in it) and that skip is not reported.
    expect(fs.statSync(path.join(root, "notes", "x")).isDirectory()).toBe(true);
    const outcome = readWriteRecord(runDir).record.revertOutcome;
    expect(outcome.reverted).toEqual(res.reverted);
    expect(outcome.leftBehind).toEqual(res.leftBehind);
  });
});

describe("(b) and (e) resolvePlanTarget", () => {
  it("[RC6] accepts a target through an in-root symlink to an existing in-root directory", () => {
    fs.mkdirSync(path.join(root, "notes", "real"));
    fs.symlinkSync(path.join(root, "notes", "real"), path.join(root, "notes", "inlink"), "dir");
    expect(resolvePlanTarget(root, "notes/inlink/x.md")).toBe(path.resolve(root, "notes/inlink/x.md"));
  });

  it("[RC7] throws, naming the target, when an ancestor is a dangling symlink (outside or in-root referent)", () => {
    fs.symlinkSync(path.join(outside, "missing"), path.join(root, "notes", "link"), "dir");
    expect(() => resolvePlanTarget(root, "notes/link/x.md")).toThrow(/notes\/link\/x\.md/);
    fs.symlinkSync(path.join(root, "notes", "missing-dir"), path.join(root, "notes", "inlink"), "dir");
    expect(() => resolvePlanTarget(root, "notes/inlink/x.md")).toThrow(/notes\/inlink\/x\.md/);
  });

  it("[RC8] with no runDir, throws 'is not a regular file' for a target that is an in-root symlink to a file or a dangling symlink", () => {
    fs.writeFileSync(path.join(root, "notes", "real.md"), "real\n");
    fs.symlinkSync(path.join(root, "notes", "real.md"), path.join(root, "notes", "l.md"));
    expect(() => resolvePlanTarget(root, "notes/l.md")).toThrow(/notes\/l\.md.*is not a regular file/);
    fs.symlinkSync(path.join(root, "notes", "nothing.md"), path.join(root, "notes", "d.md"));
    expect(() => resolvePlanTarget(root, "notes/d.md")).toThrow(/notes\/d\.md.*is not a regular file/);
  });

  it("[RC9] with no runDir, throws 'is not a regular file' for an existing directory and for a FIFO", () => {
    fs.mkdirSync(path.join(root, "notes", "dir"));
    expect(() => resolvePlanTarget(root, "notes/dir")).toThrow(/notes\/dir.*is not a regular file/);
    const r = spawnSync("mkfifo", [path.join(root, "notes", "fifo")], { encoding: "utf8", timeout: GIT_TIMEOUT });
    expect(r.status, r.stderr).toBe(0);
    expect(() => resolvePlanTarget(root, "notes/fifo")).toThrow(/notes\/fifo.*is not a regular file/);
  });

  it("[RC10] still returns path.resolve(root, target) for a missing target (missing parents too) and an existing regular file", () => {
    expect(resolvePlanTarget(root, "notes/new.md")).toBe(path.resolve(root, "notes/new.md"));
    expect(resolvePlanTarget(root, "notes/p/q/r.md")).toBe(path.resolve(root, "notes/p/q/r.md"));
    fs.writeFileSync(path.join(root, "notes", "reg.md"), "reg\n");
    expect(resolvePlanTarget(root, "notes/reg.md")).toBe(path.resolve(root, "notes/reg.md"));
  });

  it("[RC11] the record helpers still refuse a symlink target (no entry / null postHash) and record a delete as postExists false", () => {
    fs.writeFileSync(path.join(root, "notes", "real.md"), "real\n");
    fs.symlinkSync(path.join(root, "notes", "real.md"), path.join(root, "notes", "l.md"));
    expect(() => recordPlanPreImage(root, runDir, "notes/l.md")).toThrow(/notes\/l\.md/);
    expect(entriesOf(runDir).find((e) => e.target === "notes/l.md")).toBeUndefined();

    recordPlanPreImage(root, runDir, "notes/p.md");
    fs.symlinkSync(path.join(root, "notes", "real.md"), path.join(root, "notes", "p.md"));
    expect(() => recordPlanPostWrite(root, runDir, "notes/p.md")).toThrow(/notes\/p\.md/);
    expect(entriesOf(runDir).find((e) => e.target === "notes/p.md").postHash).toBeNull();

    fs.writeFileSync(path.join(root, "notes", "del.md"), "del\n");
    recordPlanPreImage(root, runDir, "notes/del.md");
    fs.rmSync(path.join(root, "notes", "del.md"));
    expect(() => recordPlanPostWrite(root, runDir, "notes/del.md")).not.toThrow();
    const del = entriesOf(runDir).find((e) => e.target === "notes/del.md");
    expect(del.postExists).toBe(false);
    expect(del.postHash).toBeNull();
  });
});

describe("(c) pre-flight containment", () => {
  it("[RC12] runApplyTool refuses a plan whose LAST file step escapes the root before ANY step writes", async () => {
    makeRepo();
    const dir = writePlan("rc12", [
      { action: "create_file", path: "notes/early-a.md", content: "a\n", title: "a" },
      { action: "create_file", path: "notes/early-b.md", content: "b\n", title: "b" },
      { action: "create_file", path: "../rc12-escape.md", content: "x\n", title: "x" },
    ]);
    let err = null;
    try {
      await runApplyTool({ projectId: "rc", label: "rc12", force: true });
    } catch (e) {
      err = e;
    }
    try {
      expect(err?.code).toBe(ErrorCode.InvalidParams);
      expect(err.message).toMatch(/refused/);
      expect(err.message).toMatch(/\.\.\/rc12-escape\.md/);
      expect(fs.existsSync(path.join(root, "notes", "early-a.md"))).toBe(false);
      expect(fs.existsSync(path.join(root, "notes", "early-b.md"))).toBe(false);
      expect(entriesOf(dir)).toHaveLength(0);
    } finally {
      fs.rmSync(path.resolve(root, "../rc12-escape.md"), { force: true });
    }
  }, 60_000);

  it("[RC13] runApplyTool refuses a plan whose last step goes through an in-root symlink to an outside directory before ANY step writes", async () => {
    makeRepo();
    fs.symlinkSync(outside, path.join(root, "notes", "link"), "dir");
    const dir = writePlan("rc13", [
      { action: "create_file", path: "notes/early.md", content: "a\n", title: "a" },
      { action: "create_file", path: "notes/link/x.md", content: "x\n", title: "x" },
    ]);
    let err = null;
    try {
      await runApplyTool({ projectId: "rc", label: "rc13", force: true });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toMatch(/notes\/link\/x\.md/);
    expect(fs.existsSync(path.join(root, "notes", "early.md"))).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(entriesOf(dir)).toHaveLength(0);
  }, 60_000);

  it("[RC14] applyFixPlan refuses a fix plan whose LAST file step escapes the root before ANY fix step writes", async () => {
    makeRepo();
    const dir = writePlan("rc14", []);
    const res = await applyFixPlan({
      projectId: "rc",
      projectRoot: root,
      runDir: dir,
      attemptNumber: 2,
      plan: { steps: [
        { action: "create_file", path: "notes/fix-a.md", content: "a\n" },
        { action: "create_file", path: "../rc14-escape.md", content: "x\n" },
      ] },
    });
    try {
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Fix plan step create_file refused:/);
      expect(res.error).toMatch(/\.\.\/rc14-escape\.md/);
      expect(res.appliedFiles).toEqual([]);
      expect(fs.existsSync(path.join(root, "notes", "fix-a.md"))).toBe(false);
      expect(entriesOf(dir)).toHaveLength(0);
    } finally {
      fs.rmSync(path.resolve(root, "../rc14-escape.md"), { force: true });
    }
  }, 60_000);

  it("[RC15] exec.mjs and fix-planner.mjs keep the per-step resolver line once, add a pre-flight call, and never path.join(projectRoot, target)", () => {
    const perStep = "absPath = resolvePlanTarget(projectRoot, target);";
    for (const file of [EXEC_SRC_PATH, FIX_SRC_PATH]) {
      const src = fs.readFileSync(file, "utf8");
      expect(src.split(perStep).length - 1, file).toBe(1);
      expect(src.split("resolvePlanTarget(").length - 1, file).toBeGreaterThanOrEqual(2);
      expect(src.includes("path.join(projectRoot, target)"), file).toBe(false);
    }
  });
});

describe("(d) applyFixPlan refusal in the exec result", () => {
  it("[RC16] tests fail after apply and applyFixPlan refuses: the result carries fixApplyRefusal { attempt, error }", async () => {
    makeRepo();
    writePlan("rc16", [{ action: "create_file", path: "notes/rc16.md", content: "# rc16\n", title: "c" }]);
    const injected = "Fix plan step create_file refused: injected rc16 refusal";
    let call = 0;
    h.runTests = () => (++call === 1 ? PASS : FAIL); // baseline passes, verification fails
    h.genFix = async () => ({ steps: [{ action: "create_file", path: "notes/rc16-fix.md", content: "x\n" }] });
    h.applyFix = async () => ({ ok: false, error: injected, appliedFiles: [] });
    const result = await runExecTool({ projectId: "rc", label: "rc16" });
    expect(vi.mocked(applyFixPlan)).toHaveBeenCalledTimes(1);
    const passedAttempt = vi.mocked(applyFixPlan).mock.calls[0][0].attemptNumber;
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.testsFailed).toBe(true);
    expect(result.fixApplyRefusal).toEqual({ attempt: passedAttempt, error: injected });
    expect(passedAttempt).toBe(2);
  }, 120_000);

  it("[RC17] no fix plan refused (tests pass after apply): the result has no fixApplyRefusal property", async () => {
    makeRepo();
    writePlan("rc17", [{ action: "create_file", path: "notes/rc17.md", content: "# rc17\n", title: "c" }]);
    h.runTests = () => PASS;
    const result = await runExecTool({ projectId: "rc", label: "rc17" });
    expect(result.testsPassed, JSON.stringify(result)).toBe(true);
    expect(vi.mocked(applyFixPlan)).not.toHaveBeenCalled();
    expect(Object.prototype.hasOwnProperty.call(result, "fixApplyRefusal")).toBe(false);
  }, 120_000);

  it("[RC18] exec.mjs has no 'rolledBack: true', no 'write-record.json' and no assignment to plan.requirementCoverage", () => {
    const src = fs.readFileSync(EXEC_SRC_PATH, "utf8");
    const lines = src.split("\n");
    expect(lines.some((l) => l.includes("rolledBack: true"))).toBe(false);
    expect(lines.some((l) => l.includes("write-record.json"))).toBe(false);
    expect(/\bplan\.requirementCoverage\s*=/.test(src)).toBe(false);
    // Positive control: the same read sees a string that is known to be present.
    expect(src).toMatch(escRe("await rollback("));
  });
});
