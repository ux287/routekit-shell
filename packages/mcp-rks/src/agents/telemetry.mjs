/**
 * Telemetry Agent
 *
 * Tier 2 Utility agent — queries telemetry data for pattern detection,
 * failure triage, ROI reporting, and backlog story suggestions.
 * Read-only against telemetry data. The feedback loop that makes
 * the system self-improving.
 *
 * Tools (server-side, no hooks):
 * - telemetry_query: query events with filtering
 * - telemetry_report: generate aggregate reports (summary, failures, trends)
 * - telemetry_analyze: analyze a specific failure with root-cause suggestions
 * - telemetry_digest: human-readable digest for a timeframe
 * - provenance_blocks: analyze provenance block patterns from log
 */

import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { loadAgentConfig } from './config.mjs';

// --- Input Contract ---
export const TelemetryInputSchema = z.object({
  projectId: z.string(),
  query: z.string().describe('Natural language telemetry question (e.g., "what failed today?", "show me provenance block patterns", "generate a summary report")'),
});

// --- Output Contract ---
export const TelemetryOutputSchema = z.object({
  ok: z.boolean(),
  summary: z.string().describe('Human-readable analysis or answer'),
  data: z.record(z.unknown()).optional().describe('Structured data supporting the analysis'),
  suggestions: z.array(z.string()).optional().describe('Actionable suggestions based on patterns found'),
});

// --- System Prompt (inline fallback; dendron note overrides) ---
const TELEMETRY_SYSTEM_PROMPT = `You are a Telemetry Agent. Your job is to query telemetry data, detect patterns, triage failures, and suggest improvements. You return concise analysis, not raw data dumps.

## Tools

1. **telemetry_query** — Query telemetry events with filtering by type, date range, correlation ID
2. **telemetry_report** — Generate aggregate reports: summary (success rates), failures (breakdown by type/reason), trends (daily counts)
3. **telemetry_analyze** — Analyze a specific failure event with root-cause suggestions
4. **telemetry_digest** — Generate a human-readable digest for a timeframe (today, yesterday, last-7-days, last-30-days)
5. **provenance_blocks** — Read and analyze the provenance block log for patterns in blocked operations

## Analysis Patterns

When triaging failures:
- Look for recurring patterns (same error across multiple events)
- Check if failures cluster around specific tools, paths, or time periods
- Suggest backlog stories for systematic fixes
- Report whether failures are novel or repeat occurrences

When analyzing provenance blocks:
- Count blocks by tool type (Read, Glob, Grep, Bash)
- Identify most-blocked paths (which files trigger the most blocks)
- Calculate block rate vs allow rate
- Identify "escape hatch" patterns (blocks that users work around)

## Workflow

1. Parse the query to determine which analysis is needed
2. Call the appropriate tool(s) — prefer summary/aggregate over raw event dumps
3. Synthesize findings into an actionable summary
4. Return JSON with analysis and suggestions

## Hard Limits

- Maximum 3 tool calls per request
- After your tool calls, you MUST return the JSON answer — do NOT call more tools
- Summarize data — do NOT return raw event arrays

## Output Format

RESPOND WITH ONLY a JSON object:
{
  "ok": true,
  "summary": "Analysis of what was found",
  "data": { ... key metrics and findings ... },
  "suggestions": ["Actionable suggestion 1", "Actionable suggestion 2"]
}`;

/**
 * Create the Telemetry agent configuration.
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.query
 * @param {string} params.projectRoot
 */
export function createTelemetryAgent({ projectId, query, projectRoot }) {
  const cfg = loadAgentConfig('telemetry', projectRoot);

  return {
    name: 'telemetry',
    model: cfg.model,
    prompt: cfg.prompt || TELEMETRY_SYSTEM_PROMPT,
    userMessage: `Telemetry query: "${query}"\n\nProject: ${projectId}. Analyze the telemetry data and return a structured summary with suggestions.`,
    inputSchema: TelemetryInputSchema,
    outputSchema: TelemetryOutputSchema,
    rawInput: { projectId, query },
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs,
    projectId,
    projectRoot,
    tools: [
      // --- telemetry_query ---
      {
        name: 'telemetry_query',
        description: 'Query telemetry events with optional filtering by type, date range, and correlation ID. Returns matching events and summary counts.',
        inputSchema: z.object({
          type: z.string().optional().describe('Filter by event type (e.g., plan.start, exec.failed, agent.research.complete)'),
          startDate: z.string().optional().describe('ISO 8601 start date'),
          endDate: z.string().optional().describe('ISO 8601 end date'),
          correlationId: z.string().optional().describe('Filter by correlation ID'),
          limit: z.number().optional().describe('Max events to return (default 100, max 1000)'),
          format: z.enum(['json', 'summary']).optional().describe('Output format (default: json)'),
        }),
        async execute(opts) {
          const { queryTelemetry } = await import('../server/telemetry/query.mjs');
          return queryTelemetry(projectRoot, opts);
        },
      },
      // --- telemetry_report ---
      {
        name: 'telemetry_report',
        description: 'Generate aggregate reports: "summary" (operation success rates), "failures" (breakdown by type and reason), "trends" (daily plan/exec counts).',
        inputSchema: z.object({
          reportType: z.enum(['summary', 'failures', 'trends']).optional().describe('Report type (default: summary)'),
          startDate: z.string().optional().describe('ISO 8601 start date'),
          endDate: z.string().optional().describe('ISO 8601 end date'),
        }),
        async execute(opts) {
          const { generateReport } = await import('../server/telemetry/reports.mjs');
          return generateReport(projectRoot, opts);
        },
      },
      // --- telemetry_analyze ---
      {
        name: 'telemetry_analyze',
        description: 'Analyze a specific failure event. Returns root-cause category, matching patterns, and suggested fixes.',
        inputSchema: z.object({
          correlationId: z.string().optional().describe('Correlation ID of the failure to analyze'),
          runId: z.string().optional().describe('Run ID to analyze'),
        }),
        async execute(opts) {
          const { analyzeFailure } = await import('../server/telemetry/analysis.mjs');
          return analyzeFailure(projectRoot, opts);
        },
      },
      // --- telemetry_digest ---
      {
        name: 'telemetry_digest',
        description: 'Generate a human-readable markdown digest for a timeframe. Good for quick overview of what happened.',
        inputSchema: z.object({
          timeframe: z.enum(['today', 'yesterday', 'last-7-days', 'last-30-days']).optional().describe('Timeframe (default: yesterday)'),
        }),
        async execute({ timeframe }) {
          const { generateDigest } = await import('../server/telemetry/digest.mjs');
          const result = await generateDigest(projectRoot, { timeframe: timeframe || 'yesterday' });
          return { ok: true, markdown: result.markdown };
        },
      },
      // --- provenance_blocks ---
      {
        name: 'provenance_blocks',
        description: 'Read and analyze the provenance block log. Returns block counts by tool type, most-blocked paths, block vs allow rates, and recent block entries.',
        inputSchema: z.object({
          limit: z.number().optional().describe('Max recent entries to analyze (default 200)'),
        }),
        async execute({ limit }) {
          const maxEntries = Math.min(limit || 200, 1000);
          const logPath = path.join(projectRoot, '.routekit', 'telemetry', 'provenance-blocks.log');

          if (!fs.existsSync(logPath)) {
            return { ok: true, total: 0, blocks: 0, allows: 0, byTool: {}, topBlockedPaths: [] };
          }

          const content = fs.readFileSync(logPath, 'utf8');
          const lines = content.split('\n').filter(l => l.trim());
          const recent = lines.slice(-maxEntries);

          let blocks = 0;
          let allows = 0;
          const byTool = {};
          const blockedPaths = {};

          for (const line of recent) {
            let ev;
            try { ev = JSON.parse(line); } catch { continue; }

            const tool = ev.tool || ev.originalTool || 'unknown';
            if (!byTool[tool]) byTool[tool] = { blocks: 0, allows: 0 };

            if (ev.allowed === false) {
              blocks++;
              byTool[tool].blocks++;
              const p = ev.path || 'unknown';
              blockedPaths[p] = (blockedPaths[p] || 0) + 1;
            } else {
              allows++;
              byTool[tool].allows++;
            }
          }

          // Top blocked paths
          const topBlockedPaths = Object.entries(blockedPaths)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([p, count]) => ({ path: p, count }));

          return {
            ok: true,
            total: recent.length,
            blocks,
            allows,
            blockRate: recent.length > 0 ? `${Math.round((blocks / recent.length) * 100)}%` : '0%',
            byTool,
            topBlockedPaths,
          };
        },
      },
    ],
  };
}
