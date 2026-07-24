/**
 * Regression coverage for backlog.feat.purge-dead-guardrails-config
 *
 * The dead, false-assurance config `.routekit/policy.guardrails.yaml` was
 * loaded and threaded through six `.js/.mjs` loaders plus two live `.ts`
 * twins, but its values were discarded by every consumer (the guard arg is
 * `_guard`, unread, at src/router.js). This story purged every loader and
 * deleted the file.
 *
 * These tests witness, deterministically (no live RAG DB, no CPU-thrashing
 * subprocess retrieval — per the project's Test Execution rules), that:
 *   1. the guard value is no longer supplied at any call site (`null` in the
 *      3rd positional slot, no `guardrailConfig`/`guard` variable) — the
 *      value-discard halt-gate;
 *   2. no loader references the deleted file, so nothing ENOENTs on it;
 *   3. the CLI planner's existence-gate for the file is gone while the
 *      genuinely-required router.yaml + RAG-DB gates remain — the
 *      no-degraded-mode witness that a plain "no ENOENT throw" check could
 *      not catch (fs.existsSync returns false silently);
 *   4. the route-optimizer's backup/restore of the file is gone and its
 *      revert path still runs;
 *   5. the file itself is deleted.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

// Every live loader that referenced the config, plus the two .ts twins.
const PURGED_LOADERS = [
  "scripts/validate-orchestrator.mjs",
  "scripts/verify-routing.js",
  "scripts/verify-routing.ts",
  "scripts/learning/route-optimizer.mjs",
  "src/agents/orchestrator.js",
  "src/agents/orchestrator.ts",
  "packages/cli/src/planner/index.js",
];

describe("purge-dead-guardrails-config: no residual references", () => {
  it.each(PURGED_LOADERS)("%s no longer references policy.guardrails", (rel) => {
    expect(read(rel)).not.toMatch(/policy\.guardrails/);
  });

  it.each(PURGED_LOADERS)("%s no longer declares a guardrailConfig binding", (rel) => {
    expect(read(rel)).not.toMatch(/guardrailConfig/);
  });
});

describe("purge-dead-guardrails-config: guard value no longer supplied (value-discard gate)", () => {
  it("validate-orchestrator passes null in the guard slot to both consumers", () => {
    const src = read("scripts/validate-orchestrator.mjs");
    // still routes/orchestrates...
    expect(src).toMatch(/retrieveWithRouting\(/);
    expect(src).toMatch(/executeOrchestration\(/);
    // ...but never threads a guard value.
    expect(src).not.toMatch(/guardrailConfig/);
  });

  it("verify-routing.js/.ts pass null (not a guard var) as the 3rd arg", () => {
    expect(read("scripts/verify-routing.js")).toMatch(/retrieveWithRouting\(q, cfg, null\)/);
    expect(read("scripts/verify-routing.ts")).toMatch(/retrieveWithRouting\(q as string, cfg, null\)/);
  });

  it("src/agents/orchestrator.js/.ts pass null as the 3rd arg", () => {
    expect(read("src/agents/orchestrator.js")).toMatch(/retrieveWithRouting\(query, routingConfig, null\)/);
    expect(read("src/agents/orchestrator.ts")).toMatch(/routingConfig,\s*null/);
  });
});

describe("purge-dead-guardrails-config: CLI planner existence-gate removed (no-degraded-mode witness)", () => {
  const src = read("packages/cli/src/planner/index.js");

  it("the guardrail existence gate is gone (no guardrailPath at all)", () => {
    expect(src).not.toMatch(/guardrailPath/);
  });

  it("the genuinely-required router.yaml + RAG-DB existence gates remain", () => {
    expect(src).toMatch(/if \(!fs\.existsSync\(routerPath\)\) missing\.push\(routerPath\);/);
    expect(src).toMatch(/if \(!fs\.existsSync\(ragDbPath\)\) missing\.push\(ragDbPath\);/);
  });

  it("retrieveWithRouting is called with null in the guard slot", () => {
    expect(src).toMatch(/retrieveWithRouting\(query, routerConfig, null,/);
  });
});

describe("purge-dead-guardrails-config: route-optimizer backup/restore of the file removed", () => {
  const src = read("scripts/learning/route-optimizer.mjs");

  it("drops the policiesConfigPath and the policy.guardrails backup/restore", () => {
    expect(src).not.toMatch(/policiesConfigPath/);
    expect(src).not.toMatch(/policiesBackup/);
    expect(src).not.toMatch(/policy\.guardrails/);
  });

  it("still backs up and reverts the router + tools configs", () => {
    expect(src).toMatch(/retrieval\.router\./);
    expect(src).toMatch(/tools\.schema\./);
  });

  it("revertLastOptimizations runs (empty history → false) without the removed backup path", async () => {
    const mod = await import(path.join(repoRoot, "scripts/learning/route-optimizer.mjs"));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "route-opt-"));
    const optimizer = new mod.DynamicRouteOptimizer({ configPath: tmp });
    await expect(optimizer.revertLastOptimizations()).resolves.toBe(false);
  });
});

describe("purge-dead-guardrails-config: dead file deleted", () => {
  it(".routekit/policy.guardrails.yaml no longer exists", () => {
    expect(fs.existsSync(path.join(repoRoot, ".routekit", "policy.guardrails.yaml"))).toBe(false);
  });
});
