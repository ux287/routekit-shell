/**
 * backlog.fix.rag-embed-lock-never-acquired-in-process — the embed lock is a real mutex for
 * the in-process entry points runRagEmbed and runRagReset in packages/rag/src/tools.mjs.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-embed-lock-acquire.test.mjs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEAD_PID = 999999999;

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

const { acquireEmbedLock, runRagEmbed, runRagReset } = await import("../../packages/rag/src/tools.mjs");

let projectRoot;
const lockPath = () => path.join(projectRoot, ".rks", "rag", ".embed-lock");
const manifestPath = () => path.join(projectRoot, ".rks", "rag", "embed-manifest.json");
const readLock = () => JSON.parse(fs.readFileSync(lockPath(), "utf8"));
const writeLock = (data) => {
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(lockPath(), JSON.stringify(data));
};

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-embed-lock-"));
  embedImpl = async () => ({ ok: true, indexed: 0 });
  resetImpl = async () => ({ ok: true, tableDropped: false, rowsBeforeReset: 0 });
  embedMock.mockClear();
  resetMock.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

describe("acquireEmbedLock", () => {
  it("creates the lock naming this pid, started and holder, creating .rks/rag when absent", async () => {
    expect(fs.existsSync(path.join(projectRoot, ".rks"))).toBe(false); // positive control: really absent
    const lock = await acquireEmbedLock(projectRoot, { holder: "test-holder" });
    expect(lock.acquired).toBe(true);
    expect(typeof lock.release).toBe("function");
    const data = readLock();
    expect(data.pid).toBe(process.pid);
    expect(data.started).toBeDefined();
    expect(data.holder).toBe("test-holder");
    await lock.release();
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("refuses a lock held by a live PID and leaves it byte-identical", async () => {
    writeLock({ pid: process.pid, started: Date.now(), holder: "other" });
    const before = fs.readFileSync(lockPath());
    const lock = await acquireEmbedLock(projectRoot, { holder: "test-holder" });
    expect(lock.acquired).toBe(false);
    expect(lock.pid).toBe(process.pid);
    expect(lock.started).toBeDefined();
    expect(fs.readFileSync(lockPath()).equals(before)).toBe(true);
  });

  it("cleans up a dead-PID lock and acquires", async () => {
    writeLock({ pid: DEAD_PID, started: Date.now() });
    const lock = await acquireEmbedLock(projectRoot, { holder: "test-holder" });
    expect(lock.acquired).toBe(true);
    expect(readLock().pid).toBe(process.pid);
    await lock.release();
  });

  it("release() does not delete a lock rewritten by a different holder", async () => {
    const lock = await acquireEmbedLock(projectRoot, { holder: "holder-a" });
    expect(lock.acquired).toBe(true);
    writeLock({ pid: process.pid, started: Date.now(), holder: "holder-b" });
    await lock.release();
    expect(fs.existsSync(lockPath())).toBe(true);
    expect(readLock().holder).toBe("holder-b");
  });

  it("release() does not delete a lock rewritten with the same holder label (ownership is the nonce)", async () => {
    const lock = await acquireEmbedLock(projectRoot, { holder: "same-label" });
    expect(lock.acquired).toBe(true);
    const original = readLock();
    expect(typeof original.nonce).toBe("string"); // positive control: the record carries a nonce
    writeLock({ pid: process.pid, started: Date.now(), holder: "same-label", nonce: "another-acquire" });
    await lock.release();
    expect(fs.existsSync(lockPath())).toBe(true);
    expect(readLock().nonce).toBe("another-acquire");
  });
});

describe("runRagEmbed holds the embed lock", () => {
  it("the lock exists and names process.pid while embed() runs", async () => {
    let seen = null;
    embedImpl = async () => {
      seen = fs.existsSync(lockPath()) ? readLock() : null;
      return { ok: true, indexed: 0 };
    };
    await runRagEmbed(projectRoot, {});
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(seen).not.toBeNull();
    expect(seen.pid).toBe(process.pid);
  });

  it("a second runRagEmbed during the window is refused and does not call embed()", async () => {
    let depth = 0;
    let inner = null;
    embedImpl = async () => {
      depth += 1;
      if (depth === 1) inner = await runRagEmbed(projectRoot, {});
      return { ok: true, indexed: 0 };
    };
    await runRagEmbed(projectRoot, {});
    expect(inner).toMatchObject({ ok: false, locked: true });
    expect(embedMock).toHaveBeenCalledTimes(1);
  });

  it("a runRagReset during the window is refused, does not call reset(), and leaves the manifest bytes unchanged", async () => {
    fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
    fs.writeFileSync(manifestPath(), JSON.stringify({ hashes: { "notes/a.md": "abc" } }));
    const before = fs.readFileSync(manifestPath());
    let inner = null;
    let afterReset = null;
    embedImpl = async () => {
      inner = await runRagReset(projectRoot);
      afterReset = fs.readFileSync(manifestPath());
      return { ok: true, indexed: 0 };
    };
    await runRagEmbed(projectRoot, {});
    expect(embedMock).toHaveBeenCalledTimes(1); // positive control: the window was entered
    expect(inner).toMatchObject({ ok: false, locked: true });
    expect(resetMock).not.toHaveBeenCalled();
    expect(afterReset.equals(before)).toBe(true);
  });

  it("releases the lock after a successful embed", async () => {
    let held = false;
    embedImpl = async () => {
      held = fs.existsSync(lockPath());
      return { ok: true, indexed: 0 };
    };
    const res = await runRagEmbed(projectRoot, {});
    expect(held).toBe(true);
    expect(res?.locked).not.toBe(true);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("releases the lock after embed() returns ok: false", async () => {
    let held = false;
    embedImpl = async () => {
      held = fs.existsSync(lockPath());
      return { ok: false, error: "embed failed", indexed: 0 };
    };
    await runRagEmbed(projectRoot, {});
    expect(held).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("releases the lock after embed() throws", async () => {
    let held = false;
    embedImpl = async () => {
      held = fs.existsSync(lockPath());
      throw new Error("embed exploded");
    };
    await runRagEmbed(projectRoot, {}).catch(() => {});
    expect(held).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("a dead-PID lock is cleaned up and the embed proceeds", async () => {
    writeLock({ pid: DEAD_PID, started: Date.now() });
    const res = await runRagEmbed(projectRoot, {});
    expect(res?.locked).not.toBe(true);
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(lockPath())).toBe(false);
  });
});

describe("runRagReset holds the embed lock", () => {
  it("the lock names process.pid while reset() runs and is gone afterwards, including when reset() throws", async () => {
    let seen = null;
    resetImpl = async () => {
      seen = fs.existsSync(lockPath()) ? readLock() : null;
      return { ok: true, tableDropped: false, rowsBeforeReset: 0 };
    };
    const res = await runRagReset(projectRoot);
    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(res?.locked).not.toBe(true);
    expect(seen?.pid).toBe(process.pid);
    expect(fs.existsSync(lockPath())).toBe(false);

    resetImpl = async () => {
      throw new Error("reset exploded");
    };
    await runRagReset(projectRoot).catch(() => {});
    expect(resetMock).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(lockPath())).toBe(false);
  });
});
