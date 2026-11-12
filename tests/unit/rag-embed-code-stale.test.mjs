// backlog.fix.rag-embed-server-stale-module-unreported: runRagEmbed reports when the embed code it
// loaded is older than the code on disk. The fingerprint directory is redirected to a temp dir through
// the __setEmbedCodeFingerprintDir seam, so no file under packages/rag/src/ is touched by this test.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const embedMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    indexed: 0,
    processedNotes: 1,
    processedCodeFiles: 0,
    addedEmbeddings: 0,
    removedEmbeddings: 0,
    totalEmbeddings: 0,
  })),
);

const loadFail = vi.hoisted(() => ({ on: false }));

vi.mock("../../packages/rag/src/embed.mjs", () => {
  if (loadFail.on) throw new Error("simulated embed.mjs load failure");
  return { embed: embedMock };
});
vi.mock("../../packages/rag/src/rag-config-loader.mjs", () => ({
  getRagPathsFor: vi.fn(async (root) => ({ notes: `${root}/.rks/rag/db` })),
}));
vi.mock("@lancedb/lancedb", () => ({
  connect: vi.fn(async () => {
    throw new Error("lancedb is not used when indexed === 0");
  }),
}));

let projectRoot;
let codeDir;
let events;
let tools;

function setMtime(file, ms) {
  fs.utimesSync(file, ms / 1000, ms / 1000);
}

function embedEvents() {
  return events.filter((e) => e.type === "rag.embed");
}

function failedEvents() {
  return events.filter((e) => e.type === "rag.embed.failed");
}

beforeEach(async () => {
  loadFail.on = false;
  vi.resetModules();
  embedMock.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-embed-stale-proj-"));
  codeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-embed-stale-code-"));
  const base = Date.now() - 60_000;
  for (const name of ["embed.mjs", "utils.mjs"]) {
    const file = path.join(codeDir, name);
    fs.writeFileSync(file, "export {};\n");
    setMtime(file, base);
  }
  events = [];
  tools = await import("../../packages/rag/src/tools.mjs");
  tools.setRagHostHooks({
    getTelemetryCollector: () => ({
      emit: (type, _projectId, payload) => events.push({ type, payload }),
    }),
  });
  tools.__setEmbedCodeFingerprintDir(codeDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(codeDir, { recursive: true, force: true });
});

describe("runRagEmbed embed-code staleness", () => {
  it("reports embedCodeStale true with both timestamps and a restart warning after a newer .mjs mtime", async () => {
    await tools.runRagEmbed(projectRoot);
    setMtime(path.join(codeDir, "embed.mjs"), Date.now() + 5_000);
    const res = await tools.runRagEmbed(projectRoot);
    expect(res.embedCodeStale).toBe(true);
    expect(Number.isNaN(Date.parse(res.embedCodeMtimeAtLoad))).toBe(false);
    expect(Number.isNaN(Date.parse(res.embedCodeOnDiskAt))).toBe(false);
    expect(Date.parse(res.embedCodeOnDiskAt)).toBeGreaterThan(Date.parse(res.embedCodeMtimeAtLoad));
    expect(res.warning).toMatch(/restart/i);
    expect(res.warning).toMatch(/MCP server/i);
  });

  it("reports embedCodeStale false when nothing changed on disk since load", async () => {
    const first = await tools.runRagEmbed(projectRoot);
    const second = await tools.runRagEmbed(projectRoot);
    expect(first.embedCodeStale).toBe(false);
    expect(second.embedCodeStale).toBe(false);
  });

  it("carries the same embedCodeStale value on the rag.embed telemetry event as on the result", async () => {
    const fresh = await tools.runRagEmbed(projectRoot);
    setMtime(path.join(codeDir, "utils.mjs"), Date.now() + 5_000);
    const stale = await tools.runRagEmbed(projectRoot);
    const evs = embedEvents();
    expect(evs).toHaveLength(2);
    expect(evs[0].payload.embedCodeStale).toBe(fresh.embedCodeStale);
    expect(evs[1].payload.embedCodeStale).toBe(stale.embedCodeStale);
    expect(evs[1].payload.embedCodeStale).toBe(true);
  });

  it("still performs a stale embed and keeps its ok value", async () => {
    await tools.runRagEmbed(projectRoot);
    setMtime(path.join(codeDir, "embed.mjs"), Date.now() + 5_000);
    const res = await tools.runRagEmbed(projectRoot);
    expect(embedMock).toHaveBeenCalledTimes(2);
    expect(res.embedCodeStale).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.processedNotes).toBe(1);
  });

  it("reports embedCodeStale null with a reason when the fingerprint cannot be computed", async () => {
    tools.__setEmbedCodeFingerprintDir(path.join(codeDir, "does-not-exist"));
    const res = await tools.runRagEmbed(projectRoot);
    expect(res.ok).toBe(true);
    expect(res.embedCodeStale).toBeNull();
    expect(typeof res.embedCodeStaleReason).toBe("string");
    expect(res.embedCodeStaleReason.length).toBeGreaterThan(0);
    expect(typeof res.warning).toBe("string");
    expect(res.warning.length).toBeGreaterThan(0);
  });

  it("reports embedCodeStale null with a reason and keeps ok false and locked true when the embed lock is refused", async () => {
    // A live-PID lock refuses acquisition (precedent: tests/unit/rag-embed-lock-acquire.test.mjs:84-88 at @3d521279b).
    const lockFile = path.join(projectRoot, ".rks", "rag", ".embed-lock");
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started: Date.now(), holder: "other" }));
    const res = await tools.runRagEmbed(projectRoot);
    expect(res.ok).toBe(false);
    expect(res.locked).toBe(true);
    expect(embedMock).not.toHaveBeenCalled();
    expect(res.embedCodeStale).toBeNull();
    expect(typeof res.embedCodeStaleReason).toBe("string");
    expect(res.embedCodeStaleReason.length).toBeGreaterThan(0);
  });

  it("reports embedCodeStale null on the error result and the rag.embed.failed event when the embed code fails to load", async () => {
    loadFail.on = true;
    // The hoisted vi.mock factory's result is cached across vi.resetModules(), so re-register the
    // same flag-driven factory to make this call's ./embed.mjs import evaluate it again and reject.
    // It returns the normal mock once loadFail.on is reset, so later tests are unaffected.
    vi.doMock("../../packages/rag/src/embed.mjs", () => {
      if (loadFail.on) throw new Error("simulated embed.mjs load failure");
      return { embed: embedMock };
    });
    const res = await tools.runRagEmbed(projectRoot);
    expect(res.ok).toBe(false);
    expect(embedMock).not.toHaveBeenCalled();
    expect(res.embedCodeStale).toBeNull();
    expect(typeof res.embedCodeStaleReason).toBe("string");
    expect(res.embedCodeStaleReason.length).toBeGreaterThan(0);
    const failed = failedEvents();
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.embedCodeStale).toBeNull();
  });

  it("carries embedCodeStale false on the error result and the rag.embed.failed event when embed throws with no on-disk change", async () => {
    // The comparison runs after ./embed.mjs loads and before embed() is called, so a throw from
    // embed() itself carries the observed value; nothing in codeDir changed since the baseline.
    embedMock.mockRejectedValueOnce(new Error("simulated embed failure"));
    const res = await tools.runRagEmbed(projectRoot);
    expect(res.ok).toBe(false);
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(res.embedCodeStale).toBe(false);
    const failed = failedEvents();
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.embedCodeStale).toBe(false);
  });

  it("names the load-time fingerprint embedCodeMtimeAtLoad and emits no embedCodeLoadedAt field", async () => {
    await tools.runRagEmbed(projectRoot);
    setMtime(path.join(codeDir, "embed.mjs"), Date.now() + 5_000);
    const res = await tools.runRagEmbed(projectRoot);
    expect(res.embedCodeStale).toBe(true);
    expect(res).toHaveProperty("embedCodeMtimeAtLoad");
    expect(res).not.toHaveProperty("embedCodeLoadedAt");
    for (const e of events) expect(e.payload ?? {}).not.toHaveProperty("embedCodeLoadedAt");
  });

  it("keeps the ./embed.mjs dynamic import specifier unchanged", () => {
    const src = fs.readFileSync(path.resolve("packages/rag/src/tools.mjs"), "utf8");
    expect(src).toContain('const { embed } = await import("./embed.mjs");');
  });

  it("re-takes the baseline when __setEmbedCodeFingerprintDir is called, so earlier edits are not stale", async () => {
    // utils.mjs is modified AFTER the beforeEach seam call but BEFORE this second seam call.
    setMtime(path.join(codeDir, "utils.mjs"), Date.now() - 1_000);
    tools.__setEmbedCodeFingerprintDir(codeDir);
    const first = await tools.runRagEmbed(projectRoot);
    expect(first.embedCodeStale).toBe(false);
    setMtime(path.join(codeDir, "utils.mjs"), Date.now() + 5_000);
    const second = await tools.runRagEmbed(projectRoot);
    expect(second.embedCodeStale).toBe(true);
  });

  it("imports tools.mjs without throwing when the default fingerprint directory cannot be read", async () => {
    // Fails the directory listing of packages/rag/src/ only; no file there is touched. If the
    // implementation lists the directory through a different fs call, Build may widen the spy to
    // that call, keeping this title and these assertions.
    const ragSrc = path.resolve("packages/rag/src");
    const realReaddirSync = fs.readdirSync;
    const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementation((p, ...rest) => {
      if (path.resolve(String(p)) === ragSrc) {
        const err = new Error("simulated EACCES");
        err.code = "EACCES";
        throw err;
      }
      return realReaddirSync(p, ...rest);
    });
    vi.resetModules();
    let fresh;
    await expect(
      (async () => {
        fresh = await import("../../packages/rag/src/tools.mjs");
      })(),
    ).resolves.toBeUndefined();
    // ARCH advisory: restore the listing before runRagEmbed. With a module-evaluation baseline the
    // failed listing is already recorded, so the result stays null; a lazy first-call baseline
    // would list successfully here and report false.
    readdirSpy.mockRestore();
    fresh.setRagHostHooks({
      getTelemetryCollector: () => ({
        emit: (type, _projectId, payload) => events.push({ type, payload }),
      }),
    });
    const res = await fresh.runRagEmbed(projectRoot);
    expect(res.ok).toBe(true);
    expect(res.embedCodeStale).toBeNull();
    expect(typeof res.embedCodeStaleReason).toBe("string");
    expect(res.embedCodeStaleReason.length).toBeGreaterThan(0);
    expect(typeof res.warning).toBe("string");
    expect(res.warning.length).toBeGreaterThan(0);
  });
});
