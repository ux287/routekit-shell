/**
 * P0-2 RESET leg: runExecAbortTool, when there is NO recoverable exec run, recovers a story
 * stranded at phase 'executing' by resetting exactly one to 'arch-approved' (0 → no-op,
 * >1 → refuse + list candidates). Unit-tier: calls runExecAbortTool DIRECTLY against a
 * temp project — NO runPlanTool/runExecTool/RAG (those would hang the unit shard).
 *
 * Story: backlog.fix.exec-interrupted-recovery
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runExecAbortTool } from "../../packages/mcp-rks/src/server/exec.mjs";
import { TEMP_BASE } from "../helpers/tmp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
// backlog.fix.test-suite-mutates-live-project-registry — a private temp registry via
// RKS_REGISTRY_PATH (assigned in beforeEach); the live <repoRoot>/projects/index.jsonl is never
// read or written.
let registryPath;

function planNote(projectRoot, storyId, phase) {
  fs.writeFileSync(
    path.join(projectRoot, "notes", `${storyId}.md`),
    `---\nid: "${storyId}"\ntitle: "fixture"\nphase: "${phase}"\n---\n\n## body\n`,
  );
}

function readPhase(projectRoot, storyId) {
  const m = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8")
    .match(/^phase:\s*["']?([a-z-]+)["']?\s*$/m);
  return m ? m[1] : null;
}

function setupChild() {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectId = `unit-abort-${stamp}`;
  const projectRoot = path.join(repoRoot, `.tmp-abort-${stamp}`);
  fs.mkdirSync(path.join(projectRoot, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "routekit", "project.json"),
    JSON.stringify({ id: projectId, baseBranch: "staging", kgFile: "routekit/kg.yaml" }, null, 2),
  );
  fs.writeFileSync(path.join(projectRoot, "routekit", "kg.yaml"), "code_roots: [src]\n");
  const record = { id: projectId, root: projectRoot };
  const existing = fs.existsSync(registryPath)
    ? fs.readFileSync(registryPath, "utf8").trim().split("\n").filter(Boolean)
    : [];
  fs.writeFileSync(registryPath, [...existing, JSON.stringify(record)].join("\n") + "\n");
  return { projectId, projectRoot };
}

describe("runExecAbortTool — stranded-executing reset (P0-2 RESET leg)", () => {
  let originalRegistryEnv;
  let registryDir;
  const cleanupPaths = [];

  beforeEach(() => {
    originalRegistryEnv = process.env.RKS_REGISTRY_PATH;
    registryDir = fs.mkdtempSync(path.join(TEMP_BASE, "exec-stranded-registry-"));
    registryPath = path.join(registryDir, "index.jsonl");
    process.env.RKS_REGISTRY_PATH = registryPath;
  });

  afterEach(() => {
    if (originalRegistryEnv === undefined) delete process.env.RKS_REGISTRY_PATH;
    else process.env.RKS_REGISTRY_PATH = originalRegistryEnv;
    if (registryDir) fs.rmSync(registryDir, { recursive: true, force: true });
    for (const p of cleanupPaths.splice(0)) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("ZERO stranded + no record → unchanged 'No incomplete exec run found' no-op", async () => {
    const { projectId, projectRoot } = setupChild();
    cleanupPaths.push(projectRoot);
    planNote(projectRoot, "backlog.feat.alpha", "ready");
    const r = await runExecAbortTool({ projectId, reason: "test" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("No incomplete exec run found");
    expect(readPhase(projectRoot, "backlog.feat.alpha")).toBe("ready");
  });

  it("ONE stranded + no record → resets that story to arch-approved", async () => {
    const { projectId, projectRoot } = setupChild();
    cleanupPaths.push(projectRoot);
    planNote(projectRoot, "backlog.feat.stuck", "executing");
    planNote(projectRoot, "backlog.feat.other", "ready");
    const r = await runExecAbortTool({ projectId, reason: "test" });
    expect(r.ok).toBe(true);
    expect(r.resetStory).toBe("backlog.feat.stuck");
    expect(r.phase).toBe("arch-approved");
    expect(r.requiredNext).toContain("rks_plan");
    expect(readPhase(projectRoot, "backlog.feat.stuck")).toBe("arch-approved");
    expect(readPhase(projectRoot, "backlog.feat.other")).toBe("ready");
  });

  it(">1 stranded + no record → refuses, lists candidates, resets none", async () => {
    const { projectId, projectRoot } = setupChild();
    cleanupPaths.push(projectRoot);
    planNote(projectRoot, "backlog.feat.one", "executing");
    planNote(projectRoot, "backlog.feat.two", "executing");
    const r = await runExecAbortTool({ projectId, reason: "test" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Multiple stories stranded/);
    expect(r.candidates).toEqual(expect.arrayContaining(["backlog.feat.one", "backlog.feat.two"]));
    expect(readPhase(projectRoot, "backlog.feat.one")).toBe("executing");
    expect(readPhase(projectRoot, "backlog.feat.two")).toBe("executing");
  });
  // backlog.fix.exec-abort-cleanup-observed (AC9): the record-present case moved to
  // tests/integration/exec-abort-cleanup-observed.test.mjs, on an isolated `git init` fixture.
  // Its in-repo .tmp-abort fixture would have driven the run-record leg's git cleanup against
  // the host repo.
});
