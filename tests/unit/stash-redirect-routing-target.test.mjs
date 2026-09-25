/**
 * backlog.fix.agent-stash-create-containment — the stash redirect must name a path that works.
 *
 * redirect-git-tools-to-agent.mjs pointed every git tool, including rks_stash, at
 * mcp__rks__rks_agent_git. After this story the git agent REFUSES to create a stash, so that
 * redirect would send a stash intent to a component that cannot service it — the same
 * dead-end shape as backlog.fix.bash-redirect-dead-end-routing. The deny is unchanged; only
 * the destination differs.
 *
 * ANTI-VACUITY — SPAWN THE CANONICAL PATH BY HARDCODED PATH.
 * tests/helpers/hook-path.mjs resolves .routekit/hooks → .routekit/hooks.bak → packages/hooks.
 * Using runHook/resolveHookByName here would assert against the DEPLOYED copy — and during a
 * guardrails-off build that is .routekit/hooks.bak, i.e. the OLD hook. The test would pass
 * while packages/hooks stayed wrong. Precedent: tests/unit/redirect-bash-routing-target.test.mjs.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs tests/unit/stash-redirect-routing-target.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Canonical source, never the deployed copy. See the ANTI-VACUITY note above.
const HOOK = path.join(PROJECT_ROOT, "packages/hooks/write/redirect-git-tools-to-agent.mjs");

let tmpProjectDir;
beforeAll(() => {
  expect(fs.existsSync(HOOK), "canonical hook source is missing — the scope is wrong").toBe(true);
  tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-stash-redirect-"));
});
afterAll(() => {
  try { fs.rmSync(tmpProjectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function runHookOn(toolName, toolInput = {}) {
  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: "utf8",
    timeout: 3000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmpProjectDir, RKS_GUARDRAILS: "on", RKS_PROJECT_ID: "test-project" },
  });
  return `${result.stdout || ""}${result.stderr || ""}`;
}

describe("rks_stash redirect points at a path that can service it", () => {
  it("still DENIES an untokened rks_stash — the deny is not weakened", () => {
    const out = runHookOn("mcp__rks__rks_stash");
    expect(out).toMatch(/deny|BLOCKED|REDIRECT/i);
  });

  it("does NOT send a stash intent to the git agent, which cannot create one", () => {
    expect(runHookOn("mcp__rks__rks_stash")).not.toMatch(/rks_agent_git/);
  });

  it("names the tokened path instead", () => {
    const out = runHookOn("mcp__rks__rks_stash");
    expect(out).toMatch(/rks_governor_init/);
    expect(out).toMatch(/rks_stash/);
    expect(out).toMatch(/_governorToken|token/i);
  });

  it("POSITIVE CONTROL — a different git tool still routes to the git agent", () => {
    // Without this, the two assertions above would pass against a hook that had stopped
    // emitting a redirect at all, or that never fired.
    const out = runHookOn("mcp__rks__rks_git_commit", { message: "wip" });
    expect(out).toMatch(/rks_agent_git/);
  });

  it("a tokened call is still exempt — the hook only guards the untokened path", () => {
    const out = runHookOn("mcp__rks__rks_stash", { _governorToken: "tok-123" });
    expect(out.trim()).toBe("");
  });
});
