/**
 * backlog.fix.plan-worker-project-root-defaults-to-install-dir
 *
 * bin/plan-worker.mjs is not importable (top-level argv code, process.exit), so this
 * test pins the two source edits with durable regexes and exercises loadProjectContext
 * under the env the detached worker receives after the fix.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectContext } from "../../packages/mcp-rks/src/project-context.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER_SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/bin/plan-worker.mjs"), "utf8");
const SERVER_SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server.mjs"), "utf8");

const ROUTING_VARS = ["ROUTEKIT_PROJECT_ROOT", "RKS_PROJECT_ROOT", "ROUTEKIT_PROJECT_ID"];

function makeChildProject(id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-child-root-"));
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".rks", "project.json"), JSON.stringify({ id, kgFile: "kg.yaml" }));
  fs.writeFileSync(path.join(dir, "kg.yaml"), "project: test\n");
  return fs.realpathSync(dir);
}

describe("plan-worker project root resolution", () => {
  let saved;
  let childRoot;

  beforeEach(() => {
    saved = Object.fromEntries(ROUTING_VARS.map((k) => [k, process.env[k]]));
    childRoot = makeChildProject("qa-child-proj");
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(childRoot, { recursive: true, force: true });
  });

  it("plan-worker.mjs no longer assigns its install root to ROUTEKIT_PROJECT_ROOT", () => {
    expect(WORKER_SRC).not.toMatch(/ROUTEKIT_PROJECT_ROOT\s*=\s*projectRoot\b/);
  });

  it("plan-worker.mjs falls back to process.cwd() only when ROUTEKIT_PROJECT_ROOT is unset", () => {
    expect(WORKER_SRC).toMatch(/if\s*\(\s*!process\.env\.ROUTEKIT_PROJECT_ROOT\s*\)/);
    expect(WORKER_SRC).toMatch(/process\.env\.ROUTEKIT_PROJECT_ROOT\s*=\s*process\.cwd\(\)/);
  });

  it("plan-worker.mjs still loads .env from its install root", () => {
    expect(WORKER_SRC).toMatch(/const projectRoot\s*=\s*path\.resolve\(__dirname,\s*['"]\.\.['"],\s*['"]\.\.['"],\s*['"]\.\.['"]\)/);
    expect(WORKER_SRC).toMatch(/dotenv\.config\(\{\s*path:\s*path\.join\(projectRoot,\s*['"]\.env['"]\)/);
  });

  it("server.mjs passes ROUTEKIT_PROJECT_ROOT = ctx.record.root in the plan-worker spawn env", () => {
    expect(SERVER_SRC).toMatch(/env:\s*\{\s*\.\.\.process\.env,\s*ROUTEKIT_PROJECT_ROOT:\s*ctx\.record\.root\s*\}/);
    expect(SERVER_SRC).not.toMatch(/env:\s*\{\s*\.\.\.process\.env\s*\},/);
  });

  it("child env (ROUTEKIT_PROJECT_ID only) + root the server now passes -> record.root is the child root, not the install root", async () => {
    delete process.env.RKS_PROJECT_ROOT;
    process.env.ROUTEKIT_PROJECT_ID = "qa-child-proj";
    // What the worker sees after the fix: server injects ctx.record.root.
    process.env.ROUTEKIT_PROJECT_ROOT = childRoot;
    const ctx = await loadProjectContext("qa-child-proj", ROOT);
    expect(ctx.record.root).toBe(childRoot);
    expect(ctx.record.root).not.toBe(ROOT);
  });

  it("when ROUTEKIT_PROJECT_ROOT is already set (shell's own case) it is honored unchanged", async () => {
    delete process.env.RKS_PROJECT_ROOT;
    process.env.ROUTEKIT_PROJECT_ID = "qa-child-proj";
    process.env.ROUTEKIT_PROJECT_ROOT = childRoot;
    const ctx = await loadProjectContext("qa-child-proj", ROOT);
    expect(ctx.record.root).toBe(childRoot);
    expect(process.env.ROUTEKIT_PROJECT_ROOT).toBe(childRoot);
  });
});
