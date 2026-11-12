import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
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

// ── backlog.feat.project-adopt-verb ──────────────────────────────────────────────────────────
// --stack becomes OPTIONAL for an already-bootstrapped target. It is scaffold-time metadata that
// selects a template skeleton; re-registering an existing child has no template to select, so
// demanding it made the documented recovery path fail on a usage error with nothing useful to supply.

describe("project add-existing — --stack inference and compatibility", () => {
  function bootstrapChild({ stack = null } = {}) {
    mkdirSync(join(projectPath, ".rks"), { recursive: true });
    mkdirSync(join(projectPath, "routekit"), { recursive: true });
    writeFileSync(join(projectPath, "routekit", "kg.yaml"), "stack: base\n");
    const cfg = { id: "routekit-shell", rksVersion: "0.20.34", kgFile: "routekit/kg.yaml" };
    if (stack) cfg.stack = stack;
    writeFileSync(join(projectPath, ".rks", "project.json"), JSON.stringify(cfg));
  }

  it("infers the stack from a bootstrapped target when --stack is omitted", async () => {
    bootstrapChild();
    const processExit = vi.fn();
    await handleProjectCommand(
      { sub: "add-existing", kv: { id: "routekit-shell", path: projectPath }, SHELL_ROOT: shellRoot },
      { processExit },
    );
    expect(processExit).toHaveBeenCalledWith(0);
    // The exact inferred value, not merely "non-empty".
    expect(getProjectById("routekit-shell", shellRoot).stack).toBe("base");
  });

  it("fails on a NOT-bootstrapped target naming BOTH remedies, writing zero rows", async () => {
    const processExit = vi.fn();
    const errors = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
    try {
      await handleProjectCommand(
        { sub: "add-existing", kv: { id: "routekit-shell", path: projectPath }, SHELL_ROOT: shellRoot },
        { processExit },
      );
      expect(processExit).toHaveBeenCalledWith(1);
      expect(errors.join("\n")).toMatch(/--stack <stackId>/);
      expect(errors.join("\n")).toMatch(/routekit project attach/);
      expect(loadProjects(shellRoot)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("prints the registry file it actually appended to", async () => {
    const logs = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    try {
      await register();
      const printed = logs.find((l) => l.startsWith("Registered in shell registry:"))?.split(": ")[1];
      expect(printed).toBe(join(shellRoot, "projects", "index.jsonl"));
      const rows = readFileSync(printed, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(rows.map((r) => r.id)).toContain("routekit-shell");
    } finally {
      spy.mockRestore();
    }
  });

  // COMPATIBILITY CONTROL. None of these are templates listTemplates() returns. attach hard-rejects
  // an unknown stack with exit 2; replicating that here would break scripts/setup.mjs, which passes
  // `--stack routekit-shell` on every fresh clone.
  it.each(["routekit-shell", "web", "legacy-stack"])(
    "writes a supplied non-template stack verbatim and still exits 0: %s",
    async (stack) => {
      const processExit = vi.fn();
      await handleProjectCommand(
        { sub: "add-existing", kv: { id: "routekit-shell", stack, path: projectPath }, SHELL_ROOT: shellRoot },
        { processExit },
      );
      expect(processExit).toHaveBeenCalledWith(0);
      expect(processExit).not.toHaveBeenCalledWith(2);
      expect(getProjectById("routekit-shell", shellRoot).stack).toBe(stack);
    },
  );
});
