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
  readHookInput, getProjectId, appendTelemetry, emitGuardrailBump,
  buildRedirectOutput, denyWithRedirect, isGuardrailsOff, PROJECT_DIR,
  isResearchAgentOutage, emitOutageFallthrough, isKeyless,
} from "../system/hook-output.mjs";
import { readProjectTestCommand } from "../lib/project-test-command.mjs";

// Build/run/toolchain commands a child legitimately drives through Bash.
// Deny-by-default: anything not listed is denied. Future: conditional allows.
const ALLOWLIST_TOKENS = new Set([
  "node", "npm", "npx", "pnpm", "yarn",
  "git", "tsc", "vitest", "eslint", "prettier",
]);

// Read-only view over ALLOWLIST_TOKENS. An importer can test membership and iterate, but
// cannot widen the live allowlist. Object.freeze on a Set would NOT achieve this: it freezes
// own properties, not the Set's entries, so .add() would still mutate it.
export const ALLOWLIST = Object.freeze({
  has: (token) => ALLOWLIST_TOKENS.has(token),
  get size() { return ALLOWLIST_TOKENS.size; },
  [Symbol.iterator]: () => ALLOWLIST_TOKENS.values(),
});

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

// git subcommands that write the index or history. A Dispatcher must not run these directly in
// Bash; they go through a Governor (the Ship Governor ad-hoc Path 3, or rks_agent_git), which runs
// git inside the MCP server process and so never reaches this hook. `stage` is git's built-in
// synonym for `add`. User-defined git aliases (e.g. `git ci`) cannot be detected statically.
// @see backlog.fix.child-bash-git-write-verbs-bypass-ship-governor
const GIT_WRITE_SUBCOMMANDS = new Set(["commit", "add", "rm", "stage"]);

// git global options that take their value as the NEXT token when written space-separated.
// The `--opt=value` and attached `-Cpath` forms consume nothing extra.
const GIT_OPTS_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path",
]);

/**
 * Pure, no I/O, never throws. Given the whitespace-split tokens of a command whose first token
 * is `git`, returns the git subcommand (the first non-option token after git's global options),
 * or null when there is none.
 */
export function gitSubcommand(tokens) {
  try {
    if (!Array.isArray(tokens)) return null;
    for (let i = 1; i < tokens.length; i++) {
      const t = String(tokens[i]);
      if (t.startsWith("-")) {
        if (GIT_OPTS_WITH_VALUE.has(t)) i++;
        continue;
      }
      return t;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pure classifier — no I/O. Returns one of:
 *   { action: "allow" }                          allowlisted toolchain command
 *   { action: "redirect", kind: "read" }         recognized read → Research Agent
 *   { action: "deny", kind: "metacharacter" }    shell chaining/obfuscation
 *   { action: "deny", kind: "git-write" }        git commit/add/rm/stage → Ship Governor path
 *   { action: "deny", kind: "unknown" }          not allowlisted, not a read
 */
// General-purpose interpreters/launchers. A testCommand.cmd whose basename is one of these adds
// nothing: allowing it as a first word would admit any script it can run.
const INTERPRETERS = new Set(["python", "python3", "bash", "sh", "zsh", "env", "uv", "uvx"]);

/**
 * Project-level extra allow tokens, sourced ONLY from <projectDir>/.rks/project.json
 * testCommand.cmd (the resolveTestCommand shape). Never throws. Returns { tokens, ignored }:
 *   tokens  - a Set holding the exact-string first word of cmd, or an empty Set.
 *   ignored - null when nothing was declared (no file, i.e. ENOENT; or no testCommand key) or
 *             when the token was accepted. Otherwise { reason, cmd? } naming why a declared
 *             config was NOT honoured: "unreadable" (any I/O error other than ENOENT, e.g.
 *             EISDIR, EACCES), "malformed" (invalid JSON, a non-object top level, or a
 *             testCommand / cmd / args of the wrong shape), "read-verb" (token or basename is a
 *             READ_COMMANDS member) or "interpreter" (basename is an INTERPRETERS member).
 * Fail-closed is unchanged: tokens is empty in every ignored case. ignored exists only so the
 * denial can SAY the declared command was ignored (R9: no silent fallback).
 * Exact-string: classifyBashCommand compares the token verbatim (no basename or PATH
 * normalization on the allow side); refusal is decided on the basename as well, which is stricter.
 */
export function loadProjectAllowConfig(projectDir) {
  const none = (ignored) => ({ tokens: new Set(), ignored });
  try {
    // The { cmd, args } shape parse is shared with the write-tier test gates
    // (backlog.fix.git-workflow-hook-ignores-project-test-command, D1). testCommand ONLY:
    // commitTestCommand never widens the Bash allowlist (A2).
    const { command, ignored } = readProjectTestCommand(projectDir);
    if (!command) return none(ignored);
    const token = command.cmd.trim().split(/\s+/)[0];
    const base = path.basename(token);
    if (READ_COMMANDS.has(token) || READ_COMMANDS.has(base)) return none({ reason: "read-verb", cmd: token });
    if (INTERPRETERS.has(base)) return none({ reason: "interpreter", cmd: token });
    return { tokens: new Set([token]), ignored: null };
  } catch {
    return none({ reason: "unreadable" });
  }
}

/** Set view of loadProjectAllowConfig, kept so every existing testRequirement holds unchanged. */
export function loadProjectAllowTokens(projectDir) {
  return loadProjectAllowConfig(projectDir).tokens;
}

const IGNORED_WHY = {
  unreadable: "the file could not be read",
  malformed: "the file or its testCommand is not valid (expected { cmd: string, args?: string[] })",
  "read-verb": "a read command always routes to the Research Agent and is never allowlisted",
  interpreter: "a general-purpose interpreter or launcher is never allowlisted, because it would admit any script",
};

/**
 * Pure, no I/O. The one extra line main() appends to an 'unknown' denial when the project's
 * declared testCommand was ignored. Returns "" for null, so an unconfigured project's denial is
 * exactly today's text.
 */
export function ignoredTestCommandLine(ignored) {
  if (!ignored) return "";
  const what = ignored.cmd ? `testCommand.cmd "${String(ignored.cmd).slice(0, 80)}"` : "testCommand";
  return `This project's .rks/project.json ${what} was ignored (${ignored.reason}): ${IGNORED_WHY[ignored.reason] || ignored.reason}.`;
}

export function classifyBashCommand(command, extraTokens) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return { action: "allow", kind: "empty" };
  if (META_RE.test(trimmed)) return { action: "deny", kind: "metacharacter" };
  const tokens = trimmed.split(/\s+/);
  const token = tokens[0];
  // Checked before the allowlist (and the project testCommand widening below), so neither can
  // admit a git write verb.
  if (token === "git" && GIT_WRITE_SUBCOMMANDS.has(gitSubcommand(tokens))) {
    return { action: "deny", kind: "git-write" };
  }
  if (ALLOWLIST.has(token)) return { action: "allow", kind: "allowlisted" };
  if (READ_COMMANDS.has(token)) return { action: "redirect", kind: "read" };
  // Project-declared tokens are consulted only AFTER the read redirect, so even a caller that
  // passes a read verb here cannot turn a read into a direct allow.
  if (extraTokens && new Set(extraTokens).has(token)) return { action: "allow", kind: "allowlisted" };
  return { action: "deny", kind: "unknown" };
}

/**
 * Pure deny-reason builder, no I/O. Takes a classifyBashCommand() result and returns the
 * user-facing reason. A metacharacter denial must not claim the verb is off the allowlist:
 * META_RE is tested before the leading verb is looked at.
 * `allowlist` defaults to ALLOWLIST; a caller holding an effective allowlist may pass it.
 */
export function denyReasonFor(result, allowlist = ALLOWLIST) {
  const kind = result && result.kind;
  if (kind === "read") {
    return "File reads/searches must go through the Research Agent, not direct Bash — cat/grep/find bypass the read boundary.";
  }
  if (kind === "git-write") {
    return "git commit, add, rm and stage must not be run directly in Bash. Commits go through a Governor: the Ship Governor ad-hoc Path 3 (/ship) with `files` (the exact paths to commit) and `rawMessage` (the complete message, trailers included), which commits via rks_git_commit and pushes with no story token; or rks_governor_init then rks_agent_git.";
  }
  if (kind === "metacharacter") {
    return "This command contains a shell metacharacter (one of ; & | ` $ ( ) { } < > \\ or a newline). The child Bash hook denies any command containing one before its leading verb is considered. Drop redirection, pipes, chaining and substitution (for example remove `2>&1`, or split `a && b` into separate calls), or use one of the other options listed with this denial.";
  }
  return `This command is not on the child allowlist. Allowlisted build/run commands (${[...allowlist].join(", ")}) run directly; everything else must be governed.`;
}

/**
 * Pure, no I/O. The options a caller actually has after a NON-READ denial (metacharacter or
 * unknown verb). No agent can run the command: rks has no ad-hoc execution agent and the
 * Research Agent is read-only, so these lines never route to one.
 */
export function denyOptionsFor(result, allowlist = ALLOWLIST) {
  const kind = result && result.kind;
  const first = kind === "metacharacter"
    ? "1. Drop the metacharacter or split the command: remove redirection such as `2>&1`, and run chained commands such as `a && b` as separate calls. A command whose leading verb is allowlisted and that contains no metacharacter runs directly."
    : `1. Use an allowlisted command if one does the job. These run directly: ${[...allowlist].join(", ")}.`;
  return [
    "This command was not run, and no agent can run it for you: rks has no ad-hoc execution agent, and the Research Agent is read-only.",
    first,
    "2. If the command is part of implementing a story, put it in the story plan as a run_command step and execute the plan with rks_exec.",
    "3. Otherwise, ask the user to run it in their terminal and paste the output.",
  ];
}

/**
 * Pure, no I/O. The keyless-mode deny envelope for a git-write denial. With no LLM credential no
 * Governor can run, so there is no REDIRECT ORDER: the user runs the git command themselves.
 */
export function gitWriteKeylessDenyOutput(result) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: denyReasonFor(result),
      additionalContext: [
        "This command was not run.",
        "Keyless mode (no LLM credential): Governors are unavailable, and with them rks_agent_git and the Ship Governor (rks_git_commit).",
        "Ask the user to run this git command in their own terminal.",
        "To delete a tracked file, ask the user to run `git rm <path>` in their own terminal (it only stages the deletion); in keyless mode the commit also runs in their terminal, and with a credential it goes through the Ship Governor ad-hoc Path 3 with that path in `files`.",
      ].join("\n"),
    },
  };
}

/**
 * Pure, no I/O. The PreToolUse deny envelope for a NON-READ denial: same shape as
 * buildRedirectOutput's, with no REDIRECT ORDER and no GOVERNOR ROUTING.
 */
export function nonReadDenyOutput(result, allowlist = ALLOWLIST) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: denyReasonFor(result, allowlist),
      additionalContext: denyOptionsFor(result, allowlist).join("\n"),
    },
  };
}

async function main() {
  const hookData = await readHookInput();
  if (hookData.tool_name !== "Bash") process.exit(0);
  if (isGuardrailsOff()) process.exit(0);

  const command = (hookData.tool_input || {}).command || "";
  // Loaded only here, after the guardrails-off exit. loadProjectAllowConfig never throws, so a
  // config fault cannot reach main().catch, whose exit 0 would fail open; it widens nothing.
  const projectConfig = loadProjectAllowConfig(PROJECT_DIR);
  const projectTokens = projectConfig.tokens;
  // Deduped: a declared cmd that is already a builtin (e.g. npx) is listed once.
  const effectiveAllowlist = [...new Set([...ALLOWLIST, ...projectTokens])];
  const result = classifyBashCommand(command, projectTokens);
  if (result.action === "allow") process.exit(0);

  // Research-Agent outage fallthrough (fail-closed) — read-class Bash ONLY. A metacharacter or
  // unknown command returns action:"deny" and never reaches here, so write-class / chained / obfus-
  // cated Bash stays HARD-DENIED even during an outage. A fresh infra breadcrumb lets a bare
  // cat/grep/find/head/tail/ls run directly for diagnosis instead of redirecting into the down agent.
  if (result.action === "redirect" && result.kind === "read") {
    const outage = isResearchAgentOutage(PROJECT_DIR);
    if (outage) {
      emitOutageFallthrough({ blockedTool: "Bash", targetPath: String(command).trim().slice(0, 160), category: outage.category, projectDir: PROJECT_DIR });
      process.exit(0);
    }
  }

  const projectId = getProjectId();
  const isRead = result.kind === "read";
  // R9: an 'unknown' denial names a declared-but-ignored testCommand instead of dropping it
  // silently. reason feeds appendTelemetry and emitGuardrailBump, so both carry the line too.
  const ignoredLine = result.kind === "unknown" ? ignoredTestCommandLine(projectConfig.ignored) : "";
  const reason = denyReasonFor(result, effectiveAllowlist) + (ignoredLine ? `\n${ignoredLine}` : "");
  const query = `inspect/search: ${String(command).trim().slice(0, 160)}`;

  appendTelemetry({
    ts: new Date().toISOString(),
    hook: "redirect-read-bash-to-agent",
    blocked: true,
    reason,
    command: String(command).slice(0, 200),
    projectId,
    kind: result.kind,
  });

  // git write verbs (commit/add/rm/stage) route to a Governor. Branches BEFORE the non-read block
  // below, whose text says no agent can run the command (false for git-write).
  if (result.kind === "git-write") {
    if (isKeyless()) {
      // Nothing is routed in keyless mode, so the bump carries no redirectAgent.
      emitGuardrailBump({ reason, blockedTool: "Bash", projectId });
      denyWithRedirect(gitWriteKeylessDenyOutput(result));
    }
    // buildRedirectOutput emits the guardrail bump (redirectAgent rks_agent_git); do not emit twice.
    const sub = gitSubcommand(String(command).trim().split(/\s+/));
    denyWithRedirect(buildRedirectOutput({
      reason,
      agent: "mcp__rks__rks_agent_git",
      agentParams: { projectId, request: `git ${sub} (blocked in Bash): ${String(command).trim().slice(0, 160)}` },
      instructions: [
        "The raw git command was not run. Do not retry it in Bash, and do not call rks_git_commit yourself (an untokened call is refused).",
        "To commit: launch the Ship Governor (/ship) ad-hoc Path 3 with `files` (the exact paths) and `rawMessage` (the complete message, trailers included); it commits via rks_git_commit and pushes with no story token. Or: rks_governor_init then rks_agent_git.",
        "To delete a tracked file, ask the user to run `git rm <path>` in their own terminal (it only stages the deletion), then commit through the Ship Governor ad-hoc Path 3 with that path in `files`.",
      ],
      project: projectId,
    }));
  }

  // Non-read denials (metacharacter, unknown verb) are NOT routed to an agent. The Research
  // Agent is read-only and rks has no ad-hoc execution agent, so a redirect could not act.
  if (!isRead) {
    emitGuardrailBump({ reason, blockedTool: "Bash", projectId });
    const out = nonReadDenyOutput(result, effectiveAllowlist);
    if (ignoredLine) {
      out.hookSpecificOutput.permissionDecisionReason += `\n${ignoredLine}`;
      out.hookSpecificOutput.additionalContext += `\n${ignoredLine}`;
    }
    denyWithRedirect(out);
  }

  // Keyless mode is MESSAGING-ONLY here (INV-2): the deny/redirect DECISION is unchanged — raw
  // reads stay governed — but with no LLM credential the Research Agent is unavailable, so point
  // the user at the keyless retrieval primitive (rks_rag_query) instead.
  const instructions = isKeyless() && isRead
    ? [
        "Keyless mode (no LLM credential): the Research Agent is unavailable.",
        "Use rks_rag_query for keyless semantic retrieval over the knowledge base instead of a raw file read/search.",
      ]
    : [
        "Read/search: launch the Research Agent (Verify pattern in CLAUDE.md) with what you need.",
      ];

  denyWithRedirect(buildRedirectOutput({
    reason,
    agent: "mcp__rks__rks_agent_research",
    agentParams: { projectId, query },
    instructions,
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
