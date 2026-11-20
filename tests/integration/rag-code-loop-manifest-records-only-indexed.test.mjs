/**
 * Witness for backlog.fix.rag-code-loop-manifest-records-unindexed-code.
 *
 * The code-file loop in packages/rag/src/embed.mjs recorded `newHashes[relPath]` BEFORE
 * processCodeFile ran, so a code file that produced no rows (a caught exception, or
 * whitespace-only content) entered the manifest as indexed and every later run skipped it as
 * unchanged. The fix mirrors the note loop: hash only when rows were produced, otherwise join
 * `unindexedPaths` (neither hashed nor stale).
 *
 * THROW SEAM. processCodeFile catches every error and returns []. To reach that path
 * deterministically the shared embedding pipeline is wrapped: any chunk containing the marker
 * throws, every other chunk goes to the real STUB embedder. `state.throws` is the positive
 * control that the seam fired — if the mock does not intercept, the RED tests fail loudly
 * rather than passing vacuously.
 *
 * STUB EMBEDDER. The mode is a module-scope const, so the env is set before the first dynamic
 * import of embed.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { connect } from "@lancedb/lancedb";
import { makeTempDir, writeFile } from "../helpers/tmp.mjs";

const state = vi.hoisted(() => ({ marker: "__RKS_CODE_LOOP_THROW__", calls: 0, throws: 0 }));

vi.mock("@routekit/rag/embedding-pipeline", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getSharedEmbeddingPipeline: async () => {
      const real = await actual.getSharedEmbeddingPipeline();
      return async (text, opts) => {
        state.calls++;
        if (String(text).includes(state.marker)) {
          state.throws++;
          throw new Error("simulated code-file embed failure");
        }
        return real(text, opts);
      };
    },
  };
});

const NOTE = (title, body) => `---\ntitle: ${title}\n---\n\n${body}\n`;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const HEALTHY = "export const healthy = 'HEALTHY-CODE';\n";
const FLAKY_OK = "export const flaky = 'FLAKY-ORIGINAL';\n";
const FLAKY_THROWS = `export const flaky = '${state.marker}';\n`;

describe("the embed code loop hashes only code files that produced rows", { timeout: 120_000 }, () => {
  let projectRoot;
  let dbPath;

  beforeEach(() => {
    process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "stub";
    process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
    delete process.env.RKS_CODE_GLOB;
    delete process.env.ROUTEKIT_CODE_GLOB;
    delete process.env.RKS_RAG_SCOPE_MODE;
    delete process.env.RKS_RAG_RESET;
    state.calls = 0;
    state.throws = 0;
    projectRoot = makeTempDir("rag_code_loop_manifest");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "rag-code-loop", private: true }));
    writeFile(path.join(projectRoot, "notes", "kept.md"), NOTE("Kept", "a note that always indexes"));
    dbPath = path.join(projectRoot, ".rks", "rag", "lance", "notes.lance");
  });

  const run = async (opts = {}) => {
    const { embed } = await import("../../packages/rag/src/embed.mjs");
    return embed({ projectRoot, vault: path.join(projectRoot, "notes"), glob: "**/*", db: dbPath, ...opts });
  };

  const readHashes = () => {
    const p = path.join(projectRoot, ".rks", "rag", "embed-manifest.json");
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8")).hashes || {};
  };

  const hashKeyFor = (needle) => Object.keys(readHashes()).find((k) => k.includes(needle));

  const rowsFor = async (relPath) => {
    const db = await connect(dbPath);
    const table = await db.openTable("embeddings");
    return (await table.query().toArray()).filter((r) => r.path === relPath);
  };

  const outcomeFor = (res, needle) => (res.fileOutcomes || []).find((o) => o.file.includes(needle));

  it("RED at HEAD — a code file whose processing throws has no manifest entry", async () => {
    writeFile(path.join(projectRoot, "src", "healthy.mjs"), HEALTHY);
    writeFile(path.join(projectRoot, "src", "flaky.mjs"), FLAKY_THROWS);

    const res = await run();

    expect(res.ok).toBe(true);
    expect(state.throws).toBeGreaterThan(0); // positive control — the throw seam fired
    expect(readHashes()["src/healthy.mjs"]).toBeTruthy(); // positive control — code files ARE hashed
    expect(readHashes()["src/flaky.mjs"]).toBeUndefined();
  });

  it("RED at HEAD — the throwing file is processed again next run over byte-identical content", async () => {
    writeFile(path.join(projectRoot, "src", "flaky.mjs"), FLAKY_THROWS);
    await run();
    expect(state.throws).toBeGreaterThan(0); // positive control

    state.throws = 0;
    await run();

    // Retried, not skipped as unchanged.
    expect(state.throws).toBeGreaterThan(0);
    expect(readHashes()["src/flaky.mjs"]).toBeUndefined();
  });

  it("a code file indexed earlier that throws on a later full walk keeps its existing rows", async () => {
    const flaky = path.join(projectRoot, "src", "flaky.mjs");
    const other = path.join(projectRoot, "src", "other.mjs");
    writeFile(flaky, FLAKY_OK);
    writeFile(other, "export const other = 1;\n");
    expect((await run()).ok).toBe(true);
    const before = await rowsFor("src/flaky.mjs");
    expect(before.some((r) => String(r.text).includes("FLAKY-ORIGINAL"))).toBe(true); // positive control

    // Second full walk: flaky now throws. `other` changes too, so rows are written and the
    // stale-deletion path is reached rather than short-circuited by the no-changes return.
    writeFile(flaky, FLAKY_THROWS);
    writeFile(other, "export const other = 2;\n");
    const res = await run();
    expect(res.ok).toBe(true);
    expect(state.throws).toBeGreaterThan(0);

    const after = await rowsFor("src/flaky.mjs");
    expect(after.some((r) => String(r.text).includes("FLAKY-ORIGINAL"))).toBe(true);
    expect(readHashes()["src/flaky.mjs"]).toBeUndefined();
  });

  it("a code file that produced rows has its SHA256 content hash in the manifest", async () => {
    writeFile(path.join(projectRoot, "src", "healthy.mjs"), HEALTHY);
    await run();
    expect(readHashes()["src/healthy.mjs"]).toBe(sha256(HEALTHY));
  });

  it("a second run over an unchanged, indexed corpus skips every code file and embeds nothing", async () => {
    writeFile(path.join(projectRoot, "src", "healthy.mjs"), HEALTHY);
    writeFile(path.join(projectRoot, "src", "also.mjs"), "export const also = 'ALSO';\n");
    const first = await run();
    expect(first.ok).toBe(true);
    expect(state.calls).toBeGreaterThan(0); // positive control — run 1 embedded

    state.calls = 0;
    const second = await run();
    expect(second.ok).toBe(true);
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("no-changes");
    expect(state.calls).toBe(0);
  });

  it("a whitespace-only code file is not hashed and costs no embedding work on re-run", async () => {
    writeFile(path.join(projectRoot, "src", "blank.mjs"), "   \n\n");
    await run();
    expect(readHashes()["src/blank.mjs"]).toBeUndefined();

    state.calls = 0;
    await run();
    expect(state.calls).toBe(0);
    expect(readHashes()["src/blank.mjs"]).toBeUndefined();
  });

  it("the note loop is unchanged — an indexed note is hashed and reported 'unchanged' on re-run", async () => {
    const first = await run();
    expect(outcomeFor(first, "kept.md").embedded).toBe(true);

    const second = await run();
    const kept = outcomeFor(second, "kept.md");
    expect(kept.embedded).toBe(false);
    expect(kept.reason).toBe("unchanged");
    expect(hashKeyFor("kept.md")).toBeTruthy();
  });
});

describe("computeManifestUpdate — code-file paths take the same three dispositions", () => {
  it("an unindexed code path is neither hashed nor stale; a vanished code path is still stale", async () => {
    const { computeManifestUpdate } = await import("../../packages/rag/src/embed.mjs");
    const out = computeManifestUpdate({
      priorHashes: { "src/flaky.mjs": "old", "src/gone.mjs": "old", "src/ok.mjs": "h" },
      newHashes: { "src/ok.mjs": "h" },
      unindexed: new Set(["src/flaky.mjs"]),
    });

    expect(out.stale).toEqual(["src/gone.mjs"]);
    expect(out.hashes["src/flaky.mjs"]).toBeUndefined();
    expect(out.hashes["src/ok.mjs"]).toBe("h");
  });
});
