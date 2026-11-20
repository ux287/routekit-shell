import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProductOwnerInputSchema,
  ProductOwnerOutputSchema,
  createProductOwnerAgent,
} from "../../../packages/mcp-rks/src/agents/product-owner.mjs";
import { ResearchInputSchema, ResearchOutputSchema } from "../../../packages/mcp-rks/src/agents/research.mjs";
import { loadAgentConfig, clearConfigCache } from "../../../packages/mcp-rks/src/agents/config.mjs";
import { createGitAgent, GitInputSchema, GitOutputSchema } from "../../../packages/mcp-rks/src/agents/git.mjs";
import { createDendronAgent, DendronInputSchema, DendronOutputSchema } from "../../../packages/mcp-rks/src/agents/dendron.mjs";
import { createTelemetryAgent, TelemetryInputSchema, TelemetryOutputSchema } from "../../../packages/mcp-rks/src/agents/telemetry.mjs";
import { createShipAgent, ShipOutputSchema } from "../../../packages/mcp-rks/src/agents/ship.mjs";
import {
  createCycleCompleteAgent,
  CycleCompleteInputSchema,
  CycleCompleteOutputSchema,
} from "../../../packages/mcp-rks/src/agents/cycle-complete.mjs";
import { createStoryAgent, StoryInputSchema, StoryOutputSchema } from "../../../packages/mcp-rks/src/agents/story.mjs";
import { createDeliveryAgent, DeliveryInputSchema, DeliveryOutputSchema } from "../../../packages/mcp-rks/src/agents/delivery.mjs";
import { createRecoveryAgent, RecoveryInputSchema } from "../../../packages/mcp-rks/src/agents/recovery.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Ported from the retired node:test suite packages/mcp-rks/__tests__/agent-runner.spec.mjs (ran in no
// CI tier). backlog.chore.retire-agent-runner-node-test-spec. Cases that read the live repository
// through process.cwd(), asserted stale tool counts, or depended on an API key were not ported.

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-ports-"));
  fs.mkdirSync(path.join(tmp, "notes"), { recursive: true });
  clearConfigCache();
});
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  clearConfigCache();
});

const writeYaml = (text) => {
  fs.mkdirSync(path.join(tmp, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".rks", "agents.yaml"), text);
  clearConfigCache();
};
const toolNames = (config) => config.tools.map((t) => t.name);
const tool = (config, name) => config.tools.find((t) => t.name === name);

describe("Product Owner agent config", () => {
  it("ProductOwnerInputSchema rejects input without problemId and ProductOwnerOutputSchema rejects an invalid verdict", () => {
    const input = ProductOwnerInputSchema.parse({ projectId: "test", problemId: "backlog.foo" });
    expect(input).toEqual({ projectId: "test", problemId: "backlog.foo" });
    expect(() => ProductOwnerInputSchema.parse({})).toThrow();
    expect(() => ProductOwnerInputSchema.parse({ projectId: "test" })).toThrow();

    const ok = ProductOwnerOutputSchema.parse({
      ok: true, verdict: "ready", quality: 0.85, completeness: 0.9, gaps: [],
      recommendations: ["Add more test cases"], sources: ["backlog.foo.md"],
    });
    expect(ok.verdict).toBe("ready");
    expect(() => ProductOwnerOutputSchema.parse({
      ok: true, verdict: "invalid", quality: 0.5, completeness: 0.5, gaps: [], recommendations: [], sources: [],
    })).toThrow();
  });

  it("createProductOwnerAgent exposes the validate_story and rag_query tools, each with an execute function", () => {
    const config = createProductOwnerAgent({ projectId: "test-project", problemId: "backlog.test.story", projectRoot: tmp });
    expect(config.name).toBe("product-owner");
    expect(config.projectId).toBe("test-project");
    // The retired spec pinned tools.length === 2; the factory now also adds research_codebase
    // (product-owner.mjs:82-85, :141), so the named tools are asserted instead of a count.
    expect(toolNames(config)).toEqual(expect.arrayContaining(["validate_story", "rag_query"]));
    for (const t of config.tools) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.inputSchema).toBeTruthy();
      expect(typeof t.execute).toBe("function");
    }
  });
});

describe("Research agent schemas", () => {
  it("ResearchInputSchema accepts projectId plus query, an optional scope, and rejects missing fields", () => {
    expect(ResearchInputSchema.parse({ projectId: "test", query: "how does X work?" })).toMatchObject({ projectId: "test", query: "how does X work?" });
    expect(ResearchInputSchema.parse({ projectId: "test", query: "find agents", scope: "code" }).scope).toBe("code");
    expect(() => ResearchInputSchema.parse({})).toThrow();
    expect(() => ResearchInputSchema.parse({ projectId: "test" })).toThrow();
  });

  it("ResearchOutputSchema accepts a sourced answer and rejects confidence out of range", () => {
    const out = ResearchOutputSchema.parse({
      ok: true, answer: "The function is defined in server.mjs at line 42",
      sources: [{ file: "src/server.mjs", snippet: "function foo() {" }], confidence: 0.85,
    });
    expect(out.ok).toBe(true);
    expect(out.sources).toHaveLength(1);
    expect(() => ResearchOutputSchema.parse({ ok: true, answer: "test", sources: [], confidence: 1.5, advisory: true })).toThrow();
  });
});

describe("Agent config loader", () => {
  let savedEnv;
  beforeEach(() => { savedEnv = process.env.RKS_RESEARCH_MODEL; delete process.env.RKS_RESEARCH_MODEL; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.RKS_RESEARCH_MODEL;
    else process.env.RKS_RESEARCH_MODEL = savedEnv;
  });

  it("an RKS_RESEARCH_MODEL env var overrides the agents.yaml model", () => {
    writeYaml("agents:\n  research:\n    model: claude-opus-4-20250514\n");
    expect(loadAgentConfig("research", tmp).model).toBe("claude-opus-4-20250514");
    process.env.RKS_RESEARCH_MODEL = "claude-sonnet-4-20250514";
    expect(loadAgentConfig("research", tmp).model).toBe("claude-sonnet-4-20250514");
  });

  it("reads fallbackModel from agents.yaml", () => {
    writeYaml("agents:\n  research:\n    model: claude-haiku-4-5-20251001\n    fallbackModel: claude-sonnet-4-20250514\n    maxTurns: 7\n");
    expect(loadAgentConfig("research", tmp).fallbackModel).toBe("claude-sonnet-4-20250514");
  });

  it("falls back to the hardcoded research timeout when no yaml exists", () => {
    // The research maxTurns default is deliberately not pinned here (see
    // backlog.fix.research-agent-max-turn-cap); only that it resolves to a positive number.
    const cfg = loadAgentConfig("research", tmp);
    expect(cfg.timeoutMs).toBe(60000);
    expect(cfg.maxTurns).toBeGreaterThan(0);
  });

  it("falls back to the global defaults for an unknown agent", () => {
    const cfg = loadAgentConfig("unknown-agent", tmp);
    expect(cfg.maxTurns).toBe(10);
    expect(cfg.timeoutMs).toBe(120000);
  });

  it("resolves the hardcoded maxTurns and timeoutMs defaults per agent when no yaml exists", () => {
    for (const [name, maxTurns, timeoutMs] of [
      ["git", 10, 45000],
      ["dendron", 5, 30000],
      ["telemetry", 5, 30000],
      ["cycle-complete", 7, 90000],
      ["story", 7, 90000],
      ["delivery", 15, 300000],
      ["recovery", 10, 120000],
    ]) {
      const cfg = loadAgentConfig(name, tmp);
      expect([name, cfg.maxTurns, cfg.timeoutMs]).toEqual([name, maxTurns, timeoutMs]);
    }
  });
});

describe("Agent factory schemas", () => {
  it("git, dendron and telemetry input schemas require the request or query field and outputs require ok", () => {
    expect(GitInputSchema.safeParse({ projectId: "test", request: "status" }).success).toBe(true);
    expect(GitInputSchema.safeParse({ projectId: "test" }).success).toBe(false);
    expect(GitOutputSchema.safeParse({ ok: true, summary: "On branch staging, clean" }).success).toBe(true);
    expect(GitOutputSchema.safeParse({ summary: "missing ok field" }).success).toBe(false);

    expect(DendronInputSchema.safeParse({ projectId: "test", request: "create a note" }).success).toBe(true);
    expect(DendronInputSchema.safeParse({ projectId: "test" }).success).toBe(false);
    expect(DendronOutputSchema.safeParse({ ok: true, summary: "Note created" }).success).toBe(true);
    expect(DendronOutputSchema.safeParse({ summary: "missing ok field" }).success).toBe(false);

    expect(TelemetryInputSchema.safeParse({ projectId: "test", query: "what failed?" }).success).toBe(true);
    expect(TelemetryInputSchema.safeParse({ projectId: "test" }).success).toBe(false);
    expect(TelemetryOutputSchema.safeParse({ ok: true, summary: "No failures found" }).success).toBe(true);
    expect(TelemetryOutputSchema.safeParse({ ok: true, summary: "Found 3", suggestions: ["Fix hook X"] }).success).toBe(true);
    expect(TelemetryOutputSchema.safeParse({ summary: "missing ok" }).success).toBe(false);
  });

  it("ship output schema accepts a successful result and a partial failure", () => {
    expect(ShipOutputSchema.safeParse({
      ok: true, summary: "Shipped successfully",
      data: {
        branch: "rks/ship-agent", prUrl: "https://github.com/test/repo/pull/1", prNumber: 1, merged: true, stagingSynced: true,
        steps: [{ step: "check_state", ok: true, detail: "clean state" }, { step: "create_pr", ok: true, detail: "PR #1 created" }],
      },
    }).success).toBe(true);
    expect(ShipOutputSchema.safeParse({
      ok: false, summary: "Failed at merge step",
      data: {
        branch: "rks/ship-agent", prUrl: "https://github.com/test/repo/pull/1", prNumber: 1, merged: false,
        steps: [{ step: "create_pr", ok: true }, { step: "merge_pr", ok: false, detail: "CI checks failing" }],
      },
    }).success).toBe(true);
  });

  it("cycle-complete schemas require storyId, accept prNumber and a full success result", () => {
    expect(CycleCompleteInputSchema.safeParse({ projectId: "p", storyId: "backlog.x" }).success).toBe(true);
    expect(CycleCompleteInputSchema.safeParse({ projectId: "p", storyId: "backlog.x", prNumber: 42 }).success).toBe(true);
    expect(CycleCompleteInputSchema.safeParse({ projectId: "p" }).success).toBe(false);
    expect(CycleCompleteOutputSchema.safeParse({
      ok: true, summary: "Cycle complete",
      data: { storyUpdated: true, epicUpdated: true, governancePassed: true, governanceDetails: { lint: true, build: true, test: true }, ragEmbedded: true, gitClean: true },
    }).success).toBe(true);
  });

  it("story schemas require storyId, validate the action enum, default action to lifecycle and accept a lifecycle result", () => {
    expect(StoryInputSchema.safeParse({ projectId: "p", storyId: "backlog.x" }).success).toBe(true);
    const withAction = StoryInputSchema.safeParse({ projectId: "p", storyId: "backlog.x", action: "validate" });
    expect(withAction.success).toBe(true);
    expect(withAction.data.action).toBe("validate");
    expect(StoryInputSchema.safeParse({ projectId: "p" }).success).toBe(false);
    expect(StoryInputSchema.safeParse({ projectId: "p", storyId: "backlog.x", action: "invalid-action" }).success).toBe(false);
    expect(StoryInputSchema.safeParse({ projectId: "p", storyId: "backlog.x" }).data.action).toBe("lifecycle");
    expect(StoryOutputSchema.safeParse({
      ok: true, summary: "Story backlog.test is ready",
      data: {
        storyId: "backlog.test", phase: "ready", status: "not-implemented",
        validation: { verdict: "ready", quality: 0.85, completeness: 0.9, gaps: [] },
        dependencies: { total: 0, resolved: 0, blocking: [] },
      },
    }).success).toBe(true);
  });

  it("delivery schemas accept storyIds and dryRun and a successful delivery result", () => {
    const input = DeliveryInputSchema.safeParse({ projectId: "p", title: "Release v1.0", storyIds: ["backlog.a", "backlog.b"], dryRun: true });
    expect(input.success).toBe(true);
    expect(input.data.storyIds).toHaveLength(2);
    expect(input.data.dryRun).toBe(true);
    expect(DeliveryOutputSchema.safeParse({
      ok: true, summary: "Delivered 2 stories",
      data: {
        storiesValidated: 2, storiesShipped: 2, cyclesCompleted: 2, prUrl: "https://github.com/test/pr/1", prNumber: 1,
        validationResults: [{ storyId: "backlog.test.a", ok: true, verdict: "pass", quality: 0.85 }],
        shipResult: { ok: true, branch: "rks/release-v1" },
        cycleResults: [{ storyId: "backlog.test.a", ok: true }],
        errors: [],
      },
    }).success).toBe(true);
  });

  it("recovery input schema accepts projectId alone and with symptoms and autoFix", () => {
    expect(RecoveryInputSchema.safeParse({ projectId: "p" }).success).toBe(true);
    const r = RecoveryInputSchema.safeParse({ projectId: "p", symptoms: "merge conflict on staging branch", autoFix: true });
    expect(r.success).toBe(true);
    expect(r.data.autoFix).toBe(true);
  });
});

describe("Agent factory tool sets", () => {
  it("each factory exposes its named tools, each with an execute function", () => {
    const cases = [
      [createGitAgent({ projectId: "t", request: "show me the status", projectRoot: tmp }), "git",
        ["git_state", "git_branch", "git_checkout", "git_commit", "git_stash", "git_reset", "git_diff", "git_log", "git_merge", "git_restore", "git_conflict_resolve", "git_cherry_pick", "git_tag"]],
      [createDendronAgent({ projectId: "t", request: "create a backlog note", projectRoot: tmp }), "dendron",
        ["dendron_create", "dendron_read", "dendron_edit", "dendron_update_field", "dendron_fix_frontmatter", "dendron_validate", "dendron_mark_implemented"]],
      [createTelemetryAgent({ projectId: "t", query: "what failed today?", projectRoot: tmp }), "telemetry",
        ["telemetry_query", "telemetry_report", "telemetry_analyze", "telemetry_digest", "provenance_blocks"]],
      [createShipAgent({ projectId: "t", title: "test PR", projectRoot: tmp }), "ship",
        ["check_state", "prepare_and_push", "create_pr", "check_pr", "merge_pr", "sync_staging"]],
      [createCycleCompleteAgent({ projectId: "t", storyId: "backlog.test", projectRoot: tmp }), "cycle-complete",
        ["mark_implemented", "update_epic", "run_governance", "check_git_state", "embed_rag"]],
      [createStoryAgent({ projectId: "t", storyId: "backlog.test", projectRoot: tmp }), "story",
        ["read_story", "validate_story", "advance_phase", "check_dependencies", "list_stories", "research_context"]],
      [createDeliveryAgent({ projectId: "t", title: "Test Release", projectRoot: tmp }), "delivery",
        ["list_ready_stories", "validate_batch", "ship_code", "complete_cycles", "release_summary"]],
      [createRecoveryAgent({ projectId: "t", projectRoot: tmp }), "recovery",
        ["diagnose", "fix_git", "fix_locks", "fix_rag", "fix_hooks"]],
    ];
    for (const [config, name, expected] of cases) {
      expect(config.name, name).toBe(name);
      expect(toolNames(config), name).toEqual(expect.arrayContaining(expected));
      for (const t of config.tools) expect(typeof t.execute, `${name}.${t.name}`).toBe("function");
    }
  });

  it("the git, dendron and telemetry configs carry a prompt and a userMessage naming the request", () => {
    const git = createGitAgent({ projectId: "t", request: "show me the status", projectRoot: tmp });
    expect(git.prompt).toBeTruthy();
    expect(git.userMessage).toContain("show me the status");
    const dendron = createDendronAgent({ projectId: "t", request: "create a backlog note for testing", projectRoot: tmp });
    expect(dendron.prompt).toBeTruthy();
    expect(dendron.userMessage).toContain("create a backlog note");
    const telemetry = createTelemetryAgent({ projectId: "t", query: "what failed today?", projectRoot: tmp });
    expect(telemetry.prompt).toBeTruthy();
    expect(telemetry.userMessage).toContain("what failed today");
  });

  it("the ship agent has at least 8 turns and a timeout of at least 60s", () => {
    const config = createShipAgent({ projectId: "t", title: "test PR", projectRoot: tmp });
    expect(typeof config.model).toBe("string");
    expect(config.maxTurns).toBeGreaterThanOrEqual(8);
    expect(config.timeoutMs).toBeGreaterThanOrEqual(60000);
  });
});

describe("Agent factory hermetic tool executions", () => {
  it("dendron_read reads a note and fails for a missing one", async () => {
    fs.writeFileSync(path.join(tmp, "notes", "test.read.md"), "---\nid: test.read\ntitle: Test\ncreated: 1\nupdated: 1\n---\n\n## Body\n\nContent here.");
    const readTool = tool(createDendronAgent({ projectId: "t", request: "read note", projectRoot: tmp }), "dendron_read");
    const found = await readTool.execute({ filename: "test.read" });
    expect(found.ok).toBeTruthy();
    expect(found.content).toContain("Content here");
    const missing = await readTool.execute({ filename: "nonexistent" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toBeTruthy();
  });

  it("provenance_blocks succeeds with total 0 when no block log exists", async () => {
    const result = await tool(createTelemetryAgent({ projectId: "t", query: "blocks", projectRoot: tmp }), "provenance_blocks").execute({});
    expect(result.ok).toBeTruthy();
    expect(result.total).toBe(0);
  });

  it("mark_implemented returns an error for a nonexistent story", async () => {
    const config = createCycleCompleteAgent({ projectId: "t", storyId: "nonexistent.story", projectRoot: tmp });
    const result = await tool(config, "mark_implemented").execute({ storyId: "nonexistent.story" });
    expect(result.error).toBeTruthy();
  });

  it("read_story fails for a missing story and check_dependencies resolves a story with no deps", async () => {
    const missing = await tool(createStoryAgent({ projectId: "t", storyId: "nonexistent.story", projectRoot: tmp }), "read_story").execute({});
    expect(missing.ok).toBe(false);
    expect(missing.error).toBeTruthy();

    fs.writeFileSync(path.join(tmp, "notes", "backlog.test.md"),
      "---\nid: backlog.test\ntitle: Test\ncreated: 1\nupdated: 1\nstatus: not-implemented\nphase: draft\n---\n\nTest body.");
    const deps = await tool(createStoryAgent({ projectId: "t", storyId: "backlog.test", projectRoot: tmp }), "check_dependencies").execute({});
    expect(deps.ok).toBeTruthy();
    expect(deps.allResolved).toBe(true);
    expect(deps.total).toBe(0);
  });

  it("list_ready_stories returns only the ready story and release_summary names the release", async () => {
    fs.writeFileSync(path.join(tmp, "notes", "backlog.test.ready.md"),
      "---\nid: backlog.test.ready\ntitle: Ready Story\nstatus: not-implemented\nphase: ready\n---\nBody");
    fs.writeFileSync(path.join(tmp, "notes", "backlog.test.draft.md"),
      "---\nid: backlog.test.draft\ntitle: Draft Story\nstatus: not-implemented\nphase: draft\n---\nBody");
    const listed = await tool(createDeliveryAgent({ projectId: "t", title: "Test", projectRoot: tmp }), "list_ready_stories").execute({});
    expect(listed.count).toBe(1);
    expect(listed.stories[0].id).toBe("backlog.test.ready");

    fs.writeFileSync(path.join(tmp, "notes", "backlog.test.story.md"),
      '---\nid: backlog.test.story\ntitle: "Test Story"\ndesc: "A test story"\n---\nBody');
    const summary = await tool(createDeliveryAgent({ projectId: "t", title: "Release v1", projectRoot: tmp }), "release_summary")
      .execute({ storiesShipped: ["backlog.test.story"] });
    expect(summary.summary).toContain("Release v1");
    expect(summary.stories).toHaveLength(1);
  });

  it("fix_locks finds no locks to remove in a clean project", async () => {
    fs.mkdirSync(path.join(tmp, ".rks", "session"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    const result = await tool(createRecoveryAgent({ projectId: "t", projectRoot: tmp }), "fix_locks").execute({});
    expect(result.count).toBe(0);
  });
});

describe("Retired node:test spec", () => {
  const SPEC = "packages/mcp-rks/__tests__/agent-runner.spec.mjs";
  const FORWARDING = "tests/unit/agents/runner-max-turns-message-forwarding.test.mjs";
  const LITERAL = 'it("forwards accumulated messages to escalated call on max_turns_exceeded", async () => {';

  it("packages/mcp-rks/__tests__/agent-runner.spec.mjs does not exist", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, SPEC))).toBe(false);
  });

  it("the manifest names no agent-runner.spec.mjs evidence file and the forwarding literal is present in its new home", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts/backlog-archive-manifest.json"), "utf8"));
    const evidence = (manifest.doneInCode || []).flatMap((e) => e.evidence || []);
    expect(evidence.some((ev) => String(ev.file).includes("agent-runner.spec.mjs"))).toBe(false);

    const entry = manifest.doneInCode.find((e) => e.id === "backlog.feat.escalation-history-passthrough");
    const moved = entry.evidence.find((ev) => ev.literal === LITERAL);
    expect(moved.file).toBe(FORWARDING);
    expect(fs.readFileSync(path.join(REPO_ROOT, FORWARDING), "utf8")).toContain(LITERAL);
  });

  it("the original sibling-spec comment lines are gone from the three CI test files", () => {
    const gone = {
      "tests/unit/git-evidence.test.mjs": " * agent-runner.spec.mjs:746/:749 cannot fail because it cannot run.",
      "tests/unit/runner-prompt-caching.test.mjs": " * packages/mcp-rks/__tests__/agent-runner.spec.mjs is node:test and is NOT swept by CI.",
      "tests/unit/telemetry-redact.test.mjs": "// LAYER 1 + LAYER 3 running witnesses. The canonical homes are in agent-runner.spec.mjs",
    };
    for (const [file, line] of Object.entries(gone)) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      expect(text.includes(line), file).toBe(false);
      expect(text.includes("agent-runner.spec.mjs"), file).toBe(false);
    }
  });
});
