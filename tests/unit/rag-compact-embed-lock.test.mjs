/**
 * backlog.fix.rag-compact-takes-embed-lock — runRagCompact takes the embed lock and
 * refuses while another holder has it.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-compact-embed-lock.test.mjs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let optimizeImpl = async () => {};
const optimizeMock = vi.fn((opts) => optimizeImpl(opts));
const connectMock = vi.fn(async () => ({
  openTable: vi.fn(async () => ({ optimize: optimizeMock })),
}));

vi.mock("@lancedb/lancedb", () => ({ connect: connectMock }));
vi.mock("../../packages/rag/src/rag-config-loader.mjs", () => ({
  getRagPathsFor: vi.fn(async (root) => ({
    unified: path.join(root, ".rks", "rag", "unified"),
    notes: path.join(root, ".rks", "rag", "notes"),
    code: path.join(root, ".rks", "rag", "code"),
    kg: path.join(root, ".rks", "rag", "kg"),
  })),
  getRagConfigFor: vi.fn(async () => ({ config: {}, configPath: null })),
}));

const { runRagCompact } = await import("../../packages/rag/src/tools.mjs");

let projectRoot;
const ragDir = () => path.join(projectRoot, ".rks", "rag");
const lockPath = () => path.join(ragDir(), ".embed-lock");
const embedsDir = () => path.join(ragDir(), "embeds");
const readLock = () => JSON.parse(fs.readFileSync(lockPath(), "utf8"));
const writeLock = (data) => {
  fs.mkdirSync(ragDir(), { recursive: true });
  fs.writeFileSync(lockPath(), JSON.stringify(data));
};
const seedEmbedRuns = () => {
  for (const run of ["run-a", "run-b"]) fs.mkdirSync(path.join(embedsDir(), run), { recursive: true });
};

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-compact-lock-"));
  optimizeImpl = async () => {};
  optimizeMock.mockClear();
  connectMock.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("runRagCompact takes the embed lock", () => {
  it("refuses while another live holder has the lock, without connecting or pruning embed runs", async () => {
    seedEmbedRuns();
    writeLock({ pid: process.pid, started: Date.now(), holder: "other" });
    const lockBefore = fs.readFileSync(lockPath());
    const runsBefore = fs.readdirSync(embedsDir()).sort();
    expect(runsBefore).toEqual(["run-a", "run-b"]); // positive control: two runs, so a prune would be visible
    const res = await runRagCompact(projectRoot);
    expect(res.ok).toBe(false);
    expect(res.locked).toBe(true);
    expect(res.error.startsWith("Compact refused: embed lock held (PID: ")).toBe(true);
    expect(connectMock).not.toHaveBeenCalled();
    expect(fs.readdirSync(embedsDir()).sort()).toEqual(runsBefore);
    expect(fs.readFileSync(lockPath()).equals(lockBefore)).toBe(true);
  });

  it("compacts when the lock is free and returns the byte counts", async () => {
    seedEmbedRuns();
    const res = await runRagCompact(projectRoot);
    expect(res?.locked).not.toBe(true);
    expect(typeof res.beforeBytes).toBe("number");
    expect(typeof res.afterBytes).toBe("number");
    expect(res.reclaimedBytes).toBe(res.beforeBytes - res.afterBytes);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(optimizeMock.mock.calls[0][0]).toEqual({ compaction: true });
    expect(fs.readdirSync(embedsDir())).toEqual(["run-b"]);
  });

  it("holds the lock naming runRagCompact while optimize runs and releases it afterwards", async () => {
    let seen = null;
    optimizeImpl = async () => {
      if (!seen) seen = fs.existsSync(lockPath()) ? readLock() : { absent: true };
    };
    await runRagCompact(projectRoot);
    expect(seen).not.toBeNull(); // positive control: optimize actually ran
    expect(seen.pid).toBe(process.pid);
    expect(seen.holder).toBe("runRagCompact");
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("releases the lock and still throws LanceDB optimize failed when optimize throws", async () => {
    let held = false;
    optimizeImpl = async () => {
      held = fs.existsSync(lockPath());
      throw new Error("optimize exploded");
    };
    await expect(runRagCompact(projectRoot)).rejects.toThrow(/LanceDB optimize failed: optimize exploded/);
    expect(held).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(false);
  });
});
