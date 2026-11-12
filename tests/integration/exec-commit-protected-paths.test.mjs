/**
 * backlog.fix.exec-commit-set-protected-paths: exec never commits a governance path.
 * Drives runApplyTool, applyFixPlan and runExecTool on temp git fixtures.
 *
 * Pattern: tests/integration/exec-run-command-produces.test.mjs (loadContext in server/project.mjs is
 * mocked so the live projects/index.jsonl is never read or written; embedScopedFiles in @routekit/rag is
 * stubbed) and tests/integration/exec-command-policy-integrity.test.mjs (a node script that spawns git
 * inside a run_command; guardrailsOff/guardrailsOn stubbed so no hook directory is moved). exec.mjs,
 * fix-planner.mjs, test-runner.mjs and command-runner.mjs are the real modules. Every git spawn, in this
 * file and inside the fixture scripts, carries an explicit timeout.
 *
 * testRequirement -> test mapping (TRn = the story's nth testRequirement):
 *   TR10 "refuses produces <entry> before any step applies" (.routekit/command-policy.yaml, .rks/x, .claude/settings.json, .git/config)
 *   TR11 "refuses produces ./.rks/x ..." and "refuses produces .RKS/x ..."
 *   TR12 "refuses create_file .claude/settings.json before anything applies; earlier create_file leaves nothing"
 *   TR13 "refuses edit_file .rks/prompts/x.md before anything applies; the file is byte-identical"
 *   TR14 "does not refuse create_file under notes/"
 *   TR15 "create_file .rks/x returns ok false, appliedFiles [], file absent"
 *   TR16 "a run_command commit of .rks/x yields protected_path_in_commit and no exec commit"
 *   TR17 "a staged-only .routekit/hooks/x.mjs yields protected_path_in_commit"
 *   TR18 "protectedPaths comes only from git output"
 *   TR19 "positive control: plan archive and story note still commit and exec reaches pending_ship"
 *   TR20 "source order: the check follows the pre-commit policy check and precedes writePlanArchive("
 *   TR21 "non-git root: the check is skipped"
 *   TR23 [process] every spawnSync below passes timeout: GIT_TIMEOUT (also inside the fixture scripts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { makeTempDir } from "../helpers/tmp.mjs";

const h = vi.hoisted(() => ({ root: null }));
vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  loadContext: vi.fn(async (projectId) => ({ record: { id: projectId, root: h.root }, projectJson: { baseBranch: "staging" } })),
}));
// Collaborator stub: exec's post-commit auto-embed would load an embedding model; it is not under test.
vi.mock("@routekit/rag", async (importOriginal) => ({
  ...(await importOriginal()),
  embedScopedFiles: vi.fn(async () => ({ ok: true, filesEmbedded: 0 })),
}));
vi.mock("../../packages/mcp-rks/src/server/guardrails-audit.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  guardrailsOff: vi.fn(async () => ({ ok: true })),
  guardrailsOn: vi.fn(async () => ({ ok: true })),
}));

const { runApplyTool, runExecTool } = await import("../../packages/mcp-rks/src/server/exec.mjs");
const { applyFixPlan } = await import("../../packages/mcp-rks/src/server/fix-planner.mjs");

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");

const GIT_TIMEOUT = 15_000;
const git = (root, args) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

const POLICY_REL = ".routekit/command-policy.yaml";
const SCRIPT_NAMES = ["write-sentinel.mjs", "commit-rks.mjs", "stage-hook.mjs", "commit-mixed.mjs", "regen.mjs", "write-rks.mjs"];
const POLICY = [
  "command_policy:",
  `  auto_execute: [${SCRIPT_NAMES.map((n) => JSON.stringify(`node ${n}`)).join(", ")}]`,
  '  execute_with_plan_approval: ["git add", "git commit"]',
  '  require_explicit_confirmation: ["rm"]',
  "",
].join("\n");

const spawnLine = (args) => `spawnSync("git", ${JSON.stringify(args)}, { timeout: ${GIT_TIMEOUT}, stdio: "ignore" });`;
const HEAD = ['import fs from "node:fs";', 'import { spawnSync } from "node:child_process";'];
const SCRIPTS = {
  "write-sentinel.mjs": 'import fs from "node:fs";\nfs.writeFileSync("sentinel.txt", "ran\\n");\n',
  "commit-rks.mjs": [
    ...HEAD,
    'fs.mkdirSync(".rks", { recursive: true });',
    'fs.writeFileSync(".rks/x", "smuggled\\n");',
    spawnLine(["add", "-f", ".rks/x"]),
    spawnLine(["commit", "-q", "-m", "smuggle", "--", ".rks/x"]),
    "",
  ].join("\n"),
  "stage-hook.mjs": [
    ...HEAD,
    'fs.mkdirSync(".routekit/hooks", { recursive: true });',
    'fs.writeFileSync(".routekit/hooks/x.mjs", "export default 1;\\n");',
    spawnLine(["add", ".routekit/hooks/x.mjs"]),
    "",
  ].join("\n"),
  "commit-mixed.mjs": [
    ...HEAD,
    'fs.mkdirSync(".rks", { recursive: true });',
    'fs.mkdirSync("src", { recursive: true });',
    'fs.mkdirSync("dist", { recursive: true });',
    'fs.writeFileSync(".rks/x", "smuggled\\n");',
    'fs.writeFileSync("src/ok.js", "export const ok = 1;\\n");',
    spawnLine(["add", "-f", ".rks/x", "src/ok.js"]),
    spawnLine(["commit", "-q", "-m", "mixed", "--", ".rks/x", "src/ok.js"]),
    'fs.writeFileSync("dist/app.js", "// regenerated " + Date.now() + "\\n");',
    "",
  ].join("\n"),
  "regen.mjs": 'import fs from "node:fs";\nfs.mkdirSync("dist", { recursive: true });\nfs.writeFileSync("dist/app.js", "// regenerated " + Date.now() + "\\n");\n',
  "write-rks.mjs": 'import fs from "node:fs";\nfs.mkdirSync(".rks", { recursive: true });\nfs.writeFileSync(".rks/x", "written\\n");\n',
};

const STORY = "backlog.fix.gov-paths-fixture";
const cleanup = [];

/** A temp project with the policy, the scripts and dist/app.js; a git repo on staging unless git:false. */
function makeRepo(tag, { withGit = true, gitignore = ".rks/*\n!.rks/plans/\n", note = false } = {}) {
  const root = makeTempDir(`gov-commit-${tag}`);
  cleanup.push(root);
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, POLICY_REL), POLICY);
  for (const [name, text] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(root, name), text);
  fs.writeFileSync(path.join(root, "dist", "app.js"), "// baseline\n");
  fs.writeFileSync(path.join(root, ".gitignore"), gitignore);
  if (note) {
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes", `${STORY}.md`), `---\nid: "${STORY}"\ntitle: "fixture"\nphase: "executing"\n---\n\nbody\n`);
  }
  if (withGit) {
    git(root, ["init", "-q", "-b", "staging"]);
    git(root, ["config", "user.email", "t@t"]);
    git(root, ["config", "user.name", "t"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["config", "core.hooksPath", ".git/hooks"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "baseline"]);
  }
  h.root = root;
  return root;
}

function writePlan(root, label, steps, extra = {}) {
  const runDir = path.join(root, ".rks", "runs", `2026-11-05T00-00-00-000Z_${label}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ slug: label, status: "executable", steps, ...extra }, null, 2));
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ projectId: "gov-commit", timestamps: {}, telemetry: { outcome: "planned" } }));
  return label;
}

const runCmd = (command, extra = {}) => ({ action: "run_command", command, title: `run ${command}`, ...extra });
const EARLY = { action: "create_file", path: "early.txt", content: "early\n", title: "early" };
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const execCommitSubjects = (root) => git(root, ["log", "--all", "--format=%s"]).split("\n").filter((s) => s.includes("feat(exec)"));
const rksBranches = (root) => git(root, ["branch", "--list", "rks/*"]).trim();

async function refusal(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
}

let errSpy;
beforeEach(() => {
  h.root = null;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy?.mockRestore();
  for (const p of cleanup.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("produces pre-flight refusal", () => {
  for (const entry of [".routekit/command-policy.yaml", ".rks/x", ".claude/settings.json", ".git/config", "./.rks/x", ".RKS/x"]) {
    it(`refuses produces ${entry} before any step applies`, async () => {
      const root = makeRepo("produces");
      const label = writePlan(root, "produces", [EARLY, runCmd("node write-sentinel.mjs", { produces: [entry] })]);
      const err = await refusal(runApplyTool({ projectId: "gov-commit", label, force: true }));
      expect(err, "runApplyTool must refuse").not.toBeNull();
      expect(err.code).toBe(ErrorCode.InvalidRequest);
      expect(err.message).toContain("step 1");
      expect(err.message).toContain(entry);
      expect(err.message).toMatch(/off-rail/i);
      expect(exists(root, "sentinel.txt")).toBe(false);
      expect(exists(root, "early.txt")).toBe(false);
    }, 60_000);
  }
});

describe("file-step pre-flight refusal (runApplyTool)", () => {
  it("refuses create_file .claude/settings.json before anything applies; earlier create_file leaves nothing", async () => {
    const root = makeRepo("claude");
    const label = writePlan(root, "claude", [EARLY, { action: "create_file", path: ".claude/settings.json", content: "{}\n", title: "settings" }]);
    const err = await refusal(runApplyTool({ projectId: "gov-commit", label, force: true }));
    expect(err, "runApplyTool must refuse").not.toBeNull();
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain("step 1");
    expect(err.message).toContain("create_file");
    expect(err.message).toContain(".claude/settings.json");
    expect(exists(root, "early.txt")).toBe(false);
    expect(exists(root, ".claude/settings.json")).toBe(false);
  }, 60_000);

  it("refuses edit_file .rks/prompts/x.md before anything applies; the file is byte-identical", async () => {
    const root = makeRepo("prompts");
    fs.mkdirSync(path.join(root, ".rks", "prompts"), { recursive: true });
    const original = "# original prompt\nkeep me\n";
    fs.writeFileSync(path.join(root, ".rks", "prompts", "x.md"), original);
    const label = writePlan(root, "prompts", [EARLY, { action: "edit_file", path: ".rks/prompts/x.md", content: "# hijacked\n", title: "prompt" }]);
    const err = await refusal(runApplyTool({ projectId: "gov-commit", label, force: true }));
    expect(err, "runApplyTool must refuse").not.toBeNull();
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain("step 1");
    expect(err.message).toContain("edit_file");
    expect(err.message).toContain(".rks/prompts/x.md");
    expect(exists(root, "early.txt")).toBe(false);
    expect(fs.readFileSync(path.join(root, ".rks", "prompts", "x.md"), "utf8")).toBe(original);
  }, 60_000);

  it("does not refuse create_file under notes/", async () => {
    const root = makeRepo("notes");
    const label = writePlan(root, "notes", [{ action: "create_file", path: "notes/backlog.x.md", content: "---\nid: backlog.x\n---\n", title: "note" }]);
    const res = await runApplyTool({ projectId: "gov-commit", label, force: true });
    expect(res.ok).toBe(true);
    expect(exists(root, "notes/backlog.x.md")).toBe(true);
  }, 60_000);
});

describe("fix-plan pre-flight refusal (applyFixPlan)", () => {
  it("create_file .rks/x returns ok false, appliedFiles [], file absent", async () => {
    const root = makeRepo("fixplan");
    const runDir = path.join(root, ".rks", "runs", "fix-run");
    fs.mkdirSync(runDir, { recursive: true });
    const plan = {
      steps: [
        { action: "create_file", path: "early.txt", content: "early\n" },
        { action: "create_file", path: ".rks/x", content: "smuggled\n" },
      ],
    };
    const res = await applyFixPlan({ projectId: "gov-commit", projectRoot: root, plan, runDir, attemptNumber: 1 });
    expect(res.ok).toBe(false);
    expect(res.appliedFiles).toEqual([]);
    expect(res.error).toContain("step 1");
    expect(res.error).toContain("create_file");
    expect(res.error).toContain(".rks/x");
    expect(exists(root, "early.txt")).toBe(false);
    expect(exists(root, ".rks/x")).toBe(false);
  }, 60_000);
});

describe("commit-boundary check", () => {
  it("a run_command commit of .rks/x yields protected_path_in_commit and no exec commit", async () => {
    const root = makeRepo("commit-rks");
    const label = writePlan(root, "commit-rks", [
      { action: "create_file", path: "plan-created.txt", content: "created\n", title: "create" },
      runCmd("node commit-rks.mjs"),
    ]);
    const result = await runExecTool({ projectId: "gov-commit", label, skipTests: true });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.status).toBe("protected_path_in_commit");
    expect(result.protectedPaths).toContain(".rks/x");
    expect(result.status).not.toBe("pending_ship");
    expect(String(result.requiredNext ?? "")).not.toContain("rks_story_ship");
    expect(execCommitSubjects(root)).toEqual([]);
    // backlog.fix.cleanup-feature-branch-unmerged-guard: the run_command commit is not on
    // base, so rollback refuses to delete the rks/ branch and reports it as retained.
    expect(result.rollback.branchCleaned).toBe(false);
    expect(result.rollback.branchRetained.reason).toBe("unmerged_commits");
    expect(result.rollback.branchRetained.unmergedCount).toBe(1);
    const retained = result.rollback.branchRetained.branchName;
    expect(rksBranches(root)).not.toBe("");
    expect(rksBranches(root)).toContain(retained);
    expect(git(root, ["log", "-1", "--format=%s", retained]).trim()).toBe("smuggle");
  }, 120_000);

  it("a staged-only .routekit/hooks/x.mjs yields protected_path_in_commit", async () => {
    const root = makeRepo("stage-hook");
    const label = writePlan(root, "stage-hook", [
      { action: "create_file", path: "plan-created.txt", content: "created\n", title: "create" },
      runCmd("node stage-hook.mjs"),
    ]);
    const result = await runExecTool({ projectId: "gov-commit", label, skipTests: true });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.status).toBe("protected_path_in_commit");
    expect(result.protectedPaths).toContain(".routekit/hooks/x.mjs");
    expect(execCommitSubjects(root)).toEqual([]);
  }, 120_000);

  it("protectedPaths comes only from git output", async () => {
    const root = makeRepo("mixed");
    const label = writePlan(root, "mixed", [runCmd("node commit-mixed.mjs", { produces: ["dist/app.js"] })]);
    const result = await runExecTool({ projectId: "gov-commit", label, skipTests: true });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.status).toBe("protected_path_in_commit");
    expect(result.protectedPaths).toEqual([".rks/x"]);
    expect(result.protectedPaths).not.toContain("src/ok.js");
    expect(result.protectedPaths).not.toContain("dist/app.js");
    expect(execCommitSubjects(root)).toEqual([]);
  }, 120_000);

  it("positive control: plan archive and story note still commit and exec reaches pending_ship", async () => {
    const root = makeRepo("positive", { note: true });
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe(".rks/*\n!.rks/plans/\n");
    const label = writePlan(root, "positive", [runCmd("node regen.mjs", { produces: ["dist/app.js"] })], { problemId: STORY });
    const result = await runExecTool({ projectId: "gov-commit", label, skipTests: true });
    expect(result.status, JSON.stringify(result)).toBe("pending_ship");
    expect(result.status).not.toBe("protected_path_in_commit");
    expect(result.planArchive.status).toBe("committed");
    const archiveRel = result.planArchive.path;
    expect(archiveRel).toMatch(/^\.rks\/plans\/.+\.json$/);
    const execCommit = git(root, ["log", "--all", "--format=%H %s"]).split("\n").find((l) => l.includes("feat(exec)"));
    expect(execCommit, "an exec commit must exist").toBeDefined();
    const sha = execCommit.split(" ")[0];
    const tree = git(root, ["ls-tree", "-r", "--name-only", sha]).split("\n").filter(Boolean);
    expect(tree).toContain("dist/app.js");
    expect(tree).toContain(archiveRel);
    expect(tree).toContain(`notes/${STORY}.md`);
  }, 120_000);

  it("source order: the check follows the pre-commit policy check and precedes writePlanArchive(", () => {
    const PRE = "const preCommitPolicyCheck = checkCommandPolicyIntegrity(";
    const RET = 'status: "protected_path_in_commit"';
    const ARCHIVE = "writePlanArchive(";
    for (const needle of [PRE, RET, ARCHIVE]) {
      expect(EXEC_SRC.split(needle).length - 1, needle).toBe(1);
    }
    const iPre = EXEC_SRC.indexOf(PRE);
    const iRet = EXEC_SRC.indexOf(RET);
    const iArchive = EXEC_SRC.indexOf(ARCHIVE);
    expect(iPre).toBeGreaterThan(-1);
    expect(iRet).toBeGreaterThan(iPre);
    expect(iArchive).toBeGreaterThan(iRet);
  });

  it("non-git root: the check is skipped", async () => {
    const root = makeRepo("nogit", { withGit: false });
    expect(exists(root, ".git")).toBe(false);
    const label = writePlan(root, "nogit", [
      { action: "create_file", path: "plan-created.txt", content: "created\n", title: "create" },
      runCmd("node write-rks.mjs"),
    ]);
    // The check is gated on a git root (and on a recorded exec base commit, which only a git root has).
    const GATE = "if (gitRepo && ctx.execBaseCommit) {";
    expect(EXEC_SRC.split(GATE).length - 1).toBe(1);
    const gateLine = EXEC_SRC.slice(0, EXEC_SRC.indexOf(GATE)).split("\n").length;
    const boundaryEndLine = EXEC_SRC.slice(0, EXEC_SRC.indexOf('status: "protected_path_in_commit"')).split("\n").length + 40;
    let result = null;
    let thrown = null;
    try {
      result = await runExecTool({ projectId: "gov-commit", label, skipTests: true });
    } catch (err) {
      thrown = err;
    }
    expect(result?.status).not.toBe("protected_path_in_commit");
    if (thrown) {
      // exec may refuse a non-git root earlier for its own reasons; it must never be the boundary check
      // that throws. The innermost exec.mjs frame of runExecToolInner lies outside the boundary block.
      expect(String(thrown.message)).not.toMatch(/commit-boundary|protected_path_in_commit/);
      const frame = /runExecToolInner \(.*exec\.mjs:(\d+):\d+\)/.exec(String(thrown.stack));
      expect(frame, String(thrown.stack)).not.toBeNull();
      const line = Number(frame[1]);
      expect(line < gateLine || line > boundaryEndLine, `thrown from exec.mjs:${line}`).toBe(true);
    } else {
      expect(result).not.toBeNull();
    }
  }, 120_000);
});
