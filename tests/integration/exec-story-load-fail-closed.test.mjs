// AC14 (Decision 10): a story-linked exec whose note is missing or unreadable is refused
// before anything is applied. Real git in a temp project; every spawn carries a timeout.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { TEMP_BASE } from "../helpers/tmp.mjs";
import { runExecTool } from "../../packages/mcp-rks/src/server/exec.mjs";

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, stdio: "pipe", timeout: 30000 }).toString();
}

const TARGET_REL = "src/example.js";
const TARGET_CONTENT = 'export const value = "before";\n';

let registryDir;
let registryPath;
let originalRegistryEnv;
let errSpy;
const cleanup = [];

/** A registered temp git project on its base branch (staging) with a clean tree. */
function setupProject(tag) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectId = `exec-story-load-${tag}-${stamp}`;
  const projectRoot = path.join(TEMP_BASE, `exec-story-load-${stamp}`);
  cleanup.push(projectRoot);
  fs.mkdirSync(path.join(projectRoot, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "routekit", "project.json"), JSON.stringify({ id: projectId, baseBranch: "staging", kgFile: "routekit/kg.yaml" }, null, 2));
  fs.writeFileSync(path.join(projectRoot, "routekit", "kg.yaml"), "code_roots: [src]\n");
  fs.writeFileSync(path.join(projectRoot, TARGET_REL), TARGET_CONTENT);
  // Runtime state (the run folder, exec state, telemetry) stays out of the dirty-tree check.
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

/** A hand-written plan in .rks/runs/<ts>_<slug>/plan.json (runPlanTool cannot plan a story with no note). */
function writePlan(projectRoot, slug, plan) {
  const runDir = path.join(projectRoot, ".rks", "runs", `2026-11-01T00-00-00-000Z_${slug}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({
    slug,
    status: "executable",
    steps: [{ action: "search_replace", path: TARGET_REL, title: "flip", edits: [{ search: 'export const value = "before";', replace: 'export const value = "after";' }] }],
    ...plan,
  }, null, 2));
}

const rksBranches = (projectRoot) => git(projectRoot, "branch --list rks/*").trim();
const errLines = () => errSpy.mock.calls.map((c) => c.map(String).join(" "));

beforeEach(() => {
  originalRegistryEnv = process.env.RKS_REGISTRY_PATH;
  registryDir = fs.mkdtempSync(path.join(TEMP_BASE, "exec-story-load-registry-"));
  registryPath = path.join(registryDir, "index.jsonl");
  process.env.RKS_REGISTRY_PATH = registryPath;
  errSpy = vi.spyOn(console, "error");
});

afterEach(() => {
  errSpy?.mockRestore();
  if (originalRegistryEnv === undefined) delete process.env.RKS_REGISTRY_PATH;
  else process.env.RKS_REGISTRY_PATH = originalRegistryEnv;
  fs.rmSync(registryDir, { recursive: true, force: true });
  for (const p of cleanup.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("exec story load fails closed (AC14)", () => {
  it("plan.problemId with no note -> test_requirements_unverifiable / story_missing; no rks/ branch, target unchanged, no baseline log", async () => {
    const { projectId, projectRoot } = setupProject("missing");
    const problemId = "backlog.fix.no-such-note";
    writePlan(projectRoot, "no-such-note", { problemId });
    const before = fs.readFileSync(path.join(projectRoot, TARGET_REL));

    const result = await runExecTool({ projectId, label: "no-such-note", skipTests: false });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("test_requirements_unverifiable");
    expect(result.reason).toBe("story_missing");
    expect(result.problemId).toBe(problemId);
    expect(rksBranches(projectRoot)).toBe("");
    expect(git(projectRoot, "rev-parse --abbrev-ref HEAD").trim()).toBe("staging");
    expect(fs.readFileSync(path.join(projectRoot, TARGET_REL)).equals(before)).toBe(true);
    expect(errLines().some((l) => l.includes("[rks.exec] Running baseline tests"))).toBe(false);
    expect(errLines().some((l) => l.includes("story_missing"))).toBe(true);
  }, 60000);

  it("note exists but loadStory throws -> story_unreadable with non-empty detail; no rks/ branch, target unchanged", async () => {
    const { projectId, projectRoot } = setupProject("unreadable");
    const problemId = "backlog.fix.broken-note";
    // Frontmatter that the real loadStory (gray-matter / js-yaml) cannot parse.
    fs.writeFileSync(path.join(projectRoot, "notes", `${problemId}.md`), `---\nid: "${problemId}\nphase: [unclosed\ntestRequirements:\n  - : :\n---\n\nbody\n`);
    writePlan(projectRoot, "broken-note", { problemId });
    const before = fs.readFileSync(path.join(projectRoot, TARGET_REL));

    const result = await runExecTool({ projectId, label: "broken-note", skipTests: false });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("test_requirements_unverifiable");
    expect(result.reason).toBe("story_unreadable");
    expect(result.problemId).toBe(problemId);
    expect(typeof result.detail).toBe("string");
    expect(result.detail.length).toBeGreaterThan(0);
    expect(rksBranches(projectRoot)).toBe("");
    expect(fs.readFileSync(path.join(projectRoot, TARGET_REL)).equals(before)).toBe(true);
    expect(errLines().some((l) => l.includes("[rks.exec] Running baseline tests"))).toBe(false);
    expect(errLines().some((l) => l.includes("story_unreadable"))).toBe(true);
  }, 60000);

  it("plan with no problemId (skipTests: true) is not refused at story load; skip-tests log emitted", async () => {
    const { projectId, projectRoot } = setupProject("noproblem");
    // A stale quality-review hash stops exec at its integrity gate, right after the skip-tests
    // branch and before any branch is created, so this case applies nothing.
    writePlan(projectRoot, "no-problem-plan", { qualityReview: { hash: "0".repeat(64) } });

    const result = await runExecTool({ projectId, label: "no-problem-plan", skipTests: true });

    expect(result.reason).not.toBe("story_missing");
    expect(result.reason).not.toBe("story_unreadable");
    expect(result.status).not.toBe("test_requirements_unverifiable");
    expect(result.status).toBe("integrity_failed");
    expect(errLines().some((l) => l.includes("[rks.exec] Skipping baseline tests (--skip-tests)"))).toBe(true);
    expect(rksBranches(projectRoot)).toBe("");
  }, 60000);
});
