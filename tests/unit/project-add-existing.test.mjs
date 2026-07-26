import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleProjectCommand } from "../../packages/cli/src/cli/project.js";
import { getProjectById, loadProjects } from "../../packages/cli/src/project/index.js";

// REAL registration round-trip for the setup step. The prior fix's unit test only asserted
// setup ISSUES the spawn (injected runner) — it never ran the command, so it couldn't catch
// `project attach` ENOENTing on a self-hosting clone. This exercises the actual registration
// verb (`add-existing`) against a temp registry and confirms rag init's lookup would resolve.

let shellRoot, projectPath;
beforeEach(() => {
  shellRoot = mkdtempSync(join(tmpdir(), "rks-shell-"));
  projectPath = mkdtempSync(join(tmpdir(), "rks-proj-"));
});
afterEach(() => {
  for (const d of [shellRoot, projectPath]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

const register = (over = {}) =>
  handleProjectCommand(
    {
      sub: "add-existing",
      kv: { id: "routekit-shell", stack: "routekit-shell", path: projectPath, ...over },
      SHELL_ROOT: shellRoot,
    },
    { processExit: vi.fn() },
  );

describe("project add-existing — real registry round-trip (the setup registration step)", () => {
  it("registers so getProjectById resolves a record with a usable root (what rag init reads)", async () => {
    const processExit = vi.fn();
    await handleProjectCommand(
      { sub: "add-existing", kv: { id: "routekit-shell", stack: "routekit-shell", path: projectPath }, SHELL_ROOT: shellRoot },
      { processExit },
    );
    expect(processExit).toHaveBeenCalledWith(0);

    const rec = getProjectById("routekit-shell", shellRoot);
    expect(rec).toBeTruthy();
    expect(rec.id).toBe("routekit-shell");
    // rag.js resolves `project.root || project.path` — both must point at the clone.
    expect(rec.root || rec.path).toBe(projectPath);
  });

  it("is idempotent — re-registering the same id leaves exactly one record", async () => {
    await register();
    await register();
    const matches = loadProjects(shellRoot).filter((p) => p.id === "routekit-shell");
    expect(matches).toHaveLength(1);
  });
});
