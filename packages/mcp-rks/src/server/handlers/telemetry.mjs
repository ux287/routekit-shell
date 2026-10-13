/**
 * Telemetry family handlers — moved verbatim from server.mjs (S2 pilot of
 * research.2026.10.05.server-mjs-safe-decomposition).
 * Lazy-import specifiers are byte-identical to the server.mjs originals (invariant I3).
 * Schema consts stay in server.mjs (TOOL_ARG_SCHEMAS and the schema-drift guard reference
 * them) and are passed in at registration. Handler contract: see ./registry.mjs.
 */
import { z } from "zod";
import { loadContext } from "../project.mjs";

export function registerTelemetryHandlers({ registerHandler }, {
  telemetryQuerySchema,
  telemetryReportSchema,
  telemetryAnalysisSchema,
  tokenCostReportSchema,
  telemetryExportSchema,
}) {
  registerHandler("rks_telemetry_digest", async (cleanArgs, ctx) => {
    const input = z.object({ 
      projectId: z.string(), 
      timeframe: z.enum(["today", "yesterday", "last-7-days", "last-30-days"]).optional() 
    }).parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const { generateDigest } = await import("@routekit/telemetry/digest");
    const res = await generateDigest(projectRoot, { timeframe: input.timeframe || "yesterday" });
    return { content: [{ type: "text", text: res.markdown }] };
  });

  registerHandler("rks_telemetry_query", async (cleanArgs, ctx) => {
    const input = telemetryQuerySchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const { queryTelemetry } = await import("@routekit/telemetry/query");
    const res = await queryTelemetry(projectRoot, input);
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_telemetry_report", async (cleanArgs, ctx) => {
    const input = telemetryReportSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const { generateReport } = await import("@routekit/telemetry/reports");
    const res = await generateReport(projectRoot, input);
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_telemetry_analysis", async (cleanArgs, ctx) => {
    const input = telemetryAnalysisSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const { analyzeFailure } = await import("@routekit/telemetry/analysis");
    const res = await analyzeFailure(projectRoot, input);
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_token_cost_report", async (cleanArgs, ctx) => {
    const input = tokenCostReportSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const { generateCostReport } = await import("@routekit/telemetry/cost-report");
    const res = generateCostReport(projectRoot, {
      scope: input.scope,
      storyId: input.storyId,
      commitSha: input.commitSha,
      format: input.format,
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_telemetry_export", async (cleanArgs, ctx) => {
    const input = telemetryExportSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const { exportTelemetry } = await import("@routekit/telemetry/export");
    const res = await exportTelemetry(projectRoot, {
      projectId: input.projectId,
      storyId: input.storyId,
      outDir: input.outDir,
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });
}
