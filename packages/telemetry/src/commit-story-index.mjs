/**
 * Commit-to-story index
 *
 * Maps git commit SHAs to story IDs via three sources in priority order:
 *   1. Commit message parse  — "chore: mark <problemId> as implemented"
 *   2. pr.merged telemetry  — join commitId to problemId
 *   3. Off-rail audit log   — join Session: footer sessionId to problemId
 */
import fs from "fs";
import path from "path";

const SESSION_LOG = ".rks/guardrails-off-sessions.jsonl";
const TELEMETRY_DIR = ".rks/telemetry";

// "chore: mark backlog.feat.some-story as implemented"
const MARK_IMPL_RE = /^chore:\s*mark\s+(\S+)\s+as\s+implemented/i;
// "Story: backlog.feat.some-story" in commit footer
const STORY_FOOTER_RE = /^Story:\s*(\S+)/mi;
// "Session: <id>" in commit footer
const SESSION_FOOTER_RE = /^Session:\s*(\S+)/mi;

function inferFlowType(message) {
  if (!message) return "other";
  if (/^feat\(off-rail\):/.test(message)) return "off_rail";
  const m = message.match(/^(\w+)(?:\([^)]+\))?:/);
  if (!m) return "other";
  const type = m[1].toLowerCase();
  const typeMap = { feat: "feature", fix: "fix", chore: "maintenance", docs: "docs", refactor: "refactor", test: "test" };
  return typeMap[type] || "other";
}

function readAuditLog(projectRoot) {
  const logPath = path.join(projectRoot, SESSION_LOG);
  if (!fs.existsSync(logPath)) return new Map();
  const sessionMap = new Map();
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.sessionId && entry.problemId) {
        sessionMap.set(entry.sessionId, entry.problemId);
      }
    } catch { /* skip bad lines */ }
  }
  return sessionMap;
}

function readPrMergedEvents(projectRoot) {
  const telemetryDir = path.join(projectRoot, TELEMETRY_DIR);
  if (!fs.existsSync(telemetryDir)) return new Map();
  const commitMap = new Map();
  try {
    const files = fs.readdirSync(telemetryDir).filter(f => f.endsWith(".jsonl")).sort();
    for (const file of files) {
      const content = fs.readFileSync(path.join(telemetryDir, file), "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "pr.merged" && ev.payload?.commitId && ev.payload?.problemId) {
            commitMap.set(ev.payload.commitId, ev.payload.problemId);
          }
        } catch { /* skip bad lines */ }
      }
    }
  } catch { /* best effort */ }
  return commitMap;
}

/**
 * Build a commit-to-story index from three sources.
 *
 * @param {string} projectRoot
 * @param {object} opts
 * @param {Array<{sha: string, message: string}>} opts.commits - Commits to index
 * @returns {Map<string, {storyId: string|null, source: string|null, flowType: string}>}
 */
export function buildCommitStoryIndex(projectRoot, opts = {}) {
  const commits = opts.commits || [];
  const index = new Map();
  if (commits.length === 0) return index;

  const prMergedMap = readPrMergedEvents(projectRoot);
  const auditSessionMap = readAuditLog(projectRoot);

  for (const { sha, message } of commits) {
    const flowType = inferFlowType(message);

    // Source 1: commit message "chore: mark <problemId> as implemented"
    const markMatch = message?.match(MARK_IMPL_RE);
    if (markMatch) {
      index.set(sha, { storyId: markMatch[1], source: "commit-message", flowType });
      continue;
    }

    // Source 2: pr.merged telemetry — commitId may be full or short SHA
    const shortSha = sha.slice(0, 8);
    const prProblemId = prMergedMap.get(sha) || prMergedMap.get(shortSha);
    if (prProblemId) {
      index.set(sha, { storyId: prProblemId, source: "pr-merged", flowType });
      continue;
    }

    // Source 3: audit log — check Story: footer first, then Session: footer lookup
    const storyFooter = message?.match(STORY_FOOTER_RE);
    if (storyFooter) {
      index.set(sha, { storyId: storyFooter[1], source: "audit-log", flowType });
      continue;
    }
    const sessionFooter = message?.match(SESSION_FOOTER_RE);
    if (sessionFooter) {
      const sessionProblemId = auditSessionMap.get(sessionFooter[1]);
      if (sessionProblemId) {
        index.set(sha, { storyId: sessionProblemId, source: "audit-log", flowType });
        continue;
      }
    }

    // No source matched
    index.set(sha, { storyId: null, source: null, flowType });
  }

  return index;
}
