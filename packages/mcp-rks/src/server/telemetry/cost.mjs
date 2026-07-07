import fs from "fs/promises";
import path from "path";

// Model pricing per 1M tokens (USD)
const MODEL_PRICING = {
  // Current generation — the models rks agents actually run.
  "claude-haiku-4-5-20251001": { input: 1.00, output: 5.00 },
  "claude-sonnet-4-6": { input: 3.00, output: 15.00 },
  // Legacy pins still referenced by some agents (DEFAULT_MODEL, QA, review).
  "claude-sonnet-4-20250514": { input: 3.00, output: 15.00 },
  "claude-opus-4-5-20251101": { input: 15.00, output: 75.00 },
  "claude-haiku-3-5-20241022": { input: 0.25, output: 1.25 },
  // Fallback for unknown models (Sonnet-rate: conservative over-estimate, not under).
  "default": { input: 3.00, output: 15.00 },
};

export function calculateCost(model, promptTokens, completionTokens) {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["default"];
  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return {
    inputCost: Math.round(inputCost * 10000) / 10000,
    outputCost: Math.round(outputCost * 10000) / 10000,
    totalCost: Math.round((inputCost + outputCost) * 10000) / 10000,
  };
}

export async function generateCostReport(projectRoot, opts = {}) {
  const { startDate, endDate } = opts;
  const telemetryDir = path.join(projectRoot, ".rks", "telemetry");
  
  const result = {
    period: `${startDate || "(all)"} to ${endDate || "(all)"}`,
    totalCalls: 0,
    totalTokens: { prompt: 0, completion: 0 },
    estimatedCostUsd: 0,
    byOperation: {},
    byModel: {},
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
          if (!event.type?.includes("llm") && !event.payload?.promptTokens) continue;

          // Date filtering
          if (startDate || endDate) {
            const ts = event.timestamp || event.time;
            if (ts) {
              const d = new Date(ts);
              if (startDate && d < new Date(startDate)) continue;
              if (endDate && d > new Date(endDate)) continue;
            }
          }

          const payload = event.payload || event;
          const model = payload.model || "default";
          const promptTokens = payload.promptTokens || 0;
          const completionTokens = payload.completionTokens || 0;
          const operation = event.type?.split(".")[0] || "unknown";

          result.totalCalls++;
          result.totalTokens.prompt += promptTokens;
          result.totalTokens.completion += completionTokens;

          const cost = calculateCost(model, promptTokens, completionTokens);
          result.estimatedCostUsd += cost.totalCost;

          // By operation
          if (!result.byOperation[operation]) {
            result.byOperation[operation] = { calls: 0, cost: 0 };
          }
          result.byOperation[operation].calls++;
          result.byOperation[operation].cost += cost.totalCost;

          // By model
          if (!result.byModel[model]) {
            result.byModel[model] = { calls: 0, tokens: 0, cost: 0 };
          }
          result.byModel[model].calls++;
          result.byModel[model].tokens += promptTokens + completionTokens;
          result.byModel[model].cost += cost.totalCost;
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Round final costs
    result.estimatedCostUsd = Math.round(result.estimatedCostUsd * 100) / 100;
    for (const op of Object.values(result.byOperation)) {
      op.cost = Math.round(op.cost * 100) / 100;
    }
    for (const m of Object.values(result.byModel)) {
      m.cost = Math.round(m.cost * 100) / 100;
    }

    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
