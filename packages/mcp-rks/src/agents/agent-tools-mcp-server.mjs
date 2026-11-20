#!/usr/bin/env node
/**
 * rks-agent-tools — stdio MCP server exposing ONE rks agent's in-process tools
 * (backlog.feat.agent-tools-mcp-server)
 *
 * runner.mjs calls agent tools as local closures. A `claude -p` child cannot reach closures, so
 * this server builds the SAME tool objects (createResearchAgent(...).tools) and serves them over
 * stdio MCP. Read-only by decision D3 (research.2026.10.15.claude-p-subscription-backend): the
 * research agent's dendron_* write tools are NOT exposed. The research agent's four read-only tools are
 * exhaustive_search, rag_query, read_file and read_git (exhaustive_search added by
 * backlog.feat.research-agent-exhaustive-search-tool; its call ledger rides in --budget-file).
 *
 * Parity with runner.mjs tool dispatch:
 *  - each call emits agent.<agent>.tool_call with the runner's fields (tool, ok, durationMs, path
 *    for read_file, query + hitCount for rag_query), tagged with the parent invocation's
 *    telemetryId and model, plus backend and billing ONLY when the launcher passed --backend /
 *    --billing (this server observes nothing about how its parent is billed, so it never
 *    invents them);
 *  - every rag_query outcome (classifyRetrieval) is appended as one JSON line to --outcomes-file,
 *    so the parent can replay it into the research agent's retrieval record. That record drives
 *    the code-set failureCategory (research.mjs buildResearchOutputSchema) and is otherwise lost
 *    across the process boundary. A failed append is volunteered on that call's tool_call event
 *    as outcomeWriteFailed + outcomeWriteError, never swallowed silently. A budget-refused
 *    rag_query appends no line;
 *  - the research agent's tool-budget counter state is written to --budget-file (a separate file)
 *    after every call, so the parent can replay counts made in this process
 *    (backlog.fix.research-agent-budget-observed-not-asserted);
 *  - --named-paths (optional) carries the parent's existing named-path set, so a read of a named
 *    path here gets the reserved allowance and is recorded in that budget state with named: true
 *    (backlog.fix.research-agent-named-path-read).
 */
import fs from 'fs';
import { pathToFileURL } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureTelemetryStorage } from '@routekit/telemetry';
import { setRagHostHooks } from '@routekit/rag';
import { createResearchAgent, classifyRetrieval } from './research.mjs';
import { zodToJsonSchema } from './zod-to-json-schema.mjs';

export const AGENT_TOOLS_SERVER_NAME = 'rks-agent-tools';
export const READ_ONLY_TOOLS = Object.freeze({
  research: Object.freeze(['exhaustive_search', 'rag_query', 'read_file', 'read_git']),
});
const AGENT_FACTORIES = Object.freeze({ research: createResearchAgent });

const FLAG_KEYS = Object.freeze({
  '--agent': 'agent',
  '--project': 'projectId',
  '--root': 'projectRoot',
  '--telemetry-id': 'telemetryId',
  '--model': 'model',
  '--outcomes-file': 'outcomesFile',
  '--budget-file': 'budgetFile',
  '--backend': 'backend',
  '--billing': 'billing',
  '--named-paths': 'namedPaths',
});

/**
 * --named-paths carries the parent's existing named-path set as a JSON array of repo-relative paths
 * (backlog.fix.research-agent-named-path-read). Anything else yields no set.
 */
export function parseNamedPaths(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const list = JSON.parse(value);
    return Array.isArray(list) && list.every((p) => typeof p === 'string') && list.length > 0 ? list : undefined;
  } catch {
    return undefined;
  }
}

export function parseServerArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = FLAG_KEYS[argv[i]];
    if (key && i + 1 < argv.length) {
      out[key] = argv[i + 1];
      i++;
    }
  }
  return out;
}

/**
 * Build the agent once and return its read-only tools plus its tool budget view (cfg._budget, when
 * the agent has one). The budget counts the calls THESE tool objects make, so it is the state the
 * parent replays (backlog.fix.research-agent-budget-observed-not-asserted).
 */
export function buildAgentTools({ agent, projectId, projectRoot, telemetryId, namedPaths, factories = AGENT_FACTORIES }) {
  const allowed = READ_ONLY_TOOLS[agent];
  const factory = factories[agent];
  if (!allowed || typeof factory !== 'function') {
    throw new Error(`rks-agent-tools: agent '${agent}' is not supported (supported: ${Object.keys(READ_ONLY_TOOLS).join(', ')})`);
  }
  // telemetryId is forwarded only when supplied (key omitted otherwise), so the agent's rag.query
  // events carry the launcher's join key (backlog.feat.research-agent-run-telemetry-coverage).
  // namedPaths likewise (backlog.fix.research-agent-named-path-read): this process's query is empty,
  // so the parent's named set is what gives its reads the reserved allowance. Named reads land in
  // the budget state file as read_file paths entries with named: true.
  const cfg = factory({
    projectId, query: '', projectRoot,
    ...(telemetryId ? { telemetryId } : {}),
    ...(Array.isArray(namedPaths) && namedPaths.length > 0 ? { namedPaths } : {}),
  });
  return { tools: (cfg.tools || []).filter((t) => allowed.includes(t.name)), budget: cfg._budget || null };
}

export function selectAgentTools(opts) {
  return buildAgentTools(opts).tools;
}

// Counter state goes to its OWN file (--budget-file), never the --outcomes-file: that file holds
// exactly one { outcome } line per executed rag_query. Written atomically (tmp + rename) so the
// parent never reads a torn snapshot. If a write fails the file is removed, so the parent reports
// the budget as not observed rather than replaying a stale count. Returns what was observed.
function writeBudgetState(budgetFile, budget) {
  if (!budgetFile || !budget || typeof budget.snapshot !== 'function') return { attempted: false };
  const tmpFile = `${budgetFile}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(budget.snapshot()), 'utf8');
    fs.renameSync(tmpFile, budgetFile);
    return { attempted: true, ok: true };
  } catch (err) {
    try { fs.rmSync(budgetFile, { force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(tmpFile, { force: true }); } catch { /* best-effort */ }
    return { attempted: true, ok: false, error: err?.message || String(err) };
  }
}

// Returns what was OBSERVED: { attempted: false } with no outcomes file, { attempted: true, ok: true }
// after a completed append, { attempted: true, ok: false, error } when the append threw. The caller
// reports a failed append on the tool_call event; it never fails the tool call itself.
function appendOutcome(outcomesFile, outcome) {
  if (!outcomesFile) return { attempted: false };
  try {
    fs.appendFileSync(outcomesFile, `${JSON.stringify({ outcome })}\n`, 'utf8');
    return { attempted: true, ok: true };
  } catch (err) {
    return { attempted: true, ok: false, error: err?.message || String(err) };
  }
}

export function createToolHandlers({
  tools,
  agent,
  projectId,
  telemetryId,
  model,
  backend,
  billing,
  collector = { emit: () => {} },
  outcomesFile,
  budgetFile,
  budget,
  now = Date.now,
}) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  // Initial snapshot: a run that makes no tool call is observed at zero, not unobserved.
  writeBudgetState(budgetFile, budget);
  // backend/billing are launcher-supplied (--backend/--billing); omitted entirely when absent.
  const tags = { telemetryId, model };
  if (backend) tags.backend = backend;
  if (billing) tags.billing = billing;
  const emit = async (data) => {
    try {
      collector.emit(`agent.${agent}.tool_call`, projectId, { ...tags, ...data });
    } catch { /* best-effort */ }
    try { await collector.flush?.(); } catch { /* best-effort */ }
  };
  const extrasFor = (name, input) => {
    if (name === 'read_file') return { path: input?.path };
    if (name === 'rag_query') return { query: input?.q };
    return {};
  };
  const asText = (value, isError = false) => ({
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  });

  return {
    listTools() {
      return {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: zodToJsonSchema(t.inputSchema),
        })),
      };
    },
    async callTool(name, input = {}) {
      const tool = toolMap.get(name);
      if (!tool) {
        await emit({ tool: name, ok: false, error: 'unknown_tool' });
        return asText({ error: `Unknown tool: ${name}` }, true);
      }
      const start = now();
      const extras = extrasFor(name, input);
      try {
        const result = await tool.execute(input);
        const budgetWrite = writeBudgetState(budgetFile, budget);
        // A failed budget-state write removed the file (the parent reports observed: false);
        // volunteer it on the event, mirroring outcomeWriteFailed.
        if (budgetWrite.attempted && !budgetWrite.ok) {
          extras.budgetWriteFailed = true;
          extras.budgetWriteError = budgetWrite.error;
        }
        // A budget refusal is not a retrieval: it appends no outcome line, so the parent's replay
        // records nothing for it (classifyRetrieval would map its ok:false to retrieval_failed).
        if (name === 'rag_query' && !result?.budgetExhausted) {
          extras.hitCount = Array.isArray(result?.matches) ? result.matches.length : undefined;
          const write = appendOutcome(outcomesFile, classifyRetrieval(result));
          if (write.attempted && !write.ok) {
            extras.outcomeWriteFailed = true;
            extras.outcomeWriteError = write.error;
          }
        }
        // Read window (backlog.feat.research-agent-run-telemetry-coverage): OBSERVED from the
        // result, never the input. Error results, budget refusals and redacted dotenv stubs carry
        // no totalLines, so they log no window fields.
        if (name === 'read_file' && typeof result?.totalLines === 'number'
          && typeof result.offset === 'number' && typeof result.limit === 'number') {
          extras.offset = result.offset;
          extras.limit = result.limit;
          extras.totalLines = result.totalLines;
          extras.truncatedWindow = result.offset + result.limit < result.totalLines;
        }
        // ok is OBSERVED from the result: a budget refusal or an error result did not succeed.
        const outcome = result?.budgetExhausted
          ? { ok: false, budgetExhausted: result.budgetExhausted }
          : typeof result?.error === 'string'
            ? { ok: false, error: result.error }
            : { ok: true };
        await emit({ tool: name, ...outcome, durationMs: now() - start, ...extras });
        return asText(result);
      } catch (err) {
        const budgetWrite = writeBudgetState(budgetFile, budget); // an admitted call that threw still consumed its slot
        if (budgetWrite.attempted && !budgetWrite.ok) {
          extras.budgetWriteFailed = true;
          extras.budgetWriteError = budgetWrite.error;
        }
        const message = err?.message || String(err);
        await emit({ tool: name, ok: false, error: message, durationMs: now() - start, ...extras });
        return asText({ error: message }, true);
      }
    },
  };
}

export async function startAgentToolsServer(argv = process.argv.slice(2), deps = {}) {
  const args = parseServerArgs(argv);
  if (!args.agent || !args.projectId || !args.projectRoot) {
    throw new Error('rks-agent-tools: --agent, --project and --root are required');
  }
  const { tools, budget } = buildAgentTools({
    agent: args.agent, projectId: args.projectId, projectRoot: args.projectRoot, telemetryId: args.telemetryId,
    namedPaths: parseNamedPaths(args.namedPaths),
  });
  let collector = { emit: () => {} };
  try {
    collector = (deps.ensureTelemetryStorage || ensureTelemetryStorage)(args.projectRoot);
  } catch { /* best-effort */ }
  // Route runRagQuery's rag.query event to THIS process's collector (backlog.fix.rag-query-ranked-telemetry):
  // on the claude-cli backend the research agent's rag_query runs here, where the RAG hooks were
  // otherwise unwired no-ops. Session provenance stays with the main server, so only telemetry is wired.
  setRagHostHooks({ getTelemetryCollector: () => collector });
  const handlers = createToolHandlers({
    tools,
    agent: args.agent,
    projectId: args.projectId,
    telemetryId: args.telemetryId,
    model: args.model,
    backend: args.backend,
    billing: args.billing,
    collector,
    outcomesFile: args.outcomesFile,
    budgetFile: args.budgetFile,
    budget,
  });
  const server = new Server({ name: AGENT_TOOLS_SERVER_NAME, version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => handlers.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (req) => handlers.callTool(req.params.name, req.params.arguments || {}));
  const transport = deps.transport || new StdioServerTransport();
  await server.connect(transport);
  return { server, handlers };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAgentToolsServer().catch((err) => {
    process.stderr.write(`${err?.message || String(err)}\n`);
    process.exit(1);
  });
}
