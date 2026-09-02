import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  runExhaustiveSearch,
  computeGitAnchor,
  runRagQuery,
} from "@routekit/rag/tools";
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

// backlog.fix.multiline-anchor-verification-false-green.
//
// These three witness what matchCount CANNOT establish. They exist because a
// governor verified a two-line anchor as two separate searches, got matchCount: 1
// twice, and reported it verified — while a line inserted between them had already
// broken the block. Both greens were true; the conclusion drawn from them was not.
//
// MUST NOT modify packages/rag/src/tools.mjs — the disclosure half of this is owned
// by mode 6 of backlog.fix.exhaustive-search-dotdir-silent-zero, and this ships first.
describe("matchCount is not a verdict on identity or adjacency", () => {
  it("CONTAINMENT, NOT EQUALITY: a differing indent still reports one match", () => {
    // The match test is lines[i].includes(pattern), so a pattern that is a strict
    // substring of the source line matches. An anchor "verified" this way fails
    // later against the file it appeared to match.
    const r = runExhaustiveSearch(repo, { pattern: "also NEEDLE", path: "src/b.js" });
    expect(r.matchCount).toBe(1);
    // …and yet the pattern is NOT the line. This is the whole point.
    expect(r.results[0].text).not.toBe("also NEEDLE");
    expect(r.results[0].text).toBe("also NEEDLE on this line");
    // The sound check the prompts now mandate: compare results[].text, not the count.
    expect(r.results[0].text === "also NEEDLE").toBe(false);
  });

  it("EQUALITY IS DERIVABLE: results[].text supports the verdict the count cannot", () => {
    // Anti-vacuity for the case above — the data needed is present, so the defect
    // is reading the wrong field, not a missing capability.
    const r = runExhaustiveSearch(repo, { pattern: "also NEEDLE on this line", path: "src/b.js" });
    expect(r.matchCount).toBe(1);
    expect(r.results[0].text).toBe("also NEEDLE on this line");
  });

  it("NO ADJACENCY EVIDENCE: two per-line greens can be any distance apart", () => {
    // Each search is individually correct. Neither carries information about the
    // other's position, so "both returned 1" says nothing about contiguity.
    const first = runExhaustiveSearch(repo, { pattern: "const x = 1;", path: "src/a.js" });
    const second = runExhaustiveSearch(repo, { pattern: "more", path: "src/a.js" });
    expect(first.matchCount).toBe(1);
    expect(second.matchCount).toBe(1);
    // Same file, but NOT consecutive — line 1 and line 3, with NEEDLE between them.
    expect(first.results[0].file).toBe(second.results[0].file);
    expect(second.results[0].line - first.results[0].line).toBeGreaterThan(1);
  });

  it("MULTI-LINE LITERAL: the sound query is not silently wrong, it simply finds nothing", () => {
    // PINS THE NEGATIVE ONLY. Today this returns a bare matchCount: 0; mode 6 may
    // later add a disclosure flag. Asserting on any flag, reason string or
    // `exhaustive` value would red the moment mode 6 lands, so this asserts none.
    const r = runExhaustiveSearch(repo, {
      pattern: "const x = 1;\nNEEDLE here",
      path: "src/a.js",
    });
    const coversBothLines =
      r.results.some((h) => h.line === 1) && r.results.some((h) => h.line === 2);
    expect(r.matchCount === 0 || coversBothLines).toBe(true);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// backlog.fix.exhaustive-search-dotdir-silent-zero
//
// One fixture per silent-false-zero mode. Each fixture is a case that returned a
// bare `fileCount: 0` at `exhaustive: true` BEFORE the fix — a result a caller
// could not tell apart from proven absence. The bar the story sets is that a mode
// with no fixture is not covered, so these are enumerated rather than sampled.
// ─────────────────────────────────────────────────────────────────────────────
describe("silent false zeros are disclosed, not returned as bare zeros", () => {
  beforeAll(() => {
    // Mode 1 — a denylisted basename nested under an ordinary, searchable scope.
    // This is the real-world shape: templates/*/.routekit/** is exactly where the
    // 2026-08-13 PO and ARCH Governors both concluded "nothing there" and were wrong.
    seed("templates/generic/.routekit/read-policy.yaml", "runtime_paths:\n  - PRUNED_NEEDLE\n");
    seed("templates/generic/keep.txt", "an ordinary file that IS searched\n");
    // ARCH FINDING 1 — the fifth skip site, tests/.tmp, which the story's Mode 4 line
    // list does not enumerate.
    seed("tests/.tmp/scratch.txt", "PRUNED_NEEDLE in scratch\n");
    seed("tests/real.test.mjs", "an ordinary test file\n");
    // Mode 4 — a file over the 2 MB cap that genuinely CONTAINS the pattern.
    seed("big/huge.txt", "x".repeat(2 * 1024 * 1024 + 16) + "\nBIGNEEDLE\n");
    // Mode 6 — seeded HERE rather than relied upon from the outer fixture. Mode 3 now
    // throws on a missing path, so a fixture whose file is seeded elsewhere would throw
    // "scoped path does not exist" instead of exercising the warning, and the mode would
    // be silently untested. Self-contained by construction.
    seed("multiline/two-lines.js", "const x = 1;\nMULTI_NEEDLE here\n");
  });

  it("MODE 1: a denylisted directory pruned mid-walk is named in `skipped`", () => {
    const r = runExhaustiveSearch(repo, { pattern: "PRUNED_NEEDLE", path: "templates" });
    // The prune is PRESERVED — this story does not make the tool walk node_modules.
    expect(r.matchCount).toBe(0);
    // ...but the zero is now qualified rather than bare.
    expect(r.exhaustive).toBe(false);
    expect(r.skipped.map((s) => s.reason)).toContain("ignored_dir");
    expect(r.skipped.some((s) => s.path.includes(".routekit"))).toBe(true);
  });

  it("MODE 2: an explicitly named denylisted scope ROOT is traversed", () => {
    // The caller asked for this directory by name. Pruning it answers a question
    // they did not ask, and answers it with a zero.
    const r = runExhaustiveSearch(repo, {
      pattern: "PRUNED_NEEDLE",
      path: "templates/generic/.routekit",
    });
    expect(r.matchCount).toBe(1);
    expect(r.exhaustive).toBe(true);
    expect(r.skipped).toEqual([]);
  });

  it("MODE 3: a nonexistent scoped path throws instead of reporting zero", () => {
    expect(() =>
      runExhaustiveSearch(repo, { pattern: "NEEDLE", path: "src/no-such-file-xyz.js" }),
    ).toThrow(/does not exist/);
  });

  it("MODE 4: a file skipped for exceeding the size cap is disclosed", () => {
    const r = runExhaustiveSearch(repo, { pattern: "BIGNEEDLE", path: "big" });
    expect(r.matchCount).toBe(0);
    expect(r.exhaustive).toBe(false);
    expect(r.skipped.map((s) => s.reason)).toContain("oversize");
  });

  it("MODE 5: countOnly carries the SAME disclosure as full mode", () => {
    // A count must never be less qualified than a result set — that asymmetry is
    // what let a countOnly caller read a number as more authoritative than it was.
    const full = runExhaustiveSearch(repo, { pattern: "PRUNED_NEEDLE", path: "templates" });
    const counted = runExhaustiveSearch(repo, {
      pattern: "PRUNED_NEEDLE",
      path: "templates",
      countOnly: true,
    });
    expect(counted.skipped).toEqual(full.skipped);
    expect(counted.warnings).toEqual(full.warnings);
    expect(counted.exhaustive).toBe(full.exhaustive);
  });

  it("MODE 6: a multi-line pattern states why it could not match", () => {
    const r = runExhaustiveSearch(repo, {
      pattern: "const x = 1;\nMULTI_NEEDLE here",
      path: "multiline/two-lines.js",
    });
    expect(r.matchCount).toBe(0);
    expect(r.exhaustive).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/line-scoped/);
  });

  it("MODE 6: a CR-only pattern is caught too, not just LF", () => {
    const r = runExhaustiveSearch(repo, {
      pattern: "const x = 1;\rMULTI_NEEDLE here",
      path: "multiline/two-lines.js",
    });
    expect(r.exhaustive).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/line-scoped/);
  });

  it("the tests/.tmp prune is ALSO bypassed when it is the named scope root", () => {
    // Same rationale as Mode 2: the caller named this directory explicitly.
    const r = runExhaustiveSearch(repo, { pattern: "PRUNED_NEEDLE", path: "tests/.tmp" });
    expect(r.matchCount).toBe(1);
    expect(r.exhaustive).toBe(true);
    expect(r.skipped).toEqual([]);
  });

  it("ARCH FINDING 1: the tests/.tmp prune is disclosed like any other skip", () => {
    const r = runExhaustiveSearch(repo, { pattern: "PRUNED_NEEDLE", path: "tests" });
    expect(r.matchCount).toBe(0);
    expect(r.exhaustive).toBe(false);
    expect(r.skipped.map((s) => s.reason)).toContain("tests_tmp");
  });

  it("CORE INVARIANT: searched-and-found-nothing is distinguishable from never-searched", () => {
    // Both return matchCount 0. Before the fix they were byte-identical results and
    // a caller had to read the source to tell them apart. That is the whole defect.
    const searched = runExhaustiveSearch(repo, { pattern: "ABSENT_LITERAL_XYZ", path: "src" });
    const unsearched = runExhaustiveSearch(repo, { pattern: "PRUNED_NEEDLE", path: "templates" });

    expect(searched.matchCount).toBe(0);
    expect(unsearched.matchCount).toBe(0);

    expect(searched.exhaustive).toBe(true);
    expect(searched.skipped).toEqual([]);

    expect(unsearched.exhaustive).toBe(false);
    expect(unsearched.skipped.length).toBeGreaterThan(0);
  });

  it("the pre-existing result fields stay backward-compatible", () => {
    const r = runExhaustiveSearch(repo, { pattern: "NEEDLE", path: "src" });
    for (const f of [
      "ok", "pattern", "path", "anchor", "exhaustive",
      "countOnly", "fileCount", "matchCount", "truncated", "results",
    ]) {
      expect(r, `contract field missing: ${f}`).toHaveProperty(f);
    }
    // The two new fields are UNCONDITIONAL, unlike `files`/`results` which are
    // mode-dependent. A caller may ignore them, but must never find them undefined.
    expect(Array.isArray(r.skipped), "skipped must always be an array").toBe(true);
    expect(Array.isArray(r.warnings), "warnings must always be an array").toBe(true);
    // A clean scope still reports a true exhaustive claim.
    expect(r.exhaustive).toBe(true);
    expect(r.matchCount).toBe(4);
  });
});
