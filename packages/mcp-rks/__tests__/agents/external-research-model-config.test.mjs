import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentConfig } from "../../src/agents/config.mjs";

// Finding 5 (notes/research.2026.06.28.uat-findings.md): external research hardcoded
// a decommissioned model id ('claude-sonnet-4-20250514') and bypassed the central
// loader. Fix: route external-research through loadAgentConfig('research') and purge
// the stale id from config.mjs DEFAULTS/GLOBAL_DEFAULTS.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_SRC = path.join(__dirname, "..", "..", "src", "agents");
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const configSrc = fs.readFileSync(path.join(AGENTS_SRC, "config.mjs"), "utf8");
const extSrc = fs.readFileSync(path.join(AGENTS_SRC, "external-research.mjs"), "utf8");

const STALE = "claude-sonnet-4-20250514";
const VALID = new Set([
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
]);

describe("external research model config (Finding 5)", () => {
  it("the decommissioned model id is gone from config.mjs (DEFAULTS + GLOBAL_DEFAULTS)", () => {
    assert.ok(!configSrc.includes(STALE), `config.mjs must not contain ${STALE}`);
  });

  it("external-research.mjs no longer hardcodes a model and routes through loadAgentConfig('research')", () => {
    assert.ok(!extSrc.includes(STALE), `external-research.mjs must not contain ${STALE}`);
    assert.match(extSrc, /loadAgentConfig\(['"]research['"]/);
    // The old `RKS_RESEARCH_MODEL || 'claude-...'` hardcoded fallback is gone.
    assert.doesNotMatch(extSrc, /RKS_RESEARCH_MODEL\s*\|\|\s*['"]claude-/);
  });

  it("the research default model is preserved as claude-haiku-4-5-20251001", () => {
    assert.match(configSrc, /'research':\s*\{\s*model:\s*'claude-haiku-4-5-20251001'/);
  });

  it("the replacement preserves the 'sonnet' substring (existing includes('sonnet') guards stay green)", () => {
    assert.ok(configSrc.includes("claude-sonnet-4-6"));
  });

  it("every agent's default model resolves to a valid current id (no stale ids resolve)", () => {
    const agents = [
      "product-owner", "research", "git", "dendron", "telemetry", "ship",
      "cycle-complete", "story", "delivery", "recovery", "planner", "lifecycle",
    ];
    // Clear any RKS_*_MODEL env overrides so we read agents.yaml/DEFAULTS, not env.
    const saved = {};
    for (const k of Object.keys(process.env)) {
      if (/^RKS_\w+_MODEL$/.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
    }
    try {
      for (const a of agents) {
        const m = loadAgentConfig(a, REPO_ROOT).model;
        assert.ok(VALID.has(m), `agent '${a}' resolved to invalid/stale model: ${m}`);
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) process.env[k] = v;
    }
  });

  it("RKS_RESEARCH_MODEL env override still wins (precedence preserved)", () => {
    const saved = process.env.RKS_RESEARCH_MODEL;
    process.env.RKS_RESEARCH_MODEL = "claude-opus-4-8";
    try {
      assert.strictEqual(loadAgentConfig("research", REPO_ROOT).model, "claude-opus-4-8");
    } finally {
      if (saved === undefined) delete process.env.RKS_RESEARCH_MODEL;
      else process.env.RKS_RESEARCH_MODEL = saved;
    }
  });
});
