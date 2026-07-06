/**
 * Unit tests for the `sub === 'upgrade'` branch in handleProjectCommand.
 * Mocks upgradeProject + getProjectById via the deps-injection seam to verify the
 * dispatch contract without touching real filesystems or registries.
 */
import { describe, it, expect, vi } from "vitest";
import { handleProjectCommand } from "../../packages/cli/src/cli/project.js";

const SHELL_ROOT = "/tmp/shell-root";
const REGISTRY_RECORD = { id: "fixture-child", root: "/tmp/child-root" };

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
