/**
 * backlog.fix.rag-autocompact-noop-embed-guard — post-embed auto-compact guard.
 *
 * The embeddings table is created LAZILY, so a run that indexed nothing leaves no table and
 * the unconditional post-embed `db.openTable("embeddings")` rejects with
 * `Table 'embeddings' was not found`. The surrounding try/catch swallows it into
 * `[rag.tools] auto-compact failed: ...` — an operator-facing error line for a non-failure.
 *
 * The guard is on the embed RESULT CONTRACT: `indexed === 0`. That predicate is true in
 * exactly the two absent-table shapes and false in exactly the two present-table shapes:
 *
 *   A1 no-changes, populated   indexed > 0, table present -> COMPACT (version pruning)
 *   A2 no-changes, no table    indexed === 0, absent      -> SKIP
 *   B  pruned empty corpus     indexed === 0, just dropped-> SKIP   (no `skipped` field!)
 *   C  wrote data              indexed > 0, present       -> COMPACT
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs \
 *     tests/unit/rag-autocompact-noop-guard.test.mjs tests/unit/rag-tools.test.mjs \
 *     tests/unit/rag-mcp-surface-consolidation.test.mjs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const TOOLS_SRC = path.join(REPO_ROOT, "packages", "rag", "src", "tools.mjs");
const EMBED_SRC = path.join(REPO_ROOT, "packages", "rag", "src", "embed.mjs");

// --- mock state (module scope; clearMocks resets spies, not plain values) ---
let embedResult = { ok: true, indexed: 0 };
let openTableBehavior = "ok";

const optimizeMock = vi.fn().mockResolvedValue(undefined);
const openTableMock = vi.fn(async () => {
  if (openTableBehavior === "not-found") {
    throw new Error("Table 'embeddings' was not found");
  }
  if (openTableBehavior === "boom") {
    throw new Error("disk exploded");
  }
  return { optimize: optimizeMock };
});
const connectMock = vi.fn(async () => ({ openTable: openTableMock }));

vi.mock("@lancedb/lancedb", () => ({ connect: connectMock }));

// Mocked by repo-relative path so Vitest intercepts tools.mjs's sibling
// `await import("./embed.mjs")` — both specifiers resolve to the same module id.
vi.mock("../../packages/rag/src/embed.mjs", () => ({
  embed: vi.fn(async () => embedResult),
}));

vi.mock("../../packages/rag/src/rag-config-loader.mjs", () => ({
  getRagPathsFor: vi.fn(async () => ({
    unified: "/tmp/rag-noop-guard/unified",
    notes: "/tmp/rag-noop-guard/notes",
    code: "/tmp/rag-noop-guard/code",
    kg: "/tmp/rag-noop-guard/kg",
  })),
  getRagConfigFor: vi.fn(async () => ({ config: {}, configPath: null })),
}));

const { runRagEmbed } = await import("../../packages/rag/src/tools.mjs");

let projectRoot;
let errSpy;

beforeEach(() => {
  // Temp projectRoot — runRagEmbed writes .rks/rag/last-embed.json under it. The live
  // .lancedb / embed-manifest.json / last-embed.json must never be touched.
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-noop-guard-"));
  openTableBehavior = "ok";
  embedResult = { ok: true, indexed: 0 };
  connectMock.mockClear();
  openTableMock.mockClear();
  optimizeMock.mockClear();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

/** Every console.error line emitted by the auto-compact block. */
function autoCompactErrors() {
  return errSpy.mock.calls
    .map((c) => String(c[0] ?? ""))
    .filter((m) => /auto-compact failed/.test(m));
}

describe("auto-compact guard — no-op embeds stay silent", () => {
  it("SIGNAL: shape A2 (no-changes, no table) emits no auto-compact error", async () => {
    embedResult = { ok: true, skipped: true, reason: "no-changes", indexed: 0 };
    openTableBehavior = "not-found";

    await runRagEmbed(projectRoot, {});

    // Decisive: asserting merely that it did not throw is insufficient — the pre-existing
    // try/catch already prevents the throw. The noise is the defect.
    expect(autoCompactErrors()).toEqual([]);
  });

  it("SIGNAL: shape A2 never even opens a connection", async () => {
    embedResult = { ok: true, skipped: true, reason: "no-changes", indexed: 0 };
    openTableBehavior = "not-found";

    await runRagEmbed(projectRoot, {});

    // Proves the block was SKIPPED, not attempted-and-silenced.
    expect(connectMock).not.toHaveBeenCalled();
    expect(openTableMock).not.toHaveBeenCalled();
    expect(optimizeMock).not.toHaveBeenCalled();
  });

  it("PREDICATE shape B: pruned empty corpus has NO `skipped` field and must still skip", async () => {
    // This is the case a `skipped === true`-only guard misses entirely: the table was just
    // dropped, and the return carries no `skipped` field, so such a guard would attempt
    // compaction and the spurious error would persist.
    embedResult = { ok: true, indexed: 0, mode: "prune", reset: true };
    openTableBehavior = "not-found";

    await runRagEmbed(projectRoot, {});

    expect(embedResult.skipped).toBeUndefined();
    expect(autoCompactErrors()).toEqual([]);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("FIRST-RUN / FRESH CLONE: an empty first embed emits zero auto-compact output", async () => {
    embedResult = { ok: true, skipped: true, reason: "no-changes", indexed: 0, processedNotes: 0 };
    openTableBehavior = "not-found";

    await runRagEmbed(projectRoot, {});

    expect(autoCompactErrors()).toEqual([]);
  });
});

describe("auto-compact guard — compaction still runs when it should", () => {
  it("PREDICATE shape A1: no-changes against a POPULATED store still compacts", async () => {
    // An over-broad `skipped`-based guard would wrongly skip here and silently disable the
    // version-pruning added by backlog.fix.rag-embed-bloat-cleanup.
    embedResult = { ok: true, skipped: true, reason: "no-changes", indexed: 42 };

    await runRagEmbed(projectRoot, {});

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(openTableMock).toHaveBeenCalledWith("embeddings");
    expect(optimizeMock).toHaveBeenCalledTimes(2);
    expect(autoCompactErrors()).toEqual([]);
  });

  it("POSITIVE PATH shape C: a successful embed compacts then prunes, in that order", async () => {
    embedResult = { ok: true, indexed: 12, addedEmbeddings: 12 };

    await runRagEmbed(projectRoot, {});

    expect(optimizeMock).toHaveBeenCalledTimes(2);
    expect(optimizeMock.mock.calls[0][0]).toEqual({ compaction: true });
    expect(optimizeMock.mock.calls[1][0]).toHaveProperty("cleanupOlderThan");
    expect(optimizeMock.mock.calls[1][0].cleanupOlderThan).toBeInstanceOf(Date);
  });

  it("FAIL TOWARD REPORTING: a malformed result with no `indexed` still ATTEMPTS compaction", async () => {
    embedResult = { ok: true }; // contract drift — `indexed` absent
    openTableBehavior = "boom";

    await runRagEmbed(projectRoot, {});

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(autoCompactErrors().join("\n")).toMatch(/auto-compact failed/);
  });
});

describe("auto-compact guard — real failures are still reported", () => {
  it("DO NOT SUPPRESS REAL FAILURES: an arbitrary optimize error is still logged", async () => {
    embedResult = { ok: true, indexed: 7 };
    openTableBehavior = "boom";

    await runRagEmbed(projectRoot, {});

    const errs = autoCompactErrors().join("\n");
    expect(errs).toMatch(/auto-compact failed/);
    expect(errs).toContain("disk exploded");
  });

  it("RESIDUAL CASE: indexed > 0 but the table is missing IS reported, not swallowed", async () => {
    // This is the assertion that distinguishes the result-contract guard from a
    // db.tableNames() existence check — the latter would silently hide this genuine defect.
    embedResult = { ok: true, indexed: 9 };
    openTableBehavior = "not-found";

    await runRagEmbed(projectRoot, {});

    const errs = autoCompactErrors().join("\n");
    expect(errs).toMatch(/auto-compact failed/);
    expect(errs).toContain("Table 'embeddings' was not found");
  });
});

describe("auto-compact guard — source contracts", () => {
  const toolsSrc = fs.readFileSync(TOOLS_SRC, "utf8");

  it("NO STRING-MATCHING: the catch block has no conditional on the error text", () => {
    const start = toolsSrc.indexOf("Auto-compact: compact fragments");
    const end = toolsSrc.indexOf("Clean up legacy lance/ directory");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = toolsSrc.slice(start, end);
    // The literal may appear in explanatory comments; it must not appear in code.
    const code = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/was not found/);
    expect(code).not.toMatch(/e\?\.message\s*[.=]==|includes\(/);

    // ...and the reporting line is retained verbatim.
    expect(block).toContain(
      "console.error(`[rag.tools] auto-compact failed: ${e?.message}`);",
    );
  });

  it("OUT OF SCOPE PIN: the manual runRagCompact path still opens the table unconditionally", () => {
    // The guard applies ONLY to the post-embed block. runRagCompact rethrows rather than
    // swallowing, and is deliberately untouched.
    const compactIdx = toolsSrc.indexOf("export async function runRagCompact");
    expect(compactIdx).toBeGreaterThan(-1);
    const compactBody = toolsSrc.slice(compactIdx, compactIdx + 2000);
    expect(compactBody).toContain('openTable("embeddings")');
    expect(compactBody).not.toContain("indexed === 0");
  });

  it("CONTRACT PIN (embed.mjs): both zero-work returns still carry a numeric `indexed`", () => {
    const embedSrc = fs.readFileSync(EMBED_SRC, "utf8");

    // Shape A — no-changes: skipped:true AND a numeric indexed.
    expect(embedSrc).toMatch(/skipped:\s*true/);
    expect(embedSrc).toMatch(/reason:\s*["']no-changes["']/);
    expect(embedSrc).toMatch(/indexed:\s*existingCount/);

    // Shape B — pruned empty corpus: indexed: 0 literal.
    expect(embedSrc).toMatch(/indexed:\s*0\s*,/);

    // existingCount defaults to 0 and is only raised when the table opens, so the
    // absent-table case genuinely reports 0.
    expect(embedSrc).toMatch(/let existingCount = 0;/);
  });
});
