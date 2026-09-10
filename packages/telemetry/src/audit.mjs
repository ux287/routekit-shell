import fs from "fs/promises";
import path from "path";

export async function generateAuditReport(projectRoot, opts = {}) {
  const { startDate, endDate, problemId } = opts;
  const telemetryDir = path.join(projectRoot, ".rks", "telemetry");
  
  const result = {
    period: `${startDate || "(all)"} to ${endDate || "(all)"}`,
    agentCommits: 0,
    filesModified: new Set(),
    storiesImplemented: new Set(),
    commits: [],
    byStory: {},
  };

  try {
    const files = await fs.readdir(telemetryDir);
    const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));

    for (const file of jsonlFiles) {
      const content = await fs.readFile(path.join(telemetryDir, file), "utf8");
      const lines = content.split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          
          // Filter for git.commit events
          if (event.type !== "git.commit" && !event.payload?.commitId) continue;

          // Date filtering
          if (startDate || endDate) {
            const ts = event.timestamp || event.time;
            if (ts) {
              const d = new Date(ts);
              if (startDate && d < new Date(startDate)) continue;
              if (endDate && d > new Date(endDate)) continue;
            }
          }

          // problemId filtering
          const eventProblemId = event.payload?.triggeredBy?.problemId || 
                                  event.payload?.problemId || 
                                  event.problemId;
          if (problemId && eventProblemId !== problemId) continue;

          const payload = event.payload || event;
          const commitId = payload.commitId;
          const filesChanged = payload.filesChanged || [];
          
          result.agentCommits++;
          
          for (const f of filesChanged) {
            const filePath = typeof f === "string" ? f : f.path;
            if (filePath) result.filesModified.add(filePath);
          }

          if (eventProblemId) {
            result.storiesImplemented.add(eventProblemId);
            
            if (!result.byStory[eventProblemId]) {
              result.byStory[eventProblemId] = {
                problemId: eventProblemId,
                commits: [],
                filesChanged: new Set(),
              };
            }
            result.byStory[eventProblemId].commits.push(commitId);
            for (const f of filesChanged) {
              const filePath = typeof f === "string" ? f : f.path;
              if (filePath) result.byStory[eventProblemId].filesChanged.add(filePath);
            }
          }

          result.commits.push({
            commitId,
            branch: payload.branch,
            message: payload.message,
            filesChanged: filesChanged.length,
            problemId: eventProblemId,
            timestamp: event.timestamp || event.time,
          });
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Convert Sets to counts/arrays for JSON serialization
    const finalResult = {
      ok: true,
      period: result.period,
      agentCommits: result.agentCommits,
      filesModified: result.filesModified.size,
      storiesImplemented: result.storiesImplemented.size,
      commits: result.commits.slice(-50), // Last 50 commits
      byStory: Object.values(result.byStory).map(s => ({
        problemId: s.problemId,
        commits: s.commits.length,
        filesChanged: s.filesChanged.size,
        latestCommit: s.commits[s.commits.length - 1],
      })),
    };

    return finalResult;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function createAuditEvent(commitId, branch, message, filesChanged, triggeredBy) {
  return {
    type: "git.commit",
    timestamp: new Date().toISOString(),
    payload: {
      commitId,
      branch,
      message,
      filesChanged: filesChanged.map(f => 
        typeof f === "string" ? { path: f, action: "modified" } : f
      ),
      triggeredBy,
    },
  };
}
