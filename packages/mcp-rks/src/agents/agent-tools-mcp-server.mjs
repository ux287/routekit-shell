#!/usr/bin/env node
/**
 * rks-agent-tools — stdio MCP server exposing ONE rks agent's in-process tools
 * (backlog.feat.agent-tools-mcp-server)
 *
 * runner.mjs calls agent tools as local closures. A `claude -p` child cannot reach closures, so
 * this server builds the SAME tool objects (createResearchAgent(...).tools) and serves them over
 * stdio MCP. Read-only by decision D3 (research.2026.10.15.claude-p-subscription-backend): the
 * research agent's dendron_* write tools are NOT exposed.
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
 *    as outcomeWriteFailed + outcomeWriteError, never swallowed silently.
 */
import fs from 'fs';
import { pathToFileURL } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureTelemetryStorage } from '@routekit/telemetry';
import { createResearchAgent, classifyRetrieval } from './research.mjs';
import { zodToJsonSchema } from './zod-to-json-schema.mjs';

export const AGENT_TOOLS_SERVER_NAME = 'rks-agent-tools';
export const READ_ONLY_TOOLS = Object.freeze({
  research: Object.freeze(['rag_query', 'read_file', 'read_git']),
});
const AGENT_FACTORIES = Object.freeze({ research: createResearchAgent });

const FLAG_KEYS = Object.freeze({
  '--agent': 'agent',
  '--project': 'projectId',
  '--root': 'projectRoot',
  '--telemetry-id': 'telemetryId',
  '--model': 'model',
  '--outcomes-file': 'outcomesFile',
  '--backend': 'backend',
  '--billing': 'billing',
});

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

export function selectAgentTools({ agent, projectId, projectRoot, factories = AGENT_FACTORIES }) {
  const allowed = READ_ONLY_TOOLS[agent];
  const factory = factories[agent];
  if (!allowed || typeof factory !== 'function') {
    throw new Error(`rks-agent-tools: agent '${agent}' is not supported (supported: ${Object.keys(READ_ONLY_TOOLS).join(', ')})`);
  }
  const cfg = factory({ projectId, query: '', projectRoot });
  return (cfg.tools || []).filter((t) => allowed.includes(t.name));
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
  now = Date.now,
}) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
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
        if (name === 'rag_query') {
          extras.hitCount = Array.isArray(result?.matches) ? result.matches.length : undefined;
          const write = appendOutcome(outcomesFile, classifyRetrieval(result));
          if (write.attempted && !write.ok) {
            extras.outcomeWriteFailed = true;
            extras.outcomeWriteError = write.error;
          }
        }
        await emit({ tool: name, ok: true, durationMs: now() - start, ...extras });
        return asText(result);
      } catch (err) {
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
  const tools = selectAgentTools({ agent: args.agent, projectId: args.projectId, projectRoot: args.projectRoot });
  let collector = { emit: () => {} };
  try {
    collector = (deps.ensureTelemetryStorage || ensureTelemetryStorage)(args.projectRoot);
  } catch { /* best-effort */ }
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
