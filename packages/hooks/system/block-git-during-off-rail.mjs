#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Route direct git write operations to guardrails-on during off-rail sessions.
 *
 * When guardrails are off (hooks.bak/ exists), agents should not run raw git
 * write commands (add, commit, push, stash, merge, rebase, reset, restore,
 * cherry-pick, revert, tag, rm, apply, am). Instead, treat the gesture as a completion
 * signal and route to rks_guardrails_on, which handles commit → branch → PR →
 * merge → cycle_complete automatically.
 *
 * Git read commands (status, diff, log, branch --list, show) are always allowed.
 *
 * Protected rks files (backlog.fix.child-bash-protected-rks-config-write-routes): off-rail this is
 * the only Bash gate (the read tier is relocated), so after the ship/discard routing every off-rail
 * Bash command — git or not, with or without shell operators — that names a protected rks path
 * (lib/protected-rks-paths.mjs), or a git checkout/restore whose pathspec can reach one, is denied.
 * A config-class path is exempt only when the session's .rks/active-scope.json is writeMode
 * "scoped" and allowedFiles holds that EXACT path; state-class paths are never exempt; a missing or
 * corrupt scope file exempts nothing.
 *
 * Fail-closed load: every static import is a Node builtin. ./hook-output.mjs and
 * ../lib/protected-rks-paths.mjs are loaded by guarded dynamic import. Off-rail, if either fails to
 * load, a builtin-only deny (exit 0) covers any command naming .rks or .routekit and any git
 * write/apply/am/checkout/restore; everything else exits 0 with no output. On-rail (no hooks.bak)
 * the hook always exits 0 with no output, whatever loaded.
 *
 * Tier: system (never disabled by rks_guardrails_off)
 */
import fs from "node:fs";
import path from "node:path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const HOOKS_BAK = path.join(PROJECT_DIR, ".routekit", "hooks.bak");

/**
 * Check if an off-rail session is active.
 * The presence of hooks.bak/ means rks_guardrails_off moved hooks there.
 */
function isOffRailActive() {
  return fs.existsSync(HOOKS_BAK);
}

/**
 * Extract git subcommands from a bash command string.
 * Handles chained commands (&&, ;, |).
 */
function extractGitSubcommands(command) {
  const gitCmdRegex = /\bgit\s+([a-z-]+)/gi;
  const matches = [];
  let m;
  while ((m = gitCmdRegex.exec(command)) !== null) {
    matches.push(m[1].toLowerCase());
  }
  return matches;
}

/**
 * Git subcommands that mutate the repository or working tree.
 * apply and am write the files a patch names, which the command line does not show.
 */
const WRITE_SUBCOMMANDS = new Set([
  "add",
  "commit",
  "push",
  "stash",
  "merge",
  "rebase",
  "reset",
  "restore",
  "clean",
  "cherry-pick",
  "revert",
  "tag",
  "rm",
  "apply",
  "am",
]);

/**
 * DISCARD gestures — the user is trying to THROW AWAY the off-rail work, not ship it.
 * These route to rks_guardrails_abort (discard + restore hooks, no commit/push) instead of
 * rks_guardrails_on (which always commits/ships). Destructive `git checkout -- <path>` is
 * added to this set in main(). (Without this split, a `git reset` to bail out gets hijacked
 * into a ship — the exact trap that made backing out off-rail work so painful.)
 */
const DISCARD_SUBCOMMANDS = new Set([
  "reset",
  "restore",
  "stash",
  "clean",
]);

/**
 * Check if the full command contains dangerous checkout patterns.
 * We allow `git checkout <branch>` for navigation but block `git checkout -- .`
 * which discards changes.
 */
function isDestructiveCheckout(command) {
  return /\bgit\s+checkout\s+--\s/i.test(command);
}

// git global options that take their value as the next word.
const GIT_OPTS_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path",
]);
// git subcommands whose pathspecs can overwrite working-tree files.
const PATHSPEC_SUBCOMMANDS = new Set(["checkout", "restore"]);

/**
 * Pure, builtin-only, never throws. Splits a command into word lists at shell operators
 * (; & | newline parentheses redirections backtick), dequoting single and double quotes.
 * Lexical only: used to find git checkout/restore pathspecs, never to allow anything.
 */
function shellSegments(command) {
  const segs = [[]];
  try {
    let cur = null;
    let quote = null;
    const flush = () => { if (cur !== null) { segs[segs.length - 1].push(cur); cur = null; } };
    const text = String(command);
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = null;
        else cur += ch;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; if (cur === null) cur = ""; continue; }
      if (ch === "\\" && i + 1 < text.length) { cur = (cur ?? "") + text[++i]; continue; }
      if (ch === " " || ch === "\t") { flush(); continue; }
      if (";&|\n\r()<>`".includes(ch)) {
        flush();
        if (segs[segs.length - 1].length) segs.push([]);
        continue;
      }
      cur = (cur ?? "") + ch;
    }
    flush();
  } catch {
    // return what was read
  }
  return segs.filter((s) => s.length);
}

/**
 * Pure, never throws. For each git invocation in the command: { sub, idx, base, words }, where
 * base is the directory pathspecs resolve against (PROJECT_DIR moved by -C options).
 */
function gitInvocations(command) {
  const out = [];
  for (const words of shellSegments(command)) {
    const g = words.findIndex((w) => path.basename(w) === "git");
    if (g === -1) continue;
    let base = path.resolve(PROJECT_DIR);
    let idx = -1;
    for (let i = g + 1; i < words.length; i++) {
      const t = words[i];
      if (t === "-C") { base = path.resolve(base, words[i + 1] ?? ""); i++; continue; }
      if (t.startsWith("-C")) { base = path.resolve(base, t.slice(2)); continue; }
      if (t.startsWith("-")) { if (GIT_OPTS_WITH_VALUE.has(t)) i++; continue; }
      idx = i;
      break;
    }
    if (idx !== -1) out.push({ sub: words[idx].toLowerCase(), idx, base, words });
  }
  return out;
}

/** Builtin-only PreToolUse deny; exits 0. No telemetry write (lib/redact.mjs may be absent). */
function writeDeny(reason, additionalContext) {
  const hookSpecificOutput = {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  };
  if (additionalContext) hookSpecificOutput.additionalContext = additionalContext;
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
  process.exit(0);
}

async function readStdinJson() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

/** True when every case-insensitive occurrence of each form of p in text is written exactly as p. */
function namedInExactCase(text, p) {
  const folded = String(text).replace(/\\/g, "/");
  const lower = folded.toLowerCase();
  const forms = [p, path.posix.basename(p), p.split("/")[0]];
  for (const form of forms) {
    const lf = form.toLowerCase();
    let at = lower.indexOf(lf);
    while (at !== -1) {
      if (folded.slice(at, at + form.length) !== form) return false;
      at = lower.indexOf(lf, at + 1);
    }
  }
  return true;
}

/**
 * Protected rks paths the command may touch that this session does not exempt. Any error inside
 * is caught here and treated as "all named paths blocked" (never reaches main().catch).
 */
function blockedProtectedPaths(command, lib) {
  let hits = new Set();
  try {
    hits = new Set(lib.protectedPathsNamedIn(command));
    for (const inv of gitInvocations(command)) {
      if (!PATHSPEC_SUBCOMMANDS.has(inv.sub)) continue;
      let afterDashDash = false;
      for (let i = inv.idx + 1; i < inv.words.length; i++) {
        const w = inv.words[i];
        if (!afterDashDash && w === "--") { afterDashDash = true; continue; }
        if (!afterDashDash && w.startsWith("-")) continue;
        for (const p of lib.pathspecProtectedPaths(w, PROJECT_DIR, inv.base)) hits.add(p);
      }
    }
    if (!hits.size) return [];
    const exempt = lib.exemptConfigPaths(PROJECT_DIR);
    return [...hits].filter((p) => !(
      exempt instanceof Set && exempt.has(p)
      && lib.PROTECTED_CONFIG_PATHS.includes(p)
      && namedInExactCase(command, p)
    ));
  } catch {
    return hits.size ? [...hits] : [...(lib.PROTECTED_CONFIG_PATHS || []), ...(lib.PROTECTED_STATE_PATHS || [])];
  }
}

function protectedDenyText(paths, lib) {
  const config = paths.filter((p) => lib.PROTECTED_CONFIG_PATHS.includes(p));
  const state = paths.filter((p) => !lib.PROTECTED_CONFIG_PATHS.includes(p));
  const reason = `Off-rail: this command names protected rks file(s): ${paths.join(", ")}. `
    + "A command line cannot be proven read-only, so any off-rail Bash command naming a protected path is denied, even a read-only one.";
  const lines = [`Protected rks file(s) named: ${paths.join(", ")}.`];
  if (config.length) {
    lines.push(`${config.join(", ")}: to change ${config.length === 1 ? "it" : "them"}, build a story whose targetFiles lists the exact path guardrails-off (an exact allowedFiles entry of this off-rail session exempts it), or ask the user to edit the file directly.`);
  }
  if (state.length) {
    lines.push(`${state.join(", ")}: runtime state written only by the rks MCP server; no Bash command may write ${state.length === 1 ? "it" : "them"}, and no allowedFiles entry exempts ${state.length === 1 ? "it" : "them"}.`);
  }
  lines.push("To read a protected file, use the Read tool.");
  lines.push("For git checkout or git restore, narrow the pathspec to the files you mean (a pathspec of ., a protected directory, a glob or pathspec magic can reach protected files).");
  return { reason, context: lines.join("\n") };
}

/** Existing ship/discard routing (unchanged apart from apply/am joining WRITE_SUBCOMMANDS). */
function routeGitWrite(command, out) {
  if (!/\bgit\s+/i.test(command)) return;

  // Extract git subcommands and check for write operations
  const subcommands = extractGitSubcommands(command);
  const writeOps = subcommands.filter(sc => WRITE_SUBCOMMANDS.has(sc));

  // Also check for destructive checkout
  if (isDestructiveCheckout(command)) {
    writeOps.push("checkout --");
  }

  if (writeOps.length === 0) {
    // git status, diff, log, branch, show, etc. are fine
    return;
  }

  const { getProjectId, buildRedirectOutput, denyWithRedirect } = out;
  const projectId = getProjectId();
  const ops = [...new Set(writeOps)].join(", ");

  // Route by INTENT. A DISCARD gesture (reset / restore / stash / clean / `checkout -- <path>`)
  // means "throw this off-rail work away" → rks_guardrails_abort. Anything else (commit / push /
  // merge / apply / am / …) means "ship it" → rks_guardrails_on. This split is what gives off-rail
  // a real abort path instead of forcing every git-write gesture into a ship.
  const isDiscard =
    writeOps.some((op) => DISCARD_SUBCOMMANDS.has(op)) || isDestructiveCheckout(command);

  if (isDiscard) {
    denyWithRedirect(buildRedirectOutput({
      reason: `Off-rail: raw git ${ops} is disabled. This looks like you want to DISCARD the off-rail work — use rks_guardrails_abort (throws away all changes + restores hooks, no commit/push).`,
      agent: "mcp__rks__rks_guardrails_abort",
      agentParams: { projectId },
      instructions: [
        "Call mcp__rks__rks_guardrails_abort with the projectId to discard all off-rail changes (hard reset to the session-start commit), restore the hooks, and end the session WITHOUT committing or pushing.",
        "If you actually meant to KEEP and ship the work, call mcp__rks__rks_guardrails_on instead.",
      ],
      project: projectId,
    }));
    return;
  }

  denyWithRedirect(buildRedirectOutput({
    reason: `Looks like you're done with your changes — completing the off-rail session (git ${ops} detected).`,
    agent: "mcp__rks__rks_guardrails_on",
    agentParams: { projectId },
    instructions: [
      "Call mcp__rks__rks_guardrails_on with the projectId to commit, branch, open a PR, merge, and complete the cycle automatically.",
      "If you meant to THROW AWAY this off-rail work instead, call mcp__rks__rks_guardrails_abort.",
    ],
    project: projectId,
  }));
}

async function main() {
  let hookData;
  try {
    hookData = await readStdinJson();
  } catch {
    process.exit(0);
  }
  // Only enforce on Bash tool
  if (!hookData || hookData.tool_name !== "Bash") process.exit(0);

  const command = String((hookData.tool_input || {}).command || "");

  // Only enforce during off-rail sessions
  if (!isOffRailActive()) process.exit(0);

  // Guarded loads: a failure here never aborts the process (a static import would exit 1, which
  // Claude Code treats as a non-blocking error, i.e. an allow).
  let out = null;
  try {
    const mod = await import("./hook-output.mjs");
    if (typeof mod.buildRedirectOutput === "function" && typeof mod.denyWithRedirect === "function"
      && typeof mod.getProjectId === "function") out = mod;
  } catch {
    out = null;
  }
  let lib = null;
  try {
    const mod = await import("../lib/protected-rks-paths.mjs");
    if (Array.isArray(mod.PROTECTED_CONFIG_PATHS) && Array.isArray(mod.PROTECTED_STATE_PATHS)
      && typeof mod.protectedPathsNamedIn === "function" && typeof mod.pathspecProtectedPaths === "function"
      && typeof mod.exemptConfigPaths === "function") lib = mod;
  } catch {
    lib = null;
  }

  // Existing ship/discard routing runs first, exactly as before.
  if (out) routeGitWrite(command, out);

  if (!out || !lib) {
    const failed = [!out && "system/hook-output.mjs", !lib && "lib/protected-rks-paths.mjs"].filter(Boolean);
    let deny = true;
    try {
      const lower = command.toLowerCase().replace(/\\/g, "/");
      const subs = new Set([
        ...extractGitSubcommands(command),
        ...gitInvocations(command).map((inv) => inv.sub),
      ]);
      deny = lower.includes(".rks") || lower.includes(".routekit")
        || [...subs].some((s) => WRITE_SUBCOMMANDS.has(s) || PATHSPEC_SUBCOMMANDS.has(s));
    } catch {
      deny = true;
    }
    if (!deny) process.exit(0);
    writeDeny(
      `Off-rail: denied fail-closed because the hook could not load ${failed.join(" and ")}, so it cannot check this command against the protected rks paths or route git writes. Commands naming .rks or .routekit and git write, apply, am, checkout or restore are refused until the hooks tree is repaired (re-sync the hooks).`,
      "To read a file, use the Read tool. To finish or discard the off-rail session, call mcp__rks__rks_guardrails_on or mcp__rks__rks_guardrails_abort.",
    );
  }

  const blocked = blockedProtectedPaths(command, lib);
  if (!blocked.length) process.exit(0);
  const { reason, context } = protectedDenyText(blocked, lib);
  writeDeny(reason, context);
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0); // On error, allow to avoid blocking work
});
