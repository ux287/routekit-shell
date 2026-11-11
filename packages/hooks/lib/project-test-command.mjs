/**
 * Shared project test-command helpers for the child hooks.
 * backlog.fix.git-workflow-hook-ignores-project-test-command
 *
 * Hooks may not import @routekit/mcp-rks (backlog.fix.child-hook-dependency-vendoring), so this is
 * the hook-side reader of the resolveTestCommand shape { cmd: string, args?: string[] }.
 * Two keys share that shape: testCommand, and the OPTIONAL commitTestCommand, which only the
 * pre-commit gate consults (A1, A3). The Bash allowlist reads testCommand only (A2).
 * Project-level ONLY: reads <projectDir>/.rks/project.json; never HOME, ~/.claude or env.
 */
import fs from "fs";
import path from "path";
import { spawnSync, execFileSync } from "child_process";

const META_RE = /[;&|`$(){}<>\\\n]/;

/** The project-level keys that share the { cmd, args } shape (A1, A2). */
export const PROJECT_COMMAND_KEYS = Object.freeze(["testCommand", "commitTestCommand"]);

/**
 * Never throws. Reads ONE key of PROJECT_COMMAND_KEYS. Returns { command, ignored, fileLevel }:
 *   command   - { cmd, args } (cmd verbatim, args copied) or null.
 *   ignored   - null when nothing was declared (ENOENT, or the key is absent) or when accepted;
 *               otherwise { reason, cmd? }: "unreadable" (I/O error other than ENOENT) or
 *               "malformed" (bad JSON, non-object top level, wrong-shaped key/cmd/args).
 *   fileLevel - true when the failure is the whole file (I/O error, bad JSON, non-object top
 *               level), so NO key in it could be read; false otherwise.
 */
export function readProjectCommand(projectDir, key) {
  const none = (ignored, fileLevel = false) => ({ command: null, ignored, fileLevel });
  try {
    if (!PROJECT_COMMAND_KEYS.includes(key)) return none({ reason: "malformed" });
    let text;
    try {
      text = fs.readFileSync(path.join(projectDir, ".rks", "project.json"), "utf8");
    } catch (err) {
      return err && err.code === "ENOENT" ? none(null) : none({ reason: "unreadable" }, true);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return none({ reason: "malformed" }, true);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return none({ reason: "malformed" }, true);
    const tc = parsed[key];
    if (tc === undefined) return none(null);
    if (!tc || typeof tc !== "object" || Array.isArray(tc)) return none({ reason: "malformed" });
    if (typeof tc.cmd !== "string" || !tc.cmd.trim()) return none({ reason: "malformed" });
    const first = tc.cmd.trim().split(/\s+/)[0];
    if (tc.args !== undefined && (!Array.isArray(tc.args) || !tc.args.every((a) => typeof a === "string"))) {
      return none({ reason: "malformed", cmd: first });
    }
    return { command: { cmd: tc.cmd, args: Array.isArray(tc.args) ? [...tc.args] : [] }, ignored: null, fileLevel: false };
  } catch {
    return none({ reason: "unreadable" }, true);
  }
}

/**
 * testCommand ONLY, with the unchanged D1 contract { command, ignored }. This is what
 * redirect-read-bash-to-agent.mjs loadProjectAllowConfig delegates to; the Bash allowlist never
 * reads commitTestCommand (A2).
 */
export function readProjectTestCommand(projectDir) {
  const { command, ignored } = readProjectCommand(projectDir, "testCommand");
  return { command, ignored };
}

/** commitTestCommand ONLY, same { command, ignored } contract. Consulted by the commit gate only (A1). */
export function readProjectCommitTestCommand(projectDir) {
  const { command, ignored } = readProjectCommand(projectDir, "commitTestCommand");
  return { command, ignored };
}

function packageHasTestScript(projectDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
    return !!(pkg && pkg.scripts && typeof pkg.scripts.test === "string" && pkg.scripts.test.trim());
  } catch {
    return false;
  }
}

function projectBlock(label, ignored) {
  return { action: "block", reason: `.rks/project.json ${label} ignored (${ignored.reason}); expected { cmd: string, args?: string[] }` };
}

/**
 * D2 precedence, amended by A1 and A3. gate is "commit" or "merge" (default "merge"); ONLY
 * gate === "commit" consults commitTestCommand, so an omitted gate can never pick it up.
 * policyCommand is the policy-file string or undefined. Returns one of:
 *   { action: "run", cmd, args, source }   source: "project.json#commitTestCommand" | "project.json" | "policy" | "package.json"
 *   { action: "block", reason }            a declared command could not be honoured (D2a, D3, A1)
 *   { action: "skip", reason }             nothing declared (D3)
 * A present-but-malformed tier BLOCKS and never falls through (R9). A valid tier wins and lower
 * tiers are not read, so a valid commitTestCommand runs even when testCommand is malformed (A1).
 */
export function resolveGateCommand(projectDir, policyCommand, gate = "merge") {
  const isCommit = gate === "commit";
  if (isCommit) {
    const c = readProjectCommand(projectDir, "commitTestCommand");
    if (c.command) return { action: "run", cmd: c.command.cmd, args: c.command.args, source: "project.json#commitTestCommand" };
    if (c.ignored) return projectBlock(c.fileLevel ? "testCommand and commitTestCommand were" : "commitTestCommand was", c.ignored);
  }
  const t = readProjectCommand(projectDir, "testCommand");
  if (t.command) return { action: "run", cmd: t.command.cmd, args: t.command.args, source: "project.json" };
  if (t.ignored) return projectBlock("testCommand was", t.ignored);
  if (typeof policyCommand === "string" && policyCommand.trim()) {
    if (META_RE.test(policyCommand)) {
      return { action: "block", reason: `policy test command contains a shell metacharacter and is never run through a shell: ${policyCommand}` };
    }
    const [cmd, ...args] = policyCommand.trim().split(/\s+/);
    return { action: "run", cmd, args, source: "policy" };
  }
  if (packageHasTestScript(projectDir)) return { action: "run", cmd: "npm", args: ["test"], source: "package.json" };
  const declared = isCommit ? ".rks/project.json commitTestCommand or testCommand" : ".rks/project.json testCommand";
  return { action: "skip", reason: `no test command is declared (${declared}, policy file, or package.json scripts.test)` };
}

export function renderCommand(cmd, args) {
  return [cmd, ...args].join(" ");
}

/** argv, shell: false. Never throws. */
export function runGateCommand(projectDir, cmd, args) {
  const r = spawnSync(cmd, args, { cwd: projectDir, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  if (r.error) return { success: false, message: `could not start ${cmd}: ${r.error.code || r.error.message}` };
  if (r.status !== 0) {
    const tail = `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").slice(-20).join("\n");
    return { success: false, message: `exit ${r.status === null ? r.signal : r.status}\n${tail}` };
  }
  return { success: true };
}

const VALUE_FLAGS = new Set(["-m", "--message", "-F", "--file", "-C", "-c", "--reuse-message", "--reedit-message", "--author", "--date", "--fixup", "--squash", "-t", "--template", "--cleanup", "-S"]);
const WIDENING_LONG = /^--(all|include|only|patch|interactive)(=|$)/;

export function isGateExemptPath(p) {
  return p.startsWith("notes/") || (p.startsWith(".rks/") && !p.startsWith(".rks/prompts/"));
}

/**
 * D4. True only when the commit's path set is provably non-empty and every path is exempt.
 * Any form it cannot classify returns false (the gate runs). Never throws.
 */
export function commitIsGateExempt(gitCmd, projectDir) {
  try {
    const bare = String(gitCmd).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "\u0000");
    const tokens = bare.trim().split(/\s+/).slice(2);
    const sep = tokens.indexOf("--");
    const opts = sep === -1 ? tokens : tokens.slice(0, sep);
    for (let i = 0; i < opts.length; i++) {
      const t = opts[i];
      if (WIDENING_LONG.test(t)) return false;
      if (/^-[A-Za-z]+$/.test(t) && /[aiop]/.test(t.slice(1))) return false;
      if (VALUE_FLAGS.has(t) || (/^-[A-Za-z]+$/.test(t) && /[mFCct]$/.test(t))) { i++; continue; }
      if (t.startsWith("-")) continue;
      return false; // a pathspec without -- (or a token it cannot classify)
    }
    let paths;
    if (sep !== -1) {
      paths = tokens.slice(sep + 1);
      if (paths.some((p) => p.includes("\u0000"))) return false;
    } else {
      paths = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 })
        .split("\n").map((s) => s.trim()).filter(Boolean);
    }
    return paths.length > 0 && paths.every(isGateExemptPath);
  } catch {
    return false;
  }
}
