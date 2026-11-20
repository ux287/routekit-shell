/**
 * backlog.fix.agent-evidence-state-reset-on-retry - per-attempt evidence state.
 *
 * research's retrieval record and git's evidence ledger are created once per factory call and
 * closed over by both the tools and the outputSchema, and every runAgent attempt reuses them.
 * Registered with the runner attempt lifecycle (backlog.feat.runner-attempt-lifecycle,
 * config.attemptState.beginAttempt(ctx)):
 *   - restart attempt (resumed false): both are re-initialised in place;
 *   - max-turns resume (resumed true): both are CARRIED - the git ledger because the resumed
 *     transcript quotes its indices, the retrieval record because the resumed model sees the
 *     earlier rag_query results (ARCH 2026-10-19; best-first, as within one attempt).
 *
 * runAgent is driven through the _testClient seam (forces the in-process API path).
 * child_process.spawnSync is faked so git tools spawn nothing. No LLM, no network, no subprocess.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
}));

import { runAgent } from "../../../packages/mcp-rks/src/agents/runner.mjs";
import { clearConfigCache } from "../../../packages/mcp-rks/src/agents/config.mjs";
import { createGitAgent, GitOutputSchema } from "../../../packages/mcp-rks/src/agents/git.mjs";
import { createEvidenceLedger, buildGitOutputSchema } from "../../../packages/mcp-rks/src/agents/git-evidence.mjs";
import { createResearchAgent } from "../../../packages/mcp-rks/src/agents/research.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const EVIDENCE_SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/agents/git-evidence.mjs"), "utf8");

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";
const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const textResp = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage });
let seq = 0;
const toolUse = (name, input = {}) => ({ content: [{ type: "tool_use", id: `tu${++seq}`, name, input }], stop_reason: "tool_use", usage });
const GIT_VALID = '{"ok":true,"summary":"read the state"}';
const RESEARCH_VALID = '{"ok":true,"answer":"a","sources":[{"file":"a.mjs"}],"confidence":0.6}';
const MODEL_OUT = { ok: true, answer: "a", sources: [{ file: "a.mjs" }], confidence: 0.6 };
const RESTART_KINDS = ["same_model_retry", "escalation", "self_escalation"];
const primary = () => ({ index: 0, kind: "primary", model: HAIKU, resumed: false });
const restart = (kind) => ({ index: 1, kind, model: kind === "same_model_retry" ? HAIKU : SONNET, resumed: false });
const resume = () => ({ index: 1, kind: "escalation", model: SONNET, resumed: true });

function scriptedClient(log, script) {
  let n = 0;
  return { messages: { create: async (args) => {
    n += 1;
    log.push({ n, model: args.model, messageCount: args.messages.length });
    return script(n, args);
  } } };
}

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-evidence-attempt-"));
  clearConfigCache();
});
afterEach(() => {
  clearConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

const gitAgent = () => createGitAgent({ projectId: "t", request: "show the state", projectRoot: root });
const researchAgent = () => createResearchAgent({ projectId: "t", query: "q", projectRoot: root });
const toolOf = (config, name) => {
  const t = config.tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
};
const sealedIndices = (config) => config.outputSchema.parse({ ok: true, summary: "s" }).evidence.calls.map((c) => c.i);

describe("git-evidence - createEvidenceLedger in-place reset", () => {
  it("reset() empties the ledger and the next call is recorded at index 0", () => {
    const ledger = createEvidenceLedger();
    ledger.record("a", {}, "first result body");
    ledger.record("b", {}, "second result body");
    expect(typeof ledger.reset).toBe("function");
    ledger.reset();
    expect(ledger.seal().callCount).toBe(0);
    ledger.record("c", {}, "third result body");
    expect(ledger.seal().calls.map((c) => [c.i, c.tool])).toEqual([[0, "c"]]);
  });

  it("a seal taken before reset() is not mutated by it", () => {
    const ledger = createEvidenceLedger();
    ledger.record("a", {}, "first result body");
    const sealed = ledger.seal();
    ledger.reset();
    expect(sealed.callCount).toBe(1);
    expect(sealed.calls).toHaveLength(1);
  });

  it("an output schema built over the ledger before reset() sees the reset (closure kept)", () => {
    const ledger = createEvidenceLedger();
    const schema = buildGitOutputSchema({ baseSchema: GitOutputSchema, ledger });
    ledger.record("a", {}, "first result body");
    ledger.reset();
    expect(schema.parse({ ok: true, summary: "s" }).evidence.callCount).toBe(0);
  });
});

describe("git agent - evidence ledger registered with the attempt state", () => {
  it("the factory config carries an attemptState with at least one registered item", () => {
    const config = gitAgent();
    expect(typeof config.attemptState?.beginAttempt).toBe("function");
    expect(config.attemptState.snapshot().items.length).toBeGreaterThanOrEqual(1);
  });

  for (const kind of RESTART_KINDS) {
    it(`a restart attempt (${kind}) seals only its own calls, indexed from 0`, async () => {
      const config = gitAgent();
      const tool = toolOf(config, "git_state");
      config.attemptState.beginAttempt(primary());
      await tool.execute({});
      await tool.execute({});
      config.attemptState.beginAttempt(restart(kind));
      await tool.execute({});
      expect(sealedIndices(config)).toEqual([0]);
    });
  }

  it("a resumed attempt (max-turns escalation) carries the ledger and indices continue", async () => {
    const config = gitAgent();
    const tool = toolOf(config, "git_state");
    config.attemptState.beginAttempt(primary());
    await tool.execute({});
    await tool.execute({});
    config.attemptState.beginAttempt(resume());
    await tool.execute({});
    expect(sealedIndices(config)).toEqual([0, 1, 2]);
  });
});

describe("git agent through the real runAgent", { timeout: 30_000 }, () => {
  it("same-model retry after invalid JSON returns only the retry's calls, indexed from 0", async () => {
    const log = [];
    const config = gitAgent();
    // 1-2 primary tool turns, 3 primary invalid JSON, 4 retry tool turn, 5 retry valid
    const script = (n) => (n <= 2 || n === 4 ? toolUse("git_state") : n === 3 ? textResp("NOT JSON") : textResp(GIT_VALID));
    const r = await runAgent({ ...config, model: HAIKU, _testClient: scriptedClient(log, script) });
    expect(log.map((c) => c.model)).toEqual([HAIKU, HAIKU, HAIKU, HAIKU, HAIKU]);
    expect(r.ok).toBe(true);
    expect(r.evidence.callCount).toBe(1);
    expect(r.evidence.calls.map((c) => c.i)).toEqual([0]);
  });

  it("max-turns escalation resumes with the ledger carried", async () => {
    const log = [];
    const config = gitAgent();
    const script = (n, args) => (args.model === SONNET ? textResp(GIT_VALID) : toolUse("git_state"));
    const r = await runAgent({ ...config, model: HAIKU, fallbackModel: SONNET, maxTurns: 1, _testClient: scriptedClient(log, script) });
    const firstSonnet = log.find((c) => c.model === SONNET);
    expect(firstSonnet).toBeDefined();
    expect(firstSonnet.messageCount).toBeGreaterThan(1);
    expect(r.ok).toBe(true);
    expect(r.evidence.callCount).toBeGreaterThanOrEqual(1);
    expect(r.evidence.calls.map((c) => c.i)).toEqual([...Array(r.evidence.callCount).keys()]);
    expect(r.evidence.calls.every((c) => c.tool === "git_state")).toBe(true);
  });
});

describe("research - retrieval record registered with the attempt state", () => {
  it("the factory config carries an attemptState with at least one registered item", () => {
    const config = researchAgent();
    expect(typeof config.attemptState?.beginAttempt).toBe("function");
    expect(config.attemptState.snapshot().items.length).toBeGreaterThanOrEqual(1);
  });

  for (const kind of RESTART_KINDS) {
    it(`a restart attempt (${kind}) does not inherit the abandoned attempt's healthy outcome`, () => {
      const config = researchAgent();
      config.attemptState.beginAttempt(primary());
      config._retrieval.record("healthy");
      config.attemptState.beginAttempt(restart(kind));
      config._retrieval.record("retrieval_failed");
      expect(config.outputSchema.parse(MODEL_OUT).failureCategory).toBe("retrieval_failed");
    });
  }

  it("a resumed attempt carries the record: an earlier healthy still ranks first (onResume carry)", () => {
    const config = researchAgent();
    config.attemptState.beginAttempt(primary());
    config._retrieval.record("healthy");
    config.attemptState.beginAttempt(resume());
    config._retrieval.record("retrieval_failed");
    expect(config.outputSchema.parse(MODEL_OUT).failureCategory).toBeUndefined();
  });

  it("a resumed attempt carries a failure recorded before the resume", () => {
    const config = researchAgent();
    config.attemptState.beginAttempt(primary());
    config._retrieval.record("retrieval_failed");
    config.attemptState.beginAttempt(resume());
    expect(config.outputSchema.parse(MODEL_OUT).failureCategory).toBe("retrieval_failed");
  });

  it("after a reset _retrieval is still the record the schema consumes, and it stays read-and-clear", () => {
    const config = researchAgent();
    const before = config._retrieval;
    config.attemptState.beginAttempt(primary());
    config.attemptState.beginAttempt(restart("same_model_retry"));
    expect(config._retrieval).toBe(before);
    config._retrieval.record("no_results");
    expect(config.outputSchema.parse(MODEL_OUT).failureCategory).toBe("no_results");
    expect(config.outputSchema.parse(MODEL_OUT).failureCategory).toBeUndefined();
  });
});

describe("research through the real runAgent", { timeout: 30_000 }, () => {
  it("same-model retry - a fresh retrieval_failed is not masked by the abandoned attempt's healthy", async () => {
    const log = [];
    const config = researchAgent();
    const outcomes = ["healthy", "retrieval_failed"];
    // rag_query stand-in: records through config._retrieval, the seam the claude-cli executor also uses.
    const tools = config.tools.map((t) => (t.name !== "rag_query" ? t : {
      ...t,
      execute: async () => {
        const outcome = outcomes.shift();
        config._retrieval.record(outcome);
        return outcome === "healthy" ? { ok: true, results: [{ file: "a.mjs" }] } : { ok: false, error: "index unavailable" };
      },
    }));
    // 1 primary rag_query, 2 primary invalid JSON, 3 retry rag_query, 4 retry valid
    const script = (n) => (n === 1 || n === 3 ? toolUse("rag_query", { q: "q" }) : n === 2 ? textResp("NOT JSON") : textResp(RESEARCH_VALID));
    const r = await runAgent({ ...config, tools, model: HAIKU, fallbackModel: SONNET, _testClient: scriptedClient(log, script) });
    expect(log.map((c) => c.model)).toEqual([HAIKU, HAIKU, HAIKU, HAIKU]);
    expect(outcomes).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.failureCategory).toBe("retrieval_failed");
  });
});

describe("git-evidence.mjs KNOWN COUPLING comment is updated, not removed", () => {
  it("still carries the KNOWN COUPLING marker and names the attempt-lifecycle reset", () => {
    expect(EVIDENCE_SRC).toContain("KNOWN COUPLING");
    expect(EVIDENCE_SRC).toMatch(/beginAttempt/);
  });

  it.each(["runner.mjs:201-207", "_executeAgent({ ...config, model: fallbackModel })", "not live for git today", "declares no fallbackModel", "zero occurrences in git.mjs"])(
    "no longer carries the stale text %s",
    (stale) => {
      expect(EVIDENCE_SRC).not.toContain(stale);
    },
  );
});
