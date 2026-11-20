/**
 * backlog.fix.rag-embed-lock-error-detail - when unreadableCode falls back to node:sqlite's generic
 * code (a regular non-database file at the embed lock path), the refusal carries SQLite's errcode and
 * errstr beside errorCode, and the embed, reset and compact refusal messages append them plus a remedy
 * naming the lock path. errorCode values, message prefixes and the busy refusal shape are unchanged,
 * and the lock file is never removed.
 *
 * node:sqlite is the real module; embed, reset and lancedb are mocked as in rag-embed-lock-acquire.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-embed-lock-error-detail.test.mjs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const embedMock = vi.fn(async () => ({ ok: true, indexed: 0 }));
const resetMock = vi.fn(async () => ({ ok: true, tableDropped: false, rowsBeforeReset: 0 }));
const connectMock = vi.fn(async () => ({
  openTable: vi.fn(async () => ({ optimize: vi.fn(async () => {}) })),
}));

vi.mock("@lancedb/lancedb", () => ({ connect: connectMock }));
// Mocked by repo-relative path so Vitest intercepts tools.mjs's sibling dynamic imports.
vi.mock("../../packages/rag/src/embed.mjs", () => ({ embed: embedMock }));
vi.mock("../../packages/rag/src/init.mjs", () => ({
  init: vi.fn(async () => ({ ok: true })),
  reset: resetMock,
}));
vi.mock("../../packages/rag/src/rag-config-loader.mjs", () => ({
  getRagPathsFor: vi.fn(async () => ({
    unified: "/tmp/rag-embed-lock-error-detail/unified",
    notes: "/tmp/rag-embed-lock-error-detail/notes",
    code: "/tmp/rag-embed-lock-error-detail/code",
    kg: "/tmp/rag-embed-lock-error-detail/kg",
  })),
  getRagConfigFor: vi.fn(async () => ({ config: {}, configPath: null })),
}));

const { runRagEmbed, runRagReset, runRagCompact } = await import("../../packages/rag/src/tools.mjs");
const { acquireEmbedLock, inspectEmbedLock, embedLockPath } = await import("../../packages/rag/src/embed-lock.mjs");

const NOT_A_DATABASE = Buffer.alloc(4096, "not a sqlite database\n");
const DETAIL_KEYS = ["errorCode", "errcode", "errstr"];

let projectRoot;
let open = [];
const lockPath = () => embedLockPath(projectRoot);

function seedNotADatabase() {
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(lockPath(), NOT_A_DATABASE);
}

function expectLockFileIntact() {
  expect(fs.statSync(lockPath()).isFile()).toBe(true);
  expect(fs.readFileSync(lockPath()).equals(NOT_A_DATABASE)).toBe(true);
}

/** The SQLite detail observed directly from acquireEmbedLock on the seeded file. */
function probeDetail() {
  const refused = acquireEmbedLock(projectRoot, { holder: "detail-probe" });
  expect(refused.acquired).toBe(false);
  expect(typeof refused.errcode).toBe("number");
  expect(typeof refused.errstr).toBe("string");
  return refused;
}

function expectDetailedMessage(error, prefix, refused) {
  expect(error.startsWith(prefix)).toBe(true);
  expect(error).toContain("ERR_SQLITE_ERROR");
  expect(error).toContain(String(refused.errcode));
  expect(error).toContain(refused.errstr);
  expect(error).toContain(lockPath());
}

beforeEach(() => {
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rag-embed-lock-error-detail-")));
  open = [];
  embedMock.mockClear();
  resetMock.mockClear();
  connectMock.mockClear();
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

describe("embed lock refusal carries SQLite errcode and errstr", () => {
  it("acquireEmbedLock over a non-database lock file refuses with ERR_SQLITE_ERROR, errcode 26 and errstr", () => {
    seedNotADatabase();
    const refused = acquireEmbedLock(projectRoot, { holder: "not-a-db" });
    expect(refused.acquired).toBe(false);
    expect(refused.errorCode).toBe("ERR_SQLITE_ERROR");
    expect(typeof refused.errcode).toBe("number");
    expect(refused.errcode & 0xff).toBe(26);
    expect(typeof refused.errstr).toBe("string");
    expect(refused.errstr.length).toBeGreaterThan(0);
    expectLockFileIntact();
  });

  it("inspectEmbedLock over a non-database lock file reports locked with the same errorCode, errcode and errstr", () => {
    seedNotADatabase();
    const refused = probeDetail();
    const status = inspectEmbedLock(projectRoot);
    expect(status.locked).toBe(true);
    expect(status.errorCode).toBe("ERR_SQLITE_ERROR");
    expect(status.errcode).toBe(refused.errcode);
    expect(status.errcode & 0xff).toBe(26);
    expect(status.errstr).toBe(refused.errstr);
    expect(status.errstr.length).toBeGreaterThan(0);
    expectLockFileIntact();
  });

  it("a directory at the lock path keeps errorCode EISDIR on acquire and inspect", () => {
    fs.mkdirSync(lockPath(), { recursive: true });
    expect(acquireEmbedLock(projectRoot, { holder: "over-dir" }).errorCode).toBe("EISDIR");
    expect(inspectEmbedLock(projectRoot).errorCode).toBe("EISDIR");
    expect(fs.statSync(lockPath()).isDirectory()).toBe(true);
  });

  it("a refusal from a live busy holder carries no errorCode, errcode or errstr", () => {
    const held = acquireEmbedLock(projectRoot, { holder: "busy-holder" });
    expect(held.acquired).toBe(true);
    open.push(held);
    const refused = acquireEmbedLock(projectRoot, { holder: "second" });
    expect(refused.acquired).toBe(false);
    expect(refused.pid).toBe(process.pid);
    const status = inspectEmbedLock(projectRoot);
    expect(status.locked).toBe(true);
    for (const key of DETAIL_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(refused, key), `refusal ${key}`).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(status, key), `inspect ${key}`).toBe(false);
    }
  });
});

describe("embed, reset and compact refusal messages append errcode, errstr and the lock path remedy", () => {
  it("runRagEmbed over a non-database lock file keeps its prefix, appends the detail and does not call embed", async () => {
    seedNotADatabase();
    const refused = probeDetail();
    const res = await runRagEmbed(projectRoot, {});
    expect(res).toMatchObject({ ok: false, locked: true });
    expectDetailedMessage(res.error, "Embed already in progress (PID: ", refused);
    expect(embedMock).not.toHaveBeenCalled();
    expectLockFileIntact();
  });

  it("runRagReset over a non-database lock file keeps its prefix, appends the detail and does not call reset", async () => {
    seedNotADatabase();
    const refused = probeDetail();
    const res = await runRagReset(projectRoot);
    expect(res).toMatchObject({ ok: false, locked: true });
    expectDetailedMessage(res.error, "Reset refused: embed lock held (PID: ", refused);
    expect(resetMock).not.toHaveBeenCalled();
    expectLockFileIntact();
  });

  it("runRagCompact over a non-database lock file keeps its prefix, appends the detail and does not connect", async () => {
    seedNotADatabase();
    const refused = probeDetail();
    const res = await runRagCompact(projectRoot);
    expect(res).toMatchObject({ ok: false, locked: true });
    expectDetailedMessage(res.error, "Compact refused: embed lock held (PID: ", refused);
    expect(connectMock).not.toHaveBeenCalled();
    expectLockFileIntact();
  });
});
