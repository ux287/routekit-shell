#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Redirect read/discovery Bash → Research Agent
 *
 * Children run their own toolchain through Bash, so Bash cannot be blanket-
 * redirected the way the shell is. Instead this hook is ALLOWLIST-FIRST /
 * deny-by-default:
 *   - a small allowlist of build/run commands (node, npm, npx, git, …) runs
 *     directly;
 *   - recognized read/discovery commands (cat, grep, find, …) are handed off to
 *     the Research Agent so file inspection stays grounded;
 *   - everything else — including any command containing shell control /
 *     chaining metacharacters — is denied.
 *
 * This closes the bash-shaped hole in the read boundary: without it, `cat file`
 * or `grep pat file` bypass the redirected Read/Grep TOOLS entirely. It is the
 * secondary part of backlog.fix.child-bash-read-boundary-bypass and only matters
 * once hook registrations resolve to their tiered paths (the primary fix).
 *
 * Classification is anchored on the LEADING token (never a substring) and any
 * shell metacharacter rejects the command outright, so an allowlisted prefix
 * cannot smuggle a second command ("npm run x && cat secrets" → denied).
 *
 * Active-scope-aware "read within the current scope" allowance is intentionally
 * deferred to the future conditional-allow iteration; under guardrails-off
 * (where active scope lives) this hook already exits early.
 *
 * Output mechanism:
 *   Exit 0 + no output = allow
 *   Exit 0 + JSON hookSpecificOutput = deny with redirect via additionalContext
 *
 * @see backlog.fix.child-bash-read-boundary-bypass
 */
import path from "path";
import { fileURLToPath } from "url";
import {
  readHookInput, getProjectId, appendTelemetry,
  buildRedirectOutput, denyWithRedirect, isGuardrailsOff,
} from "../system/hook-output.mjs";

// Build/run/toolchain commands a child legitimately drives through Bash.
// Deny-by-default: anything not listed is denied. Future: conditional allows.
const ALLOWLIST = new Set([
  "node", "npm", "npx", "pnpm", "yarn",
  "git", "tsc", "vitest", "eslint", "prettier",
]);

// Recognized read/discovery commands — denied from running directly, but handed
// off to the Research Agent (grounded inspection) rather than a bare deny.
const READ_COMMANDS = new Set([
  "cat", "less", "more", "head", "tail", "tac", "nl",
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "find", "fd", "ls", "tree", "stat",
  "sed", "awk", "cut", "sort", "uniq", "wc", "column",
  "od", "xxd", "strings", "hexdump", "diff", "view",
]);

const META_RE = /[;&|`$(){}<>\\\n]/;

/**
 * Pure classifier — no I/O. Returns one of:
 *   { action: "allow" }                          allowlisted toolchain command
 *   { action: "redirect", kind: "read" }         recognized read → Research Agent
 *   { action: "deny", kind: "metacharacter" }    shell chaining/obfuscation
 *   { action: "deny", kind: "unknown" }          not allowlisted, not a read
 */
export function classifyBashCommand(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return { action: "allow", kind: "empty" };
  if (META_RE.test(trimmed)) return { action: "deny", kind: "metacharacter" };
  const token = trimmed.split(/\s+/)[0];
  if (ALLOWLIST.has(token)) return { action: "allow", kind: "allowlisted" };
  if (READ_COMMANDS.has(token)) return { action: "redirect", kind: "read" };
  return { action: "deny", kind: "unknown" };
}

async function main() {
  const hookData = await readHookInput();
  if (hookData.tool_name !== "Bash") process.exit(0);
  if (isGuardrailsOff()) process.exit(0);

  const command = (hookData.tool_input || {}).command || "";
  const result = classifyBashCommand(command);
  if (result.action === "allow") process.exit(0);

  const projectId = getProjectId();
  const isRead = result.kind === "read";
  const reason = isRead
    ? "File reads/searches must go through the Research Agent, not direct Bash — cat/grep/find bypass the read boundary."
    : "This command is not on the child allowlist. Allowlisted build/run commands (node, npm, npx, git, …) run directly; everything else must be governed.";
  const query = isRead
    ? `inspect/search: ${String(command).trim().slice(0, 160)}`
    : `run (needs governance): ${String(command).trim().slice(0, 160)}`;

  appendTelemetry({
    ts: new Date().toISOString(),
    hook: "redirect-read-bash-to-agent",
    blocked: true,
    reason,
    command: String(command).slice(0, 200),
    projectId,
  });

  denyWithRedirect(buildRedirectOutput({
    reason,
    agent: "mcp__rks__rks_agent_research",
    agentParams: { projectId, query },
    instructions: [
      "Read/search: launch the Research Agent (Verify pattern in CLAUDE.md) with what you need.",
      "Build/run: if this is legitimate toolchain, it should be allowlisted; otherwise route through a Governor.",
    ],
    project: projectId,
  }));
}

// Only run when executed directly as a hook — importing for classifyBashCommand
// (tests) must not trigger stdin reading.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`Hook error: ${err.message}\n`);
    process.exit(0); // On error, allow to avoid blocking work
  });
}
