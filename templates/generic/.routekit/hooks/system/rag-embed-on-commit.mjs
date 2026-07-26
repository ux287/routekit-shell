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
 * - Idempotent (uses lock file to prevent concurrent embeds)
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

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOCK_FILE = path.join(PROJECT_DIR, ".rks", "rag", ".embed-lock");
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

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // Signal 0 = check if process exists
    return true;
  } catch {
    return false; // Process doesn't exist
  }
}

function isLocked() {
  if (!fs.existsSync(LOCK_FILE)) return false;

  try {
    const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));

    // If we have a PID, check if the process is still alive
    if (lockData.pid) {
      if (isProcessAlive(lockData.pid)) {
        // Process still running - lock is valid
        return true;
      } else {
        // Process dead - crashed without cleanup, remove lock
        log(`Removing orphaned lock (PID ${lockData.pid} no longer running)`);
        fs.unlinkSync(LOCK_FILE);
        return false;
      }
    }

    // Fallback for old lock files without PID: use time-based check
    const stats = fs.statSync(LOCK_FILE);
    const ageSeconds = (Date.now() - stats.mtimeMs) / 1000;
    if (ageSeconds > 300) {
      log(`Removing stale lock file (age: ${Math.round(ageSeconds)}s, no PID)`);
      fs.unlinkSync(LOCK_FILE);
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function createLock(commitInfo, pid) {
  const lockDir = path.dirname(LOCK_FILE);
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  fs.writeFileSync(LOCK_FILE, JSON.stringify({
    sha: commitInfo.sha,
    started: new Date().toISOString(),
    pid: pid
  }));
}

function removeLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // Ignore errors
  }
}

function triggerRagEmbed(commitInfo, changedFiles) {
  log(`Triggering RAG embed for commit ${commitInfo.shortSha}...`);
  log(`Changed files (${changedFiles.length}): ${changedFiles.join(", ")}`);

  // Spawn the embed process in background
  const embedScript = `
    import('${PROJECT_DIR}/scripts/rag/embed.mjs').then(async ({ embed }) => {
      console.log('[rag-embed] Starting embed for commit ${commitInfo.shortSha}...');
      const result = await embed();
      if (result && result.ok) {
        console.log('[rag-embed] Completed successfully');
        console.log('[rag-embed]   Embedded notes:', result.embeddedNotes);
        console.log('[rag-embed]   Total chunks:', result.addedEmbeddings);
      } else {
        console.error('[rag-embed] Failed:', result?.error || 'unknown error');
      }
    }).catch(err => {
      console.error('[rag-embed] Error:', err.message);
    }).finally(async () => {
      // Remove lock file using dynamic import (ESM-compatible)
      try {
        const { unlinkSync } = await import('node:fs');
        unlinkSync('${LOCK_FILE}');
      } catch {}
    });
  `;

  // Run in detached subprocess so it doesn't block
  const child = spawn("node", ["-e", embedScript], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      RKS_COMMIT_SHA: commitInfo.sha,
      RKS_COMMIT_SHORT: commitInfo.shortSha,
      RKS_COMMIT_MSG: commitInfo.message,
      RKS_COMMIT_AUTHOR: commitInfo.author
    }
  });

  // Pipe output to log file
  child.stdout.on("data", (data) => {
    fs.appendFileSync(LOG_FILE, data.toString());
  });
  child.stderr.on("data", (data) => {
    fs.appendFileSync(LOG_FILE, data.toString());
  });

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

  // Check if the commit succeeded (look for error indicators in output)
  const toolResult = hookData.tool_result || "";
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

  // Idempotency check
  if (isLocked()) {
    log(`RAG embed already in progress (lock file exists), skipping`);
    process.exit(0);
  }

  // Create lock with child PID after spawning
  const childPid = triggerRagEmbed(commitInfo, changedFiles);
  if (childPid) {
    createLock(commitInfo, childPid);
  }

  process.exit(0);
}

main();
