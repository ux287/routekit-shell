import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  runExhaustiveSearch,
  computeGitAnchor,
  runRagQuery,
} from "../../packages/mcp-rks/src/rag/tools.mjs";
import { isProtectedTool, UNPROTECTED_TOOLS } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { makeTempDir } from "../helpers/tmp.mjs";

// Covers the governed exhaustive-search capability (Option C for Findings 6/7).
// See notes/research.2026.06.28.uat-findings.md.

function git(repo, args) {
  // Subprocess Timeout Rule: every git spawn is timeout-bounded.
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 10000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

let repo;

function seed(rel, content) {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeAll(() => {
  repo = makeTempDir("exhaustive-search");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  // "NEEDLE" appears in 3 files under src/ (4 occurrences total) + 1 decoy outside scope.
  seed("src/a.js", "const x = 1;\nNEEDLE here\nmore\n");
  seed("src/b.js", "// nothing\nalso NEEDLE on this line\n");
  seed("src/nested/c.js", "NEEDLE\nNEEDLE again\n");
  seed("other/d.js", "NEEDLE outside the scoped path\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed"]);
});

afterAll(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("governed exhaustive search", () => {
  it("EXHAUSTIVENESS: returns every literal occurrence in the scoped path (not a top-k subset)", () => {
    // The Finding 7 failure case: a top-k semantic draw can miss a consumer;
    // exhaustive search returns ALL of them.
    const r = runExhaustiveSearch(repo, { pattern: "NEEDLE", path: "src" });
    const files = [...new Set(r.results.map((h) => h.file))].sort();
    expect(r.fileCount).toBe(3);
    expect(r.matchCount).toBe(4);
    expect(files).toEqual(["src/a.js", "src/b.js", "src/nested/c.js"]);
    // The decoy outside the scoped path is NOT returned.
    expect(r.results.some((h) => h.file === "other/d.js")).toBe(false);
  });

  it("CITATION SHAPE: each hit carries {file, line, verbatim text} equal to the source line", () => {
    const r = runExhaustiveSearch(repo, { pattern: "NEEDLE", path: "src" });
    expect(r.results.length).toBe(4);
    for (const hit of r.results) {
      expect(hit.file).toBeTruthy();
      expect(hit.line).toBeGreaterThan(0);
      const sourceLines = fs.readFileSync(path.join(repo, hit.file), "utf8").split("\n");
      expect(hit.text).toBe(sourceLines[hit.line - 1]); // verbatim, not a paraphrase
      expect(hit.text).toContain("NEEDLE");
    }
  });

  it("GIT ANCHOR: committed tree -> @<sha> with no +dirty flag", () => {
    const r = runExhaustiveSearch(repo, { pattern: "NEEDLE", path: "src" });
    expect(r.anchor).toMatch(/^@[0-9a-f]+$/);
    expect(r.anchor).not.toContain("+dirty");
    expect(computeGitAnchor(repo)).toBe(r.anchor);
  });

  it("GIT ANCHOR: dirty working tree -> @<sha>+dirty (honest flag)", () => {
    seed("src/a.js", "const x = 1;\nNEEDLE here\nmore\nDIRTY_EDIT\n");
    const r = runExhaustiveSearch(repo, { pattern: "NEEDLE", path: "src" });
    expect(r.anchor).toMatch(/^@[0-9a-f]+\+dirty$/);
    git(repo, ["checkout", "--", "src/a.js"]); // restore clean state
  });

  it("BOUNDED INPUT: a scoped path is required; pattern is required", () => {
    expect(() => runExhaustiveSearch(repo, { pattern: "NEEDLE" })).toThrow(/scoped 'path' is required/);
    expect(() => runExhaustiveSearch(repo, { pattern: "NEEDLE", path: "" })).toThrow(/scoped 'path' is required/);
    expect(() => runExhaustiveSearch(repo, { path: "src" })).toThrow(/pattern is required/);
  });

  it("BOUNDED MODE: countOnly returns filenames + counts, no full match text", () => {
    const r = runExhaustiveSearch(repo, { pattern: "NEEDLE", path: "src", countOnly: true });
    expect(r.countOnly).toBe(true);
    expect(r.results).toBeUndefined();
    expect(r.files).toEqual([
      { file: "src/a.js", count: 1 },
      { file: "src/b.js", count: 1 },
      { file: "src/nested/c.js", count: 2 },
    ]);
  });

  it("DETERMINISM: identical inputs produce a deeply-equal exhaustive result set", () => {
    const a = runExhaustiveSearch(repo, { pattern: "NEEDLE", path: "src" });
    const b = runExhaustiveSearch(repo, { pattern: "NEEDLE", path: "src" });
    expect(a).toEqual(b);
  });

  it("RAW OUTPUT STAYS SERVER-SIDE: returns the structured cited-result contract, not raw stdout", () => {
    const r = runExhaustiveSearch(repo, { pattern: "NEEDLE", path: "src" });
    expect(r).toMatchObject({ ok: true, exhaustive: true });
    expect(Array.isArray(r.results)).toBe(true); // structured hits, not a stdout string
    expect(r).not.toHaveProperty("stdout");
    expect(r).not.toHaveProperty("rawOutput");
  });

  it("GOVERNED: rks_exhaustive_search is protected (token-gated), unlike the semantic rks_rag_query", () => {
    // Protected-by-default at the MCP gate => an unauthenticated call is
    // rejected/auto-routed (mirrors how raw Grep is blocked by the read hooks).
    expect(isProtectedTool("rks_exhaustive_search")).toBe(true);
    expect(UNPROTECTED_TOOLS.has("rks_exhaustive_search")).toBe(false);
    expect(isProtectedTool("rks_rag_query")).toBe(false); // contrast: semantic search is unprotected
  });

  it("ADDITIVE: the semantic RAG query path is unchanged and is a distinct function", () => {
    expect(typeof runRagQuery).toBe("function");
    expect(runRagQuery).not.toBe(runExhaustiveSearch);
  });
});
