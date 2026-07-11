#!/usr/bin/env node
/**
 * track-write-telemetry.mjs — PostToolUse hook (system tier)
 *
 * Emits telemetry when the Dispatcher makes direct Edit/Write calls.
 * This is the "I wrote a thing" event — creates an audit trail for
 * off-rails operations where agents are bypassed.
 *
 * Writes to both:
 * - .routekit/telemetry/guardrails.log (hook-level telemetry)
 * - .rks/telemetry/events-YYYY-MM-DD.jsonl (server-level telemetry)
 *
 * Matcher: Edit|Write (PostToolUse)
 */
import fs from "fs";
import path from "path";
import { recordWrittenPath } from "../lib/session-state.mjs";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TELEMETRY_DIR = path.join(PROJECT_DIR, ".routekit", "telemetry");
const TELEMETRY_FILE = path.join(TELEMETRY_DIR, "guardrails.log");
const EVENTS_DIR = path.join(PROJECT_DIR, ".rks", "telemetry");
const SCOPE_FILE = path.join(PROJECT_DIR, ".rks", "active-scope.json");
const ACTIVE_PLAN_FILE = path.join(PROJECT_DIR, ".claude", "active-plan.json");

function appendTelemetry(entry) {
  try {
    fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  } catch {
    // best-effort telemetry
  }
}

function appendEvent(entry) {
  try {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const eventFile = path.join(EVENTS_DIR, `events-${date}.jsonl`);
    fs.appendFileSync(eventFile, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  } catch {
    // best-effort telemetry
  }
}

function loadScope() {
  try {
    if (fs.existsSync(SCOPE_FILE)) {
      return JSON.parse(fs.readFileSync(SCOPE_FILE, "utf8"));
    }
  } catch { /* ignore */ }
  return null;
}

function loadActivePlan() {
  try {
    if (fs.existsSync(ACTIVE_PLAN_FILE)) {
      return JSON.parse(fs.readFileSync(ACTIVE_PLAN_FILE, "utf8"));
    }
  } catch { /* ignore */ }
  return null;
}

function findAuthorization(relativePath) {
  const notesDir = path.join(PROJECT_DIR, "notes");
  if (!fs.existsSync(notesDir)) return null;

  try {
    const files = fs.readdirSync(notesDir).filter(f => f.startsWith("backlog.") && f.endsWith(".md"));
    const fileName = path.basename(relativePath);

    for (const noteFile of files) {
      const content = fs.readFileSync(path.join(notesDir, noteFile), "utf8");
      if (content.includes(relativePath) || content.includes(fileName)) {
        const statusMatch = content.match(/^status:\s*(.+)$/m);
        const status = statusMatch ? statusMatch[1].trim() : "unknown";
        if (status !== "implemented") {
          return noteFile.replace(/^backlog\./, "").replace(/\.md$/, "");
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const input = JSON.parse(await readStdin());
  const { tool_name, tool_input } = input;

  // Only track Edit/Write
  if (!["Edit", "Write"].includes(tool_name)) {
    process.exit(0);
  }

  const filePath = tool_input?.file_path || tool_input?.path;
  if (!filePath) {
    process.exit(0);
  }

  // Session write-ledger: record this path so the read-provenance guardrail lets
  // the session read back a file it just wrote (see the `session_write` branch in
  // read-classification.mjs). Best-effort — recordWrittenPath swallows its own errors.
  recordWrittenPath(filePath);

  // Normalize to relative path
  let relPath = filePath;
  if (filePath.startsWith(PROJECT_DIR)) {
    relPath = filePath.slice(PROJECT_DIR.length).replace(/^\//, "");
  }

  // Gather context from scope file and active plan
  const scope = loadScope();
  const activePlan = loadActivePlan();

  const timestamp = new Date().toISOString();

  // Build change summary from tool input
  let change = null;
  if (tool_name === "Edit") {
    const oldStr = (tool_input?.old_string || "").slice(0, 120);
    const newStr = (tool_input?.new_string || "").slice(0, 120);
    change = { old: oldStr, new: newStr };
    if (tool_input?.replace_all) change.replaceAll = true;
  } else if (tool_name === "Write") {
    const content = tool_input?.content || "";
    const firstLine = content.split("\n")[0].slice(0, 120);
    change = { preview: firstLine, length: content.length };
  }

  // Resolve authority chain: active plan → active scope → backlog search → untracked
  let authority = "untracked";
  let authoritySource = null;
  if (activePlan?.backlog_note) {
    authority = path.basename(activePlan.backlog_note, ".md").replace(/^backlog\./, "");
    authoritySource = "active-plan";
  } else if (scope?.problemId) {
    authority = scope.problemId;
    authoritySource = "active-scope";
  } else {
    const found = findAuthorization(relPath);
    if (found) {
      authority = found;
      authoritySource = "backlog-match";
    }
  }

  const event = {
    event: "dispatcher.direct_write",
    tool: tool_name,
    file: relPath,
    timestamp,
    payload: {
      change,
      authority,
      authoritySource,
      writeMode: scope?.writeMode || "on-rail",
      activePlan: activePlan?.backlog_note || null,
      sessionId: scope?.sessionId || null,
      problemId: scope?.problemId || null,
    },
  };

  // Write to both telemetry destinations
  appendTelemetry(event);
  appendEvent(event);

  process.exit(0);
}

main().catch(() => {
  process.exit(0); // On error, exit cleanly — PostToolUse hooks should never block
});
