/**
 * Client-side hook.guardrail_bump emit (backlog.feat.chain-violation-telemetry — client half).
 *
 * Proves the redirect chokepoint writes a CANONICAL hook.guardrail_bump event to the SERVER
 * sink (.rks/telemetry/events-<date>.jsonl) — the same envelope the readers/dashboard consume —
 * and that it is best-effort (a failed write never throws into the redirect).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { withTempDir } from "../_helpers/with-temp-dir.mjs";
import { emitGuardrailBump, buildRedirectOutput } from "../../packages/hooks/system/hook-output.mjs";

function readSinkEvents(dir) {
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, ".rks", "telemetry", `events-${date}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("emitGuardrailBump — canonical event to the server sink", () => {
  it("writes a canonical {id,type,timestamp,projectId,payload} hook.guardrail_bump event", async () => {
    await withTempDir("gb-", async (dir) => {
      emitGuardrailBump({
        projectDir: dir,
        projectId: "proj-1",
        reason: "Raw search tool blocked",
        redirectAgent: "mcp__rks__rks_agent_research",
        agentParams: { projectId: "proj-1", command: "grep foo" },
        blockedTool: "Bash",
      });
      const events = readSinkEvents(dir);
      expect(events.length).toBe(1);
      const ev = events[0];
      expect(ev.type).toBe("hook.guardrail_bump");
      expect(typeof ev.id).toBe("string");
      expect(typeof ev.timestamp).toBe("string");
      expect(ev.projectId).toBe("proj-1");
      expect(ev.payload.blockedTool).toBe("Bash");
      expect(ev.payload.redirectAgent).toBe("mcp__rks__rks_agent_research");
      expect(ev.payload.reason).toBe("Raw search tool blocked");
      expect(ev.payload.context).toEqual({ projectId: "proj-1", command: "grep foo" });
    });
  });

  it("infers blockedTool from agentParams.command when not explicitly given", async () => {
    await withTempDir("gb2-", async (dir) => {
      emitGuardrailBump({ projectDir: dir, agentParams: { command: "git push origin staging" } });
      const ev = readSinkEvents(dir)[0];
      expect(ev.payload.blockedTool).toBe("git");
    });
  });

  it("picks up problemId/tier/sessionId from .rks/active-scope.json when present", async () => {
    await withTempDir("gb-scope-", async (dir) => {
      fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".rks", "active-scope.json"),
        JSON.stringify({ problemId: "backlog.feat.x", tier: "build-only", sessionId: "sess-9" }),
      );
      emitGuardrailBump({ projectDir: dir, reason: "blocked" });
      const ev = readSinkEvents(dir)[0];
      expect(ev.payload.problemId).toBe("backlog.feat.x");
      expect(ev.payload.tier).toBe("build-only");
      expect(ev.payload.sessionId).toBe("sess-9");
    });
  });

  it("best-effort: an unwritable sink never throws", () => {
    expect(() => emitGuardrailBump({ projectDir: "\0invalid", reason: "x" })).not.toThrow();
  });

  it("buildRedirectOutput fires the bump at the chokepoint AND still returns the deny output", async () => {
    await withTempDir("gb3-", async (dir) => {
      const prev = process.env.CLAUDE_PROJECT_DIR;
      process.env.CLAUDE_PROJECT_DIR = dir;
      try {
        const out = buildRedirectOutput({
          reason: "blocked",
          agent: "mcp__rks__rks_agent_git",
          agentParams: { command: "git commit" },
        });
        expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
        const events = readSinkEvents(dir);
        expect(events.some((e) => e.type === "hook.guardrail_bump")).toBe(true);
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = prev;
      }
    });
  });
});
