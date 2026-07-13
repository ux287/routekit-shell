import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { makeTempDir, writeFile } from "../helpers/tmp.mjs";

describe("rag embed (upsert/scoping)", { timeout: 60_000 }, () => {
  beforeEach(() => {
    process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "stub";
    process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
    delete process.env.RKS_CODE_GLOB;
    delete process.env.ROUTEKIT_CODE_GLOB;
    delete process.env.RKS_RAG_SCOPE_MODE;
    delete process.env.RKS_RAG_RESET;
  });

  it("is idempotent (re-embed does not increase row count)", async () => {
    const projectRoot = makeTempDir("rag_project");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "rag-project", private: true }, null, 2));
    writeFile(path.join(projectRoot, "notes", "test.note.md"), "---\ntitle: Test\n---\n\nHello world\n");
    writeFile(path.join(projectRoot, "src", "_includes", "layouts", "hero.njk"), "<h1>{{ title }}</h1>\n");

    const dbPath = path.join(projectRoot, ".rks", "rag", "lance", "notes.lance");
    process.env.RKS_RAG_SCOPE_MODE = "append";

    const { embed } = await import("../../scripts/rag/embed.mjs");

    const run1 = await embed({ projectRoot, vault: path.join(projectRoot, "notes"), glob: "**/*", db: dbPath });
    const run2 = await embed({ projectRoot, vault: path.join(projectRoot, "notes"), glob: "**/*", db: dbPath });

    expect(run1.ok).toBe(true);
    expect(run2.ok).toBe(true);
    expect(run2.indexed).toBe(run1.indexed);
  });

  it("supports prune via reset-and-rebuild when scope changes", async () => {
    const projectRoot = makeTempDir("rag_project_prune");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "rag-project-prune", private: true }, null, 2));
    writeFile(path.join(projectRoot, "notes", "test.note.md"), "---\ntitle: Test\n---\n\nHello world\n");
    writeFile(path.join(projectRoot, "src", "_includes", "layouts", "hero.njk"), "<h1>{{ title }}</h1>\n");

    const dbPath = path.join(projectRoot, ".rks", "rag", "lance", "notes.lance");
    const { embed } = await import("../../scripts/rag/embed.mjs");

    process.env.RKS_RAG_SCOPE_MODE = "append";
    const run1 = await embed({ projectRoot, vault: path.join(projectRoot, "notes"), glob: "**/*", db: dbPath });
    expect(run1.ok).toBe(true);

    // Narrow scope by excluding code globs entirely, and prune (drop/rebuild).
    process.env.RKS_CODE_GLOB = "does-not-match-anything/**/*";
    process.env.RKS_RAG_SCOPE_MODE = "prune";
    const run2 = await embed({ projectRoot, vault: path.join(projectRoot, "notes"), glob: "**/*", db: dbPath });
    expect(run2.ok).toBe(true);
    expect(run2.indexed).toBeLessThan(run1.indexed);
  });

  it("writes embeddings table to the project-local db path", async () => {
    const projectRoot = makeTempDir("rag_project_db");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "rag-project-db", private: true }, null, 2));
    writeFile(path.join(projectRoot, "notes", "test.note.md"), "---\ntitle: Test\n---\n\nHello world\n");

    const dbPath = path.join(projectRoot, ".rks", "rag", "lance", "notes.lance");
    const { embed } = await import("../../scripts/rag/embed.mjs");
    const run = await embed({ projectRoot, vault: path.join(projectRoot, "notes"), glob: "**/*", db: dbPath });

    expect(run.ok).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("ignores vendored toolchains and common artifacts from code candidates", async () => {
    const projectRoot = makeTempDir("rag_project_ignores");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "rag-project-ignores", private: true }, null, 2));
    writeFile(path.join(projectRoot, "notes", "test.note.md"), "---\ntitle: Test\n---\n\nHello world\n");

    writeFile(path.join(projectRoot, "src", "app.js"), "console.log('ok');\n");
    writeFile(path.join(projectRoot, "tools", "routekit-shell", "packages", "cli", "bin", "routekit.js"), "console.log('vendored');\n");
    writeFile(path.join(projectRoot, "node_modules", "pkg", "index.js"), "console.log('deps');\n");
    writeFile(path.join(projectRoot, ".rks", "rag", "tmp.js"), "console.log('rag');\n");
    writeFile(path.join(projectRoot, "public", "index.html"), "<h1>public</h1>\n");

    const prev = process.env.ROUTEKIT_PROJECT_ROOT;
    process.env.ROUTEKIT_PROJECT_ROOT = projectRoot;
    try {
      const { listRagCodeEmbedCandidates } = await import("../../scripts/rag/embed.mjs");
      const candidates = await listRagCodeEmbedCandidates({ projectRoot, codeGlob: "**/*.{js,html}" });

      expect(candidates).toContain("src/app.js");
      expect(candidates.some((p) => p.startsWith("tools/"))).toBe(false);
      expect(candidates.some((p) => p.startsWith("node_modules/"))).toBe(false);
      expect(candidates.some((p) => p.startsWith(".rks/"))).toBe(false);
      expect(candidates.some((p) => p.startsWith("public/"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
      else process.env.ROUTEKIT_PROJECT_ROOT = prev;
    }
  });
});
