import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// backlog.feat.rag-module-import-redirect — the RAG consumers now import from the shipped barrel
// packages/mcp-rks/src/rag/index.mjs instead of reaching into individual rag/ modules. Behavior-
// preserving (export * identity). This suite pins the redirect, guards the circular-import risk,
// and enforces that the barrel is the SOLE import surface for the barrel'd modules outside rag/.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = resolve(ROOT, "packages/mcp-rks/src");
const read = (rel) => readFileSync(resolve(SRC, rel), "utf8");

const REDIRECTED = [
  "rag-context.mjs", "server.mjs",
  "server/planner.mjs", "server/exec.mjs", "server/review.mjs",
  "server/planner-context.mjs", "server/planner-preflight.mjs", "server/planner-utils.mjs",
  "server/story-validator-v2.mjs",
  "agents/dendron.mjs", "agents/planner.mjs", "agents/product-owner.mjs", "agents/research.mjs",
  "shared/commit-and-embed.mjs",
];
const BARRELED = ["tools", "embedding-pipeline", "rag-columns", "hybrid-search", "fidelity-filter", "query-intent", "source-classifier", "notes-chunker"];
const deepImportRe = new RegExp(`rag/(${BARRELED.join("|")})\\.mjs`);
const EXCLUSIONS = ["server/orchestrator.mjs", "server/guardrails-audit.mjs"];

function walkMjs(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMjs(p, acc);
    else if (e.name.endsWith(".mjs")) acc.push(p);
  }
  return acc;
}

describe("RAG import redirect — consumers route through the barrel", () => {
  it("every redirected consumer imports RAG symbols from the ../rag barrel and holds no deep rag/ import", () => {
    for (const f of REDIRECTED) {
      const src = read(f);
      expect(src, `${f} should import from the rag barrel`).toMatch(/["'](\.\.?)\/rag\/index\.mjs["']/);
      expect(deepImportRe.test(src), `${f} still deep-imports a barrel'd rag module`).toBe(false);
    }
  });

  it("the barrel is the SOLE surface: no file under packages/mcp-rks/src (outside rag/) retains a deep import of a barrel'd module", () => {
    const offenders = walkMjs(SRC)
      .filter((p) => !p.includes(`${SRC}/rag/`)) // the barrel'd modules import each other — that's internal
      .map((p) => p.slice(SRC.length + 1))
      .filter((rel) => !EXCLUSIONS.includes(rel)) // orchestrator/guardrails-audit are confirmed non-redirects
      .filter((rel) => deepImportRe.test(readFileSync(resolve(SRC, rel), "utf8")));
    expect(offenders, "these still deep-import a barrel'd rag module").toEqual([]);
  });

  it("exclusions are untouched (not redirected onto the barrel)", () => {
    // orchestrator keeps its non-barrel'd deep imports (query-expander / reranker).
    expect(read("server/orchestrator.mjs")).toMatch(/rag\/(query-expander|reranker)/);
    // guardrails-audit only references scripts/rag path strings, never a barrel'd module import.
    expect(deepImportRe.test(read("server/guardrails-audit.mjs"))).toBe(false);
  });

  it("no circular import: the barrel resolves cleanly, and no barrel'd rag/ module imports the flagged consumer rag-context", async () => {
    const barrel = await import(pathToFileURL(resolve(SRC, "rag/index.mjs")).href);
    expect(barrel.runRagQuery).toBeTypeOf("function");
    for (const m of BARRELED) {
      const src = readFileSync(resolve(SRC, `rag/${m}.mjs`), "utf8");
      // an IMPORT (not a doc-comment) of rag-context by a barrel'd module would cycle via the barrel.
      expect(src, `rag/${m}.mjs imports rag-context (would cycle)`).not.toMatch(/from ["'][^"']*rag-context/);
      expect(src, `rag/${m}.mjs dynamic-imports rag-context (would cycle)`).not.toMatch(/import\(["'][^"']*rag-context/);
    }
  });

  it("behavior-preservation: symbols via the barrel are identical references to their source module (export * identity)", async () => {
    const barrel = await import(pathToFileURL(resolve(SRC, "rag/index.mjs")).href);
    const tools = await import(pathToFileURL(resolve(SRC, "rag/tools.mjs")).href);
    expect(barrel.runRagQuery).toBe(tools.runRagQuery);
    expect(barrel.runRagEmbed).toBe(tools.runRagEmbed);
  });
});
