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
 * Classification is anchored on the LEADING word (never a substring) and any
 * UNQUOTED shell metacharacter (or ambiguous quoting) rejects the command outright,
 * so an allowlisted prefix cannot smuggle a second command ("npm run x && cat
 * secrets" → denied). Words are read quote-aware via scanShellWords; a metacharacter
 * inside balanced quotes is honored only for read verbs and for a git command in
 * which every global option before the subcommand is on the permitted list
 * (GIT_GLOBAL_OPTS_ALLOWLIST; backlog.fix.child-bash-git-shell-exec-bypass, which
 * replaced the denylist of backlog.fix.bash-metachar-check-quote-aware, D2).
 *
 * A git command that can reach a shell is denied with kind git-exec: a global option
 * outside GIT_GLOBAL_OPTS_ALLOWLIST (-c, --config-env, --exec-path, --attr-source, …),
 * a subcommand outside GIT_SUBCOMMAND_ALLOWLIST (closes aliases and git config), an
 * exec-taking or file-writing long option, or rebase short -x
 * (backlog.fix.child-bash-git-shell-exec-bypass).
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
import { scanShellWords } from "../lib/shell-words.mjs";

// Shared protected rks paths, loaded by a GUARDED dynamic import (never a static one): a hooks tree
// that has this hook but not the lib (version skew) must not lose the whole hook. A rejected import,
// or a module whose path lists are not arrays, is a load failure, and classifyBashCommand then
// classifies fail-closed (see protectedConfigCheck). Top-level await keeps classifyBashCommand sync.
// @see backlog.fix.child-bash-protected-rks-config-write-routes
let PROTECTED_LIB = null;
try {
  const mod = await import("../lib/protected-rks-paths.mjs");
  if (
    Array.isArray(mod.PROTECTED_CONFIG_PATHS) && Array.isArray(mod.PROTECTED_STATE_PATHS)
    && typeof mod.protectedPathsNamedIn === "function" && typeof mod.pathspecProtectedPaths === "function"
  ) {
    PROTECTED_LIB = mod;
  }
} catch {
  PROTECTED_LIB = null;
}

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

// Research-Agent outage fallthrough: the ONLY verbs that may run directly under a fresh outage
// breadcrumb. Exact-string match on the dequoted leading word (no basename, no path form, no case
// folding). Deliberately excludes every other READ_COMMANDS verb: sed -i, sort -o, uniq <in> <out>,
// tree -o, xxd -r write files; rg --pre, fd -x/--exec run commands; the rest add nothing a
// diagnosis needs. cat, grep, head, tail and ls have no write or exec option in GNU or BSD form,
// so no flag filter is applied to them; any verb added here must re-justify that or add a filter.
// Module-private and never exported, so no importer can widen it (a frozen Set is still mutable).
// @see backlog.fix.outage-fallthrough-bash-verb-allowlist
const OUTAGE_FALLTHROUGH_VERBS = new Set(["cat", "grep", "find", "head", "tail", "ls"]);

// find primaries that write, delete or execute. Any word equal to or starting with one of these
// denies (startsWith covers -fprint0/-fprintf; -exec also over-denies -executable, accepted).
const FIND_WRITE_EXEC_PRIMARIES = Object.freeze([
  "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls",
]);

/**
 * Pure, no I/O, never throws. Given the DEQUOTED words (scanShellWords(...).words) of a command,
 * true only when it may run directly under a Research-Agent outage: words[0] is exactly one of
 * OUTAGE_FALLTHROUGH_VERBS and, for find, no word equals or starts with a write/exec primary.
 * Any non-array, empty array, non-string word or exception → false (fail closed).
 * @see backlog.fix.outage-fallthrough-bash-verb-allowlist
 */
export function isOutageSafeReadCommand(words) {
  try {
    if (!Array.isArray(words)) return false;
    const len = words.length;
    if (typeof len !== "number" || len < 1) return false;
    const list = [];
    for (let i = 0; i < len; i++) {
      const w = words[i];
      if (typeof w !== "string") return false;
      list.push(w);
    }
    const verb = list[0];
    if (!OUTAGE_FALLTHROUGH_VERBS.has(verb)) return false;
    if (verb === "find") {
      for (let i = 1; i < list.length; i++) {
        const w = list[i];
        if (FIND_WRITE_EXEC_PRIMARIES.some((p) => w === p || w.startsWith(p))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

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
 * Pure, no I/O, never throws. Given the dequoted words (from scanShellWords) of a command whose first token
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
 *   { action: "deny", kind: "git-exec" }         git that can reach a shell (config, alias, exec option)
 *   { action: "deny", kind: "protected-config", paths }  names protected rks config/state, git apply/am,
 *                                                or a checkout/restore pathspec that can reach it
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

// git global options (before the subcommand) permitted in child Bash. Everything else there is
// denied git-exec: -c (any form), --config-env and --exec-path carry shell through config or an
// alias, and an unknown value-taking option (e.g. --attr-source) would make the subcommand git
// runs differ from the one gitSubcommand reads. Matching is case-exact and name-exact (no
// abbreviation). Every separate-value option here is also in GIT_OPTS_WITH_VALUE, so whenever
// gitGlobalsAllowed passes, gitSubcommand names the word git runs as the subcommand.
// @see backlog.fix.child-bash-git-shell-exec-bypass
const GIT_GLOBAL_OPTS_ALLOWLIST = Object.freeze({
  // -C <path> (separate) or -C<path> (attached).
  dirOption: "-C",
  // Separate (consumes the next word) or = form.
  withValue: new Set(["--git-dir", "--work-tree", "--namespace"]),
  // Exact, no value.
  exact: new Set([
    "--no-pager", "-P", "-p", "--paginate", "--bare", "--no-replace-objects",
    "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs",
    "--no-optional-locks",
  ]),
});

// git subcommands a child may run directly in Bash (D1). Fail-closed: anything else, including
// every alias (an alias cannot shadow a builtin, so none of these can be one), is denied git-exec.
// Deliberately absent: config, clone, init, submodule, bisect, difftool, mergetool, filter-branch,
// archive, daemon, instaweb, hook, credential, send-email, grep, help, ls-remote.
const GIT_SUBCOMMAND_ALLOWLIST = new Set([
  "am", "apply", "blame", "branch", "cat-file", "checkout", "cherry", "cherry-pick", "commit-tree",
  "describe", "diff", "fetch", "for-each-ref", "format-patch", "log", "ls-files", "ls-tree",
  "merge", "merge-base", "mv", "pull", "push", "range-diff", "rebase", "reflog", "remote", "reset",
  "restore", "rev-list", "rev-parse", "revert", "shortlog", "show", "show-ref", "stash", "status",
  "switch", "symbolic-ref", "tag", "version", "worktree",
]);

// Long options (after the subcommand) that take a command or write a chosen file. Matched two-way
// by prefix (d.startsWith(n) || n.startsWith(d)) so unambiguous abbreviations (--upl, --outp) and
// longer names (--output-directory) are both denied; the latter is accepted fail-closed friction.
const GIT_EXEC_LONG_OPTS = [
  "upload-pack", "receive-pack", "exec", "config", "template", "open-files-in-pager", "output",
];

/**
 * Pure, no I/O, never throws. Index of the git subcommand in `words` (same skip rule as
 * gitSubcommand), or -1 when there is none.
 */
function gitSubcommandIndex(words) {
  for (let i = 1; i < words.length; i++) {
    const t = String(words[i]);
    if (t.startsWith("-")) {
      if (GIT_OPTS_WITH_VALUE.has(t)) i++;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Pure, no I/O, never throws. True only when every word starting with `-` between `git` and the
 * subcommand is on GIT_GLOBAL_OPTS_ALLOWLIST. Read by both the git-exec check and the quote
 * relaxation, so no global option can pass one gate and fail the other. On exception: false.
 */
function gitGlobalsAllowed(words) {
  try {
    const { dirOption, withValue, exact } = GIT_GLOBAL_OPTS_ALLOWLIST;
    for (let i = 1; i < words.length; i++) {
      const t = String(words[i]);
      if (!t.startsWith("-")) return true;
      if (t === dirOption || withValue.has(t)) { i++; continue; }
      if (t.startsWith(dirOption)) continue;
      if ([...withValue].some((o) => t.startsWith(`${o}=`))) continue;
      if (exact.has(t)) continue;
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure, no I/O, never throws. True when a git command (dequoted words, words[0] === "git") can
 * reach a shell or write a chosen file: a global option off GIT_GLOBAL_OPTS_ALLOWLIST, a
 * subcommand off GIT_SUBCOMMAND_ALLOWLIST, an exec-taking or file-writing long option after the
 * subcommand, or rebase short -x. On exception: true (deny).
 */
function gitCanReachShell(words) {
  try {
    if (!gitGlobalsAllowed(words)) return true;
    const idx = gitSubcommandIndex(words);
    if (idx === -1) return false;
    const sub = String(words[idx]);
    if (!GIT_SUBCOMMAND_ALLOWLIST.has(sub)) return true;
    for (let i = idx + 1; i < words.length; i++) {
      const t = String(words[i]);
      if (t.startsWith("--")) {
        const n = t.slice(2).split("=")[0];
        if (n && GIT_EXEC_LONG_OPTS.some((d) => d.startsWith(n) || n.startsWith(d))) return true;
      } else if (sub === "rebase" && t.startsWith("-") && t.includes("x")) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Pure, no I/O. D2: whether a command whose only metacharacters are inside balanced quotes may
 * proceed past the metacharacter check. Only read verbs (redirected, never run) and a git command
 * in which every global option before the subcommand is on the permitted list (gitGlobalsAllowed
 * over GIT_GLOBAL_OPTS_ALLOWLIST, the same predicate the git-exec check uses) qualify; every other
 * verb, including a project testCommand token, keeps the metacharacter denial.
 */
function quoteRelaxationApplies(words) {
  const token = words[0];
  if (READ_COMMANDS.has(token)) return true;
  if (token === "git") return gitGlobalsAllowed(words);
  return false;
}

// git subcommands whose written paths cannot be read off the command line (they live in the patch).
const GIT_PATCH_SUBCOMMANDS = new Set(["apply", "am"]);
// git subcommands whose pathspecs can overwrite working-tree files with another version.
const GIT_PATHSPEC_SUBCOMMANDS = new Set(["checkout", "restore"]);

/**
 * Pure, never throws. The directory git resolves pathspecs against: projectDir, moved by each
 * `-C <dir>` / `-C<dir>` global option before the subcommand (successive -C options compound).
 */
function gitBaseDir(words, idx, projectDir) {
  let base = path.resolve(projectDir);
  try {
    for (let i = 1; i < idx; i++) {
      const t = String(words[i]);
      if (t === "-C") { base = path.resolve(base, String(words[i + 1] ?? "")); i++; continue; }
      if (t.startsWith("-C")) { base = path.resolve(base, t.slice(2)); continue; }
      if (GIT_OPTS_WITH_VALUE.has(t)) i++;
    }
  } catch {
    // keep the last resolved base
  }
  return base;
}

/**
 * Pure apart from the module-load state; never throws. The protected rks config check for a
 * NON-read leading verb (a READ_COMMANDS verb returns null and keeps its redirect/read kind,
 * ARCH Item 11). Returns a protected-config deny result or null.
 *   - git apply / git am: always denied (the patch, not the command, names the files).
 *   - any other verb: denied when the command text names a protected path (lib fragment rule);
 *     for git checkout / git restore also when a pathspec word may reach one (., a protected
 *     directory, a glob, pathspec magic, or a path resolving to a member, -C aware).
 *   - lib not loaded: fail closed. git apply/am/checkout/restore in any form, and any command
 *     whose text contains .rks or .routekit, are denied.
 * @see backlog.fix.child-bash-protected-rks-config-write-routes
 */
function protectedConfigCheck(tokens, text, projectDir) {
  const token = tokens[0];
  if (READ_COMMANDS.has(token)) return null;
  const idx = token === "git" ? gitSubcommandIndex(tokens) : -1;
  const sub = idx === -1 ? null : String(tokens[idx]);
  const deny = (paths, extra = {}) => ({ action: "deny", kind: "protected-config", paths, ...extra });
  if (!PROTECTED_LIB) {
    if (sub && (GIT_PATCH_SUBCOMMANDS.has(sub) || GIT_PATHSPEC_SUBCOMMANDS.has(sub))) {
      return deny([], { gitOp: sub, libUnavailable: true });
    }
    const lower = String(text).toLowerCase().replace(/\\/g, "/");
    if (lower.includes(".rks") || lower.includes(".routekit")) return deny([], { libUnavailable: true });
    return null;
  }
  try {
    if (sub && GIT_PATCH_SUBCOMMANDS.has(sub)) return deny([], { gitOp: sub });
    const hits = new Set(PROTECTED_LIB.protectedPathsNamedIn(text));
    if (sub && GIT_PATHSPEC_SUBCOMMANDS.has(sub)) {
      const base = gitBaseDir(tokens, idx, projectDir);
      let afterDashDash = false;
      for (let i = idx + 1; i < tokens.length; i++) {
        const w = String(tokens[i]);
        if (!afterDashDash && w === "--") { afterDashDash = true; continue; }
        if (!afterDashDash && w.startsWith("-")) continue;
        for (const p of PROTECTED_LIB.pathspecProtectedPaths(w, projectDir, base)) hits.add(p);
      }
      if (hits.size) return deny([...hits], { gitOp: sub });
    }
    return hits.size ? deny([...hits]) : null;
  } catch {
    return deny([], { libUnavailable: true });
  }
}

export function classifyBashCommand(command, extraTokens, projectDir = PROJECT_DIR) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return { action: "allow", kind: "empty" };
  const scan = scanShellWords(trimmed);
  if (!scan.ok) return { action: "deny", kind: "metacharacter" };
  const tokens = scan.words;
  if (tokens.length === 0) return { action: "deny", kind: "metacharacter" };
  if (scan.quotedMeta && !quoteRelaxationApplies(tokens)) return { action: "deny", kind: "metacharacter" };
  const token = tokens[0];
  // Checked before the allowlist (and the project testCommand widening below), so neither can
  // admit a git write verb.
  if (token === "git" && GIT_WRITE_SUBCOMMANDS.has(gitSubcommand(tokens))) {
    return { action: "deny", kind: "git-write" };
  }
  // After git-write (so a write verb keeps that kind) and before the allowlist and the project
  // testCommand widening (so neither can admit it). @see backlog.fix.child-bash-git-shell-exec-bypass
  if (token === "git" && gitCanReachShell(tokens)) {
    return { action: "deny", kind: "git-exec" };
  }
  // After git-write and git-exec (so those kinds hold) and before the allowlist and the project
  // testCommand widening (so neither can admit it). Skipped for READ_COMMANDS verbs, which keep
  // redirect/read. @see backlog.fix.child-bash-protected-rks-config-write-routes
  const protectedResult = protectedConfigCheck(tokens, trimmed, projectDir || PROJECT_DIR);
  if (protectedResult) return protectedResult;
  if (ALLOWLIST.has(token)) return { action: "allow", kind: "allowlisted" };
  if (READ_COMMANDS.has(token)) return { action: "redirect", kind: "read" };
  // Project-declared tokens are consulted only AFTER the read redirect, so even a caller that
  // passes a read verb here cannot turn a read into a direct allow.
  if (extraTokens && new Set(extraTokens).has(token)) return { action: "allow", kind: "allowlisted" };
  return { action: "deny", kind: "unknown" };
}

const PROTECTED_STORY_ROUTE = "To change a protected config file, file a story whose targetFiles lists its exact path and build it guardrails-off, or ask the user to edit the file directly.";

/**
 * Pure, no I/O. The reason for a protected-config denial: names the protected file(s) (split into
 * config and runtime-state classes), the governed route to change a config file, and, for git
 * apply/am or a checkout/restore pathspec, what to do instead. Never advises turning hooks off.
 * @see backlog.fix.child-bash-protected-rks-config-write-routes
 */
function protectedConfigReason(result) {
  const paths = Array.isArray(result && result.paths) ? result.paths.map(String) : [];
  const gitOp = result && result.gitOp;
  if (result && result.libUnavailable) {
    const what = gitOp ? `git ${gitOp}` : "this command, which names .rks or .routekit,";
    return `Denied fail-closed: the hook could not load lib/protected-rks-paths.mjs, so it cannot verify that ${what} leaves protected rks configuration untouched. Until the hooks tree is repaired (re-sync the hooks), git apply, git am, git checkout, git restore and any non-read command naming .rks or .routekit are refused. Read files through the Research Agent. ${PROTECTED_STORY_ROUTE}`;
  }
  if (gitOp === "apply" || gitOp === "am") {
    return `git ${gitOp} is denied in child Bash: a patch's target files cannot be verified from the command, so it could rewrite protected rks configuration (such as .rks/project.json). Make the change with a story built through the normal plan, or ask the user to apply the patch in their own terminal. ${PROTECTED_STORY_ROUTE}`;
  }
  const config = PROTECTED_LIB ? paths.filter((p) => PROTECTED_LIB.PROTECTED_CONFIG_PATHS.includes(p)) : paths;
  const state = PROTECTED_LIB ? paths.filter((p) => PROTECTED_LIB.PROTECTED_STATE_PATHS.includes(p)) : [];
  const parts = [`This command names protected rks file(s): ${paths.join(", ")}.`];
  parts.push("A command line cannot be proven read-only, so any non-read command naming a protected path is denied, even a read-only one. Read files through the Research Agent.");
  if (config.length) parts.push(`${config.join(", ")} configure what rks permits. ${PROTECTED_STORY_ROUTE}`);
  if (state.length) parts.push(`${state.join(", ")} ${state.length === 1 ? "is" : "are"} runtime state written only by the rks MCP server; no Bash command may write ${state.length === 1 ? "it" : "them"}.`);
  if (gitOp === "checkout" || gitOp === "restore") {
    parts.push(`To discard changes elsewhere, narrow the pathspec to the files you mean (for example \`git restore src\` or \`git checkout -- src/app.ts\`): a pathspec of ., a protected directory, a glob or pathspec magic can reach protected files.`);
  }
  return parts.join(" ");
}

/**
 * Pure deny-reason builder, no I/O. Takes a classifyBashCommand() result and returns the
 * user-facing reason. A metacharacter denial must not claim the verb is off the allowlist:
 * the scanShellWords metacharacter check runs before the leading verb is looked at.
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
    return "This command contains an unquoted shell metacharacter (one of ; & | ` $ ( ) { } < > \\ or a newline), or quoting the hook cannot read unambiguously (an unbalanced quote; $, a backtick or a backslash escape inside double quotes; a newline inside quotes; or a quoted metacharacter on a verb other than a read command or a git command in which every global option before the subcommand is on the permitted list, such as -C, --git-dir or --no-pager). The child Bash hook denies such a command before its leading verb is considered. Drop redirection, pipes, chaining and substitution (for example remove `2>&1`, or split `a && b` into separate calls), or use one of the other options listed with this denial.";
  }
  if (kind === "protected-config") return protectedConfigReason(result);
  if (kind === "git-exec") {
    return "This git command was denied because it can run a shell command: config injection (-c, --config-env, git config), a global option before the subcommand that is not on the permitted list (such as --exec-path or --attr-source), an alias or any subcommand outside the child git subcommand allowlist, a command-taking option (rebase --exec/-x, --upload-pack, --receive-pack) or a file-writing option such as --output. git itself runs directly in Bash only with a subcommand from that allowlist and no such option.";
  }
  return `This command is not on the child allowlist. Allowlisted build/run commands (${[...allowlist].join(", ")}) run directly; everything else must be governed.`;
}

/**
 * Pure, no I/O. The options a caller actually has after a NON-READ denial (metacharacter,
 * git-exec or unknown verb). No agent can run the command: rks has no ad-hoc execution agent and the
 * Research Agent is read-only, so these lines never route to one.
 */
export function denyOptionsFor(result, allowlist = ALLOWLIST) {
  const kind = result && result.kind;
  const first = kind === "metacharacter"
    ? "1. Drop the unquoted metacharacter or split the command: remove redirection such as `2>&1`, and run chained commands such as `a && b` as separate calls. Metacharacters inside balanced quotes are read as literal text only for read commands and for a git command in which every global option before the subcommand is on the permitted list, such as -C, --git-dir or --no-pager; inside double quotes, $, backticks and backslash escapes are still refused."
    : kind === "protected-config"
    ? `1. Do not change protected rks files from Bash. To read one, launch the Research Agent. ${PROTECTED_STORY_ROUTE} For git checkout or git restore, narrow the pathspec to the files you mean.`
    : kind === "git-exec"
    ? `1. Rewrite the git command without the shell-capable part: use a subcommand from the permitted list (${[...GIT_SUBCOMMAND_ALLOWLIST].join(", ")}), no global option other than -C, --git-dir, --work-tree, --namespace, --no-pager, -P/-p/--paginate, --bare or the pathspec/lock flags, no alias, and no command-taking or file-writing option (--exec/-x, --upload-pack, --receive-pack, --config, --template, --open-files-in-pager, --output). git config and aliases are never run here.`
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

  // Research-Agent outage fallthrough (fail-closed) — read-class Bash ONLY, and only for a command
  // with no metacharacter anywhere, quoted or unquoted. A command with an unquoted metacharacter, or
  // an unknown verb, returns action:"deny" and never reaches here. A read verb whose only
  // metacharacters are quoted classifies redirect/read under the quote relaxation, but its quoted
  // payload can still execute (awk system(), find -exec sh -c), so it takes the normal Research
  // Agent redirect below instead of running. A fresh infra breadcrumb lets ONLY an explicit
  // allowlist run directly for diagnosis (isOutageSafeReadCommand over the dequoted words):
  // cat/grep/find/head/tail/ls, exact verb, with find's write/exec primaries (-exec, -execdir, -ok,
  // -okdir, -delete, -fprint*, -fls) denied. Every other read verb (sed, awk, sort, rg, fd, …) and
  // any denied find primary takes the normal Research Agent redirect below.
  // @see backlog.fix.bash-metachar-check-quote-aware
  // @see backlog.fix.outage-fallthrough-bash-verb-allowlist
  if (result.action === "redirect" && result.kind === "read") {
    const outageScan = scanShellWords(String(command).trim());
    const outage = outageScan.ok && !outageScan.quotedMeta && isOutageSafeReadCommand(outageScan.words)
      ? isResearchAgentOutage(PROJECT_DIR)
      : false;
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
    const sub = gitSubcommand(scanShellWords(String(command).trim()).words);
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

  // Non-read denials (metacharacter, git-exec, unknown verb) are NOT routed to an agent. The Research
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
