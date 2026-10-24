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
} from "../../packages/mcp-rks/src/server/exec-provenance.mjs";

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
    expect(EXEC_SRC.slice(iStagedGuard, iStagedGuard + 200)).toMatch(/commitResult\?\.ok === true \? "committed" : "commit_failed"/);
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
    expect(WORKFLOW_SRC).toContain('runGit(projectRoot, ["add", ...toAdd]);');
  });
});
