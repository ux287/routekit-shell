#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Redirect Edit/Write → Governor
 *
 * The Dispatcher does not edit files directly. All code changes
 * go through Governor → Playbook → Delivery Agent.
 */
import fs from "fs";
import path from "path";
import os from "os";
import {
  readHookInput, getProjectId, appendTelemetry,
  buildRedirectOutput, denyWithRedirect, isGuardrailsOff, PROJECT_DIR,
} from "../system/hook-output.mjs";

const SCOPE_FILE = path.join(PROJECT_DIR, ".rks", "active-scope.json");

function isFileInActiveScope(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(SCOPE_FILE, "utf8"));
    const allowed = Array.isArray(data.allowedFiles) ? data.allowedFiles : [];
    if (!allowed.length) return false;
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_DIR, filePath);
    return allowed.some(f => {
      const a = path.isAbsolute(f) ? f : path.resolve(PROJECT_DIR, f);
      return abs === a;
    });
  } catch { return false; }
}

// True only when filePath resolves inside a harness agent-memory directory
// (<homedir>/.claude/projects/<slug>/memory/). Directory-anchored — never a
// substring match — and fail-closed: any error or non-string input returns false.
function isMemoryDirPath(filePath) {
  try {
    if (!filePath || typeof filePath !== "string") return false;
    // Expand a leading ~ to the home directory, then resolve to a normalized
    // absolute path so tilde / absolute / PROJECT_DIR-relative forms all match.
    let p = filePath;
    if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(PROJECT_DIR, p);
    // Require the ordered segments .claude → projects → <slug> → memory, with the
    // target file strictly inside that memory directory.
    const segs = abs.split(path.sep);
    for (let i = 0; i + 4 < segs.length; i++) {
      if (segs[i] === ".claude" && segs[i + 1] === "projects" && segs[i + 2] && segs[i + 3] === "memory") {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function main() {
  const hookData = await readHookInput();
  const toolName = hookData.tool_name;

  if (!["Edit", "Write"].includes(toolName)) process.exit(0);
  if (isGuardrailsOff()) process.exit(0);

  const toolInput = hookData.tool_input || {};
  const filePath = toolInput.file_path || "";

  if (filePath && isFileInActiveScope(filePath)) process.exit(0);

  // Agent-memory writes: redirect to the /memory skill, which owns an atomic
  // write → commit → embed (commit strictly before embed). Deny output is built
  // inline — no Governor route — so buildRedirectOutput is not used here.
  if (filePath && isMemoryDirPath(filePath)) {
    const memProjectId = getProjectId();
    const slug = path.basename(filePath, path.extname(filePath));
    appendTelemetry({
      ts: new Date().toISOString(),
      hook: "redirect-edit-to-governor",
      blocked: true,
      reason: `Agent memory write redirected to /memory skill (slug: ${slug}).`,
      file: filePath.slice(0, 200),
      projectId: memProjectId,
    });
    denyWithRedirect({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Agent memory must be saved via the /memory skill (atomic write → commit → embed). Do not write directly to ~/.claude/.",
        additionalContext: [
          "REDIRECT ORDER — agent memory is project-local in this repository.",
          "",
          `Do NOT write to ${filePath.slice(0, 200)} — that path is outside the repo:`,
          "not committed, not shared with teammates, not RAG-indexed.",
          "",
          "Invoke the /memory skill to save this memory:",
          `  slug: ${slug}`,
          "  content: <the memory content from the Write payload>",
          "",
          "The /memory skill performs an atomic write → commit → embed and saves",
          "the memory as a project-local Dendron note that is committed with the",
          "repo and RAG-indexed.",
          "",
          "This is a hard redirect — do not retry the ~/.claude/ path, and do not",
          "attempt a bare Write to the project notes directory.",
        ].join("\n"),
      },
    });
    return;
  }

  const projectId = getProjectId();

  appendTelemetry({
    ts: new Date().toISOString(),
    hook: "redirect-edit-to-governor",
    blocked: true,
    reason: `File changes must go through a Governor. See CLAUDE.md for the Build pattern (max_turns: 80).`,
    file: filePath.slice(0, 200),
    projectId,
  });

  denyWithRedirect(buildRedirectOutput({
    reason: toolName + " must go through the Governor. Do not modify files directly.",
    agent: "governor",
    agentParams: { projectId, query: toolName + " " + filePath.slice(0, 150) },
    instructions: [
      "Launch a Governor with the Build pattern from CLAUDE.md.",
      "Be specific about what to create or modify and the expected outcome.",
    ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write("Hook error: " + err.message + "\n");
  process.exit(0);
});
