#!/usr/bin/env node
/**
 * Tests for enforce-guardrails-off-requires-session.mjs (system-tier hook)
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const HOOK_PATH = path.join(PROJECT_ROOT, ".routekit/hooks/system/enforce-guardrails-off-requires-session.mjs");

let failures = 0;
function ok(msg)   { console.log("[PASS] " + msg); }
function fail(msg) { console.error("[FAIL] " + msg); failures++; }

function callHook(toolName, toolInput) {
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  return new Promise((resolve) => {
    const proc = spawn("node", [HOOK_PATH], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_ROOT },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", d => stdout += d);
    proc.stderr.on("data", d => stderr += d);
    proc.stdin.write(input);
    proc.stdin.end();
    proc.on("close", (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* not JSON */ }
      resolve({ code, stdout, stderr, parsed, blocked: code === 2 });
    });
  });
}

async function run() {
  console.log("[test-enforce-guardrails-off-requires-session] running tests");

  // 1. Hook file exists (implicit — if we got here, the import succeeded)
  ok("hook file exists at .routekit/hooks/system/enforce-guardrails-off-requires-session.mjs");

  // 2. Non-target tool passes through (hook only intercepts rks_guardrails_off)
  const r1 = await callHook("mcp__rks__rks_guardrails_on", { projectId: "routekit-shell" });
  if (!r1.blocked && r1.code === 0) ok("non-target tool (rks_guardrails_on) passes through");
  else fail("non-target tool should pass through; got code=" + r1.code);

  // 3. Both token and problemId present → allow (exit 0, no deny output)
  const r2 = await callHook("mcp__rks__rks_guardrails_off", {
    projectId: "routekit-shell",
    problemId: "backlog.fix.my-story",
    _governorToken: "abc-token-123",
    reason: "test",
  });
  if (r2.code === 0 && (!r2.parsed || r2.parsed?.hookSpecificOutput?.permissionDecision !== "deny")) {
    ok("both token and problemId present → allowed");
  } else {
    fail("both present should be allowed; got code=" + r2.code + " stdout=" + r2.stdout);
  }

  // 4. _governorToken absent → deny with REDIRECT ORDER
  const r3 = await callHook("mcp__rks__rks_guardrails_off", {
    projectId: "routekit-shell",
    problemId: "backlog.fix.my-story",
    reason: "test",
    // _governorToken intentionally omitted
  });
  if (r3.code === 0 && r3.parsed?.hookSpecificOutput?.permissionDecision === "deny") {
    ok("missing _governorToken → deny with permissionDecision");
  } else {
    fail("missing token should deny; got code=" + r3.code + " stdout=" + r3.stdout);
  }
  if (r3.parsed?.hookSpecificOutput?.additionalContext?.includes("rks_governor_init")) {
    ok("deny context includes redirect to rks_governor_init");
  } else {
    fail("deny context should reference rks_governor_init; got: " + r3.parsed?.hookSpecificOutput?.additionalContext);
  }

  // 5. problemId absent → deny with REDIRECT ORDER
  const r4 = await callHook("mcp__rks__rks_guardrails_off", {
    projectId: "routekit-shell",
    _governorToken: "abc-token-123",
    reason: "test",
    // problemId intentionally omitted
  });
  if (r4.code === 0 && r4.parsed?.hookSpecificOutput?.permissionDecision === "deny") {
    ok("missing problemId → deny with permissionDecision");
  } else {
    fail("missing problemId should deny; got code=" + r4.code + " stdout=" + r4.stdout);
  }

  // 6. Both absent → deny
  const r5 = await callHook("mcp__rks__rks_guardrails_off", {
    projectId: "routekit-shell",
    reason: "test",
  });
  if (r5.code === 0 && r5.parsed?.hookSpecificOutput?.permissionDecision === "deny") {
    ok("both absent → deny");
  } else {
    fail("both absent should deny; got code=" + r5.code + " stdout=" + r5.stdout);
  }

  // 7. Output conforms to hookSpecificOutput JSON shape
  if (
    r3.parsed?.hookSpecificOutput?.hookEventName === "PreToolUse" &&
    typeof r3.parsed?.hookSpecificOutput?.permissionDecisionReason === "string" &&
    typeof r3.parsed?.hookSpecificOutput?.additionalContext === "string"
  ) {
    ok("deny output conforms to hookSpecificOutput JSON shape");
  } else {
    fail("deny output missing required fields; got: " + JSON.stringify(r3.parsed?.hookSpecificOutput));
  }

  if (failures > 0) {
    console.error("[test-enforce-guardrails-off-requires-session] FAILED — " + failures + " test(s) failed");
    process.exitCode = 1;
  } else {
    console.log("[test-enforce-guardrails-off-requires-session] OK — all tests passed");
    process.exitCode = 0;
  }
}

run();
