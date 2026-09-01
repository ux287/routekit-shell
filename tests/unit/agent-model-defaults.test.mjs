/**
 * Running witness for backlog.feat.haiku-primary-agent-defaults.
 *
 * Drives the REAL loadAgentConfig resolution (no re-implementation) against a clean temp
 * projectRoot (no agents.yaml) with all RKS_*_MODEL env vars unset, so it exercises the
 * hardcoded DEFAULTS / GLOBAL_DEFAULTS in config.mjs. Lives in tests/unit/ (CI tier).
 *
 * Cost policy: mechanical agents default to Haiku-4.5 + Sonnet-fallback; the planner stays
 * Sonnet-primary (silent plan-quality drift can't be caught by failure-escalation yet).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAgentConfig, clearConfigCache } from "../../packages/mcp-rks/src/agents/config.mjs";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";
const OLD_SONNET = "claude-sonnet-4-20250514";

const ENV_KEYS = [
  "RKS_PO_MODEL", "RKS_RESEARCH_MODEL", "RKS_GIT_MODEL", "RKS_DENDRON_MODEL",
  "RKS_TELEMETRY_MODEL", "RKS_SHIP_MODEL", "RKS_CYCLE_COMPLETE_MODEL", "RKS_STORY_MODEL",
  "RKS_DELIVERY_MODEL", "RKS_RECOVERY_MODEL", "RKS_PLANNER_MODEL", "RKS_LIFECYCLE_MODEL",
];

describe("agent model defaults", () => {
  let root;
  const saved = {};

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "agent-defaults-"));
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    clearConfigCache();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (root) rmSync(root, { recursive: true, force: true });
    clearConfigCache();
  });

  const resolve = (name) => loadAgentConfig(name, root);

  describe("mechanical agents → Haiku-4.5 primary + Sonnet fallback", () => {
    for (const name of ["product-owner", "ship", "story", "delivery", "recovery", "lifecycle"]) {
      it(`${name}`, () => {
        const cfg = resolve(name);
        expect(cfg.model).toBe(HAIKU);
        expect(cfg.fallbackModel).toBe(SONNET);
      });
    }
  });

  it("PLANNER stays Sonnet-primary (NOT haiku), no no-op self-fallback", () => {
    const cfg = resolve("planner");
    expect(cfg.model).toBe(SONNET);
    expect(cfg.model).not.toBe(HAIKU); // load-bearing: the flip must not touch the planner
    // The old sonnet→sonnet no-op fallback is removed (undefined, or at least not == model).
    expect(cfg.fallbackModel === undefined || cfg.fallbackModel !== cfg.model).toBe(true);
  });

  it("research stays Haiku primary + Sonnet fallback (unchanged)", () => {
    const cfg = resolve("research");
    expect(cfg.model).toBe(HAIKU);
    expect(cfg.fallbackModel).toBe(SONNET);
  });

  for (const name of ["git", "dendron", "telemetry", "cycle-complete"]) {
    it(`${name} stays Haiku (unchanged)`, () => {
      expect(resolve(name).model).toBe(HAIKU);
    });
  }

  it("GLOBAL_DEFAULTS (unknown agent) → Haiku primary + Sonnet fallback", () => {
    const cfg = resolve("some-undeclared-agent");
    expect(cfg.model).toBe(HAIKU);
    expect(cfg.fallbackModel).toBe(SONNET);
  });

  it("no resolved agent config references the retired Sonnet-4 id", () => {
    const all = ["product-owner", "research", "git", "dendron", "telemetry", "ship",
      "cycle-complete", "story", "delivery", "recovery", "planner", "lifecycle", "unknown-x"];
    for (const name of all) {
      const cfg = resolve(name);
      expect(cfg.model).not.toBe(OLD_SONNET);
      if (cfg.fallbackModel) expect(cfg.fallbackModel).not.toBe(OLD_SONNET);
    }
  });
});
