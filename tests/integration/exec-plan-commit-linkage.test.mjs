// backlog.feat.exec-plan-commit-linkage — AC1, AC2 (commit level), AC3 (git half), AC14 (real git).
// Every git subprocess in this file passes an explicit timeout.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Mock only the embedding step, never commitAndEmbed: the real git commit must run.
vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));

import { runGitCommit } from "../../packages/mcp-rks/src/server/git/git-workflow.mjs";
import {
  buildExecTrailers,
  buildPlanArchive,
  writePlanArchive,
  planArchiveRelPath,
  planHashFor,
  checkPlanArchiveIgnored,
  planArchiveWriteFailed,
  cleanupPlanArchive,
} from "../../packages/mcp-rks/src/server/exec-provenance.mjs";
import { markExecComplete } from "../../packages/mcp-rks/src/workflow/exec-state.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");
const PROV_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec-provenance.mjs"), "utf8");
const WORKFLOW_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/git/git-workflow.mjs"), "utf8");
const TIMEOUT = 15_000;
const git = (cwd, args, input) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT, input });

const STORY = "backlog.feat.some-story";
const RUN_ID = "run-20261024-0001";
const PLAN = { problemId: STORY, steps: [{ action: "edit_file", path: "src/a.mjs" }], qualityReview: { hash: "x" } };
const PLAN_HASH = planHashFor(PLAN);
const CO_AUTHOR_ID = "Test Author <test@example.com>";

const roots = [];
function makeRepo(gitignore = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "exec-plan-commit-"));
  roots.push(root);
  git(root, ["init", "-q", "-b", "staging"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(root, "init.txt"), "init\n");
  if (gitignore !== null) fs.writeFileSync(path.join(root, ".gitignore"), gitignore);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  git(root, ["checkout", "-q", "-b", "rks/some-story"]);
  return root;
}
function writeApplied(root, name = "src/a.mjs") {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), `// work ${Math.random()}\n`);
  return name;
}
const headBody = (root) => git(root, ["log", "-1", "--format=%B"]);
const headSha = (root) => git(root, ["rev-parse", "HEAD"]).trim();
const parsedTrailers = (root) => git(root, ["interpret-trailers", "--parse"], headBody(root));
const lastParagraph = (body) => body.trimEnd().split("\n\n").pop().split("\n");
const lsTree = (root) => git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean);

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe("runGitCommit trailers (AC1/AC2)", { timeout: 30_000 }, () => {
  let root;
  beforeEach(() => { root = makeRepo(); });

  it("Story, Plan-Hash and Run-Id share one final trailer block reported by git interpret-trailers --parse", async () => {
    const file = writeApplied(root);
    const res = await runGitCommit({
      projectRoot: root, message: STORY, scope: "exec", type: "feat", files: [file], storyId: STORY,
      trailers: buildExecTrailers({ planHash: PLAN_HASH, runId: RUN_ID }),
    });
    expect(res.ok).toBe(true);
    expect(lastParagraph(headBody(root))).toEqual([`Story: ${STORY}`, `Plan-Hash: ${PLAN_HASH}`, `Run-Id: ${RUN_ID}`]);
    const parsed = parsedTrailers(root);
    expect(parsed).toContain(`Story: ${STORY}`);
    expect(parsed).toContain(`Plan-Hash: ${PLAN_HASH}`);
    expect(parsed).toContain(`Run-Id: ${RUN_ID}`);
  });

  it("with coAuthor, Co-Authored-By is in the same block as all three", async () => {
    const file = writeApplied(root);
    const res = await runGitCommit({
      projectRoot: root, message: STORY, scope: "exec", type: "feat", files: [file], storyId: STORY, coAuthor: CO_AUTHOR_ID,
      trailers: buildExecTrailers({ planHash: PLAN_HASH, runId: RUN_ID }),
    });
    expect(res.ok).toBe(true);
    const block = lastParagraph(headBody(root));
    expect(block).toEqual([`Co-Authored-By: ${CO_AUTHOR_ID}`, `Story: ${STORY}`, `Plan-Hash: ${PLAN_HASH}`, `Run-Id: ${RUN_ID}`]);
    const parsed = parsedTrailers(root);
    for (const l of block) expect(parsed).toContain(l);
  });

  it("trailers absent or [] leaves the message byte-identical to today", async () => {
    const bodies = [];
    for (const extra of [{}, { trailers: [] }, { trailers: undefined }]) {
      const file = writeApplied(root, `src/f-${bodies.length}.mjs`);
      const res = await runGitCommit({ projectRoot: root, message: STORY, scope: "exec", type: "feat", files: [file], storyId: STORY, ...extra });
      expect(res.ok).toBe(true);
      bodies.push(headBody(root));
    }
    expect(bodies[0].trimEnd()).toBe(`feat(exec): ${STORY}\n\nStory: ${STORY}`);
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
  });

  it("trailers with no storyId and no coAuthor still open their own parseable trailer block", async () => {
    const file = writeApplied(root);
    const res = await runGitCommit({ projectRoot: root, message: "slug", scope: "exec", type: "feat", files: [file], trailers: [{ key: "Run-Id", value: RUN_ID }] });
    expect(res.ok).toBe(true);
    expect(headBody(root).trimEnd()).toBe(`feat(exec): slug\n\nRun-Id: ${RUN_ID}`);
    expect(parsedTrailers(root)).toContain(`Run-Id: ${RUN_ID}`);
  });

  it("exec.mjs passes storyId: plan.problemId and trailers built by buildExecTrailers from planHashFor(plan) and runIdValue", () => {
    expect(EXEC_SRC).toMatch(/runGitCommit\(\{[^}]*storyId:\s*plan\.problemId,\s*trailers:\s*execTrailers,?[^}]*\}\)/);
    expect(EXEC_SRC).toContain("const execTrailers = buildExecTrailers({ planHash: planHashFor(plan), runId: runIdValue });");
  });
});

describe("plan archive in the commit (AC3)", { timeout: 30_000 }, () => {
  it("git show HEAD:.rks/plans/<runId>.json returns an archive whose planHash equals the Plan-Hash trailer", async () => {
    const root = makeRepo(".rks/*\n!.rks/plans/\n");
    const file = writeApplied(root);
    const fixPlans = [{ attempt: 2, steps: [] }];
    const rel = writePlanArchive(root, buildPlanArchive({ runId: RUN_ID, plan: PLAN, fixPlans }));
    expect(rel).toBe(planArchiveRelPath(RUN_ID));
    const res = await runGitCommit({
      projectRoot: root, message: STORY, scope: "exec", type: "feat", files: [file, rel], storyId: STORY,
      trailers: buildExecTrailers({ planHash: PLAN_HASH, runId: RUN_ID }),
    });
    expect(res.ok).toBe(true);
    const archived = JSON.parse(git(root, ["show", `HEAD:.rks/plans/${RUN_ID}.json`]));
    const trailerHash = /^Plan-Hash: (\S+)$/m.exec(parsedTrailers(root))?.[1];
    expect(trailerHash).toBe(PLAN_HASH);
    expect(archived.planHash).toBe(trailerHash);
    expect(planHashFor(archived.plan)).toBe(archived.planHash);
    expect(archived.fixPlans).toEqual(fixPlans);
    expect(/^Run-Id: (\S+)$/m.exec(parsedTrailers(root))?.[1]).toBe(archived.runId);
  });
});

describe("root .gitignore tracks .rks/plans/", () => {
  it("check-ignore: .rks/plans is not ignored, .rks/runs still is", () => {
    const ignored = (p) => {
      try { execFileSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: REPO_ROOT, timeout: TIMEOUT }); return true; } catch { return false; }
    };
    expect(ignored(".rks/plans/run-x.json")).toBe(false);
    expect(ignored(".rks/runs/run-x/plan.yaml")).toBe(true);
  });
});

// AC14 (QA 2026-10-24): checkPlanArchiveIgnored against real git in temp repos.
describe("AC14 ignored archive path", { timeout: 30_000 }, () => {
  it("temp repo with .gitignore `.rks/`: checkPlanArchiveIgnored returns { status: 'ignored', error: null }", () => {
    const root = makeRepo(".rks/\n");
    expect(checkPlanArchiveIgnored(root, planArchiveRelPath(RUN_ID))).toEqual({ status: "ignored", error: null });
  });

  it("design-risk witness: with the archive written under an ignored `.rks/`, runGitCommit listing it in files does not return ok: true and HEAD is unchanged", async () => {
    const root = makeRepo(".rks/\n");
    const file = writeApplied(root);
    const rel = writePlanArchive(root, buildPlanArchive({ runId: RUN_ID, plan: PLAN }));
    const before = headSha(root);
    const res = await runGitCommit({ projectRoot: root, message: STORY, scope: "exec", type: "feat", files: [file, rel], storyId: STORY });
    expect(res.ok).not.toBe(true);
    expect(headSha(root)).toBe(before);
  });

  it("ignored: runGitCommit listing only the applied file with storyId and buildExecTrailers trailers succeeds; interpret-trailers reports all three; ls-tree has no .rks/plans/ path", async () => {
    const root = makeRepo(".rks/\n");
    const file = writeApplied(root);
    expect(checkPlanArchiveIgnored(root, planArchiveRelPath(RUN_ID)).status).toBe("ignored");
    const res = await runGitCommit({
      projectRoot: root, message: STORY, scope: "exec", type: "feat", files: [file], storyId: STORY,
      trailers: buildExecTrailers({ planHash: PLAN_HASH, runId: RUN_ID }),
    });
    expect(res.ok).toBe(true);
    const parsed = parsedTrailers(root);
    expect(parsed).toContain(`Story: ${STORY}`);
    expect(parsed).toContain(`Plan-Hash: ${PLAN_HASH}`);
    expect(parsed).toContain(`Run-Id: ${RUN_ID}`);
    expect(lsTree(root).filter((p) => p.startsWith(".rks/plans/"))).toEqual([]);
    expect(lsTree(root)).toContain(file);
  });

  it("temp repo with `.rks/*` then `!.rks/plans/`: checkPlanArchiveIgnored returns not_ignored and a commit listing the written archive contains it", async () => {
    const root = makeRepo(".rks/*\n!.rks/plans/\n");
    const rel = planArchiveRelPath(RUN_ID);
    expect(checkPlanArchiveIgnored(root, rel)).toEqual({ status: "not_ignored", error: null });
    const file = writeApplied(root);
    writePlanArchive(root, buildPlanArchive({ runId: RUN_ID, plan: PLAN }));
    const res = await runGitCommit({ projectRoot: root, message: STORY, scope: "exec", type: "feat", files: [file, rel], storyId: STORY });
    expect(res.ok).toBe(true);
    expect(lsTree(root)).toContain(`.rks/plans/${RUN_ID}.json`);
  });

  it("non-repo temp dir: checkPlanArchiveIgnored returns check_failed with a non-empty error naming exit 128", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    roots.push(dir);
    const out = checkPlanArchiveIgnored(dir, planArchiveRelPath(RUN_ID));
    expect(out.status).toBe("check_failed");
    expect(out.status).not.toBe("ignored");
    expect(out.status).not.toBe("not_ignored");
    expect(typeof out.error).toBe("string");
    expect(out.error).toMatch(/exit 128/);
  });

  it("real repo root: checkPlanArchiveIgnored(REPO_ROOT, '.rks/plans/run-x.json') returns not_ignored", () => {
    expect(checkPlanArchiveIgnored(REPO_ROOT, ".rks/plans/run-x.json")).toEqual({ status: "not_ignored", error: null });
  });
});

describe("exec.mjs structural pins (AC3, AC14)", () => {
  const iShould = EXEC_SRC.indexOf("if (shouldCommit) {");
  const iCheck = EXEC_SRC.indexOf("checkPlanArchiveIgnored(", iShould);
  const iWrite = EXEC_SRC.indexOf("writePlanArchive(", iShould);
  const iCommit = EXEC_SRC.indexOf("runGitCommit(", iShould);

  it("imports checkPlanArchiveIgnored and the archive builders from ./exec-provenance.mjs", () => {
    const imp = EXEC_SRC.slice(EXEC_SRC.indexOf("import {\n  planHashFor,"), EXEC_SRC.indexOf('} from "./exec-provenance.mjs";') + 1);
    for (const name of ["checkPlanArchiveIgnored", "writePlanArchive", "buildPlanArchive", "planArchiveRelPath", "buildExecTrailers", "planHashFor", "emitTerminalOutcome"]) {
      expect(imp, name).toContain(name);
    }
  });

  it("check precedes the single write, which precedes runGitCommit, all inside if (shouldCommit) and after the scope guard", () => {
    expect(iShould).toBeGreaterThan(EXEC_SRC.indexOf("const unexpectedFiles = computeUnexpectedFiles("));
    expect(iCheck).toBeGreaterThan(iShould);
    expect(iWrite).toBeGreaterThan(iCheck);
    expect(iCommit).toBeGreaterThan(iWrite);
    expect([...EXEC_SRC.matchAll(/writePlanArchive\(/g)]).toHaveLength(1);
    // The write is gated on the not_ignored status.
    expect(EXEC_SRC.slice(iCheck, iWrite)).toContain('"not_ignored"');
    // The archive work sits inside the commitFiles.length > 0 branch.
    const iBranch = EXEC_SRC.indexOf("if (commitFiles.length > 0) {", iShould);
    expect(iBranch).toBeGreaterThan(iShould);
    expect(iBranch).toBeLessThan(iCheck);
  });

  it("commitFiles is unchanged and never pushed; execCommitFiles is built on its own line and passed as files", () => {
    expect(EXEC_SRC).toContain("  const commitFiles = [...new Set([...appliedFiles, ...installDerived])];");
    expect(EXEC_SRC).not.toMatch(/commitFiles\.push\(/);
    expect(EXEC_SRC).not.toMatch(/execCommitFiles\.push\(/);
    const lines = EXEC_SRC.split("\n");
    const par = lines.filter((l) => l.trim() === "let planArchiveRel = null;");
    const ecf = lines.filter((l) => l.trim() === "const execCommitFiles = planArchiveRel ? [...commitFiles, planArchiveRel] : commitFiles;");
    expect(par).toHaveLength(1);
    expect(ecf).toHaveLength(1);
    expect(par[0].match(/^\s*/)[0]).toBe(ecf[0].match(/^\s*/)[0]);
    expect(EXEC_SRC.indexOf(par[0])).toBeLessThan(EXEC_SRC.indexOf(ecf[0]));
    expect(EXEC_SRC).not.toContain("const execCommitFiles = commitFiles.length > 0");
    const reassigns = [...EXEC_SRC.matchAll(/\bplanArchiveRel = (?!null;)/g)].map((m) => EXEC_SRC.slice(m.index, m.index + 40));
    expect(reassigns).toEqual([expect.stringMatching(/^planArchiveRel = writePlanArchive\(/)]);
    expect(EXEC_SRC).toContain("files: execCommitFiles");
    expect(EXEC_SRC).not.toContain("files: commitFiles");
  });

  it("planArchive is declared not_attempted after let commitResult = null; and before if (shouldCommit) {, and committed/commit_failed is set only from staged after the commit", () => {
    const decl = 'let planArchive = { status: "not_attempted", path: null, error: null };';
    const iDecl = EXEC_SRC.indexOf(decl);
    expect(iDecl).toBeGreaterThan(EXEC_SRC.indexOf("let commitResult = null;"));
    expect(iDecl).toBeLessThan(iShould);
    // The non-not_ignored branch assigns from the check's own status and error, and logs once.
    const iElse = EXEC_SRC.indexOf("} else {", iWrite);
    const elseBlock = EXEC_SRC.slice(iElse, EXEC_SRC.indexOf("\n    }\n", iElse));
    expect(elseBlock).toContain("planArchive = { status: ignoreCheck.status, path: archiveRel, error: ignoreCheck.error };");
    expect([...elseBlock.matchAll(/console\.error\(/g)]).toHaveLength(1);
    expect(elseBlock).toMatch(/console\.error\([^;]*archiveRel[^;]*ignoreCheck\.status/);
    const iStagedGuard = EXEC_SRC.indexOf('if (planArchive.status === "staged") {');
    expect(iStagedGuard).toBeGreaterThan(iCommit);
    // Re-pointed (backlog.fix.exec-plan-commit-linkage-review-followups AC7): the staged guard sets
    // committed/commit_failed, then cleans up only on commit_failed, all inside the same guard.
    const iGuardEnd = EXEC_SRC.indexOf("\n    }\n", iStagedGuard);
    const stagedGuard = EXEC_SRC.slice(iStagedGuard, iGuardEnd);
    expect(stagedGuard).toMatch(/^if \(planArchive\.status === "staged"\) \{\n\s*planArchive = \{ \.\.\.planArchive, status: commitResult\?\.ok === true \? "committed" : "commit_failed" \};/);
    expect(stagedGuard).toMatch(/if \(planArchive\.status === "commit_failed"\) \{\s*planArchive = \{ \.\.\.planArchive, \.\.\.cleanupPlanArchive\(projectRoot, planArchive\.path\) \};\s*\}/);
    // Every planArchive assignment that can set staged/ignored/check_failed lies inside the archive branch.
    const iBranch = EXEC_SRC.indexOf("if (commitFiles.length > 0) {", iShould);
    for (const m of EXEC_SRC.matchAll(/\bplanArchive = \{ status: (?!"not_attempted")/g)) {
      if (m.index > iStagedGuard) continue;
      expect(m.index).toBeGreaterThan(iBranch);
      expect(m.index).toBeLessThan(iCommit);
    }
  });

  it("planArchive is reported in the pending_ship return and the exec.complete payload", () => {
    const idxStatus = EXEC_SRC.indexOf("status: 'pending_ship'");
    const shipObj = EXEC_SRC.slice(EXEC_SRC.lastIndexOf("return {", idxStatus), EXEC_SRC.indexOf("};", idxStatus));
    expect(shipObj).toMatch(/\bplanArchive,/);
    const iComplete = EXEC_SRC.indexOf('collector.emit("exec.complete", projectId, {');
    const payload = EXEC_SRC.slice(iComplete, EXEC_SRC.indexOf("}, { correlationId });", iComplete));
    expect(payload).toMatch(/\bplanArchive,/);
    expect(iComplete).toBeGreaterThan(iCommit);
  });

  it("no force add: exec.mjs and exec-provenance.mjs carry no -f or --force literal; git-workflow still stages listed files plainly", () => {
    for (const src of [EXEC_SRC, PROV_SRC]) {
      expect(src).not.toContain('"-f"');
      expect(src).not.toContain("'-f'");
      expect(src).not.toContain("--force");
    }
    // backlog.fix.ship-path-commits-tracked-files-under-ignored-dirs: listed files are split by
    // `git ls-files`; tracked ones are staged with `add -u`, untracked ones with a plain add.
    expect(WORKFLOW_SRC).toContain("splitTrackedPaths(projectRoot, toAdd)");
    expect(WORKFLOW_SRC).toContain('runGit(projectRoot, ["add", "-u", "--", ...trackedPaths]);');
    // backlog.fix.git-commit-split-tracked-paths-misclassifies-dirs-and-dotdot: the plain add also
    // takes the untracked NON-ignored files git reports inside a path that covers tracked content.
    expect(WORKFLOW_SRC).toContain("const plainAdd = [...untrackedPaths, ...untrackedWithinTracked];");
    expect(WORKFLOW_SRC).toContain('runGit(projectRoot, ["add", "--", ...plainAdd]);');
    expect(WORKFLOW_SRC).not.toContain('["add", "-f"');
    expect(WORKFLOW_SRC).not.toContain('"--force"');
  });
});

// ── backlog.fix.exec-plan-commit-linkage-review-followups ───────────────────────────────────────
// Real git in temp repos; every git subprocess passes an explicit timeout (TIMEOUT above).

/** A git hooks dir OUTSIDE the repo whose pre-commit exits 1, so the commit fails after staging. */
function failCommitsIn(root) {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "exec-plan-commit-hooks-"));
  roots.push(hooks);
  fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  git(root, ["config", "core.hooksPath", hooks]);
}
const stagedNames = (root) => git(root, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
const execTrailers = () => buildExecTrailers({ planHash: PLAN_HASH, runId: RUN_ID });

/**
 * The archive step of exec.mjs's commit block, driven against the real helpers: the same guarded
 * write (try writePlanArchive, catch -> planArchiveWriteFailed) and the same execCommitFiles rule.
 * The structural pins below tie exec.mjs to exactly this shape.
 */
function archiveStep(root, commitFiles) {
  let planArchive = { status: "not_attempted", path: null, error: null };
  let planArchiveRel = null;
  const archiveRel = planArchiveRelPath(RUN_ID);
  const ignoreCheck = checkPlanArchiveIgnored(root, archiveRel);
  if (ignoreCheck.status === "not_ignored") {
    try {
      planArchiveRel = writePlanArchive(root, buildPlanArchive({ runId: RUN_ID, plan: PLAN }));
      planArchive = { status: "staged", path: planArchiveRel, error: null };
    } catch (archiveErr) {
      planArchive = planArchiveWriteFailed(root, archiveRel, archiveErr);
    }
  } else {
    planArchive = { status: ignoreCheck.status, path: archiveRel, error: ignoreCheck.error };
  }
  const execCommitFiles = planArchiveRel ? [...commitFiles, planArchiveRel] : commitFiles;
  return { planArchive, planArchiveRel, execCommitFiles };
}

describe("AC2 runtime: exec-state.json records the commit's full SHA and Plan-Hash", { timeout: 30_000 }, () => {
  it("runGitCommit with buildExecTrailers then markExecComplete yields fullCommitId == HEAD and planHash == the Plan-Hash trailer", async () => {
    const root = makeRepo();
    const file = writeApplied(root);
    const res = await runGitCommit({ projectRoot: root, message: STORY, scope: "exec", type: "feat", files: [file], storyId: STORY, trailers: execTrailers() });
    expect(res.ok).toBe(true);
    const runDir = path.join(root, ".rks", "runs", RUN_ID);
    fs.mkdirSync(runDir, { recursive: true });
    markExecComplete(runDir, { testsPassed: true, commitId: res.commitId || null, fullCommitId: res.fullCommitId || null, planHash: PLAN_HASH });
    const state = JSON.parse(fs.readFileSync(path.join(runDir, "exec-state.json"), "utf8"));
    expect(state.currentPhase).toBe("complete");
    expect(state.fullCommitId).toMatch(/^[0-9a-f]{40}$/);
    expect(state.fullCommitId).toBe(headSha(root));
    expect(state.planHash).toBe(/^Plan-Hash: (\S+)$/m.exec(parsedTrailers(root))?.[1]);
  });
});

describe("AC3 plan-archive write failure is reported as write_failed and the commit proceeds", { timeout: 30_000 }, () => {
  let errSpy;
  beforeEach(() => { errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { errSpy.mockRestore(); });

  it("archive path occupied by a directory: write_failed with path and error, one console.error naming the path, no file, not listed", () => {
    const root = makeRepo(".rks/*\n!.rks/plans/\n");
    const rel = planArchiveRelPath(RUN_ID);
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    const file = writeApplied(root);
    const out = archiveStep(root, [file]);
    expect(out.planArchive.status).toBe("write_failed");
    expect(out.planArchive.path).toBe(`.rks/plans/${RUN_ID}.json`);
    expect(typeof out.planArchive.error).toBe("string");
    expect(out.planArchive.error.length).toBeGreaterThan(0);
    expect(["staged", "committed", "not_attempted"]).not.toContain(out.planArchive.status);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain(rel);
    const st = fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false });
    expect(st?.isFile() ?? false).toBe(false);
    expect(out.planArchiveRel).toBeNull();
    expect(out.execCommitFiles).toEqual([file]);
  });

  it("after write_failed the commit proceeds with commitFiles only and carries Story, Plan-Hash and Run-Id", async () => {
    const root = makeRepo(".rks/*\n!.rks/plans/\n");
    fs.mkdirSync(path.join(root, planArchiveRelPath(RUN_ID)), { recursive: true });
    const file = writeApplied(root);
    const out = archiveStep(root, [file]);
    expect(out.planArchive.status).toBe("write_failed");
    const res = await runGitCommit({ projectRoot: root, message: STORY, scope: "exec", type: "feat", files: out.execCommitFiles, storyId: STORY, trailers: execTrailers() });
    expect(res.ok).toBe(true);
    const parsed = parsedTrailers(root);
    expect(parsed).toContain(`Story: ${STORY}`);
    expect(parsed).toContain(`Plan-Hash: ${PLAN_HASH}`);
    expect(parsed).toContain(`Run-Id: ${RUN_ID}`);
    expect(lsTree(root)).toContain(file);
    expect(lsTree(root).filter((p) => p.startsWith(".rks/plans/"))).toEqual([]);
  });

  it("planArchiveWriteFailed removes a partially written archive file", () => {
    const root = makeRepo(".rks/*\n!.rks/plans/\n");
    const rel = planArchiveRelPath(RUN_ID);
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '{"runId": "partial');
    const out = planArchiveWriteFailed(root, rel, new Error("ENOSPC: no space left on device"));
    expect(out).toEqual({ status: "write_failed", path: rel, error: "ENOSPC: no space left on device" });
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain(rel);
  });
});

describe("AC4 archive cleanup after a failed commit", { timeout: 30_000 }, () => {
  let errSpy;
  beforeEach(() => { errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { errSpy.mockRestore(); });

  it("written and staged archive, commit fails: commit_failed, then cleanup removes it from the index and the working tree", async () => {
    const root = makeRepo(".rks/*\n!.rks/plans/\n");
    failCommitsIn(root);
    const file = writeApplied(root);
    const out = archiveStep(root, [file]);
    expect(out.planArchive.status).toBe("staged");
    const before = headSha(root);
    const res = await runGitCommit({ projectRoot: root, message: STORY, scope: "exec", type: "feat", files: out.execCommitFiles, storyId: STORY, trailers: execTrailers() });
    expect(res.ok).toBe(false);
    expect(headSha(root)).toBe(before);
    const rel = out.planArchive.path;
    // The failed commit left the archive staged and on disk: the state the cleanup must undo.
    expect(stagedNames(root)).toContain(rel);
    expect(fs.existsSync(path.join(root, rel))).toBe(true);
    let planArchive = { ...out.planArchive, status: res?.ok === true ? "committed" : "commit_failed" };
    expect(planArchive.status).toBe("commit_failed");
    errSpy.mockClear();
    planArchive = { ...planArchive, ...cleanupPlanArchive(root, planArchive.path) };
    expect(planArchive.cleanup).toBe("removed");
    expect(planArchive).not.toHaveProperty("cleanupError");
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
    expect(stagedNames(root)).not.toContain(rel);
    expect(stagedNames(root)).toContain(file);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("a failing removal call yields cleanup_failed with a non-empty cleanupError and one console.error naming the path", () => {
    const root = makeRepo(".rks/*\n!.rks/plans/\n");
    const rel = planArchiveRelPath(RUN_ID);
    // A non-empty directory at the archive path: the removal calls cannot delete it as a file.
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    fs.writeFileSync(path.join(root, rel, "keep.txt"), "x\n");
    const out = cleanupPlanArchive(root, rel);
    expect(out.cleanup).toBe("cleanup_failed");
    expect(typeof out.cleanupError).toBe("string");
    expect(out.cleanupError.length).toBeGreaterThan(0);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain(rel);
  });

  it("outside a git repo the git removal call fails and cleanup is cleanup_failed, never removed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    roots.push(dir);
    const rel = planArchiveRelPath(RUN_ID);
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), "{}\n");
    const out = cleanupPlanArchive(dir, rel);
    expect(out.cleanup).toBe("cleanup_failed");
    expect(out.cleanupError).toMatch(/git rm --cached/);
    // The unlink is attempted despite the unstage failure.
    expect(fs.existsSync(path.join(dir, rel))).toBe(false);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain(rel);
  });

  // backlog.fix.exec-plan-archive-cleanup-skips-unlink-on-unstage-failure
  it("unstage fails on an index.lock with the archive staged: the file is still deleted, cleanup_failed names git rm --cached", () => {
    const root = makeRepo(".rks/*\n!.rks/plans/\n");
    const rel = planArchiveRelPath(RUN_ID);
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), "{}\n");
    git(root, ["add", "--", rel]);
    expect(stagedNames(root)).toContain(rel);
    fs.writeFileSync(path.join(root, ".git", "index.lock"), "");
    const out = cleanupPlanArchive(root, rel, { timeoutMs: TIMEOUT });
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
    expect(out.cleanup).toBe("cleanup_failed");
    expect(out.cleanup).not.toBe("removed");
    expect(out.cleanupError).toMatch(/git rm --cached/);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain(rel);
  });

  it("both fail (index.lock and a non-empty directory at the archive path): cleanupError names both failures", () => {
    const root = makeRepo(".rks/*\n!.rks/plans/\n");
    const rel = planArchiveRelPath(RUN_ID);
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    fs.writeFileSync(path.join(root, rel, "keep.txt"), "x\n");
    fs.writeFileSync(path.join(root, ".git", "index.lock"), "");
    const out = cleanupPlanArchive(root, rel, { timeoutMs: TIMEOUT });
    expect(out.cleanup).toBe("cleanup_failed");
    expect(out.cleanupError).toMatch(/git rm --cached/);
    expect(out.cleanupError).toMatch(/unlink/);
    const parts = out.cleanupError.split("; ");
    expect(parts.length).toBe(2);
    expect(parts[0]).not.toBe(parts[1]);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain(rel);
  });
});

describe("AC5: no cleanup key outside commit_failed", { timeout: 30_000 }, () => {
  it("committed, ignored, check_failed and not_attempted dispositions carry no cleanup key", async () => {
    const root = makeRepo(".rks/*\n!.rks/plans/\n");
    const file = writeApplied(root);
    const out = archiveStep(root, [file]);
    const res = await runGitCommit({ projectRoot: root, message: STORY, scope: "exec", type: "feat", files: out.execCommitFiles, storyId: STORY, trailers: execTrailers() });
    const committed = { ...out.planArchive, status: res?.ok === true ? "committed" : "commit_failed" };
    expect(committed.status).toBe("committed");
    expect(committed).not.toHaveProperty("cleanup");
    expect(archiveStep(makeRepo(".rks/\n"), [file]).planArchive).toEqual({ status: "ignored", path: planArchiveRelPath(RUN_ID), error: null });
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    roots.push(nonRepo);
    const failed = archiveStep(nonRepo, [file]).planArchive;
    expect(failed.status).toBe("check_failed");
    expect(failed).not.toHaveProperty("cleanup");
    // Source: the only cleanup call sits under the commit_failed branch of the staged guard, and
    // not_attempted is declared without one.
    expect(EXEC_SRC.split("cleanupPlanArchive(").length - 1).toBe(1);
    expect(EXEC_SRC).toContain('let planArchive = { status: "not_attempted", path: null, error: null };');
    expect(EXEC_SRC).not.toMatch(/planArchive = \{ status: [^}]*cleanup/);
  });
});

describe("AC3/AC6 exec.mjs structural pins (guarded write, single exec.complete)", () => {
  const iShould = EXEC_SRC.indexOf("if (shouldCommit) {");
  const iBranch = EXEC_SRC.indexOf("if (commitFiles.length > 0) {", iShould);
  const iWrite = EXEC_SRC.indexOf("writePlanArchive(", iShould);
  const iCommit = EXEC_SRC.indexOf("runGitCommit(", iShould);

  it("the single writePlanArchive call is inside a try whose catch reports write_failed via planArchiveWriteFailed, in the archive branch before runGitCommit", () => {
    const iTry = EXEC_SRC.lastIndexOf("try {", iWrite);
    expect(iTry).toBeGreaterThan(iBranch);
    expect(EXEC_SRC.slice(iTry, iWrite)).toMatch(/^try \{\s*planArchiveRel = $/);
    const iCatch = EXEC_SRC.indexOf("} catch (archiveErr) {", iWrite);
    expect(iCatch).toBeGreaterThan(iWrite);
    expect(iCatch).toBeLessThan(iCommit);
    const catchBody = EXEC_SRC.slice(iCatch, EXEC_SRC.indexOf("\n        }\n", iCatch));
    expect(catchBody).toContain("planArchive = planArchiveWriteFailed(projectRoot, archiveRel, archiveErr);");
    expect(catchBody).not.toMatch(/planArchiveRel\s*=/);
    expect(catchBody).not.toMatch(/"(staged|committed|not_attempted)"/);
  });

  it("exec.mjs has exactly one exec.complete emit, a literal payload carrying planArchive", () => {
    const emits = [...EXEC_SRC.matchAll(/collector\.emit\("exec\.complete",\s*projectId,\s*\{/g)];
    expect(emits).toHaveLength(1);
    expect([...EXEC_SRC.matchAll(/collector\.emit\("exec\.complete"/g)]).toHaveLength(1);
    const payload = EXEC_SRC.slice(emits[0].index, EXEC_SRC.indexOf("}, { correlationId });", emits[0].index));
    expect(payload).toMatch(/\bplanArchive,/);
    expect(emits[0].index).toBeGreaterThan(iCommit);
  });

  it("the dead exec.complete payload builder is gone from packages/mcp-rks/src and tests (AC6)", () => {
    const name = "buildExecComplete" + "Payload";
    const hits = [];
    for (const base of ["packages/mcp-rks/src", "tests"]) {
      for (const rel of fs.readdirSync(path.join(REPO_ROOT, base), { recursive: true })) {
        if (!/\.(mjs|cjs|js|ts)$/.test(rel) || rel.includes("node_modules")) continue;
        const abs = path.join(REPO_ROOT, base, rel);
        if (fs.statSync(abs).isFile() && fs.readFileSync(abs, "utf8").includes(name)) hits.push(path.join(base, rel));
      }
    }
    expect(hits).toEqual([]);
    expect(PROV_SRC).not.toContain(name);
  });
});

describe("AC13 runGitCommit refuses trailers with CR/LF or an invalid key", { timeout: 30_000 }, () => {
  const bad = [
    ["value contains LF", { key: "Run-Id", value: "r1\nStory: forged" }, "Run-Id"],
    ["value contains CR", { key: "Plan-Hash", value: "abc\rdef" }, "Plan-Hash"],
    ["key contains LF", { key: "Run\nId", value: "r1" }, "Run\nId"],
    ["key contains a space", { key: "Run Id", value: "r1" }, "Run Id"],
    ["key contains a colon", { key: "Run:Id", value: "r1" }, "Run:Id"],
  ];
  for (const [label, trailer, key] of bad) {
    it(`${label}: ok false, error names the key, HEAD unchanged`, async () => {
      const root = makeRepo();
      const file = writeApplied(root);
      const before = headSha(root);
      const res = await runGitCommit({ projectRoot: root, message: STORY, scope: "exec", type: "feat", files: [file], storyId: STORY, trailers: [trailer] });
      expect(res.ok).toBe(false);
      expect(res.error).toContain(JSON.stringify(key));
      expect(headSha(root)).toBe(before);
    });
  }

  it("empty or non-string key/value entries are still silently dropped", async () => {
    const root = makeRepo();
    const file = writeApplied(root);
    const res = await runGitCommit({
      projectRoot: root, message: STORY, scope: "exec", type: "feat", files: [file], storyId: STORY,
      trailers: [null, { key: "", value: "x" }, { key: "X-Empty", value: "" }, { key: 5, value: "y" }, { key: "X-Num", value: 7 }, ...execTrailers()],
    });
    expect(res.ok).toBe(true);
    expect(lastParagraph(headBody(root))).toEqual([`Story: ${STORY}`, `Plan-Hash: ${PLAN_HASH}`, `Run-Id: ${RUN_ID}`]);
  });
});
