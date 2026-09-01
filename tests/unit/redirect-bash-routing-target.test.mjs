/**
 * backlog.fix.bash-redirect-dead-end-routing — the redirect must be actionable.
 *
 * The hook used to name `mcp__rks__rks_agent_run` as the agent that would service a
 * blocked Bash call. That tool cannot: its schema is `{ agent, input }` and it
 * dispatches LLM agents from a registry, none of whose input schemas accepts a
 * command string. There is NO ad-hoc command-execution tool available to a Governor.
 * So every Bash redirect pointed at a dead end — two Governors followed it, stalled,
 * and a human ran the commands manually.
 *
 * ARCH ruled Option C: remove the false promise and describe what IS possible.
 *
 * These assertions are BEHAVIOURAL. They do not pin a replacement string, so they
 * survive a later decision to add a real constrained execution capability.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs tests/unit/redirect-bash-routing-target.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOOK = path.join(PROJECT_ROOT, "packages/hooks/write/redirect-bash-to-governor.mjs");

let tmpProjectDir;
beforeAll(() => {
  tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-bash-routing-"));
});
afterAll(() => {
  try { fs.rmSync(tmpProjectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function runBashHook(command) {
  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmpProjectDir,
      RKS_GUARDRAILS: "on",
      RKS_PROJECT_ID: "test-project",
    },
    timeout: 10_000,
  });
  return { exitCode: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

/** A command that is definitely NOT on the read-only allowlist. */
const BLOCKED = "npm run build";

function redirectContext(command = BLOCKED) {
  const r = runBashHook(command);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim(), "expected a redirect payload").not.toBe("");
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  expect(out.permissionDecision).toBe("deny");
  return out.additionalContext;
}

describe("bash redirect does not promise execution it cannot deliver", () => {
  /** The `agent:` line under GOVERNOR ROUTING — i.e. what is named as the servicer. */
  function routingTarget(ctx) {
    const m = ctx.match(/^\s*agent:\s*(.+)$/m);
    expect(m, `no 'agent:' line in:\n${ctx}`).toBeTruthy();
    return m[1].trim();
  }

  it("DECISIVE: rks_agent_run is not the routing target", () => {
    // The discriminating assertion. Fails against the old hook; passes under any
    // corrective option, without pinning what replaced it.
    //
    // Scoped to the routing TARGET, not the whole payload: the redirect may still
    // mention rks_agent_run in a NEGATIVE instruction ("do not call it — it cannot
    // run this"), which is useful guidance and must not be forbidden.
    expect(routingTarget(redirectContext())).not.toContain("rks_agent_run");
  });

  it("no mcp__rks__ agent tool is presented as the executor", () => {
    const target = routingTarget(redirectContext());
    expect(target).not.toMatch(/^mcp__rks__/);
  });

  it("the REDIRECT ORDER line does not tell the caller to route to rks_agent_run", () => {
    const ctx = redirectContext();
    const orderLine = ctx.split("\n").find((l) => l.includes("REDIRECT ORDER:"));
    expect(orderLine).toBeTruthy();
    // The old text read "Do NOT call mcp__rks__rks_agent_run or the original tool
    // directly" — naming it as the thing being routed TO.
    expect(orderLine).not.toContain("rks_agent_run");
  });

  it("still emits a well-formed, deny-shaped redirect", () => {
    const ctx = redirectContext();
    expect(ctx).toContain("REDIRECT ORDER:");
    expect(ctx).toContain("GOVERNOR ROUTING:");
  });

  it("tells the caller what IS possible — actionable, not a dead end", () => {
    const ctx = redirectContext();
    // At least one real, reachable path must be named. Behavioural: any of the
    // sanctioned routes satisfies this, so a later redesign does not redden it.
    const mentionsRealPath =
      /rks_exec/.test(ctx) || /run_command/.test(ctx) || /testFiles/.test(ctx) || /terminal/i.test(ctx);
    expect(mentionsRealPath, `redirect must name a reachable path:\n${ctx}`).toBe(true);
  });

  it("does not emit the raw command in agentParams (sibling strict-parsing dependency)", () => {
    // backlog.fix.agent-run-strict-input-and-delivery-guard makes rks_agent_run
    // reject unknown keys. `command` is in no agent schema, so leaving it here
    // would hard-fail every Bash redirect once that ships.
    const ctx = redirectContext("npm run build --some-flag");
    const params = ctx.match(/params: (\{.*\})/);
    expect(params, "GOVERNOR ROUTING params should be present").toBeTruthy();
    const parsed = JSON.parse(params[1]);
    expect(parsed).not.toHaveProperty("command");
  });

  it("TELEMETRY COUPLING PRESERVED: blocked-tool attribution still resolves", () => {
    // hook-output.mjs derives the guardrail-bump tool name as
    //   blockedTool || agentParams.tool || <first token of agentParams.command>
    // Dropping `command` must not lose attribution — `tool` carries the same value.
    const ctx = redirectContext("npm run build");
    const params = JSON.parse(ctx.match(/params: (\{.*\})/)[1]);
    const derived = params.tool || params.command;
    expect(derived, `no usable tool name in ${JSON.stringify(params)}`).toBeTruthy();
    expect(derived).toBe("npm");
  });

  it("read-only allowlist is unchanged — still allows, still blocks", () => {
    // Non-narrowing
    for (const allowed of [
      "git status --porcelain",
      "git log --oneline -3",
      "gh run list --limit 5",
      "node scripts/analyze-vitest-report.mjs foo.json",
    ]) {
      const r = runBashHook(allowed);
      expect(r.stdout.trim(), `must still ALLOW: ${allowed}`).toBe("");
    }
    // Non-widening
    for (const blocked of [
      "git push origin staging",
      "gh pr merge 1",
      "git status && rm -rf /tmp/x",
      "npm run build",
    ]) {
      const r = runBashHook(blocked);
      expect(r.stdout.trim(), `must still REDIRECT: ${blocked}`).not.toBe("");
    }
  });
});

describe("the misconception is corrected at its source", () => {
  it("governor-state.mjs no longer claims rks_agent_run runs commands", () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, "packages/mcp-rks/src/shared/governor-state.mjs"),
      "utf8",
    );
    // The comment that seeded the same false belief in the hook.
    expect(src).not.toContain("can run multiple commands");
    // Value must be unchanged — exact-equality pins depend on it.
    expect(src).toContain("rks_agent_run: 'executing'");
  });

  it("CLAUDE.md records that Bash has no execution agent", () => {
    const md = fs.readFileSync(path.join(PROJECT_ROOT, "CLAUDE.md"), "utf8");
    expect(md).toMatch(/no ad-hoc execution agent|no such tool exists/i);
    expect(md).toContain("rks_exec");
  });
});
