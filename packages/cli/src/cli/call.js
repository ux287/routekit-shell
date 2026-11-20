// routekit call --project <id> --batch <calls.json>
// routekit call --project <id> --tool <name> [--args '<json>' | --args-file <path>]
// One mcp-rks connection, one governor session, token + projectId injected into every call.
// backlog.feat.cli-call-batch-runner
//
// No side effects at import time: routekit.js imports this module statically for every verb.
//
// Governance parity: this runner reaches tools ONLY through a spawned mcp-rks.mjs and MCP
// callTool. It imports no server module or tool handler, so the server-side token gate, chain
// state and audit apply to every call exactly as they do for any other MCP client. Claude Code
// hooks do not run for CLI calls.
import fs from "fs";
import path from "path";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const INIT_TOOL = "rks_governor_init";
const END_TOOL = "rks_governor_end";
const READBACK_TOOLS = new Set(["dendron_update_field", "dendron_update_fields"]);
const SERVER_BIN = "packages/mcp-rks/bin/mcp-rks.mjs";
const FLOW_TYPES = new Set(["open", "ops"]);
// Variables that make the server skip token validation. Never forwarded to the spawned server.
const BYPASS_VARS = ["RKS_SKIP_PREFLIGHT", "RKS_TEST_MODE"];

// ---------- batch parsing ----------

// Shared by the --batch and --tool paths: an entry must name a string tool, must not open the
// session itself, and must not carry its own token (the runner injects the session token).
export function validateEntries(raw) {
  if (!Array.isArray(raw)) throw new Error("batch file must be a JSON array of { tool, arguments }");
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || typeof entry.tool !== "string" || !entry.tool) {
      throw new Error(`batch entry ${i} has no tool`);
    }
    if (entry.tool === INIT_TOOL) {
      throw new Error(`batch entry ${i} names ${INIT_TOOL}; the runner opens the session itself`);
    }
    if (entry.arguments !== undefined && (entry.arguments === null || typeof entry.arguments !== "object" || Array.isArray(entry.arguments))) {
      throw new Error(`batch entry ${i} has arguments that are not an object`);
    }
    if (entry.arguments && "_governorToken" in entry.arguments) {
      throw new Error(`batch entry ${i} carries _governorToken; the runner injects the session token`);
    }
  });
  return raw;
}

export function parseBatchFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return validateEntries(raw);
}

// Copy of baseEnv with ROUTEKIT_PROJECT_ID / ROUTEKIT_PROJECT_ROOT set and the token-gate bypass
// variables removed (RKS_SKIP_PREFLIGHT, RKS_TEST_MODE, and NODE_ENV when it equals "test").
// RKS_VIA is always set to "call" (backlog.feat.project-lease-actor-attribution §6a, D15); RKS_ACTOR
// and RKS_DISPATCH_RUN_ID pass through unchanged (D16, D17).
// Never mutates baseEnv. `scrubbed` names every inherited variable whose value was removed OR
// replaced: RKS_VIA in `scrubbed` (and so in the report's envScrubbed) next to RKS_VIA=call in the
// returned env is expected, and means "the inherited value was removed", not "the variable is absent".
export function buildServerEnv(baseEnv, { projectId, projectRoot }) {
  const env = { ...baseEnv };
  const scrubbed = [];
  for (const k of BYPASS_VARS) {
    if (k in env) {
      delete env[k];
      scrubbed.push(k);
    }
  }
  if (env.NODE_ENV === "test") {
    delete env.NODE_ENV;
    scrubbed.push("NODE_ENV");
  }
  env.ROUTEKIT_PROJECT_ID = projectId;
  env.ROUTEKIT_PROJECT_ROOT = projectRoot;
  // Lane attribution (backlog.feat.project-lease-actor-attribution §6a): the server resolves via
  // from RKS_VIA before the init input, so an inherited value (e.g. "dispatch") would mislabel this lane.
  // scrubbed names every inherited variable whose value was removed OR replaced: RKS_VIA in envScrubbed
  // next to RKS_VIA=call in the env is expected and means the inherited value was removed (D15).
  if ("RKS_VIA" in env && env.RKS_VIA !== "call") scrubbed.push("RKS_VIA");
  env.RKS_VIA = "call";
  return { env, scrubbed };
}

// ---------- result classification (fail closed) ----------

// A result is ok ONLY when its first text item parses as JSON, the payload has ok === true and it
// carries no _autoRouted field. Everything else is a failure with a reason; there is no third status.
function classify(mcpResult) {
  const items = mcpResult && Array.isArray(mcpResult.content) ? mcpResult.content : [];
  const textItem = items.find((c) => c && c.type === "text" && typeof c.text === "string");
  if (!textItem) return { ok: false, reason: "unverifiable_payload", payload: null };
  let payload;
  try {
    payload = JSON.parse(textItem.text);
  } catch {
    return { ok: false, reason: "unverifiable_payload", payload: textItem.text };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "unverifiable_payload", payload };
  }
  // The runner always sends a token, so an auto-route envelope means the token was rejected.
  if ("_autoRouted" in payload) return { ok: false, reason: "auto_routed", payload };
  if (payload.ok === false || (payload.error !== undefined && payload.error !== null)) {
    return { ok: false, reason: "tool_error", payload };
  }
  if (payload.ok !== true) return { ok: false, reason: "unverifiable_payload", payload };
  return { ok: true, payload };
}

async function callAndClassify(client, name, args) {
  try {
    return classify(await client.callTool({ name, arguments: args }));
  } catch (err) {
    return { ok: false, reason: "call_threw", payload: null, error: err?.message || String(err) };
  }
}

function errorText(c) {
  if (c.error) return c.error;
  const p = c.payload;
  if (p && typeof p === "object") {
    if (typeof p.error === "string") return p.error;
    if (p.error) return JSON.stringify(p.error);
    if (typeof p.message === "string") return p.message;
  }
  return undefined;
}

// ---------- read-back ----------

function valuesEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && valuesEqual(a[k], b[k]));
  }
  return a === b;
}

// The fields a write step claims to have written, as { field: value }.
function writtenFields(tool, args) {
  if (tool === "dendron_update_field") return { [args.field]: args.value };
  if (tool === "dendron_update_fields" && args.fields && typeof args.fields === "object") return { ...args.fields };
  return {};
}

// Reads the written fields back and passes only when every value read back EQUALS the value written.
async function readBack({ client, tool, args, projectId, token }) {
  const expected = writtenFields(tool, args);
  const fields = Object.keys(expected);
  if (fields.length === 0) {
    return { ok: false, reason: "readback_mismatch", readback: null, error: "write step names no field to read back" };
  }
  const read = await callAndClassify(client, "dendron_read_note", {
    filename: args.filename,
    fields,
    projectId,
    _governorToken: token,
  });
  if (!read.ok) {
    return { ok: false, reason: "readback_failed", readback: read.payload, error: errorText(read) || `read-back ${read.reason}` };
  }
  const payload = read.payload;
  const notFound = Array.isArray(payload.fieldsNotFound) ? payload.fieldsNotFound.filter((f) => fields.includes(f)) : [];
  if (notFound.length > 0) {
    return { ok: false, reason: "readback_mismatch", readback: payload, error: `fields not found on read-back: ${notFound.join(", ")}` };
  }
  let parsed;
  try {
    parsed = YAML.parse(typeof payload.content === "string" ? payload.content : "");
  } catch (err) {
    return { ok: false, reason: "readback_mismatch", readback: payload, error: `read-back content is not YAML: ${err?.message || err}` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "readback_mismatch", readback: payload, error: "read-back content holds no fields" };
  }
  const mismatched = fields.filter((f) => !valuesEqual(parsed[f], expected[f]));
  if (mismatched.length > 0) {
    return { ok: false, reason: "readback_mismatch", readback: payload, error: `value read back differs from value written: ${mismatched.join(", ")}` };
  }
  return { ok: true, readback: payload };
}

// ---------- runner ----------

function sessionEndFrom(c) {
  const p = c.payload && typeof c.payload === "object" && !Array.isArray(c.payload) ? c.payload : null;
  const out = { ok: c.ok };
  if (c.ok) {
    if (p && "ended" in p) out.ended = p.ended;
    if (p && typeof p.reason === "string") out.reason = p.reason;
  } else {
    // ARCH ruling: copy the server's own reason when the parsed payload carries one; the
    // runner's step vocabulary applies only when the payload supplies no reason.
    const ownReason = p && c.reason !== "auto_routed" && typeof p.reason === "string" ? p.reason : null;
    out.reason = ownReason || c.reason;
    if (p && "ended" in p) out.ended = p.ended;
    if (p && Array.isArray(p.blockedBy)) out.blockedBy = [...p.blockedBy];
    const err = errorText(c);
    if (err) out.error = err;
  }
  out.result = c.payload;
  return out;
}

export async function runBatch({ calls, projectId, flowType = "open", client, readback = true, continueOnError = false }) {
  const steps = [];
  const allIndices = calls.map((_, i) => i);
  const report = { ok: false, projectId, flowType, init: null, steps, failedAt: null, skipped: [], sessionEnd: null };

  // One session: init exactly once, first. A throw here means no token and no session to end.
  let initResult;
  try {
    initResult = await client.callTool({ name: INIT_TOOL, arguments: { projectId, flowType, via: "call" } }); // §6a, D18: fallback behind RKS_VIA
  } catch (err) {
    report.init = { ok: false, reason: "call_threw", error: err?.message || String(err) };
    report.skipped = allIndices;
    return report;
  }
  const init = classify(initResult);
  const initPayload = init.payload && typeof init.payload === "object" ? init.payload : null;
  const token = initPayload && typeof initPayload.token === "string" && initPayload.token ? initPayload.token : null;
  if (initPayload && initPayload.state !== undefined) report.sessionState = initPayload.state;
  const initOk = init.ok && token !== null;
  report.init = initOk
    ? { ok: true }
    : { ok: false, reason: init.ok ? "no_token" : init.reason, error: errorText(init), result: init.payload };

  if (token === null) {
    report.skipped = allIndices;
    return report;
  }

  // A token was issued, so a session exists: end it in a finally on EVERY exit path.
  // `current` is the index being run, so a throw escaping the loop can be recorded against it.
  let current = null;
  try {
    if (!initOk) {
      report.skipped = allIndices;
    } else {
      for (let i = 0; i < calls.length; i++) {
        current = i;
        const entry = calls[i];
        const own = entry.arguments || {};
        let step;
        if (own.projectId !== undefined && own.projectId !== projectId) {
          step = {
            index: i,
            tool: entry.tool,
            ok: false,
            reason: "project_mismatch",
            result: null,
            error: `entry projectId ${JSON.stringify(own.projectId)} differs from --project ${projectId}`,
          };
        } else {
          const args = { ...own, projectId, _governorToken: token };
          const c = await callAndClassify(client, entry.tool, args);
          step = { index: i, tool: entry.tool, ok: c.ok, result: c.payload };
          if (!c.ok) {
            step.reason = c.reason;
            const err = errorText(c);
            if (err) step.error = err;
            if (c.payload && typeof c.payload === "object") {
              if (c.payload.state !== undefined) step.state = c.payload.state;
              if (c.payload.message !== undefined) step.message = c.payload.message;
            }
          } else if (readback && READBACK_TOOLS.has(entry.tool)) {
            const rb = await readBack({ client, tool: entry.tool, args: own, projectId, token });
            step.readback = rb.readback;
            if (!rb.ok) {
              step.ok = false;
              step.reason = rb.reason;
              if (rb.error) step.error = rb.error;
            }
          }
        }
        steps.push(step);
        if (!step.ok) {
          if (report.failedAt === null) report.failedAt = i;
          if (!continueOnError) {
            report.skipped = allIndices.slice(i + 1);
            break;
          }
        }
      }
      current = null;
    }
  } catch (err) {
    // A throw escaping the step loop is recorded in the report (as a step entry at the throwing
    // index, so failedAt, steps and skipped stay consistent) instead of propagating; the finally
    // below still ends the session, and the report is returned with ok false (fail closed).
    const index = current === null ? steps.length : current;
    let tool;
    try {
      tool = calls[index] ? calls[index].tool : undefined;
    } catch {
      tool = undefined;
    }
    const entry = { index, tool, ok: false, reason: "runner_threw", error: err?.message || String(err) };
    const existing = steps.findIndex((s) => s.index === index);
    if (existing === -1) steps.push(entry);
    else steps[existing] = entry;
    if (report.failedAt === null || report.failedAt > index) report.failedAt = index;
    report.skipped = allIndices.slice(index + 1);
  } finally {
    // Exactly once, last, with the init token; never retried and never a step.
    const end = await callAndClassify(client, END_TOOL, { projectId, _governorToken: token });
    report.sessionEnd = sessionEndFrom(end);
  }

  report.ok = initOk && report.failedAt === null && steps.every((s) => s.ok === true) && report.sessionEnd.ok === true;
  return report;
}

// ---------- CLI handler ----------

async function defaultConnect({ SHELL_ROOT, env }) {
  // Spawns exactly one mcp-rks with exactly the env it is handed (no { ...process.env } spread).
  const transport = new StdioClientTransport({ command: "node", args: [path.join(SHELL_ROOT, SERVER_BIN)], env });
  const client = new Client({ name: "routekit-call", version: "0.1.0" });
  await client.connect(transport);
  const parsedTimeout = Number(env.RKS_MCP_TIMEOUT_MS || env.ROUTEKIT_MCP_TIMEOUT_MS);
  const timeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 300000;
  return {
    client: { callTool: (params) => client.callTool(params, undefined, { timeout }) },
    close: () => client.close(),
  };
}

async function defaultResolveProjectRoot(projectId, SHELL_ROOT) {
  // Lazy import, matching packages/cli/src/cli/rag.js and project.js.
  const { getProjectById } = await import("../project/index.js");
  const record = getProjectById(projectId, SHELL_ROOT);
  const root = record && (record.root || record.path);
  if (!root) throw new Error(`project not found in registry: ${projectId}`);
  return root;
}

// Waits for stdout to flush before exiting, so a piped JSON report is never truncated.
async function defaultProcessExit(code) {
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(code);
}

function printUsage(log) {
  log(`Usage:
  routekit call --project <id> --batch <calls.json> [--flow open|ops] [--no-readback] [--continue-on-error]
  routekit call --project <id> --tool <name> [--args '<json>' | --args-file <path>] [--flow open|ops] [--no-readback]

  Opens one mcp-rks connection and one governor session, injects projectId and the session token
  into every call, reads back frontmatter writes, stops on the first failure and ends the session.
  Prints a JSON report; exits non-zero when the report's ok is false.
  Claude Code hooks do not run for CLI calls; governance is server-side (token gate, chain state, audit).`);
}

function parseCallArgs(args) {
  const parts = args[0] === "call" ? args.slice(1) : args.slice();
  const opts = {};
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (["no-readback", "continue-on-error", "help"].includes(key)) {
      opts[key] = true;
      continue;
    }
    if (!["project", "batch", "flow", "tool", "args", "args-file"].includes(key)) throw new Error(`unknown option: --${key}`);
    let value;
    if (eq !== -1) value = a.slice(eq + 1);
    else {
      value = parts[i + 1];
      i += 1;
    }
    if (value === undefined) throw new Error(`--${key} needs a value`);
    opts[key] = value;
  }
  return opts;
}

function callsFromOptions(opts) {
  if (opts.batch && opts.tool) throw new Error("pass either --batch or --tool, not both");
  if (opts.batch) return parseBatchFile(path.resolve(opts.batch));
  if (!opts.tool) throw new Error("one of --batch <calls.json> or --tool <name> is required");
  if (opts.args !== undefined && opts["args-file"] !== undefined) throw new Error("pass either --args or --args-file, not both");
  let toolArgs;
  if (opts.args !== undefined) toolArgs = JSON.parse(opts.args);
  else if (opts["args-file"] !== undefined) toolArgs = JSON.parse(fs.readFileSync(path.resolve(opts["args-file"]), "utf8"));
  const entry = toolArgs === undefined ? { tool: opts.tool } : { tool: opts.tool, arguments: toolArgs };
  return validateEntries([entry]);
}

// DI contract follows handlePublishCommand (publish.js): every side-effecting dependency is
// injectable and defaults to the real implementation. Return after each processExit call, because a
// stubbed processExit does not end the process.
export async function handleCallCommand({ args = [], SHELL_ROOT } = {}, deps = {}) {
  const resolveProjectRoot = deps.resolveProjectRoot || defaultResolveProjectRoot;
  const connect = deps.connect || defaultConnect;
  const baseEnv = deps.env || process.env;
  const log = deps.log || console.log;
  const errorLog = deps.errorLog || console.error;
  const processExit = deps.processExit ?? defaultProcessExit;

  let opts;
  try {
    opts = parseCallArgs(args);
  } catch (err) {
    errorLog(`routekit call: ${err?.message || err}`);
    printUsage(errorLog);
    return await processExit(2);
  }
  if (opts.help) {
    printUsage(log);
    return await processExit(0);
  }
  const projectId = opts.project;
  if (!projectId) {
    errorLog("routekit call: --project <id> is required");
    printUsage(errorLog);
    return await processExit(2);
  }
  const flowType = opts.flow || "open";
  if (!FLOW_TYPES.has(flowType)) {
    errorLog(`routekit call: --flow must be open or ops (got ${flowType})`);
    return await processExit(2);
  }

  // Parse and validate every call BEFORE resolving the project or connecting.
  let calls;
  try {
    calls = callsFromOptions(opts);
  } catch (err) {
    errorLog(`routekit call: ${err?.message || err}`);
    return await processExit(2);
  }

  let projectRoot;
  try {
    projectRoot = await resolveProjectRoot(projectId, SHELL_ROOT);
  } catch (err) {
    errorLog(`routekit call: ${err?.message || err}`);
    return await processExit(1);
  }

  const { env, scrubbed } = buildServerEnv(baseEnv, { projectId, projectRoot });

  let connection;
  try {
    connection = await connect({ projectId, projectRoot, SHELL_ROOT, env });
  } catch (err) {
    errorLog(`routekit call: could not start mcp-rks: ${err?.message || err}`);
    return await processExit(1);
  }

  let report;
  try {
    report = await runBatch({
      calls,
      projectId,
      flowType,
      client: connection.client,
      readback: opts["no-readback"] !== true,
      continueOnError: opts["continue-on-error"] === true,
    });
  } catch (err) {
    errorLog(`routekit call: runner failed: ${err?.message || err}`);
    report = null;
  } finally {
    try {
      await connection.close();
    } catch {
      // closing a dead transport is not a reportable failure of the run
    }
  }
  if (!report) return await processExit(1);

  log(JSON.stringify({ ...report, envScrubbed: scrubbed }, null, 2));
  return await processExit(report.ok ? 0 : 1);
}
