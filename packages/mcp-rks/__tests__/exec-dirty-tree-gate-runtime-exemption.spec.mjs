import assert from "node:assert";
import { describe, it } from "node:test";
import { isRuntimeArtifact, RKS_RUNTIME_ARTIFACT_PATTERNS } from "../src/utils/git.mjs";

// backlog.fix.exec-dirty-tree-gate-exempts-generated-files
//
// rks.exec's pre-apply dirty-tree gate (exec.mjs ~193) builds `dirtyFiles` and hard-blocks when
// any remain. It now also excludes runtime artifacts via isRuntimeArtifact(), so an artifacts-only
// dirty tree (package-lock.json churn, rks's own .routekit/context-state.json) no longer blocks.
//
// CRITICAL boundary: the exemption must stay SPECIFIC. isRuntimeArtifact matches by exact-OR-prefix
// (startsWith), so a broad '.routekit/' pattern would silently exempt git-TRACKED guardrail config
// (.routekit/hooks-manifest.json, .routekit/project.json, .routekit/hooks/) — letting dirty edits to
// those bypass the gate unvalidated. The pattern list deliberately adds only the specific file.

describe("isRuntimeArtifact — exec dirty-tree exemption", () => {
  it("exempts lockfiles and rks-generated state (the gate-throttling artifacts)", () => {
    assert.strictEqual(isRuntimeArtifact("package-lock.json"), true);
    assert.strictEqual(isRuntimeArtifact(".routekit/context-state.json"), true);
    assert.strictEqual(isRuntimeArtifact(".routekit/state.json"), true);
    assert.strictEqual(isRuntimeArtifact(".routekit/telemetry/run-1.json"), true);
    assert.strictEqual(isRuntimeArtifact(".rks/runs/2026-01-01/plan.json"), true);
  });

  it("does NOT exempt git-tracked guardrail config (the over-exemption boundary)", () => {
    assert.strictEqual(isRuntimeArtifact(".routekit/hooks-manifest.json"), false);
    assert.strictEqual(isRuntimeArtifact(".routekit/project.json"), false);
    assert.strictEqual(isRuntimeArtifact(".routekit/hooks/read/redirect-read-to-agent.mjs"), false);
  });

  it("does NOT exempt ordinary source/doc files", () => {
    assert.strictEqual(isRuntimeArtifact("src/foo.js"), false);
    assert.strictEqual(isRuntimeArtifact("README.md"), false);
    assert.strictEqual(isRuntimeArtifact("packages/mcp-rks/src/server/exec.mjs"), false);
  });

  it("adds the SPECIFIC .routekit/context-state.json, not a broad .routekit/ prefix", () => {
    assert.ok(RKS_RUNTIME_ARTIFACT_PATTERNS.includes(".routekit/context-state.json"));
    assert.ok(
      !RKS_RUNTIME_ARTIFACT_PATTERNS.includes(".routekit/"),
      "a broad '.routekit/' catch-all would exempt tracked guardrail config"
    );
  });
});

describe("exec dirty-tree gate — artifact exemption behavior", () => {
  // Mirrors the block-relevant exec.mjs:193 filter (notes excluded upstream; artifacts now excluded).
  // dirtyFiles.length === 0 ⇒ exec proceeds; > 0 ⇒ exec blocks.
  const gateDirty = (allDirty) =>
    allDirty.filter((f) => !f.startsWith("notes/") && !isRuntimeArtifact(f));

  it("artifacts-only dirty tree yields zero blocking files (exec proceeds)", () => {
    assert.deepStrictEqual(gateDirty(["package-lock.json", ".routekit/context-state.json"]), []);
  });

  it("a real unrelated file still blocks", () => {
    assert.deepStrictEqual(gateDirty(["package-lock.json", "src/foo.js"]), ["src/foo.js"]);
  });

  it("a dirty guardrail config file still blocks (not exempted)", () => {
    assert.deepStrictEqual(gateDirty([".routekit/hooks-manifest.json"]), [".routekit/hooks-manifest.json"]);
  });

  it("mixed tree blocks naming only the real offender, not the artifacts", () => {
    assert.deepStrictEqual(
      gateDirty(["package-lock.json", ".routekit/context-state.json", "README.md"]),
      ["README.md"]
    );
  });
});
