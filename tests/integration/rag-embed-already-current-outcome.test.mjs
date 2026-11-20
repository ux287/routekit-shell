/**
 * Witness for backlog.fix.rag-embed-unchanged-outcome-legibility (producer half).
 * An unchanged file's outcome must say it is already current, at BOTH recording sites
 * (note loop and code loop), and no other outcome may carry the flag.
 * Stub embedder: env set before the dynamic import (see rag-embed-per-file-outcomes.test.mjs).
 */
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { makeTempDir, writeFile } from "../helpers/tmp.mjs";

const NOTE = (title, body) => `---\ntitle: ${title}\n---\n\n${body}\n`;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

describe("rks_rag_embed marks an already-current file plainly", { timeout: 120_000 }, () => {
  let projectRoot;
  let dbPath;

  beforeEach(() => {
    process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "stub";
    process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
    delete process.env.RKS_CODE_GLOB;
    delete process.env.ROUTEKIT_CODE_GLOB;
    delete process.env.RKS_RAG_CODE_GLOB;
    delete process.env.RKS_RAG_SCOPE_MODE;
    delete process.env.RKS_RAG_RESET;
    projectRoot = makeTempDir("rag_already_current");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "rag-already-current", private: true }));
    dbPath = path.join(projectRoot, ".rks", "rag", "lance", "notes.lance");
  });

  const run = async (opts = {}) => {
    const { embed } = await import("../../packages/rag/src/embed.mjs");
    return embed({ projectRoot, vault: path.join(projectRoot, "notes"), glob: "**/*", db: dbPath, ...opts });
  };
  const outcomeFor = (res, rel) => (res.fileOutcomes || []).find((o) => o.file === rel);

  it("an unchanged note re-embedded by name is reported alreadyCurrent", async () => {
    writeFile(path.join(projectRoot, "notes", "stable.md"), NOTE("Stable", "unchanging"));
    expect(outcomeFor(await run(), "notes/stable.md")?.embedded).toBe(true); // positive control
    const second = await run({ files: ["notes/stable.md"] });
    expect(outcomeFor(second, "notes/stable.md")).toMatchObject({ embedded: false, reason: "unchanged", alreadyCurrent: true });
  });

  it("an unchanged code file is reported alreadyCurrent", async () => {
    writeFile(path.join(projectRoot, "src", "healthy.mjs"), "export const healthy = 'HEALTHY-CODE';\n");
    expect(outcomeFor(await run(), "src/healthy.mjs")?.embedded).toBe(true); // positive control
    const second = await run();
    expect(outcomeFor(second, "src/healthy.mjs")).toMatchObject({ embedded: false, reason: "unchanged", alreadyCurrent: true });
  });

  it("an embedded outcome carries no alreadyCurrent field", async () => {
    writeFile(path.join(projectRoot, "notes", "fresh.md"), NOTE("Fresh", "new content"));
    const o = outcomeFor(await run(), "notes/fresh.md");
    expect(o?.embedded).toBe(true);
    expect(has(o, "alreadyCurrent")).toBe(false);
  });

  it("not-selected and no-rows outcomes carry no alreadyCurrent field", async () => {
    writeFile(path.join(projectRoot, "src", "healthy.mjs"), "export const healthy = 'HEALTHY-CODE';\n");
    writeFile(path.join(projectRoot, "src", "blank.mjs"), "   \n\n");
    const full = await run();
    const blank = outcomeFor(full, "src/blank.mjs");
    expect(blank).toMatchObject({ embedded: false, reason: "no-rows" });
    expect(has(blank, "alreadyCurrent")).toBe(false);
    const scoped = await run({ files: ["package.json"] });
    const ignored = outcomeFor(scoped, "package.json");
    expect(ignored).toMatchObject({ embedded: false, reason: "not-selected" });
    expect(has(ignored, "alreadyCurrent")).toBe(false);
  });

  it("an excluded note outcome carries no alreadyCurrent field", async () => {
    writeFile(path.join(projectRoot, "notes", "optedout.md"), "---\ntitle: Opted\nrag: false\n---\n\nbody\n");
    const o = outcomeFor(await run(), "notes/optedout.md");
    expect(o).toMatchObject({ embedded: false, reason: "excluded" });
    expect(has(o, "alreadyCurrent")).toBe(false);
  });
});
