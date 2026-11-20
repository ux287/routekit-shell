/**
 * Witness for backlog.fix.rag-embed-result-file-outcomes-unbounded (code-loop half).
 * The code loop in packages/rag/src/embed.mjs must record a fileOutcome for every code file.
 */
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { makeTempDir, writeFile } from "../helpers/tmp.mjs";

const NOTE = (title, body) => `---\ntitle: ${title}\n---\n\n${body}\n`;

describe("embed() records fileOutcomes for code files", { timeout: 120_000 }, () => {
  let projectRoot;
  let dbPath;

  beforeEach(() => {
    process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "stub";
    process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
    delete process.env.RKS_CODE_GLOB;
    delete process.env.ROUTEKIT_CODE_GLOB;
    delete process.env.RKS_RAG_CODE_GLOB; // embed() reads this first; clear it so the default code walk applies
    delete process.env.RKS_RAG_SCOPE_MODE;
    delete process.env.RKS_RAG_RESET;
    projectRoot = makeTempDir("rag_code_file_outcomes");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "rag-code-outcomes", private: true }));
    writeFile(path.join(projectRoot, "notes", "kept.md"), NOTE("Kept", "a note that always indexes"));
    dbPath = path.join(projectRoot, ".rks", "rag", "lance", "notes.lance");
  });

  const run = async (opts = {}) => {
    const { embed } = await import("../../packages/rag/src/embed.mjs");
    return embed({ projectRoot, vault: path.join(projectRoot, "notes"), glob: "**/*", db: dbPath, ...opts });
  };
  const outcomeFor = (res, rel) => (res.fileOutcomes || []).find((o) => o.file === rel);

  it("a changed code file is recorded embedded: true", async () => {
    writeFile(path.join(projectRoot, "src", "healthy.mjs"), "export const healthy = 'HEALTHY-CODE';\n");
    const res = await run();
    expect(res.ok).toBe(true);
    expect(outcomeFor(res, "src/healthy.mjs")).toMatchObject({ embedded: true, reason: null });
  });

  it("an unchanged code file is recorded reason 'unchanged' on re-run", async () => {
    writeFile(path.join(projectRoot, "src", "healthy.mjs"), "export const healthy = 'HEALTHY-CODE';\n");
    expect(outcomeFor(await run(), "src/healthy.mjs")?.embedded).toBe(true); // positive control
    const second = await run();
    expect(outcomeFor(second, "src/healthy.mjs")).toMatchObject({ embedded: false, reason: "unchanged" });
  });

  it("a whitespace-only code file is recorded embedded: false with reason 'no-rows'", async () => {
    writeFile(path.join(projectRoot, "src", "healthy.mjs"), "export const healthy = 'HEALTHY-CODE';\n");
    writeFile(path.join(projectRoot, "src", "blank.mjs"), "   \n\n");
    const res = await run();
    expect(outcomeFor(res, "src/healthy.mjs")?.embedded).toBe(true); // positive control
    expect(outcomeFor(res, "src/blank.mjs")).toMatchObject({ embedded: false, reason: "no-rows" });
  });

  it("a code file passed in files gets exactly one outcome, from the code loop", async () => {
    writeFile(path.join(projectRoot, "src", "healthy.mjs"), "export const healthy = 'HEALTHY-CODE';\n");
    // package.json is in CODE_IGNORE and is not a note, so neither loop handles it: positive
    // control that the not-selected branch still fires for a requested path nothing processes.
    const res = await run({ files: ["src/healthy.mjs", "package.json"] });
    expect(res.ok).toBe(true);
    const forCode = (res.fileOutcomes || []).filter((o) => o.file === "src/healthy.mjs");
    expect(forCode).toEqual([{ file: "src/healthy.mjs", embedded: true, reason: null }]);
    const forIgnored = (res.fileOutcomes || []).filter((o) => o.file === "package.json");
    expect(forIgnored).toEqual([{ file: "package.json", embedded: false, reason: "not-selected" }]);
  });
});
