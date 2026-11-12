#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook: Trigger RAG embed after git commits
 *
 * When a git commit succeeds, this hook
 * triggers rag_embed to keep the knowledge index fresh. Both notes and code changes are relevant context.
 *
 * Features:
 * - Triggers on any successful git commit
 * - Supports [skip-rag] flag in commit message
 * - Concurrency-safe: the detached child takes the kernel-held embed lock on
 *   .rks/rag/embed-lock.sqlite via acquireEmbedLock (packages/rag/src/embed-lock.mjs) and
 *   releases it with lock.release() (or by exiting)
 * - Runs embed in background to not block Claude
 * - Logs commit metadata for traceability
 *
 * Part of: backlog.dogfooding.02-rag-embed-on-commit
 *
 * Exit codes:
 *   0 = always (PostToolUse hooks don't block)
 */
import fs from "fs";
import path from "path";
import { execSync, spawn } from "child_process";
import { pathToFileURL } from "url";
import { appendTelemetry } from "./hook-output.mjs";

/**
 * Flatten a PostToolUse result payload to something string operations can match.
 *
 * Bash `tool_response` is an OBJECT { stdout, stderr, interrupted, isImage }. Here the
 * flattening is CRASH-SAFETY, not just correctness: the guard below uses
 * String.prototype.includes, and calling .includes() on an object throws TypeError —
 * which would crash this PostToolUse hook on every single git commit.
 *
 * @param {unknown} value
 * @returns {string}
 */
function toSearchableString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const parts = [];
    if (typeof value.stdout === "string") parts.push(value.stdout);
    if (typeof value.stderr === "string") parts.push(value.stderr);
    if (parts.length > 0) return parts.join("\n");
    try { return JSON.stringify(value); } catch { return ""; }
  }
  return String(value);
}

/**
 * Report a PostToolUse payload shape this hook cannot interpret.
 * Top-level KEY NAMES ONLY — never values, which may carry credential material.
 */
function reportUnknownPayloadShape(toolName, hookData, detail) {
  let keys = [];
  try { keys = Object.keys(hookData || {}).sort(); } catch { /* best-effort */ }
  process.stderr.write(
    `[rag-embed-on-commit] Unrecognized PostToolUse payload from ${toolName} (${detail}); ` +
      `top-level keys: ${keys.join(", ") || "<none>"}\n`,
  );
  try {
    appendTelemetry({
      event: "hook.payload_shape_unknown",
      hook: "rag-embed-on-commit",
      tool_name: toolName,
      detail,
      keys, // KEY NAMES ONLY
      timestamp: new Date().toISOString(),
    });
  } catch { /* best-effort */ }
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(PROJECT_DIR, ".rks", "rag", "post-commit.log");

function log(message) {
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} [rag-embed-on-commit] ${message}\n`;

  // Ensure log directory exists
  const logDir = path.dirname(LOG_FILE);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  fs.appendFileSync(LOG_FILE, logLine);
  console.error(logLine.trim()); // stderr for hook output
}

function isGitCommitCommand(command) {
  // Match git commit commands (not git commit-msg or other subcommands)
  return /git\s+commit\s+/.test(command) || /git\s+commit$/.test(command);
}

function getCommitInfo() {
  try {
    const sha = execSync("git rev-parse HEAD", {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();

    const shortSha = execSync("git rev-parse --short HEAD", {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();

    const message = execSync("git log -1 --format=%B", {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();

    const author = execSync("git log -1 --format=%an", {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();

    return { sha, shortSha, message, author };
  } catch {
    return null;
  }
}

function getChangedFilesInCommit() {
  try {
    const output = execSync("git diff-tree --no-commit-id --name-only -r HEAD", {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();

    if (!output) return [];

    return output.split("\n").filter(f => f.trim());
  } catch {
    return [];
  }
}

function triggerRagEmbed(commitInfo, changedFiles) {
  log(`Triggering RAG embed for commit ${commitInfo.shortSha}...`);
  log(`Changed files (${changedFiles.length}): ${changedFiles.join(", ")}`);

  // The detached child is the process that runs embed(), so it is the one that holds
  // the embed lock on .rks/rag/embed-lock.sqlite: it takes the lock with acquireEmbedLock
  // (a node:sqlite exclusive lock the kernel drops if the child dies) and releases it with
  // lock.release(). The parent never writes, inspects or deletes the lock. Loading node:sqlite
  // may print an ExperimentalWarning to the child's stderr, i.e. to post-commit.log; it is not
  // an error. backlog.feat.rag-embed-lock-kernel-held
  // Both imports sit inside try/catch, so a project without packages/rag/src refuses
  // cleanly without creating a lock.
  // backlog.fix.rag-embed-on-commit-uses-acquire-embed-lock
  const embedLockUrl = pathToFileURL(path.join(PROJECT_DIR, "packages", "rag", "src", "embed-lock.mjs")).href;
  const embedUrl = pathToFileURL(path.join(PROJECT_DIR, "packages", "rag", "src", "embed.mjs")).href;
  const embedScript = `
    (async () => {
      let lock;
      try {
        const { acquireEmbedLock } = await import(${JSON.stringify(embedLockUrl)});
        lock = acquireEmbedLock(${JSON.stringify(PROJECT_DIR)}, { holder: 'rag-embed-on-commit' });
      } catch (err) {
        console.error('[rag-embed] Error:', err.message);
        return;
      }
      if (!lock || !lock.acquired) {
        console.log('[rag-embed] Skipped: embed lock held by ' + (lock?.holder || 'unknown') + ' (PID: ' + (lock?.pid ?? 'unknown') + ')' + (lock?.legacyLockPath ? ' (legacy lock record: ' + lock.legacyLockPath + '; remove it if no rks process is running)' : ''));
        return;
      }
      try {
        const { embed } = await import(${JSON.stringify(embedUrl)});
        console.log('[rag-embed] Starting embed for commit ${commitInfo.shortSha}...');
        const result = await embed();
        if (result && result.ok) {
          console.log('[rag-embed] Completed successfully');
          console.log('[rag-embed]   Embedded notes:', result.embeddedNotes);
          console.log('[rag-embed]   Total chunks:', result.addedEmbeddings);
        } else {
          console.error('[rag-embed] Failed:', result?.error || 'unknown error');
        }
      } catch (err) {
        console.error('[rag-embed] Error:', err.message);
      } finally {
        // Release: COMMIT + close of the lock connection (process exit releases it too).
        try { lock.release(); } catch {}
      }
    })();
  `;

  // The child's stdout and stderr go straight to post-commit.log through an fd the parent
  // opens, so its output does not depend on the parent staying alive (the parent exits
  // right after spawning, which would leave a pipe with no reader).
  const logDir = path.dirname(LOG_FILE);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const logFd = fs.openSync(LOG_FILE, "a");

  // Run in detached subprocess so it doesn't block
  let child;
  try {
    child = spawn(process.execPath, ["-e", embedScript], {
      cwd: PROJECT_DIR,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        RKS_COMMIT_SHA: commitInfo.sha,
        RKS_COMMIT_SHORT: commitInfo.shortSha,
        RKS_COMMIT_MSG: commitInfo.message,
        RKS_COMMIT_AUTHOR: commitInfo.author
      }
    });
  } finally {
    // The child holds its own copy of the fd; the parent's copy is no longer needed.
    try { fs.closeSync(logFd); } catch { /* best-effort */ }
  }

  child.unref();

  log(`RAG embed spawned in background (PID: ${child.pid})`);
  return child.pid;
}

async function main() {
  // Read hook input from stdin
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  // Only process Bash tool calls
  if (hookData.tool_name !== "Bash") {
    process.exit(0);
  }

  const command = hookData.tool_input?.command || "";

  // Only process git commit commands
  if (!isGitCommitCommand(command)) {
    process.exit(0);
  }

  // Check if the commit succeeded (look for error indicators in output).
  //
  // Claude Code sends `tool_response`, never `tool_result` — reading the latter meant
  // this was always undefined, coerced to "", and the failure branch was unreachable.
  // Consequence: a RAG embed was spawned after commits that actually FAILED.
  // See toSearchableString above for why the object flattening is crash-safety here.
  const toolResult = toSearchableString(hookData.tool_response ?? hookData.tool_result) || "";
  if (hookData.tool_response === undefined && hookData.tool_result === undefined) {
    reportUnknownPayloadShape(hookData.tool_name || "Bash", hookData, "neither tool_response nor tool_result present");
  }
  if (toolResult.includes("error:") || toolResult.includes("fatal:") || toolResult.includes("Exit code")) {
    log("Git commit appears to have failed, skipping RAG embed");
    process.exit(0);
  }

  // Get commit info
  const commitInfo = getCommitInfo();
  if (!commitInfo) {
    log("Could not get commit info, skipping RAG embed");
    process.exit(0);
  }

  // Check for [skip-rag] flag
  if (commitInfo.message.toLowerCase().includes("[skip-rag]")) {
    log(`Skipping RAG embed ([skip-rag] found in commit message)`);
    process.exit(0);
  }

  // Check if any files were changed
  const changedFiles = getChangedFilesInCommit();
  if (changedFiles.length === 0) {
    log(`No file changes in commit ${commitInfo.shortSha}, skipping RAG embed`);
    process.exit(0);
  }

  // No lock pre-check here: the detached child's acquireEmbedLock is the only lock
  // decision, so a held lock is refused (and logged) by the child.
  try {
    triggerRagEmbed(commitInfo, changedFiles);
  } catch (err) {
    try { log(`Failed to spawn RAG embed: ${err?.message || err}`); } catch { /* best-effort */ }
  }

  process.exit(0);
}

main();
