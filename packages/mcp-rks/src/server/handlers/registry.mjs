/**
 * Per-server MCP tool handler registry.
 *
 * S2 of research.2026.10.05.server-mjs-safe-decomposition. server.mjs builds ONE registry per
 * createServer() call and consults it once inside the CallTool IIFE, after the pre-dispatch
 * gate. Since S10 the registry is the only dispatch path: lookupHandler consults the name map
 * first, then the single resolver installed by registerResolver (the lazy per-agent tools); a
 * miss on both returns null, and null is the only route to the server.mjs unknown-tool throw.
 *
 * Handler contract (frozen): async (cleanArgs, ctx) => response
 *   cleanArgs — request arguments with _governorToken stripped (what the chain branches get)
 *   ctx       — frozen { tool, args, activeToken, governorToken, revertEntryTransition }; args is
 *               for audit only. revertEntryTransition (S10, additive) is a server.mjs closure that
 *               hands back the IIFE's entry transition; the handler decides when to call it.
 * A handler returns the MCP response or throws. Chain-state helpers are imported from
 * src/shared/governor-token.mjs by the handler module, not carried on ctx. The entry-transition
 * revert, decideToolOutcome, audit finally and flushPendingStashPops stay in server.mjs.
 * Extending ctx in a later story is an additive change that must be stated in that story.
 */
export function createHandlerRegistry() {
  const handlers = new Map();
  let resolver = null;
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
    registerResolver(fn) {
      if (typeof fn !== "function") {
        throw new TypeError("registerResolver: resolver must be a function");
      }
      if (resolver !== null) {
        throw new Error("registerResolver: a resolver is already registered");
      }
      resolver = fn;
    },
    lookupHandler(tool) {
      return handlers.get(tool) ?? resolver?.(tool) ?? null;
    },
    registeredTools() {
      return [...handlers.keys()].sort();
    },
  });
}
