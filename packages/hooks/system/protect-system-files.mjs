#!/usr/bin/env node
/**
 * protect-system-files.mjs — PreToolUse hook (system tier)
 *
 * Hard block on Edit / Write / MultiEdit / NotebookEdit to files that the
 * Dispatcher or Governors must not modify directly. Three classes:
 *
 *   1. User-only system files (no exemption, ever):
 *        CLAUDE.md (Dispatcher instructions), .claude/settings.json and
 *        .claude/settings.local.json (hooks + permissions).
 *
 *   2. rks project config — the PROTECTED_CONFIG_PATHS list of the shared lib
 *      hooks/lib/protected-rks-paths.mjs. Denied unless the off-rail scope file
 *      (.rks/active-scope.json under CLAUDE_PROJECT_DIR) parses, has
 *      writeMode "scoped", and its allowedFiles holds an entry that, once
 *      normalized, EQUALS the target path. Glob entries never exempt. Any
 *      problem reading the scope file denies (fail-closed).
 *
 *   3. Server-written state — the lib's PROTECTED_STATE_PATHS list. Written only
 *      inside the rks MCP server process; never exemptible.
 *
 * Classes 2 and 3 match case-insensitively on every platform. Targets are
 * classified in a lexical form (path.resolve against CLAUDE_PROJECT_DIR) and a
 * canonical form (realpath of the deepest existing ancestor, relative to the
 * realpath of CLAUDE_PROJECT_DIR); a hit in either form counts, and the state
 * class wins. A target outside the project root is classified by suffix
 * ("/" + entry) and is never exempt.
 *
 * The lists are loaded by a guarded dynamic import of the shared lib. If the lib
 * cannot be loaded (or lacks either list), every write whose path has a segment
 * equal to .rks or .routekit (case-insensitive) is denied.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block
 */
import fs from "node:fs";
import path from "node:path";

const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

const PROTECTED_PATTERNS = [
  /\/CLAUDE\.md$/,
  /^CLAUDE\.md$/,
  /\/\.claude\/settings.*\.json$/,
  /^\.claude\/settings.*\.json$/,
];

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

const LIB_NAME = "protected-rks-paths.mjs";

function deny(message) {
  process.stderr.write(message);
  process.exit(2);
}

function isStringList(v) {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0);
}

/** Load the shared lists; null on any failure. */
async function loadLib() {
  try {
    const mod = await import(new URL(`../lib/${LIB_NAME}`, import.meta.url));
    if (!isStringList(mod.PROTECTED_CONFIG_PATHS) || !isStringList(mod.PROTECTED_STATE_PATHS)) return null;
    return mod;
  } catch {
    return null;
  }
}

const toSlash = (p) => p.split(path.sep).join("/").replace(/\\/g, "/");

/**
 * Canonical absolute form: realpath of the deepest existing ancestor with the
 * remaining segments re-appended. Dangling symlinks are followed via readlink.
 * Errors other than ENOENT propagate (the caller denies).
 */
function canonicalize(abs, depth = 0) {
  if (depth > 40) {
    const err = new Error(`too many symbolic links resolving ${abs}`);
    err.code = "ELOOP";
    throw err;
  }
  try {
    return fs.realpathSync(abs);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  let st = null;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (st && st.isSymbolicLink()) {
    return canonicalize(path.resolve(path.dirname(abs), fs.readlinkSync(abs)), depth + 1);
  }
  const parent = path.dirname(abs);
  if (parent === abs) return abs;
  return path.join(canonicalize(parent, depth + 1), path.basename(abs));
}

/**
 * Classify one absolute path against one root.
 * Returns { cls: "state"|"config"|null, entry, inside, rel }.
 */
function classify(abs, root, lists) {
  const relRaw = path.relative(root, abs);
  const rel = toSlash(relRaw);
  const inside = !path.isAbsolute(relRaw) && rel !== ".." && !rel.startsWith("../");
  const find = (list) => {
    if (inside) {
      const lower = rel.toLowerCase();
      return list.find((e) => e.toLowerCase() === lower);
    }
    const absLower = toSlash(abs).toLowerCase();
    return list.find((e) => absLower.endsWith("/" + e.toLowerCase()));
  };
  const stateEntry = find(lists.state);
  if (stateEntry) return { cls: "state", entry: stateEntry, inside, rel };
  const configEntry = find(lists.config);
  if (configEntry) return { cls: "config", entry: configEntry, inside, rel };
  return { cls: null, entry: null, inside, rel };
}

/** Config entries exempted by an EXACT allowedFiles entry of a scoped off-rail session. */
function exemptConfigEntries(projectDir, lib) {
  if (typeof lib.exemptConfigPaths === "function") {
    try {
      const out = lib.exemptConfigPaths(projectDir);
      return out instanceof Set ? out : new Set();
    } catch {
      return new Set();
    }
  }
  try {
    const root = path.resolve(projectDir);
    const scope = JSON.parse(fs.readFileSync(path.join(root, ".rks", "active-scope.json"), "utf8"));
    if (!scope || scope.writeMode !== "scoped" || !Array.isArray(scope.allowedFiles)) return new Set();
    const out = new Set();
    for (const entry of scope.allowedFiles) {
      if (typeof entry !== "string" || /[*?[]/.test(entry)) continue;
      const rel = toSlash(path.relative(root, path.resolve(root, entry)));
      if (lib.PROTECTED_CONFIG_PATHS.includes(rel)) out.add(rel);
    }
    return out;
  } catch {
    return new Set();
  }
}

function configMessage(display, entry) {
  return (
    `\n⛔ Write blocked: ${display} is rks project config (${entry})\n` +
    `   Agents may not write rks project config directly. Governed routes:\n` +
    `   - Onboarding / initialization: the rks MCP tools rks_init, rks_rag_init or rks_onboarder,\n` +
    `     or the \`routekit project\` CLI, write this file server-side.\n` +
    `   - Any other change: file a story (/po or /pipeline) whose targetFiles lists the exact path\n` +
    `     ${entry}, take it to arch-approved, and build it guardrails-off; during that off-rail\n` +
    `     session this hook allows exactly that path.\n` +
    `   - The user may edit the file directly in their own editor.\n\n`
  );
}

function stateMessage(display, entry) {
  const writer = entry.toLowerCase().includes("telemetry/")
    ? "the Research Agent run"
    : "rks_guardrails_off / rks_guardrails_on";
  return (
    `\n⛔ Write blocked: ${display} is rks server-written state (${entry})\n` +
    `   This file is written only by the rks MCP server (${writer}).\n` +
    `   No story or off-rail scope can exempt it.\n` +
    `   The user may still edit it directly in their own editor for manual recovery.\n\n`
  );
}

async function main() {
  const input = JSON.parse(await readStdin());
  const { tool_name } = input;
  const tool_input = input.tool_input || {};

  if (!WRITE_TOOLS.includes(tool_name)) {
    process.exit(0);
  }

  const filePath = String(tool_input.file_path || tool_input.notebook_path || tool_input.path || "");
  const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Class 1 — user-only system files (string-slice matching, unchanged).
  let relPath = filePath;
  if (filePath.startsWith(PROJECT_DIR)) {
    relPath = filePath.slice(PROJECT_DIR.length).replace(/^\//, "");
  }
  for (const pattern of PROTECTED_PATTERNS) {
    if (pattern.test(filePath) || pattern.test(relPath)) {
      deny(
        `\n⛔ Write blocked: ${relPath} is a protected system file\n` +
        `   This file is managed by the user only. Governors and Dispatchers must not modify it.\n\n`
      );
    }
  }

  if (!filePath) process.exit(0);

  const root = path.resolve(PROJECT_DIR);
  const abs = path.resolve(root, filePath);

  // Classes 2 and 3 — protected rks paths, loaded fail-closed.
  const lib = await loadLib();
  if (!lib) {
    const segs = [...filePath.split(/[\\/]+/), ...abs.split(/[\\/]+/)].map((s) => s.toLowerCase());
    if (segs.includes(".rks") || segs.includes(".routekit")) {
      deny(
        `\n⛔ Write blocked: ${filePath}\n` +
        `   The rks protected-path list (hooks/lib/${LIB_NAME}) could not be loaded.\n` +
        `   Writes under .rks/ and .routekit/ are denied until the hook library is restored.\n\n`
      );
    }
    process.exit(0);
  }

  const lists = { config: lib.PROTECTED_CONFIG_PATHS, state: lib.PROTECTED_STATE_PATHS };
  let lexical;
  let canonical;
  try {
    lexical = classify(abs, root, lists);
    let realRoot = root;
    try {
      realRoot = fs.realpathSync(root);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    canonical = classify(canonicalize(abs), realRoot, lists);
  } catch (err) {
    deny(
      `\n⛔ Write blocked: ${filePath}\n` +
      `   The target path could not be resolved (${err.code || err.message}); protected rks paths are checked fail-closed.\n\n`
    );
  }

  const stateHit = [lexical, canonical].find((c) => c.cls === "state");
  if (stateHit) deny(stateMessage(filePath, stateHit.entry));

  const configHit = [lexical, canonical].find((c) => c.cls === "config");
  if (configHit) {
    const entry = configHit.entry;
    const exactInside =
      lexical.inside && canonical.inside &&
      lexical.cls === "config" && canonical.cls === "config" &&
      lexical.rel === entry && canonical.rel === entry;
    if (exactInside && exemptConfigEntries(root, lib).has(entry)) process.exit(0);
    deny(configMessage(filePath, entry));
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
