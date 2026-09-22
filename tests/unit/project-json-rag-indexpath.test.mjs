/**
 * backlog.fix.keyless-rag-uat-quickfixes — AC1
 *
 * `.rks/project.json` advertised `rag.indexPath: ".rks/rag/index.lance"`, a path that does not
 * exist (the real store is `.rks/rag/routekit-shell.lancedb`). The field is vestigial — proven not
 * read by any code (readers resolve the store via getRagPaths from .rks/rag/config.json) — so this
 * is a config-honesty correction: point it at the real store rather than a phantom path.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe(".rks/project.json rag.indexPath (AC1)", () => {
  it("points at the real store, not the non-existent index.lance", () => {
    const pj = JSON.parse(fs.readFileSync(path.join(repoRoot, ".rks", "project.json"), "utf8"));
    expect(pj.rag.indexPath).toBe(".rks/rag/routekit-shell.lancedb");
    expect(pj.rag.indexPath).not.toBe(".rks/rag/index.lance");
  });
});
