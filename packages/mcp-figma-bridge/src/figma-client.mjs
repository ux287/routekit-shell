const DEFAULT_URL = "http://127.0.0.1:3845/mcp";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

function buildInitializeParams() {
  const protocolVersion =
    (process.env.FIGMA_MCP_PROTOCOL_VERSION && String(process.env.FIGMA_MCP_PROTOCOL_VERSION).trim()) ||
    DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "routekit-figma-bridge", version: "0.1.0" },
  };
}

function isInvalidSessionError(payload) {
  const message = payload?.error?.message || payload?.message || "";
  return typeof message === "string" && /invalid sessionid/i.test(message);
}

async function readJsonRpcResponseFromSse(response, wantedId) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new Error("Figma MCP response did not include a readable body stream");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    // Parse SSE: collect "data:" frames and find the matching jsonrpc id.
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);

        if (!line) continue;
        if (!line.startsWith("data:")) continue;
        const raw = line.slice("data:".length).trim();
        if (!raw || raw === "[DONE]") continue;
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        if (msg && Object.prototype.hasOwnProperty.call(msg, "id") && msg.id === wantedId) {
          return msg;
        }
      }
    }
  } finally {
    try {
      reader.cancel();
    } catch {
      // ignore
    }
  }

  throw new Error("Figma MCP response ended before receiving the expected JSON-RPC message");
}

async function parseJsonRpcResponse(response, wantedId) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    return readJsonRpcResponseFromSse(response, wantedId);
  }
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    // Some servers may return a single message directly (not SSE).
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, "id") && parsed.id === wantedId) return parsed;
    return parsed;
  } catch {
    throw new Error(`Figma MCP returned non-JSON response: ${text.slice(0, 200)}`);
  }
}

export class FigmaMcpHttpClient {
  constructor(options = {}) {
    this.url =
      (options.url && String(options.url).trim()) ||
      (process.env.FIGMA_MCP_URL && String(process.env.FIGMA_MCP_URL).trim()) ||
      DEFAULT_URL;
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== "function") {
      throw new Error("FigmaMcpHttpClient requires a fetch implementation (global fetch not available)");
    }
    this.sessionId = null;
    this._initPromise = null;
  }

  async ensureSession() {
    if (this.sessionId) return this.sessionId;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this.initialize()
      .then((sid) => sid)
      .finally(() => {
        this._initPromise = null;
      });
    return this._initPromise;
  }

  async initialize() {
    const res = await this._callJsonRpc("initialize", buildInitializeParams(), { sessionId: null });
    const sessionId = res.sessionId;
    if (!sessionId) {
      throw new Error("Figma MCP initialize did not return mcp-session-id header");
    }
    this.sessionId = sessionId;
    return sessionId;
  }

  async toolsList() {
    await this.ensureSession();
    const res = await this._callJsonRpc("tools/list", {}, { sessionId: this.sessionId });
    if (res.payload?.error) throw new Error(res.payload.error.message || "Figma MCP tools/list failed");
    return res.payload?.result?.tools || [];
  }

  async toolsCall(name, args) {
    await this.ensureSession();
    const attempt = async () => this._callJsonRpc("tools/call", { name, arguments: args || {} }, { sessionId: this.sessionId });
    let res = await attempt();
    if (isInvalidSessionError(res.payload)) {
      this.sessionId = null;
      await this.initialize();
      res = await attempt();
    }
    if (res.payload?.error) throw new Error(res.payload.error.message || "Figma MCP tools/call failed");
    return res.payload?.result;
  }

  async _callJsonRpc(method, params, { sessionId }) {
    const id = Math.floor(Math.random() * 1_000_000_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      if (sessionId) headers["mcp-session-id"] = sessionId;

      const response = await this.fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });

      const nextSession = response.headers.get("mcp-session-id") || response.headers.get("Mcp-Session-Id");
      const payload = await parseJsonRpcResponse(response, id);
      return { payload, sessionId: nextSession || sessionId || null };
    } catch (error) {
      const msg = error?.name === "AbortError" ? `Timeout calling Figma MCP at ${this.url}` : error?.message || String(error);
      throw new Error(msg);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function describeFigmaConnectivityError(err) {
  const message = err?.message || String(err);
  if (/timeout/i.test(message) || /fetch/i.test(message) || /ECONNREFUSED/i.test(message)) {
    return `Figma Desktop not listening on ${DEFAULT_URL}. Ensure Figma Desktop is running and MCP is enabled.`;
  }
  if (/invalid sessionid/i.test(message)) {
    return "Figma MCP session expired. Re-initialize and retry.";
  }
  return message;
}

