import fs from "fs";
import path from "path";

export async function generateDigest(projectRoot, { timeframe = "yesterday" }) {
  const telemetryDir = path.join(projectRoot, ".rks/telemetry");
  if (!fs.existsSync(telemetryDir)) {
    return { markdown: "No telemetry data found." };
  }

  // Calculate date range
  const now = new Date();
  let startDate, endDate;
  if (timeframe === "today") {
    startDate = new Date(now.setHours(0, 0, 0, 0));
    endDate = new Date();
  } else if (timeframe === "yesterday") {
    endDate = new Date(now.setHours(0, 0, 0, 0));
    startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
  } else if (timeframe === "last-7-days") {
    endDate = new Date();
    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else {
    endDate = new Date();
    startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }

  // Read and filter events
  const events = [];
  const files = fs.readdirSync(telemetryDir).filter(f => f.endsWith(".jsonl"));
  for (const file of files) {
    const lines = fs.readFileSync(path.join(telemetryDir, file), "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const eventDate = new Date(event.timestamp);
        if (eventDate >= startDate && eventDate <= endDate) {
          events.push(event);
        }
      } catch (e) { }
    }
  }

  // Generate summary - match actual emitted event types
  // Plan events: plan.targetfiles.parsed (start), plan.ac.coverage (success proxy)
  const planStarts = events.filter(e => 
    e.type === "plan.start" || 
    e.type === "plan.targetfiles.parsed" || 
    e.type === "plan.prompt.assembled"
  ).length;
  const planSuccesses = events.filter(e => 
    e.type === "plan.success" || 
    e.type === "plan.ac.coverage"
  ).length;
  // Exec events: exec.start, exec.complete
  const execStarts = events.filter(e => e.type === "exec.start").length;
  const execSuccesses = events.filter(e => 
    e.type === "exec.success" || 
    e.type === "exec.complete"
  ).length;
  const failures = events.filter(e => 
    e.type?.includes("failed") || 
    e.type?.includes("error") ||
    e.type === "plan.retry.exhausted"
  ).length;

  const dateStr = timeframe === "today" ? "Today" : 
                  timeframe === "yesterday" ? "Yesterday" :
                  timeframe === "last-7-days" ? "Last 7 Days" : "Last 30 Days";

  const markdown = `## RKS Usage Digest: ${dateStr}

### Summary
- Plans generated: ${planStarts}
- Plans succeeded: ${planSuccesses} (${planStarts ? Math.round(planSuccesses/planStarts*100) : 0}%)
- Executions started: ${execStarts}
- Executions succeeded: ${execSuccesses} (${execStarts ? Math.round(execSuccesses/execStarts*100) : 0}%)
- Total failures: ${failures}

### Event Count
- Total events: ${events.length}
`;

  return { markdown, events: events.length, timeframe };
}
