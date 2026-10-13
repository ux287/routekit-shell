/**
 * Per-server MCP tool handler registry.
 *
 * S2 of research.2026.10.05.server-mjs-safe-decomposition. server.mjs builds ONE registry per
 * createServer() call and consults it once inside the CallTool IIFE, after the pre-dispatch
 * gate and before the legacy if-chain. Unregistered tools fall through to the chain.
 *
 * Handler contract (frozen): async (cleanArgs, ctx) => response
 *   cleanArgs — request arguments with _governorToken stripped (what the chain branches get)
 *   ctx       — frozen { tool, args, activeToken, governorToken }; args is for audit only
 * A handler returns the MCP response or throws. Chain-state helpers are imported from
 * src/shared/governor-token.mjs by the handler module, not carried on ctx. The entry-transition
 * revert, decideToolOutcome, audit finally and flushPendingStashPops stay in server.mjs.
 * Extending ctx in a later story is an additive change that must be stated in that story.
 */
export function createHandlerRegistry() {
  const handlers = new Map();
  return Object.freeze({
    registerHandler(tool, handler) {
      if (typeof tool !== "string" || tool.length === 0) {
        throw new TypeError("registerHandler: tool name must be a non-empty string");
      }
      if (typeof handler !== "function") {
        throw new TypeError(`registerHandler: handler for ${tool} must be a function`);
      }
      if (handlers.has(tool)) {
        throw new Error(`registerHandler: duplicate registration for ${tool}`);
      }
      handlers.set(tool, handler);
    },
    lookupHandler(tool) {
      return handlers.get(tool) ?? null;
    },
    registeredTools() {
      return [...handlers.keys()].sort();
    },
  });
}
