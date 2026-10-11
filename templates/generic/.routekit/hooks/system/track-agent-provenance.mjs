#!/usr/bin/env node
/**
 * track-agent-provenance.mjs — PostToolUse hook
 *
 * Bridges the provenance gap between server-side agents and coordinator-level
 * enforcement. When an agent (Research, Git, PO) returns results containing
 * file paths, this hook extracts those paths and writes them to session state
 * via addRagSourcedPath(). This allows enforce-read-provenance to permit
 * subsequent reads of files the agent identified.
 *
 * Matcher: All mcp__rks__rks_agent_* tools (research, git, dendron, telemetry, ship, cycle-complete, story, delivery, recovery, etc.)
 */
import { addRagSourcedPath } from "../lib/session-state.mjs";
import { appendTelemetry } from "./hook-output.mjs";

/**
 * Read stdin as UTF-8, decoding ONCE at the end.
 *
 * The previous form was `let input = ""; for await (...) input += chunk;`, which
 * coerces EACH Buffer independently via toString("utf8"). A multi-byte character
 * straddling a chunk boundary is therefore decoded as two partial sequences and
 * becomes U+FFFD on both sides.
 *
 * That does NOT throw — U+FFFD is valid inside a JSON string literal, so
 * JSON.parse succeeds and the corruption flows silently into the ledger as
 * mangled paths and queries. Buffering and decoding once makes chunk boundaries
 * irrelevant.
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Unconditional invocation heartbeat.
 *
 * WHY THIS EXISTS. main() had FOUR bare `process.exit(0)` sites reachable before
 * any loud reporting — empty stdin, unparseable stdin, and two at the tool-name
 * gate. All four produced no mint, no stderr and no telemetry, which made them
 * observationally IDENTICAL to the hook process never being spawned at all.
 * That ambiguity blocked the diagnosis of a live defect for an entire
 * investigation: 0 of 41 ledger entries carried the `agent:` prefix, and nothing
 * in the record could say whether the hook ran and bailed or never ran.
 *
 * A heartbeat resolves it by construction. If a record appears, the hook ran and
 * the `stage` field says where it went. If NO record appears for a tool call that
 * should have matched, the process was never spawned — and the fix is not in this
 * file.
 *
 * DELIBERATELY a distinct event name from `hook.payload_shape_unknown`:
 * track-agent-provenance-payload.test.mjs filters on that exact event and asserts
 * a non-empty result, so reusing it would let heartbeats satisfy those filters and
 * mask a real regression.
 *
 * Emits top-level KEY NAMES ONLY, never values — same privacy rule as
 * reportUnknownPayloadShape below. Best-effort: a telemetry failure must never
 * throw out of main() or break the turn.
 *
 * @param {object} fields Stage marker plus whatever is known at that point.
 */
function recordHeartbeat(fields) {
  try {
    appendTelemetry({
      event: "hook.provenance_heartbeat",
      hook: "track-agent-provenance",
      ...fields,
      timestamp: new Date().toISOString(),
    });
  } catch { /* telemetry is best-effort; never break the turn */ }
}

/**
 * Describe the STRUCTURE of tool_response without emitting any of its content.
 *
 * The heartbeat records top-level key names, which proved tool_response is present
 * but said nothing about its internal shape — and that shape is the last unknown
 * standing between the hook and a working mint. extractAgentResult already handles
 * `{ content: [{type:"text"}] }`, a plain JSON string, and an already-parsed object
 * carrying ok/sources/answer, yet it still returns null against the real payload.
 * So the delivered shape is none of those, and at least four candidates produce the
 * identical symptom. Guessing between them would mean inverting a test guard on an
 * assumption — the exact move that produced the last wrong conclusion here.
 *
 * STRICTLY names, types, lengths and booleans. Never a value, never a text body.
 * `type` discriminators ("text", "image") are structural metadata, not content.
 *
 * @param {object} hookData
 * @returns {object} A shape descriptor safe to write to telemetry.
 */
function describeToolResponse(hookData) {
  const hd = hookData || {};
  const tr = hd.tool_response ?? hd.tool_result;

  const elementTypes = (arr) => {
    try {
      return [...new Set(arr.map((e) =>
        e && typeof e === "object" && typeof e.type === "string" ? e.type : typeof e,
      ))].sort();
    } catch { return []; }
  };

  const describeBlocks = (arr, shape, prefix) => {
    shape[`${prefix}_length`] = arr.length;
    shape[`${prefix}_element_types`] = elementTypes(arr);
    const textBlock = arr.find((e) => e && e.type === "text");
    shape.found_text_block = Boolean(textBlock && typeof textBlock.text === "string");
    if (textBlock && typeof textBlock.text === "string") {
      shape.text_length = textBlock.text.length;
      try { JSON.parse(textBlock.text); shape.text_json_parse_ok = true; }
      catch { shape.text_json_parse_ok = false; }
    }
  };

  const shape = {
    present: tr !== undefined,
    field: hd.tool_response !== undefined
      ? "tool_response"
      : (hd.tool_result !== undefined ? "tool_result" : null),
    type: tr === null ? "null" : Array.isArray(tr) ? "array" : typeof tr,
  };

  try {
    if (typeof tr === "string") {
      shape.string_length = tr.length;
      try { JSON.parse(tr); shape.json_parse_ok = true; }
      catch { shape.json_parse_ok = false; }
    } else if (Array.isArray(tr)) {
      // A BARE content array — no { content: ... } wrapper. extractAgentResult has
      // no branch for this: `.content` is undefined, typeof is "object" so the
      // string branch is skipped, and ok/sources/answer are absent.
      describeBlocks(tr, shape, "array");
    } else if (tr && typeof tr === "object") {
      shape.keys = Object.keys(tr).sort();
      if (Array.isArray(tr.content)) describeBlocks(tr.content, shape, "content");
    }
  } catch { /* best-effort; a shape probe must never break the turn */ }

  return shape;
}

/**
 * Report a PostToolUse payload this hook could not interpret.
 *
 * The silence WAS the defect: this hook read the wrong field name for its entire
 * life and produced no error, no telemetry and no failing test — it just quietly
 * granted nothing. Restoring function without breaking the silence would leave the
 * same trap armed for the next contract change.
 *
 * Emits top-level KEY NAMES ONLY, never values — payloads carry tool output that
 * may include credential material.
 *
 * @param {string} toolName
 * @param {object} hookData
 * @param {string} detail Why the payload was not usable.
 */
function reportUnknownPayloadShape(toolName, hookData, detail) {
  let keys = [];
  try { keys = Object.keys(hookData || {}).sort(); } catch { /* best-effort */ }
  process.stderr.write(
    `[agent-provenance] Unrecognized PostToolUse payload from ${toolName} (${detail}); ` +
      `top-level keys: ${keys.join(", ") || "<none>"}\n`,
  );
  try {
    appendTelemetry({
      event: "hook.payload_shape_unknown",
      hook: "track-agent-provenance",
      tool_name: toolName,
      detail,
      keys, // KEY NAMES ONLY — never payload values
      timestamp: new Date().toISOString(),
    });
  } catch { /* telemetry is best-effort; never break the turn */ }
}

/**
 * Extract the agent's JSON result from the hook data.
 *
 * Claude Code's PostToolUse payload field is `tool_response`; for MCP tools it is
 * { content: [{ type: "text", text: "..." }] } or a plain string/object. This hook
 * previously read `tool_result`, which Claude Code never sends, so the value was
 * always undefined and the whole provenance bridge was a silent no-op.
 *
 * `??` and NOT `||`: a present-but-falsy tool_response ("" or 0) is a real answer,
 * and falling through to the legacy field on it would re-hide exactly this kind of
 * contract drift. `tool_result` is retained only as a fallback for harness variants
 * that still send the old name.
 */
function extractAgentResult(hookData) {
  const toolResult = hookData.tool_response ?? hookData.tool_result;
  if (toolResult) {
    // BARE MCP content array: [{ type: "text", text: "JSON string" }]
    //
    // THIS IS WHAT THE HARNESS ACTUALLY SENDS. Observed 2026-08-15 from live
    // telemetry, not inferred:
    //   {"type":"array","array_length":1,"array_element_types":["text"],
    //    "found_text_block":true,"text_length":2178,"text_json_parse_ok":true}
    //
    // The wrapped `{ content: [...] }` form below is real for other callers, but
    // the bare array had NO branch, so every real agent call fell through to
    // `return null` and the provenance bridge minted nothing for its entire life.
    // Ordered FIRST, and before the object branch, because `typeof [] === "object"`.
    if (Array.isArray(toolResult)) {
      const textBlock = toolResult.find(
        (c) => c && c.type === "text" && typeof c.text === "string",
      );
      if (textBlock) {
        try { return JSON.parse(textBlock.text); } catch {}
      }
      // No text block (e.g. [1,2,3]) or unparseable text: fall through to null
      // rather than into the object branch. An array is never an agent result.
      return null;
    }
    // MCP content array: { content: [{ type: "text", text: "JSON string" }] }
    if (toolResult.content && Array.isArray(toolResult.content)) {
      const textBlock = toolResult.content.find(c => c.type === "text");
      if (textBlock && textBlock.text) {
        try { return JSON.parse(textBlock.text); } catch {}
      }
    }
    // Plain string
    if (typeof toolResult === "string") {
      try { return JSON.parse(toolResult); } catch {}
    }
    // Already parsed object with agent fields
    if (typeof toolResult === "object" && (toolResult.ok !== undefined || toolResult.sources || toolResult.answer)) {
      return toolResult;
    }
  }

  // Fallback: some hook formats embed result in tool_input
  const toolInput = hookData.tool_input || {};
  if (toolInput.result && typeof toolInput.result === "object") {
    return toolInput.result;
  }

  return null;
}

/**
 * Extract file paths from an agent result.
 * Handles different agent output shapes:
 *   Research: { sources: [{ file: "path", snippet: "..." }] }
 *   Git:      { data: { files: [{ path: "..." }], ... } }
 *   PO:       { sources: ["path1", "path2"] }
 */
function extractPaths(result) {
  const paths = new Set();

  if (!result || typeof result !== "object") return [];

  // Research Agent / PO Agent: sources array
  if (Array.isArray(result.sources)) {
    for (const src of result.sources) {
      if (!src) continue;
      if (typeof src === "string") {
        // PO agent: sources is string array
        if (looksLikeFilePath(src)) paths.add(src);
      } else if (typeof src === "object") {
        // Research agent: { file: "path", snippet: "..." }
        if (src.file) paths.add(String(src.file));
        if (src.path) paths.add(String(src.path));
      }
    }
  }

  // Git Agent: data object may contain file paths
  // Dendron Agent: data.path, data.filename
  // Ship/Story/Delivery/Recovery: data may contain various path fields
  if (result.data && typeof result.data === "object") {
    const data = result.data;
    // files array from git_state
    if (Array.isArray(data.files)) {
      for (const f of data.files) {
        if (!f) continue;
        if (typeof f === "string") paths.add(f);
        else if (f.path) paths.add(String(f.path));
      }
    }
    // Single file field
    if (data.file) paths.add(String(data.file));
    // Dendron Agent: path and filename fields
    if (data.path) paths.add(String(data.path));
    if (data.filename && looksLikeFilePath(String(data.filename))) paths.add(String(data.filename));
    // Diff output may reference file paths
    if (data.diff && typeof data.diff === "string") {
      extractPathsFromText(data.diff, paths);
    }
    // targetFiles from plan/story agents
    if (Array.isArray(data.targetFiles)) {
      for (const f of data.targetFiles) {
        if (typeof f === "string" && looksLikeFilePath(f)) paths.add(f);
      }
    }
  }

  // DELIBERATELY NOT SCRAPED: result.answer / result.summary prose.
  //
  // This hook previously ran extractPathsFromText over the agent's answer and summary
  // narrative. That hands read provenance to any file-like string the model happened to
  // MENTION — including one it hallucinated — rather than to what it actually cited and
  // retrieved. Provenance must follow evidence, not prose.
  //
  // The over-grant was invisible until now only because this hook read the wrong payload
  // field and never executed at all; correcting the field name would have switched it on.
  // Structured `data.*` extraction above is retained: those are tool outputs (git file
  // lists, dendron paths, diffs), not free text.
  return Array.from(paths).filter(p => p && looksLikeFilePath(p));
}

/**
 * Regex extraction of file paths from free text.
 * Matches patterns like "packages/mcp-rks/src/foo.mjs" or "notes/backlog.bar.md"
 */
function extractPathsFromText(text, pathSet) {
  const re = /((?:packages|src|notes|docs|\.routekit|\.rks|\.claude|templates|scripts|__tests__)\/[\w\-\.\/]+\.[a-zA-Z0-9_\-]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    pathSet.add(m[1]);
  }
}

function looksLikeFilePath(s) {
  return /\.[a-zA-Z0-9]+$/.test(s) && s.includes("/");
}

/**
 * Derive a provenance query string from the agent's input.
 */
function getProvenanceQuery(hookData) {
  const input = hookData.tool_input || {};
  // Research agent: query field
  if (input.query) return `agent:research "${input.query}"`;
  // Git agent: request field
  if (input.request) return `agent:git "${input.request}"`;
  // PO agent: problemId field
  if (input.problemId) return `agent:product-owner "${input.problemId}"`;
  // Generic: agent field + stringified input
  if (input.input && typeof input.input === "object") {
    return `agent:${input.agent || "unknown"} ${JSON.stringify(input.input).slice(0, 100)}`;
  }
  return `agent:${hookData.tool_name || "unknown"}`;
}

(async function main() {
  // FIRST ACTION, before stdin is even read: prove the process was spawned.
  // Placed ahead of readStdin deliberately — if stdin never arrives the await
  // below never returns, and without this record that hang would be
  // indistinguishable from the hook never running.
  recordHeartbeat({ stage: "entry" });

  const raw = await readStdin();
  if (!raw) {
    recordHeartbeat({ stage: "exit_stdin_empty", raw_length: 0 });
    process.exit(0);
  }

  let hookData;
  try {
    hookData = JSON.parse(raw);
  } catch {
    // Length only — never the payload text, which may carry credential material.
    recordHeartbeat({ stage: "exit_stdin_unparseable", raw_length: raw.length });
    process.exit(0);
  }

  // The payload shape the harness actually delivered. This is the record that
  // tests the standing hypothesis about the line below: `tool_name` and `tool`
  // are the ONLY fields consulted, so if the harness carries the name under any
  // other key, toolName becomes "" and the tool-name gate exits silently. The
  // same class of field-contract drift already happened once in this file
  // (tool_result vs tool_response) and went undetected for the hook's entire life.
  let keys = [];
  try { keys = Object.keys(hookData || {}).sort(); } catch { /* best-effort */ }
  recordHeartbeat({
    stage: "payload_received",
    raw_length: raw.length,
    keys, // KEY NAMES ONLY — never payload values
    tool_name_present: hookData != null && hookData.tool_name !== undefined,
    tool_present: hookData != null && hookData.tool !== undefined,
    tool_name: (hookData != null && hookData.tool_name) || null,
    tool: (hookData != null && hookData.tool) || null,
    tool_response_shape: describeToolResponse(hookData),
  });

  const toolName = hookData.tool_name || hookData.tool || "";

  // Only process agent tool results
  const agentTools = [
    "rks_agent_run",
    "rks_agent_research",
    "rks_agent_validate_story",
    "rks_agent_git",
    "rks_agent_external_research",
    "rks_agent_dendron",
    "rks_agent_telemetry",
    "rks_agent_ship",
    "rks_agent_cycle_complete",
    "rks_agent_story",
    "rks_agent_delivery",
    "rks_agent_recovery",
  ];
  const isAgentTool = agentTools.some(t => toolName.includes(t));
  if (!isAgentTool) {
    // Distinguishes the two gate exits that used to look identical: an EMPTY
    // toolName means neither consulted field was present (contract drift), while
    // a non-empty one means a real tool name that simply is not an agent tool.
    recordHeartbeat({ stage: "exit_not_agent_tool", tool_name: toolName || null });
    process.exit(0);
  }

  // A handled tool that carries NEITHER field is the contract-drift signal this hook
  // exists to make loud — it is exactly the state that hid this defect.
  if (hookData.tool_response === undefined && hookData.tool_result === undefined) {
    reportUnknownPayloadShape(toolName, hookData, "neither tool_response nor tool_result present");
    process.exit(0);
  }

  const result = extractAgentResult(hookData);
  if (!result) {
    reportUnknownPayloadShape(toolName, hookData, "payload present but not parseable to an agent result");
    process.exit(0);
  }

  const paths = extractPaths(result);
  if (paths.length === 0) {
    // Parsed, but into a shape carrying no recognised sources[] / path array.
    // Grant nothing, but make the next contract drift detectable.
    reportUnknownPayloadShape(toolName, hookData, "parsed result exposed no recognised source paths");
    process.exit(0);
  }

  const query = getProvenanceQuery(hookData);

  for (const p of paths) {
    try {
      addRagSourcedPath(p, query);
    } catch {
      // best-effort
    }
  }

  if (paths.length > 0) {
    process.stderr.write(`[agent-provenance] Tracked ${paths.length} paths from ${toolName}: ${paths.slice(0, 5).join(", ")}\n`);
  }

  process.exit(0);
})();
