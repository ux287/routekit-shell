/**
 * backlog.feat.rag-embed-lock-kernel-held — runRagEmbed and runRagReset in packages/rag/src/tools.mjs
 * hold the kernel-held embed lock for their whole run, refuse while it is held, and keep their refusal
 * message prefixes, appending the lock errorCode when the lock file cannot be opened or locked.
 * (Earlier: backlog.fix.rag-embed-lock-never-acquired-in-process.)
 *
 * Holder metadata is observed through inspectEmbedLock and refusal fields, and lock-free state
 * through a fresh acquireEmbedLock. node:sqlite is the real module.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-embed-lock-acquire.test.mjs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- mock state (module scope) ---
let embedImpl = async () => ({ ok: true, indexed: 0 });
let resetImpl = async () => ({ ok: true, tableDropped: false, rowsBeforeReset: 0 });
const embedMock = vi.fn((opts) => embedImpl(opts));
const resetMock = vi.fn((opts) => resetImpl(opts));

vi.mock("@lancedb/lancedb", () => ({
  connect: vi.fn(async () => ({
    openTable: vi.fn(async () => ({ optimize: vi.fn(async () => {}) })),
  })),
}));
// Mocked by repo-relative path so Vitest intercepts tools.mjs's sibling dynamic imports.
vi.mock("../../packages/rag/src/embed.mjs", () => ({ embed: embedMock }));
vi.mock("../../packages/rag/src/init.mjs", () => ({
  init: vi.fn(async () => ({ ok: true })),
  reset: resetMock,
}));
vi.mock("../../packages/rag/src/rag-config-loader.mjs", () => ({
  getRagPathsFor: vi.fn(async () => ({
    unified: "/tmp/rag-embed-lock/unified",
    notes: "/tmp/rag-embed-lock/notes",
    code: "/tmp/rag-embed-lock/code",
    kg: "/tmp/rag-embed-lock/kg",
  })),
  getRagConfigFor: vi.fn(async () => ({ config: {}, configPath: null })),
}));

const tools = await import("../../packages/rag/src/tools.mjs");
const { acquireEmbedLock, inspectEmbedLock, runRagEmbed, runRagReset } = tools;
const { embedLockPath } = await import("../../packages/rag/src/embed-lock.mjs");

let projectRoot;
let open = [];
const lockPath = () => embedLockPath(projectRoot);
const manifestPath = () => path.join(projectRoot, ".rks", "rag", "embed-manifest.json");

/** True when a fresh acquire succeeds (the lock is free); the probe lock is released at once. */
function lockIsFree() {
  const probe = acquireEmbedLock(projectRoot, { holder: "free-probe" });
  if (probe.acquired) probe.release();
  return probe.acquired === true;
}

function take(holder) {
  const lock = acquireEmbedLock(projectRoot, { holder });
  if (lock.acquired) open.push(lock);
  return lock;
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-embed-lock-"));
  open = [];
  embedImpl = async () => ({ ok: true, indexed: 0 });
  resetImpl = async () => ({ ok: true, tableDropped: false, rowsBeforeReset: 0 });
  embedMock.mockClear();
  resetMock.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const lock of open) {
    try { lock.release(); } catch { /* best-effort */ }
  }
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

describe("runRagEmbed and runRagReset under the kernel-held lock", () => {
  it("runRagEmbed holds the lock while embed runs and releases it after success, ok false and throw", async () => {
    const outcomes = [
      async () => ({ ok: true, indexed: 0 }),
      async () => ({ ok: false, error: "embed failed", indexed: 0 }),
      async () => { throw new Error("embed exploded"); },
    ];
    for (const outcome of outcomes) {
      let seen = null;
      embedImpl = async () => {
        seen = inspectEmbedLock(projectRoot);
        return outcome();
      };
      await runRagEmbed(projectRoot, {}).catch(() => {});
      expect(seen).not.toBeNull(); // positive control: embed() ran
      expect(seen.locked).toBe(true);
      expect(seen.pid).toBe(process.pid);
      expect(seen.holder).toBe("runRagEmbed");
      expect(lockIsFree()).toBe(true);
      expect(fs.existsSync(lockPath())).toBe(true);
    }
    expect(embedMock).toHaveBeenCalledTimes(3);
  });

  it("runRagReset holds the lock while reset runs and releases it after success and throw", async () => {
    const outcomes = [
      async () => ({ ok: true, tableDropped: false, rowsBeforeReset: 0 }),
      async () => { throw new Error("reset exploded"); },
    ];
    for (const outcome of outcomes) {
      let seen = null;
      resetImpl = async () => {
        seen = inspectEmbedLock(projectRoot);
        return outcome();
      };
      await runRagReset(projectRoot).catch(() => {});
      expect(seen).not.toBeNull(); // positive control: reset() ran
      expect(seen.locked).toBe(true);
      expect(seen.pid).toBe(process.pid);
      expect(seen.holder).toBe("runRagReset");
      expect(lockIsFree()).toBe(true);
    }
    expect(resetMock).toHaveBeenCalledTimes(2);
  });

  it("a nested runRagEmbed and runRagReset during the window are refused without running", async () => {
    fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
    fs.writeFileSync(manifestPath(), JSON.stringify({ hashes: { "notes/a.md": "abc" } }));
    const before = fs.readFileSync(manifestPath());
    let innerEmbed = null;
    let innerReset = null;
    let afterReset = null;
    let depth = 0;
    embedImpl = async () => {
      depth += 1;
      if (depth === 1) {
        innerEmbed = await runRagEmbed(projectRoot, {});
        innerReset = await runRagReset(projectRoot);
        afterReset = fs.readFileSync(manifestPath());
      }
      return { ok: true, indexed: 0 };
    };
    await runRagEmbed(projectRoot, {});
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(innerEmbed).toMatchObject({ ok: false, locked: true });
    expect(innerReset).toMatchObject({ ok: false, locked: true });
    expect(resetMock).not.toHaveBeenCalled();
    expect(afterReset.equals(before)).toBe(true);
  });

  it("runRagEmbed over a directory lock path is refused with EISDIR and does not call embed", async () => {
    fs.mkdirSync(lockPath(), { recursive: true });
    const res = await runRagEmbed(projectRoot, {});
    expect(res.ok).toBe(false);
    expect(res.locked).toBe(true);
    expect(res.error.startsWith("Embed already in progress (PID: unknown")).toBe(true);
    expect(res.error).toContain("EISDIR");
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("runRagReset over a directory lock path is refused with EISDIR and does not call reset", async () => {
    fs.mkdirSync(lockPath(), { recursive: true });
    const res = await runRagReset(projectRoot);
    expect(res.ok).toBe(false);
    expect(res.locked).toBe(true);
    expect(res.error.startsWith("Reset refused: embed lock held (PID: unknown")).toBe(true);
    expect(res.error).toContain("EISDIR");
    expect(resetMock).not.toHaveBeenCalled();
  });

  it("refusal messages are unchanged for a held lock with a fixed started value", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    const lock = take("fixed-started");
    nowSpy.mockRestore();
    expect(lock.acquired).toBe(true);
    const embedRes = await runRagEmbed(projectRoot, {});
    const resetRes = await runRagReset(projectRoot);
    expect(embedRes.error).toBe(`Embed already in progress (PID: ${process.pid}, started: 1700000000000)`);
    expect(resetRes.error).toBe(`Reset refused: embed lock held (PID: ${process.pid}, started: 1700000000000)`);
    expect(embedMock).not.toHaveBeenCalled();
    expect(resetMock).not.toHaveBeenCalled();
  });

  it("a live-pid legacy record no longer refuses runRagEmbed or runRagReset", async () => {
    // backlog.chore.rag-embed-lock-retire-legacy-compat: ownership is the kernel lock alone.
    projectRoot = fs.realpathSync(projectRoot);
    const record = path.join(projectRoot, ".rks", "rag", ".embed-lock");
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ pid: process.pid, started: 1700000000000, holder: "pre-redesign" }));
    const before = fs.readFileSync(record);
    const embedRes = await runRagEmbed(projectRoot, {});
    const resetRes = await runRagReset(projectRoot);
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(embedRes?.locked).not.toBe(true);
    expect(String(embedRes?.error ?? "")).not.toContain("legacy lock record");
    expect(String(resetRes?.error ?? "")).not.toContain("legacy lock record");
    expect(fs.readFileSync(record).equals(before)).toBe(true);
  });

  it("tools.mjs still re-exports the embed-lock functions", () => {
    for (const name of ["acquireEmbedLock", "releaseEmbedLock", "inspectEmbedLock"]) {
      expect(typeof tools[name], name).toBe("function");
    }
  });
});
