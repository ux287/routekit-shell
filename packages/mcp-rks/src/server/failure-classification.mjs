/**
 * Canonical failure classification for plan-worker markers and MCP tool outcomes.
 *
 * Extracted from server.mjs so the unit tier can drive these decisions without
 * importing a 4,700-LOC MCP server module. Both exports are pure functions.
 */

export const TOOL_COMPLETE = "mcp.tool.complete";
export const TOOL_FAILED = "mcp.tool.failed";

/**
 * Decide the audit outcome for a single tool invocation.
 *
 * A tool fails if it threw OR if it returned a payload whose ok field is false.
 * The second arm is the fix: server.mjs flipped its audit flag only inside the
 * catch, so a non-throwing ok:false payload was recorded as a completion and
 * the failure went uncounted.
 */
export function decideToolOutcome({ threw = false, result } = {}) {
  if (threw) return TOOL_FAILED;
  if (result && typeof result === "object" && result.ok === false) return TOOL_FAILED;
  return TOOL_COMPLETE;
}

/**
 * Pull the JSON payload back out of an MCP tool response envelope.
 *
 * Tool handlers return `{ content: [{ type: "text", text: JSON.stringify(result) }] }`,
 * so the `ok` flag `decideToolOutcome` needs is only reachable by re-parsing. Returns
 * null for anything that is not a parseable text envelope — a null result is NOT a
 * failure, it is an absence of evidence, and `decideToolOutcome` treats it as complete.
 */
export function toolPayloadFromResponse(response) {
  const text = response?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Map a plan-worker marker to its canonical failure class and operator message.
 *
 * A marker carrying a stamped failureClass is authoritative and is returned
 * verbatim; only an unstamped marker is re-derived, preserving the
 * output_invalid vs story_unplannable distinction.
 */
export function classifyMarkerFailure(marker = {}) {
  const failureClass =
    marker.failureClass ||
    (marker.status === "refinement_required"
      ? marker.reason === "create_file_complexity"
        ? "story_unplannable"
        : "output_invalid"
      : marker.status === "quality_failed"
        ? "output_invalid"
        : "worker_crashed");

  return { failureClass, message: messageFor(failureClass, marker) };
}

function messageFor(failureClass, marker) {
  if (failureClass === "structural") {
    const targets = Array.isArray(marker.uncoveredCreateTargets)
      ? marker.uncoveredCreateTargets.filter(Boolean)
      : [];
    const listed = targets.length ? targets.join(", ") : "the declared create target(s)";
    return `The planner produced no usable content for ${listed}. Hand-author the file or escalate to a stronger model; refinement will not help.`;
  }
  // These three are server.mjs's existing operator messages, moved across VERBATIM rather
  // than re-worded. The authorable block in the story sketched terser replacements; adopting
  // those would have silently dropped the actionable half of each message ("split it
  // (rks_refine)", "add @@SEARCH/@@REPLACE blocks"). No test pins them — `too complex to plan`
  // and `Plan worker failed` both return zero over `tests`, against a live positive control —
  // so the degradation would have shipped unnoticed. Deviation recorded in Refinement History.
  if (failureClass === "story_unplannable") {
    return "Story is too complex to plan as-is — split it (rks_refine) or reduce acceptance-criteria scope, then re-plan.";
  }
  if (failureClass === "output_invalid") {
    return "The generated plan had no executable steps — refine the story (add @@SEARCH/@@REPLACE blocks or clearer targets) and re-plan.";
  }
  return "The plan worker crashed before producing a plan; see error. Re-run rks_plan.";
}
