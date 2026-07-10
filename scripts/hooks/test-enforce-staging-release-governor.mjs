#!/usr/bin/env node
/**
 * Tests for enforce-staging-release-governor.mjs (write-tier hook)
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const HOOK_PATH = path.join(PROJECT_ROOT, ".routekit/hooks/write/enforce-staging-release-governor.mjs");

let failures = 0;
function ok(msg)   { console.log("[PASS] " + msg); }
function fail(msg) { console.error("[FAIL] " + msg); failures++; }

function callHook(toolName, toolInput, env = {}) {
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  const result = spawnSync("node", [HOOK_PATH], {
    input,
    encoding: "utf8",
    timeout: 5000,
    cwd: PROJECT_ROOT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_ROOT, ...env },
  });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* not JSON */ }
  return { ...result, parsed };
}

async function run() {
  console.log("[test-enforce-staging-release-governor] running tests");

  // 1. Non-target tool passes through
  const r1 = callHook("mcp__rks__rks_agent_git", { projectId: "routekit-shell" });
  if (r1.status === 0 && !r1.parsed?.hookSpecificOutput) ok("non-target tool passes through");
  else fail("non-target tool should pass through; got: " + r1.stdout);

  // 2. rks_staging_merge without token → deny
  const r2 = callHook("mcp__rks__rks_staging_merge", { projectId: "routekit-shell" });
  if (r2.status === 0 && r2.parsed?.hookSpecificOutput?.permissionDecision === "deny") {
    ok("rks_staging_merge without token → denied");
  } else {
    fail("rks_staging_merge without token should be denied; got: " + r2.stdout);
  }

  // 3. rks_release without token → deny
  const r3 = callHook("mcp__rks__rks_release", { projectId: "routekit-shell" });
  if (r3.status === 0 && r3.parsed?.hookSpecificOutput?.permissionDecision === "deny") {
    ok("rks_release without token → denied");
  } else {
    fail("rks_release without token should be denied; got: " + r3.stdout);
  }

  // 4. rks_staging_merge with _governorToken → allow
  const r4 = callHook("mcp__rks__rks_staging_merge", { projectId: "routekit-shell", _governorToken: "test-token" });
  if (r4.status === 0 && !r4.parsed?.hookSpecificOutput) {
    ok("rks_staging_merge with _governorToken → allowed");
  } else {
    fail("rks_staging_merge with token should be allowed; got: " + r4.stdout);
  }

  // 5. rks_release with _governorToken → allow
  const r5 = callHook("mcp__rks__rks_release", { projectId: "routekit-shell", _governorToken: "test-token" });
  if (r5.status === 0 && !r5.parsed?.hookSpecificOutput) {
    ok("rks_release with _governorToken → allowed");
  } else {
    fail("rks_release with token should be allowed; got: " + r5.stdout);
  }

  // 6. Deny output uses exit 0 with permissionDecision deny (not exit 2)
  const r6 = callHook("mcp__rks__rks_release", { projectId: "routekit-shell" });
  if (r6.status === 0 && r6.parsed?.hookSpecificOutput?.permissionDecision === "deny") {
    ok("deny uses exit 0 with permissionDecision: deny");
  } else {
    fail("deny should use exit 0 + JSON; got status=" + r6.status);
  }

  // 7. Deny output has hookEventName: PreToolUse and non-empty permissionDecisionReason
  const r7 = callHook("mcp__rks__rks_staging_merge", {});
  const hso7 = r7.parsed?.hookSpecificOutput;
  if (hso7?.hookEventName === "PreToolUse" && hso7?.permissionDecisionReason?.length > 0) {
    ok("deny output has hookEventName: PreToolUse and non-empty reason");
  } else {
    fail("deny output missing hookEventName or reason; got: " + JSON.stringify(hso7));
  }

  // 8. Deny context references rks_governor_init with flowType: ops
  const r8 = callHook("mcp__rks__rks_release", {});
  const context8 = JSON.stringify(r8.parsed?.hookSpecificOutput?.additionalContext || "");
  if (context8.includes("rks_governor_init") && context8.includes("ops")) {
    ok("deny context references rks_governor_init with flowType: ops");
  } else {
    fail("deny context should name rks_governor_init + ops; got: " + context8);
  }

  // 9. RKS_GUARDRAILS=off bypasses hook
  const r9 = callHook("mcp__rks__rks_release", {}, { RKS_GUARDRAILS: "off" });
  if (r9.status === 0 && !r9.parsed?.hookSpecificOutput) {
    ok("RKS_GUARDRAILS=off bypasses hook");
  } else {
    fail("guardrails-off should bypass hook; got: " + r9.stdout);
  }

  // 10. hooks-manifest.json includes enforce-staging-release-governor as write tier
  const manifest = JSON.parse(readFileSync(path.join(PROJECT_ROOT, ".routekit/hooks-manifest.json"), "utf8"));
  if (manifest["enforce-staging-release-governor"]?.tier === "write") {
    ok("hooks-manifest.json registers enforce-staging-release-governor as write tier");
  } else {
    fail("hooks-manifest.json missing enforce-staging-release-governor write entry");
  }

  // 11. .claude/settings.json includes matcher for both tools
  const settings = JSON.parse(readFileSync(path.join(PROJECT_ROOT, ".claude/settings.json"), "utf8"));
  const preToolUse = settings.hooks?.PreToolUse || [];
  const entry = preToolUse.find(h => {
    const m = h.matcher || "";
    return m.includes("rks_staging_merge") && m.includes("rks_release");
  });
  if (entry && JSON.stringify(entry).includes("enforce-staging-release-governor")) {
    ok(".claude/settings.json registers matcher for rks_staging_merge|rks_release");
  } else {
    fail(".claude/settings.json missing matcher entry; found: " + JSON.stringify(entry));
  }

  console.log("\n" + (failures === 0 ? "✅ All tests passed" : `❌ ${failures} test(s) failed`));
  process.exit(failures > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
