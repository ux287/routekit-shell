/**
 * backlog.fix.rag-module-dangling-imports-mcp-agents.
 *
 * Four call sites in packages/mcp-rks/src imported or spawned a server-local rag module that has
 * not existed since the RAG substrate was extracted into @routekit/rag. Because all four were
 * DYNAMIC (an `await import` or a spawned argv path), nothing failed at load time and no compiler
 * saw them — they threw only when their code path ran.
 *
 * The worst was fix_rag, the tool whose job is repairing a broken RAG index: it was itself broken
 * and reported its own dangling wiring as 'RAG embed failed' with the hint "try rks_rag_embed
 * manually", sending anyone debugging a bad index in a circle.
 *
 * THIS IS NOT A SPECIFIER SWAP. The real exports are POSITIONAL —
 * runRagEmbed(projectRoot, options), runRagQuery(projectRoot, options), runRagCompact(projectRoot)
 * — and none accepts a projectId, while every dead call site passed a single object containing one.
 * An edit that only changes the import string compiles and stays wrong, so the assertions below
 * pin the CALL SHAPE, not the source text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

vi.mock("@routekit/rag", () => ({
  runRagEmbed: vi.fn(async () => ({ ok: true, chunks: 3 })),
  runRagQuery: vi.fn(async () => ({ results: [{ id: "x" }] })),
  runRagCompact: vi.fn(async () => ({ ok: true })),
}));

vi.mock("child_process", () => ({
  spawnSync: vi.fn(() => ({ stdout: "packages/mcp-rks/src/agents/story.mjs\n", stderr: "", status: 0 })),
}));

import { spawnSync } from "child_process";
import { runRagEmbed, runRagQuery, runRagCompact } from "@routekit/rag";
import { createCycleCompleteAgent } from "../../packages/mcp-rks/src/agents/cycle-complete.mjs";
import { createRecoveryAgent } from "../../packages/mcp-rks/src/agents/recovery.mjs";

const toolNamed = (agent, name) => agent.tools.find((t) => t.name === name);

beforeEach(() => {
  vi.resetAllMocks();
  spawnSync.mockReturnValue({ stdout: "packages/mcp-rks/src/agents/story.mjs\n", stderr: "", status: 0 });
  runRagEmbed.mockResolvedValue({ ok: true, chunks: 3 });
  runRagQuery.mockResolvedValue({ results: [{ id: "x" }] });
  runRagCompact.mockResolvedValue({ ok: true });
});

describe("the repointed specifiers actually resolve", () => {
  // EMPIRICAL, not a source-text check: a wrong-but-different specifier would pass a string
  // assertion and fail here. vi.mock does not intercept this — it resolves the real package.
  it("@routekit/rag really exports the three functions the agents now call", async () => {
    const real = await vi.importActual("@routekit/rag");
    expect(typeof real.runRagEmbed).toBe("function");
    expect(typeof real.runRagQuery).toBe("function");
    expect(typeof real.runRagCompact).toBe("function");
  });

  it("no module under packages/mcp-rks/src still references a server-local rag module", () => {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(mjs|js)$/.test(e.name)) {
          fs.readFileSync(full, "utf8").split("\n").forEach((line, i) => {
            if (line.includes("server/rag" + ".mjs")) hits.push(`${path.relative(REPO_ROOT, full)}:${i + 1}`);
          });
        }
      }
    };
    const src = path.join(REPO_ROOT, "packages/mcp-rks/src");
    walk(src);
    // POSITIVE CONTROL: the walk actually visited files, so the zero above is proven, not blind.
    expect(fs.existsSync(path.join(src, "agents/recovery.mjs"))).toBe(true);
    expect(hits).toEqual([]);
  });
});

describe("positional call shape — an import-string-only fix would fail here", () => {
  it("embed_rag calls runRagEmbed(projectRoot, options), never a single object", async () => {
    const agent = createCycleCompleteAgent({
      projectId: "p", storyId: "backlog.x", prNumber: null, projectRoot: REPO_ROOT,
    });
    const res = await toolNamed(agent, "embed_rag").execute({});
    expect(res?.skipped, "the embed path must actually run - a skip makes this test vacuous").toBeUndefined(); // no changed files in this checkout — nothing to assert

    expect(runRagEmbed).toHaveBeenCalled();
    const [first, second] = runRagEmbed.mock.calls[0];
    expect(typeof first).toBe("string");            // projectRoot, positionally first
    expect(first).toBe(REPO_ROOT);
    expect(second).toBeTypeOf("object");            // options, positionally second
    expect(second).toHaveProperty("files");
    expect(second).not.toHaveProperty("projectId"); // the function accepts no projectId
    expect(first).not.toBeTypeOf("object");         // the old single-object shape must fail
  });

  it("fix_rag embed calls runRagEmbed positionally and spawns nothing under src/server", async () => {
    const agent = createRecoveryAgent({ projectId: "p", symptoms: [], autoFix: false, projectRoot: REPO_ROOT });
    const res = await toolNamed(agent, "fix_rag").execute({ action: "embed" });
    expect(res.ok).toBe(true);
    expect(runRagEmbed).toHaveBeenCalledTimes(1);
    expect(runRagEmbed.mock.calls[0][0]).toBe(REPO_ROOT);
    expect(runRagEmbed.mock.calls[0][0]).not.toBeTypeOf("object");
    // No child process, so no stdout to report.
    expect(res).not.toHaveProperty("output");
  });

  it("fix_rag compact calls runRagCompact with EXACTLY one argument", async () => {
    const agent = createRecoveryAgent({ projectId: "p", symptoms: [], autoFix: false, projectRoot: REPO_ROOT });
    const res = await toolNamed(agent, "fix_rag").execute({ action: "compact" });
    expect(res.ok).toBe(true);
    expect(runRagCompact).toHaveBeenCalledTimes(1);
    expect(runRagCompact.mock.calls[0]).toHaveLength(1);
    expect(runRagCompact.mock.calls[0][0]).toBe(REPO_ROOT);
  });
});

describe("honesty — a failed embed is not reported as a success, nor as a missing module", () => {
  it("embed_rag does not claim embedded:true when runRagEmbed reports ok:false", async () => {
    // runRagEmbed does NOT throw on failure — packages/rag/src/tools.mjs returns { ok:false, ... }.
    // Returning embedded:true without observing that return was the original defect.
    runRagEmbed.mockResolvedValueOnce({ ok: false, error: "index locked" });
    const agent = createCycleCompleteAgent({
      projectId: "p", storyId: "backlog.x", prNumber: null, projectRoot: REPO_ROOT,
    });
    const res = await toolNamed(agent, "embed_rag").execute({});
    expect(res?.skipped, "the embed path must actually run - a skip makes this test vacuous").toBeUndefined();
    expect(res.embedded).toBe(false);
    expect(String(res.error ?? "")).toContain("index locked");
    // The module IS available; saying otherwise would be the lie the old fallback told.
    expect(JSON.stringify(res)).not.toContain("RAG module not available");
  });

  it("fix_rag surfaces the real error, not a generic failure from a missing module", async () => {
    runRagEmbed.mockResolvedValueOnce({ ok: false, error: "lancedb unavailable" });
    const agent = createRecoveryAgent({ projectId: "p", symptoms: [], autoFix: false, projectRoot: REPO_ROOT });
    const res = await toolNamed(agent, "fix_rag").execute({ action: "embed" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("lancedb unavailable");
  });
});

describe("the workspace manifest declares what the source imports", () => {
  it("every bare @routekit/* specifier under src/ is a declared dependency", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/package.json"), "utf8"));
    const declared = new Set(Object.keys(manifest.dependencies || {}));

    const found = new Set();
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(mjs|js)$/.test(e.name)) {
          const src = fs.readFileSync(full, "utf8");
          // Only real IMPORT specifiers — a bare quoted string mentioning a package name is
          // not a dependency. `from "x"`, `import("x")`, `require("x")`.
          const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"`](@routekit\/[^'"`]+)['"`]/g;
          for (const m of src.matchAll(SPEC)) {
            // Normalize a subpath specifier (@routekit/rag/query-expander) to scope-and-name:
            // dependencies declare the PACKAGE, never each subpath.
            const [scope, name] = m[1].split("/");
            const pkg = `${scope}/${name}`;
            // A package does not declare itself.
            if (pkg !== manifest.name) found.add(pkg);
          }
        }
      }
    };
    walk(path.join(REPO_ROOT, "packages/mcp-rks/src"));

    // NON-VACUITY: extraction must have found the two packages we know are imported.
    expect(found.has("@routekit/rag")).toBe(true);
    expect(found.has("@routekit/telemetry")).toBe(true);

    const undeclared = [...found].filter((p) => !declared.has(p));
    expect(undeclared, `undeclared @routekit/* dependencies: ${undeclared.join(", ")}`).toEqual([]);
  });
});

/**
 * Shipping-review gaps for backlog.fix.rag-module-dangling-imports-mcp-agents.
 *
 * Every assertion above exercises RETURNED failure (runRagEmbed resolves { ok: false }). None
 * exercised a THROWN one — which is the only case the surrounding try/catch exists for, and the
 * reason a reviewer could claim the catch had been orphaned without the suite contradicting it.
 * These settle it empirically: if the catch did not cover the call, the rejection would escape
 * and the test would fail rather than observe an error field.
 */
describe("a thrown RAG error is caught, not propagated", () => {
  it("embed_rag returns an error field instead of rejecting", async () => {
    runRagEmbed.mockRejectedValueOnce(new Error("embed exploded"));
    const agent = createCycleCompleteAgent({
      projectId: "p", storyId: "backlog.x", prNumber: null, projectRoot: REPO_ROOT,
    });
    const res = await toolNamed(agent, "embed_rag").execute({});
    expect(res?.skipped, "the embed path must actually run - a skip makes this test vacuous").toBeUndefined();
    expect(String(res.error ?? "")).toContain("embed exploded");
  });

  it("fix_rag returns ok:false instead of rejecting when runRagCompact throws", async () => {
    runRagCompact.mockRejectedValueOnce(new Error("compact exploded"));
    const agent = createRecoveryAgent({ projectId: "p", symptoms: [], autoFix: false, projectRoot: REPO_ROOT });
    const res = await toolNamed(agent, "fix_rag").execute({ action: "compact" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("compact exploded");
  });
});

/**
 * The third call site. runRagQuery was mocked but never invoked by any test above, so a wrong
 * call shape in story.mjs would have passed silently — the exact failure mode this story exists
 * to prevent, left uncovered at one of the three sites it fixes.
 */
describe("story research_context calls runRagQuery positionally", () => {
  it("passes projectRoot first and { q, k } second, with no projectId", async () => {
    const { createStoryAgent } = await import("../../packages/mcp-rks/src/agents/story.mjs");
    const agent = createStoryAgent({
      projectId: "p", storyId: "backlog.x", action: "lifecycle", projectRoot: REPO_ROOT,
    });
    const res = await toolNamed(agent, "research_context").execute({ query: "how does exec work", k: 7 });
    expect(res.ok).toBe(true);

    expect(runRagQuery).toHaveBeenCalledTimes(1);
    const [first, second] = runRagQuery.mock.calls[0];
    expect(first).toBe(REPO_ROOT);
    expect(first).not.toBeTypeOf("object");
    expect(second).toEqual({ q: "how does exec work", k: 7 });
    expect(second).not.toHaveProperty("projectId");
  });

  it("a thrown query error is caught and reported non-fatally", async () => {
    runRagQuery.mockRejectedValueOnce(new Error("query exploded"));
    const { createStoryAgent } = await import("../../packages/mcp-rks/src/agents/story.mjs");
    const agent = createStoryAgent({
      projectId: "p", storyId: "backlog.x", action: "lifecycle", projectRoot: REPO_ROOT,
    });
    const res = await toolNamed(agent, "research_context").execute({ query: "q" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("query exploded");
    expect(res.results).toEqual([]);
  });
});
