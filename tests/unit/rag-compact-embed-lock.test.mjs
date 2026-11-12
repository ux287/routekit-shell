/**
 * backlog.fix.rag-compact-takes-embed-lock — runRagCompact takes the embed lock and
 * refuses while another holder has it.
 *
 * backlog.feat.rag-embed-lock-kernel-held — the lock is the kernel-held node:sqlite lock on
 * .rks/rag/embed-lock.sqlite: holder metadata is observed through inspectEmbedLock, a live holder is
 * a real in-process acquire, lock-free state is a fresh acquire, and a refusal over an unreadable lock
 * file appends its errorCode.
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

const { runRagCompact, acquireEmbedLock, inspectEmbedLock } = await import("../../packages/rag/src/tools.mjs");
const { embedLockPath } = await import("../../packages/rag/src/embed-lock.mjs");

let projectRoot;
const ragDir = () => path.join(projectRoot, ".rks", "rag");
const lockPath = () => embedLockPath(projectRoot);
const embedsDir = () => path.join(ragDir(), "embeds");
let open = [];
function take(holder) {
  const lock = acquireEmbedLock(projectRoot, { holder });
  if (lock.acquired) open.push(lock);
  return lock;
}
/** True when a fresh acquire succeeds (the lock is free); the probe lock is released at once. */
function lockIsFree() {
  const probe = acquireEmbedLock(projectRoot, { holder: "free-probe" });
  if (probe.acquired) probe.release();
  return probe.acquired === true;
}
const seedEmbedRuns = () => {
  for (const run of ["run-a", "run-b"]) fs.mkdirSync(path.join(embedsDir(), run), { recursive: true });
};

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-compact-lock-"));
  open = [];
  optimizeImpl = async () => {};
  optimizeMock.mockClear();
  connectMock.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const lock of open) {
    try { lock.release(); } catch { /* best-effort */ }
  }
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("runRagCompact takes the embed lock", () => {
  it("refuses while another live holder has the lock, without connecting or pruning embed runs", async () => {
    seedEmbedRuns();
    const lock = take("other");
    expect(lock.acquired).toBe(true);
    const runsBefore = fs.readdirSync(embedsDir()).sort();
    expect(runsBefore).toEqual(["run-a", "run-b"]); // positive control: two runs, so a prune would be visible
    const res = await runRagCompact(projectRoot);
    expect(res.ok).toBe(false);
    expect(res.locked).toBe(true);
    expect(res.error.startsWith("Compact refused: embed lock held (PID: ")).toBe(true);
    expect(connectMock).not.toHaveBeenCalled();
    expect(fs.readdirSync(embedsDir()).sort()).toEqual(runsBefore);
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
      if (!seen) seen = inspectEmbedLock(projectRoot);
    };
    await runRagCompact(projectRoot);
    expect(seen).not.toBeNull(); // positive control: optimize actually ran
    expect(seen.locked).toBe(true);
    expect(seen.pid).toBe(process.pid);
    expect(seen.holder).toBe("runRagCompact");
    expect(lockIsFree()).toBe(true);
  });

  it("releases the lock and still throws LanceDB optimize failed when optimize throws", async () => {
    let held = null;
    optimizeImpl = async () => {
      held = inspectEmbedLock(projectRoot).locked;
      throw new Error("optimize exploded");
    };
    await expect(runRagCompact(projectRoot)).rejects.toThrow(/LanceDB optimize failed: optimize exploded/);
    expect(held).toBe(true); // positive control: optimize ran under the lock
    expect(lockIsFree()).toBe(true);
  });

  it("refuses over a directory at the kernel lock path with EISDIR appended, without connecting", async () => {
    fs.mkdirSync(lockPath(), { recursive: true });
    const res = await runRagCompact(projectRoot);
    expect(res.ok).toBe(false);
    expect(res.locked).toBe(true);
    expect(res.error.startsWith("Compact refused: embed lock held (PID: unknown")).toBe(true);
    expect(res.error).toContain("EISDIR");
    expect(connectMock).not.toHaveBeenCalled();
    expect(fs.statSync(lockPath()).isDirectory()).toBe(true);
  });
});
