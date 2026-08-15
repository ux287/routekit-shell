/**
 * Unit tests for the `sub === 'upgrade'` branch in handleProjectCommand.
 * Mocks upgradeProject + getProjectById via the deps-injection seam to verify the
 * dispatch contract without touching real filesystems or registries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleProjectCommand } from "../../packages/cli/src/cli/project.js";

const SHELL_ROOT = "/tmp/shell-root";
const REGISTRY_RECORD = { id: "fixture-child", root: "/tmp/child-root" };

// A REAL on-disk dir that looks like an rks shell root (has package.json), for exercising
// the --from-release validation + content-source override. Caller cleans up.
function makeShellRoot() {
  const d = mkdtempSync(path.join(os.tmpdir(), "rel-root-"));
  writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "routekit-shell", version: "0.20.39" }));
  return d;
}

function okReport(over = {}) {
  return {
    ok: true,
    projectId: "fixture-child",
    from: "0.20.18",
    to: "0.20.19",
    boundary: "patch",
    gated: false,
    dryRun: false,
    backupPath: null,
    reconciled: [],
    migrationsApplied: [],
    preserved: [],
    stampAdvanced: true,
    restartRequired: true,
    warnings: [],
    ...over,
  };
}

function makeDeps(over = {}) {
  return {
    processExit: vi.fn(),
    upgradeProject: vi.fn(() => okReport()),
    getProjectById: vi.fn(() => REGISTRY_RECORD),
    ...over,
  };
}

describe('handleProjectCommand — sub === "upgrade"', () => {
  it("resolves the project and invokes upgradeProject with projectRoot/projectId/shellRoot/opts", async () => {
    const deps = makeDeps();
    await handleProjectCommand({ sub: "upgrade", kv: { id: "fixture-child" }, SHELL_ROOT }, deps);
    expect(deps.getProjectById).toHaveBeenCalledWith("fixture-child", SHELL_ROOT);
    expect(deps.upgradeProject).toHaveBeenCalledWith({
      projectRoot: REGISTRY_RECORD.root,
      projectId: "fixture-child",
      shellRoot: SHELL_ROOT,
      opts: { dryRun: false, noBackup: false },
    });
    expect(deps.processExit).toHaveBeenCalledWith(0);
  });

  it("threads --dry-run and --no-backup into opts", async () => {
    const deps = makeDeps();
    await handleProjectCommand(
      { sub: "upgrade", kv: { id: "fixture-child", "dry-run": true, "no-backup": true }, SHELL_ROOT },
      deps,
    );
    expect(deps.upgradeProject).toHaveBeenCalledWith(
      expect.objectContaining({ opts: { dryRun: true, noBackup: true } }),
    );
  });

  it("exits non-zero when --id is missing (upgradeProject not called)", async () => {
    const deps = makeDeps();
    await handleProjectCommand({ sub: "upgrade", kv: {}, SHELL_ROOT }, deps);
    expect(deps.upgradeProject).not.toHaveBeenCalled();
    expect(deps.processExit.mock.calls[0][0]).not.toBe(0);
  });

  it("exits non-zero when the project is not in the registry", async () => {
    const deps = makeDeps({ getProjectById: vi.fn(() => null) });
    await handleProjectCommand({ sub: "upgrade", kv: { id: "unknown" }, SHELL_ROOT }, deps);
    expect(deps.upgradeProject).not.toHaveBeenCalled();
    expect(deps.processExit.mock.calls[0][0]).not.toBe(0);
  });

  it("exits 1 when the report is not ok", async () => {
    const deps = makeDeps({ upgradeProject: vi.fn(() => okReport({ ok: false, boundary: "invalid" })) });
    await handleProjectCommand({ sub: "upgrade", kv: { id: "fixture-child" }, SHELL_ROOT }, deps);
    expect(deps.processExit).toHaveBeenCalledWith(1);
  });

  it("exits non-zero when upgradeProject throws", async () => {
    const deps = makeDeps({
      upgradeProject: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    await handleProjectCommand({ sub: "upgrade", kv: { id: "fixture-child" }, SHELL_ROOT }, deps);
    expect(deps.processExit.mock.calls[0][0]).not.toBe(0);
  });

  it("handles a gated (major) report without throwing", async () => {
    const deps = makeDeps({
      upgradeProject: vi.fn(() =>
        okReport({ boundary: "major", gated: true, stampAdvanced: false, warnings: ["major not supported"] }),
      ),
    });
    await handleProjectCommand({ sub: "upgrade", kv: { id: "fixture-child" }, SHELL_ROOT }, deps);
    expect(deps.processExit).toHaveBeenCalledWith(0);
  });
});

// backlog.feat.child-lifecycle.upgrade-all-from-release — --from-release content source + --all batch.
describe("handleProjectCommand — upgrade --from-release / --all", () => {
  it("DECOUPLING: --from-release is the CONTENT shellRoot; the child still resolves from the SHELL_ROOT registry", async () => {
    const release = makeShellRoot();
    try {
      const deps = makeDeps();
      await handleProjectCommand({ sub: "upgrade", kv: { id: "fixture-child", "from-release": release }, SHELL_ROOT }, deps);
      expect(deps.getProjectById).toHaveBeenCalledWith("fixture-child", SHELL_ROOT); // registry: default shell root
      expect(deps.upgradeProject).toHaveBeenCalledWith(
        expect.objectContaining({ projectRoot: REGISTRY_RECORD.root, projectId: "fixture-child", shellRoot: path.resolve(release) }),
      ); // content: the release
      expect(deps.processExit).toHaveBeenCalledWith(0);
    } finally {
      rmSync(release, { recursive: true, force: true });
    }
  });

  it("--shell-root is an alias for --from-release", async () => {
    const release = makeShellRoot();
    try {
      const deps = makeDeps();
      await handleProjectCommand({ sub: "upgrade", kv: { id: "fixture-child", "shell-root": release }, SHELL_ROOT }, deps);
      expect(deps.upgradeProject).toHaveBeenCalledWith(expect.objectContaining({ shellRoot: path.resolve(release) }));
    } finally {
      rmSync(release, { recursive: true, force: true });
    }
  });

  it("BACKWARD COMPAT: no --from-release ⇒ content shellRoot === SHELL_ROOT (unchanged)", async () => {
    const deps = makeDeps();
    await handleProjectCommand({ sub: "upgrade", kv: { id: "fixture-child" }, SHELL_ROOT }, deps);
    expect(deps.upgradeProject).toHaveBeenCalledWith(expect.objectContaining({ shellRoot: SHELL_ROOT }));
  });

  it("VALIDATION: --from-release pointing at a non-shell path errors, no child mutated, non-zero exit", async () => {
    const deps = makeDeps();
    await handleProjectCommand({ sub: "upgrade", kv: { id: "fixture-child", "from-release": "/no/such/release/root" }, SHELL_ROOT }, deps);
    expect(deps.upgradeProject).not.toHaveBeenCalled();
    expect(deps.processExit.mock.calls[0][0]).not.toBe(0);
  });

  it("--all upgrades EVERY registered child (from the SHELL_ROOT registry) with the release content root", async () => {
    const release = makeShellRoot();
    const a = makeShellRoot();
    const b = makeShellRoot();
    try {
      const children = [{ id: "child-a", root: a }, { id: "child-b", root: b }];
      const deps = makeDeps({ loadProjects: vi.fn(() => children) });
      await handleProjectCommand({ sub: "upgrade", kv: { all: true, "from-release": release }, SHELL_ROOT }, deps);
      expect(deps.loadProjects).toHaveBeenCalledWith(SHELL_ROOT); // children come from the default registry
      expect(deps.upgradeProject).toHaveBeenCalledTimes(2);
      expect(deps.upgradeProject).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: a, projectId: "child-a", shellRoot: path.resolve(release) }));
      expect(deps.upgradeProject).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: b, projectId: "child-b", shellRoot: path.resolve(release) }));
      expect(deps.processExit).toHaveBeenCalledWith(0);
    } finally {
      for (const d of [release, a, b]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("--all is mutually exclusive with --id (errors, nothing upgraded)", async () => {
    const deps = makeDeps({ loadProjects: vi.fn(() => []) });
    await handleProjectCommand({ sub: "upgrade", kv: { all: true, id: "x" }, SHELL_ROOT }, deps);
    expect(deps.upgradeProject).not.toHaveBeenCalled();
    expect(deps.processExit.mock.calls[0][0]).not.toBe(0);
  });

  it("--all continues past a child with a missing root and exits non-zero", async () => {
    const good = makeShellRoot();
    try {
      const children = [{ id: "child-a", root: good }, { id: "missing", root: "/no/such/child-root" }];
      const deps = makeDeps({ loadProjects: vi.fn(() => children) });
      await handleProjectCommand({ sub: "upgrade", kv: { all: true }, SHELL_ROOT }, deps);
      expect(deps.upgradeProject).toHaveBeenCalledTimes(1); // only the existing child
      expect(deps.processExit).toHaveBeenCalledWith(1);
    } finally {
      rmSync(good, { recursive: true, force: true });
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// backlog.fix.shell-self-sync-skill-wipe-health-gate — `--all` must not eat the shell
// ══════════════════════════════════════════════════════════════════════════════════
//
// setup.mjs registers the SHELL in its own registry. `--all` loops every registry record. Without a
// skip, the shell is upgraded as if it were one of its own children: syncProject then runs with
// projectRoot === shellRoot, deletes the shell's skills, and exits 0. This is the command that wiped
// the clean-machine UAT box.
describe('handleProjectCommand — --all skips the shell\'s own registry record', () => {
  it('upgrade --all: the shell record is SKIPPED; real children still upgrade', async () => {
    const shell = makeShellRoot();
    const kid = makeShellRoot();
    try {
      const deps = makeDeps({
        loadProjects: vi.fn(() => [
          { id: 'routekit-shell-core', root: shell }, // ← the shell, in its own registry
          { id: 'child-a', root: kid },
        ]),
      });
      // SHELL_ROOT is the shell — so its record resolves to the same directory.
      await handleProjectCommand({ sub: 'upgrade', kv: { all: true }, SHELL_ROOT: shell }, deps);

      // POSITIVE CONTROL: the loop ran and did real work — "the shell wasn't upgraded" is also true
      // of a command that fell over before the loop.
      expect(deps.upgradeProject).toHaveBeenCalledWith(
        expect.objectContaining({ projectRoot: kid, projectId: 'child-a' }),
      );
      // THE CLAIM: never against the shell itself.
      expect(deps.upgradeProject).not.toHaveBeenCalledWith(expect.objectContaining({ projectRoot: shell }));
      expect(deps.upgradeProject).toHaveBeenCalledTimes(1);
      // A skip is not a failure — the command still succeeds.
      expect(deps.processExit).toHaveBeenCalledWith(0);
    } finally {
      for (const d of [shell, kid]) rmSync(d, { recursive: true, force: true });
    }
  });

});

// ── backlog.feat.project-adopt-verb ──────────────────────────────────────────────────────────
// The report now carries the resolved shell root; both printers must actually SHOW it. Carrying it
// on the report while printing nothing would leave the original defect exactly where it was — the
// operator still could not see which shell the version came from.

describe("handleProjectCommand — upgrade printers render the resolved shell root", () => {
  let logs;
  let spy;

  beforeEach(() => {
    logs = [];
    spy = vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
  });
  afterEach(() => spy.mockRestore());

  it("single-project (--id) path prints the shell root", async () => {
    const deps = makeDeps({ upgradeProject: vi.fn(() => okReport({ shellRoot: "/resolved/shell" })) });
    await handleProjectCommand({ sub: "upgrade", kv: { id: "fixture-child" }, SHELL_ROOT }, deps);
    expect(logs.join("\n")).toContain("/resolved/shell");
  });

  it("single-project no-op path still prints the shell root", async () => {
    // The motivating case: `Already at X — nothing to do.` must no longer be the whole story.
    const deps = makeDeps({
      upgradeProject: vi.fn(() =>
        okReport({ boundary: "none", shellRoot: "/resolved/shell", warnings: ["Already at 0.20.19 — nothing to do."] }),
      ),
    });
    await handleProjectCommand({ sub: "upgrade", kv: { id: "fixture-child" }, SHELL_ROOT }, deps);
    expect(logs.join("\n")).toContain("/resolved/shell");
  });

  it("--all batch path prints the shell root per project", async () => {
    const shell = mkdtempSync(path.join(os.tmpdir(), "dispatch-shell-"));
    const kidA = mkdtempSync(path.join(os.tmpdir(), "kid-a-"));
    const kidB = mkdtempSync(path.join(os.tmpdir(), "kid-b-"));
    try {
      const deps = makeDeps({
        loadProjects: vi.fn(() => [
          { id: "child-a", root: kidA },
          { id: "child-b", root: kidB },
        ]),
        upgradeProject: vi.fn(() => okReport({ shellRoot: "/resolved/shell" })),
      });
      await handleProjectCommand({ sub: "upgrade", kv: { all: true }, SHELL_ROOT: shell }, deps);

      const shellLines = logs.filter((l) => l.includes("/resolved/shell"));
      expect(shellLines).toHaveLength(2); // per-project, not once for the batch
      expect(shellLines.join("\n")).toContain("child-a");
      expect(shellLines.join("\n")).toContain("child-b");
    } finally {
      for (const d of [shell, kidA, kidB]) rmSync(d, { recursive: true, force: true });
    }
  });
});
