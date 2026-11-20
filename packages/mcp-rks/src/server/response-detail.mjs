// backlog.feat.mcp-tool-response-summary-default — shared summary/full MCP response
// mechanism. Large non-action responses spill their full payload to
// <projectRoot>/.rks/state/responses/<tool>/ and return a summary plus fullPayloadPath.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DEFAULT_INLINE_THRESHOLD_BYTES = 4096;
export const MAX_SPILL_FILES_PER_TOOL = 50;

function envelope(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

export function spillDir(projectRoot, tool) {
  return path.join(projectRoot, ".rks", "state", "responses", tool);
}

function pruneSpillDir(dir, keep = MAX_SPILL_FILES_PER_TOOL) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
}

export function buildToolResponse({
  projectRoot,
  tool,
  payload,
  detail = "summary",
  summarize = (p) => p,
  mustInline = () => false,
  inlineThresholdBytes = DEFAULT_INLINE_THRESHOLD_BYTES,
}) {
  if (detail === "full" || mustInline(payload)) return envelope(payload);
  const full = JSON.stringify(payload);
  const fullPayloadBytes = Buffer.byteLength(full, "utf8");
  if (fullPayloadBytes <= inlineThresholdBytes) return envelope(payload);
  const dir = spillDir(projectRoot, tool);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fullPayloadPath = path.join(dir, `${stamp}-${crypto.randomBytes(4).toString("hex")}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPayloadPath, full);
  } catch (err) {
    return envelope({ ...payload, detailFallback: "write_failed", detailFallbackError: String(err?.message || err) });
  }
  // Prune is non-fatal: the spill write was observed to succeed, so a prune failure must not
  // be reported as write_failed (evidence-bound reporting). It is reported as pruneError instead.
  let pruneError;
  try {
    pruneSpillDir(dir);
  } catch (err) {
    pruneError = String(err?.message || err);
  }
  const summary = summarize(payload);
  const omittedKeys = Object.keys(payload).filter((k) => !(k in summary) || summary[k] !== payload[k]);
  return envelope({ ...summary, detail: "summary", fullPayloadPath, fullPayloadBytes, omittedKeys, ...(pruneError ? { pruneError } : {}) });
}
