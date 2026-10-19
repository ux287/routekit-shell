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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProductOwnerAgent } from "../../packages/mcp-rks/src/agents/product-owner.mjs";
import { createStoryAgent } from "../../packages/mcp-rks/src/agents/story.mjs";
import { createTelemetryAgent } from "../../packages/mcp-rks/src/agents/telemetry.mjs";
import { createDendronAgent } from "../../packages/mcp-rks/src/agents/dendron.mjs";
import { createCycleCompleteAgent } from "../../packages/mcp-rks/src/agents/cycle-complete.mjs";
import { createDeliveryAgent } from "../../packages/mcp-rks/src/agents/delivery.mjs";
import { createShipAgent } from "../../packages/mcp-rks/src/agents/ship.mjs";
import { createRecoveryAgent } from "../../packages/mcp-rks/src/agents/recovery.mjs";
import { createLifecycleAgent } from "../../packages/mcp-rks/src/agents/lifecycle.mjs";
import { createGitAgent } from "../../packages/mcp-rks/src/agents/git.mjs";

// createShipAgent runs git ls-remote at factory time (ship.mjs:143). The unit tier spawns nothing,
// so child_process is faked here; a non-zero status makes the target read as local-only.
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  spawnSync: () => ({ status: 1, stdout: "", stderr: "" }),
}));
import { loadAgentConfig, clearConfigCache } from "../../packages/mcp-rks/src/agents/config.mjs";

const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";
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

  for (const name of ["dendron", "telemetry", "cycle-complete"]) {
    it(`${name} is Haiku primary + Sonnet fallback`, () => {
      const cfg = resolve(name);
      expect(cfg.model).toBe(HAIKU);
      expect(cfg.fallbackModel).toBe(SONNET);
    });
  }

  // Stage 3 (backlog.feat.git-agent-haiku-first-fallback): git's evidence ledger is reset per
  // attempt (backlog.fix.agent-evidence-state-reset-on-retry), so git now gets its Sonnet fallback.
  it("git is Haiku primary + Sonnet fallback (stage 3)", () => {
    const cfg = resolve("git");
    expect(cfg.model).toBe(HAIKU);
    expect(cfg.fallbackModel).toBe(SONNET);
  });

  it("every non-planner agent has a defined fallbackModel distinct from its model", () => {
    for (const name of ["product-owner", "research", "git", "dendron", "telemetry", "ship",
      "cycle-complete", "story", "delivery", "recovery", "lifecycle"]) {
      const cfg = resolve(name);
      expect(cfg.fallbackModel, name).toBeDefined();
      expect(cfg.fallbackModel, name).not.toBe(cfg.model);
    }
  });

  // ARCH 2026-10-19: loadAgentConfig resolving fallbackModel is not enough; runner.mjs:207 reads it
  // from the factory config. These cases are red until each factory forwards cfg.fallbackModel.
  describe("agent factories forward fallbackModel to the runner config", () => {
    const factories = [
      ["product-owner", () => createProductOwnerAgent({ projectId: "t", problemId: "backlog.t.x", projectRoot: root })],
      ["story", () => createStoryAgent({ projectId: "t", storyId: "backlog.t.x", projectRoot: root })],
      ["telemetry", () => createTelemetryAgent({ projectId: "t", query: "q", projectRoot: root })],
      ["dendron", () => createDendronAgent({ projectId: "t", request: "r", projectRoot: root })],
      ["cycle-complete", () => createCycleCompleteAgent({ projectId: "t", storyId: "backlog.t.x", projectRoot: root })],
      ["delivery", () => createDeliveryAgent({ projectId: "t", storyIds: ["backlog.t.x"], projectRoot: root })],
      ["ship", () => createShipAgent({ projectId: "t", storyId: "backlog.t.x", projectRoot: root })],
      ["recovery", () => createRecoveryAgent({ projectId: "t", projectRoot: root })],
      ["lifecycle", () => createLifecycleAgent({ projectId: "t", storyId: "backlog.t.x", projectRoot: root })],
      ["git", () => createGitAgent({ projectId: "t", request: "r", projectRoot: root })],
    ];
    for (const [name, build] of factories) {
      it(`${name} factory config carries Haiku model and Sonnet fallbackModel`, () => {
        const config = build();
        expect(config.model).toBe(HAIKU);
        expect(config.fallbackModel).toBe(SONNET);
      });
    }
  });

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

  // Regression witness for backlog.feat.universal-haiku-first-escalation-path: the cases above use an
  // empty projectRoot, so they never saw .rks/agents.yaml overriding DEFAULTS. This block reads the REAL yaml.
  describe("real .rks/agents.yaml - stage 1 resolved state", () => {
    const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const real = (name) => loadAgentConfig(name, REPO_ROOT);

    for (const [name, maxTurns, timeoutMs] of [["product-owner", 5, 60000], ["story", 7, 90000]]) {
      it(`${name} is Haiku primary + Sonnet fallback with yaml runtime overrides kept`, () => {
        const cfg = real(name);
        expect(cfg.model).toBe(HAIKU);
        expect(cfg.fallbackModel).toBe(SONNET);
        expect(cfg.maxTurns).toBe(maxTurns);
        expect(cfg.timeoutMs).toBe(timeoutMs);
      });
    }

    for (const name of ["dendron", "telemetry", "cycle-complete"]) {
      it(`${name} is Haiku primary + Sonnet fallback`, () => {
        const cfg = real(name);
        expect(cfg.model).toBe(HAIKU);
        expect(cfg.fallbackModel).toBe(SONNET);
      });
    }

    it("delivery is Haiku primary + Sonnet fallback with yaml runtime overrides kept (de-pinned in stage 2)", () => {
      const cfg = real("delivery");
      expect(cfg.model).toBe(HAIKU);
      expect(cfg.fallbackModel).toBe(SONNET);
      expect(cfg.maxTurns).toBe(15);
      expect(cfg.timeoutMs).toBe(300000);
    });

    it("no non-planner agent remains without a usable escalation path", () => {
      // Stage 2 (backlog.feat.escalation-safe-side-effecting-agents) de-pinned delivery, ship and recovery.
      // Stage 3 (backlog.feat.git-agent-haiku-first-fallback) gives git its fallback and empties this set.
      const nonPlanner = ["product-owner", "research", "git", "dendron", "telemetry", "ship",
        "cycle-complete", "story", "delivery", "recovery", "lifecycle"];
      const noEscalation = nonPlanner.filter((n) => {
        const cfg = real(n);
        return cfg.fallbackModel === undefined || cfg.fallbackModel === cfg.model;
      });
      expect(noEscalation.sort()).toEqual([]);
      expect(real("git").fallbackModel).toBe(SONNET);
      expect(real("ship").model).toBe(HAIKU);
      expect(real("recovery").model).toBe(HAIKU);
    });

    for (const [name, maxTurns, timeoutMs] of [["ship", 8, 120000], ["recovery", 10, 120000]]) {
      it(`${name} is Haiku primary + Sonnet fallback with yaml runtime overrides kept (stage 2)`, () => {
        const cfg = real(name);
        expect(cfg.model).toBe(HAIKU);
        expect(cfg.fallbackModel).toBe(SONNET);
        expect(cfg.maxTurns).toBe(maxTurns);
        expect(cfg.timeoutMs).toBe(timeoutMs);
      });
    }

    // Raw-text witness: the de-pin removes ONLY the model line, and no other entry changes.
    const yamlBlocks = () => {
      const blocks = {};
      let current = null;
      for (const line of readFileSync(path.join(REPO_ROOT, ".rks", "agents.yaml"), "utf8").split("\n")) {
        const key = line.match(/^  ([a-z-]+):\s*$/);
        if (key) { current = key[1]; blocks[current] = []; continue; }
        if (current && line.startsWith("    ")) blocks[current].push(line.trim());
      }
      return blocks;
    };

    it("delivery, ship and recovery yaml entries carry only maxTurns and timeoutMs", () => {
      const b = yamlBlocks();
      expect(b.delivery).toEqual(["maxTurns: 15", "timeoutMs: 300000"]);
      expect(b.ship).toEqual(["maxTurns: 8", "timeoutMs: 120000"]);
      expect(b.recovery).toEqual(["maxTurns: 10", "timeoutMs: 120000"]);
    });

    it("every other yaml entry keeps its line set and no entry is added or removed", () => {
      const b = yamlBlocks();
      const H = "model: claude-haiku-5-5";
      expect(Object.keys(b).sort()).toEqual(["cycle-complete", "delivery", "dendron", "external-research", "git",
        "llm-planner", "product-owner", "qa-agent", "recovery", "research", "reviewer", "ship", "story", "telemetry"]);
      expect(b["product-owner"]).toEqual(["maxTurns: 5", "timeoutMs: 60000"]);
      expect(b.research).toEqual(["backend: claude-cli", H, "fallbackModel: claude-sonnet-5-5", "maxTurns: 12", "timeoutMs: 60000"]);
      expect(b.git).toEqual([H, "maxTurns: 7", "timeoutMs: 45000"]);
      expect(b.dendron).toEqual([H, "maxTurns: 5", "timeoutMs: 30000"]);
      expect(b.telemetry).toEqual([H, "maxTurns: 5", "timeoutMs: 30000"]);
      expect(b["cycle-complete"]).toEqual([H, "maxTurns: 7", "timeoutMs: 90000"]);
      expect(b.story).toEqual(["maxTurns: 7", "timeoutMs: 90000"]);
      for (const k of ["llm-planner", "reviewer", "external-research", "qa-agent"]) expect(b[k]).toEqual(["backend: claude-cli"]);
    });

    it("planner stays Sonnet-primary", () => {
      expect(real("planner").model).toBe(SONNET);
    });
  });
});
