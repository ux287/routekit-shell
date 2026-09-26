#!/usr/bin/env node
/**
 * System-tier PreToolUse hook: Verify hooks directory state
 *
 * Runs BEFORE all other hooks to catch broken state early.
 * Part of: backlog.fix.hooks-state-preflight
 */
import fs from "fs";
import path from "path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const HOOKS_PATH = path.join(PROJECT_DIR, ".routekit", "hooks");
const HOOKS_BAK_PATH = path.join(PROJECT_DIR, ".routekit", "hooks.bak");
const SCOPE_PATH = path.join(PROJECT_DIR, ".rks", "active-scope.json");
const MANIFEST_PATH = path.join(PROJECT_DIR, ".routekit", "hooks-manifest.json");

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return {};
  }
}

function getCurrentHooks() {
  if (!fs.existsSync(HOOKS_PATH)) return [];
  return fs.readdirSync(HOOKS_PATH).filter(f => f.endsWith(".mjs"));
}

function verifyHooksState() {
  const hooksExist = fs.existsSync(HOOKS_PATH);
  const bakExists = fs.existsSync(HOOKS_BAK_PATH);
  const scopeExists = fs.existsSync(SCOPE_PATH);
  const manifest = loadManifest();
  const expectedHooks = Object.keys(manifest).map(h => `${h}.mjs`);

  // Guardrails OFF mode (active session)
  if (scopeExists) {
    if (!bakExists) {
      return {
        ok: false,
        error: "Guardrails off but no hooks.bak - state corrupted",
        recovery: "Restore hooks from template: cp -r templates/generic/.routekit/hooks/ .routekit/"
      };
    }
    return { ok: true, mode: "off", warning: "Operating without guardrails" };
  }

  // Guardrails ON mode (expected)
  if (!hooksExist) {
    return {
      ok: false,
      error: "Guardrails on but hooks/ missing - auto-restoring from template",
      autoRecover: true
    };
  }

  // Verify all expected hooks are present
  const currentHooks = getCurrentHooks();
  const missing = expectedHooks.filter(h => !currentHooks.includes(h));

  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing hooks: ${missing.join(", ")}`,
      recovery: "Restore: git checkout HEAD -- .routekit/hooks/",
      autoRecover: true
    };
  }

  // Check for stale hooks.bak (no active session but bak exists)
  if (bakExists) {
    return {
      ok: false,
      error: "Stale hooks.bak found without active session",
      recovery: "Clean up: rm -rf .routekit/hooks.bak"
    };
  }

  return { ok: true, mode: "on" };
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  // This hook runs on every tool call
  const result = verifyHooksState();

  if (!result.ok) {
    console.error(`⛔ Hooks state error: ${result.error}`);
    if (result.recovery) {
      console.error(`   Recovery: ${result.recovery}`);
    }
    // Exit 2 to block the operation
    process.exit(2);
  }

  // State is valid, allow operation to proceed
  process.exit(0);
}

main();
