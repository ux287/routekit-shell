/**
 * backlog.feat.governor-session-end — rks_governor_end handler outcomes and wiring (unit tier).
 *
 * The handler is exercised directly against the real governor-token module with a temp project
 * root (sessions persist under <root>/.rks/session/governor). No subprocess is spawned.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleGovernorInit } from "../../packages/mcp-rks/src/tools/governor-init.mjs";
import { TOOL_NAME, INPUT_SCHEMA, handleGovernorEnd } from "../../packages/mcp-rks/src/tools/governor-end.mjs";
import { getSession, setProjectRoot, resetToken, setToken, COMMON_TOOLS, UNPROTECTED_TOOLS } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { TOOL_AGENTS, agentsForToolCall } from "../../packages/mcp-rks/src/llm/claude-cli/subscription-status.mjs";
import { CHILD_RKS_ALLOW_TOOLS, CHILD_RKS_PROMPT_TOOLS } from "../../packages/cli/src/project/child-permissions.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const PROJECT = "governor-end-fixture";
let root;

async function openSession() {
  const r = await handleGovernorInit({ projectId: PROJECT, flowType: "open" });
  expect(r.ok).toBe(true);
  return r.token;
}
const recordPath = (token) => path.join(root, ".rks", "session", "governor", `${token}.json`);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-governor-end-"));
  setProjectRoot(root);
  try { resetToken(); setToken(null); } catch { /* fresh module */ }
});

describe("rks_governor_end handler", () => {
  it("module shape: name and schema", () => {
    expect(TOOL_NAME).toBe("rks_governor_end");
    expect(INPUT_SCHEMA.required).toEqual(["projectId"]);
    expect(Object.keys(INPUT_SCHEMA.properties).sort()).toEqual(["_governorToken", "projectId"]);
  });

  it("no token -> token_required, no session touched", async () => {
    const token = await openSession();
    expect(handleGovernorEnd({ projectId: PROJECT }, undefined)).toMatchObject({ ok: false, reason: "token_required" });
    expect(getSession(token)).not.toBeNull();
  });

  it("live session -> ended true with pre-end flowType/state; observed gone; second call session_not_live", async () => {
    const token = await openSession();
    const before = { ...getSession(token) };
    expect(fs.existsSync(recordPath(token))).toBe(true);
    const r = handleGovernorEnd({ projectId: PROJECT }, token);
    expect(r).toMatchObject({ ok: true, ended: true, flowType: before.flowType, state: before.state });
    expect(before.flowType).toBe("open");
    expect(getSession(token)).toBeNull();
    expect(fs.existsSync(recordPath(token))).toBe(false);
    expect(handleGovernorEnd({ projectId: PROJECT }, token)).toMatchObject({ ok: true, ended: false, reason: "session_not_live" });
  });

  it("unknown token -> session_not_live", () => {
    expect(handleGovernorEnd({ projectId: PROJECT }, "no-such-token")).toMatchObject({ ok: true, ended: false, reason: "session_not_live" });
  });

  it("a session persisted on disk but absent from memory (MCP restart) is rehydrated and ended", async () => {
    const token = await openSession();
    const persisted = fs.readFileSync(recordPath(token), "utf8");
    // Simulate a server restart: memory is cleared (resetToken also removes records), then the
    // on-disk record is put back exactly as it was, with the same project root.
    resetToken();
    fs.mkdirSync(path.dirname(recordPath(token)), { recursive: true });
    fs.writeFileSync(recordPath(token), persisted);
    expect(getSession(token)).toBeNull();
    const r = handleGovernorEnd({ projectId: PROJECT }, token);
    expect(r).toMatchObject({ ok: true, ended: true, flowType: "open" });
    expect(r.reason).toBeUndefined();
    expect(getSession(token)).toBeNull();
    expect(fs.existsSync(recordPath(token))).toBe(false);
  });

  it("project mismatch -> project_mismatch, session stays live", async () => {
    const token = await openSession();
    expect(handleGovernorEnd({ projectId: "other-project" }, token)).toMatchObject({ ok: false, reason: "project_mismatch" });
    expect(getSession(token)).not.toBeNull();
  });

  for (const flags of [["guardrailsDisabled"], ["pendingStash"], ["guardrailsDisabled", "pendingStash"]]) {
    it(`end_blocked lists exactly ${flags.join("+")}; session stays live, nothing restored or popped`, async () => {
      const token = await openSession();
      const s = getSession(token);
      for (const f of flags) s[f] = f === "pendingStash" ? { ref: "stash@{0}" } : true;
      const r = handleGovernorEnd({ projectId: PROJECT }, token);
      expect(r).toMatchObject({ ok: false, reason: "end_blocked", flowType: "open", state: s.state });
      expect(r.blockedBy).toEqual(flags);
      // endSession never ran: the session and its flags are untouched and the record persists.
      const after = getSession(token);
      expect(after).not.toBeNull();
      for (const f of flags) expect(after[f]).toBeTruthy();
      expect(fs.existsSync(recordPath(token))).toBe(true);
    });
  }

  it("admission sets: COMMON_TOOLS and UNPROTECTED_TOOLS; init stays first common tool", () => {
    expect(COMMON_TOOLS.has("rks_governor_end")).toBe(true);
    expect(UNPROTECTED_TOOLS.has("rks_governor_end")).toBe(true);
    expect(Array.from(COMMON_TOOLS)[0]).toBe("rks_governor_init");
  });
});

describe("rks_governor_end wiring", () => {
  const PROMPTS = ["po", "qa", "arch", "research", "build", "ship"].map((n) => `.rks/prompts/governor-${n}.md`);
  for (const p of PROMPTS) {
    it(`${p}: first bullet under ## Rules names rks_governor_end; no Session end heading`, () => {
      const src = read(p);
      const start = src.indexOf("\n## Rules\n");
      expect(start).toBeGreaterThan(-1);
      const rest = src.slice(start + "\n## Rules\n".length);
      const firstBullet = rest.split("\n").find((l) => l.startsWith("- "));
      expect(firstBullet).toContain("rks_governor_end");
      expect(src).not.toMatch(/^## .*session end/im);
    });
  }

  it("Tool Allowlists of qa and arch list rks_governor_end; Call ONLY rules name it", () => {
    for (const p of [".rks/prompts/governor-qa.md", ".rks/prompts/governor-arch.md"]) {
      const src = read(p);
      expect(src.slice(src.indexOf("## Tool Allowlist"))).toContain("  - rks_governor_end");
    }
    for (const p of [".rks/prompts/governor-build.md", ".rks/prompts/governor-qa.md"]) {
      const line = read(p).split("\n").find((l) => l.startsWith("- Call ONLY"));
      expect(line).toContain("rks_governor_end");
    }
  });

  it("TOOL_AGENTS classifies rks_governor_end as running no LLM agent", () => {
    expect(TOOL_AGENTS.rks_governor_end).toEqual([]);
    expect(agentsForToolCall("rks_governor_end")).toEqual([]);
    expect(agentsForToolCall("mcp__rks__rks_governor_end")).toEqual([]);
  });

  it("governor subagent and child permissions admit the tool", () => {
    expect(read(".claude/agents/governor.md")).toContain("  - mcp__rks__rks_governor_end");
    expect(CHILD_RKS_ALLOW_TOOLS).toContain("mcp__rks__rks_governor_end");
    expect(Object.keys(CHILD_RKS_PROMPT_TOOLS)).not.toContain("mcp__rks__rks_governor_end");
  });

  it("ops, release and research skills instruct the end call after their last other MCP call", () => {
    expect(read(".claude/skills/ops/SKILL.md")).toContain("rks_governor_end");
    const rel = read(".claude/skills/release/SKILL.md");
    const endAt = rel.indexOf("rks_governor_end");
    expect(endAt).toBeGreaterThan(rel.indexOf("If any check fails, it returns"));
    expect(endAt).toBeLessThan(rel.indexOf("### Step 4: Report result"));
    const res = read(".claude/skills/research/SKILL.md");
    const rEnd = res.indexOf("rks_governor_end");
    expect(rEnd).toBeGreaterThan(-1);
    expect(rEnd).toBeLessThan(res.indexOf("3. Present the answer directly"));
  });
});
