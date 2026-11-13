import fs from "fs";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runApplyTool } from "../packages/mcp-rks/src/server.mjs";
import { TEMP_BASE } from "./helpers/tmp.mjs";

const repoRoot = path.resolve(path.join(__dirname, ".."));

describe("runApplyTool", () => {
  // backlog.fix.test-suite-mutates-live-project-registry — a private temp registry via
  // RKS_REGISTRY_PATH; the live <repoRoot>/projects/index.jsonl is never read or written.
  let originalRegistryEnv;
  let registryDir;
  let registryPath;
  // Use a unique project ID per test run to avoid stale registry entries from previous runs
  const projectId = `apply-test-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  let projectRoot;
  let runDir;

  beforeEach(() => {
    originalRegistryEnv = process.env.RKS_REGISTRY_PATH;
    registryDir = fs.mkdtempSync(path.join(TEMP_BASE, "apply-registry-"));
    registryPath = path.join(registryDir, "index.jsonl");
    process.env.RKS_REGISTRY_PATH = registryPath;

    projectRoot = path.join(repoRoot, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "routekit"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "routekit", "project.json"),
      JSON.stringify({ id: projectId, baseBranch: "dev", kgFile: "routekit/kg.yaml" }, null, 2)
    );
    fs.writeFileSync(path.join(projectRoot, "routekit", "kg.yaml"), "code_roots: []\n");

    const record = { id: projectId, root: projectRoot };
    fs.writeFileSync(registryPath, JSON.stringify(record) + "\n");

    const runsRoot = path.join(projectRoot, ".rks", "runs");
    runDir = path.join(runsRoot, `2025-apply-${Date.now()}_apply-test`);
    fs.mkdirSync(runDir, { recursive: true });
    const plan = {
      steps: [
        {
          action: "create_file",
          path: "notes/hello.md",
          content: "Hello world\n",
        },
      ],
    };
    fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify(plan, null, 2));
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify(
        {
          projectId,
          timestamps: { plannedAt: new Date().toISOString(), validatedAt: null, appliedAt: null },
          telemetry: { outcome: "planned" },
        },
        null,
        2
      )
    );
  });

  afterEach(() => {
    if (originalRegistryEnv === undefined) delete process.env.RKS_REGISTRY_PATH;
    else process.env.RKS_REGISTRY_PATH = originalRegistryEnv;
    if (registryDir) fs.rmSync(registryDir, { recursive: true, force: true });
    if (projectRoot && fs.existsSync(projectRoot)) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("applies plan steps and updates metadata", async () => {
    // Use force=true to bypass exec context check (this is a direct test)
    const result = await runApplyTool({ projectId, label: "apply-test", force: true });
    expect(result.ok).toBe(true);
    const notePath = path.join(projectRoot, "notes", "hello.md");
    expect(fs.existsSync(notePath)).toBe(true);
    expect(fs.readFileSync(notePath, "utf8")).toBe("Hello world\n");

    const applyLog = fs.readFileSync(path.join(runDir, "apply", "apply.log"), "utf8");
    expect(applyLog).toMatch(/wrote: notes\/hello\.md/);

    const runMeta = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    expect(runMeta.timestamps?.appliedAt).toBeTruthy();
    expect(runMeta.telemetry?.outcome).toBe("applied");
  });
});
