import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The standalone RAG MCP servers must BOOT and serve WITHOUT any LLM credential (they do not inherit
// the main MCP server's boot-time credential gate). Real subprocess spawns, credentials scrubbed,
// timeout-guarded.
//
// backlog.fix.rag-http-server-sse-boot: rag-server-http.mjs's HTTP/SSE boot was fixed here — it now
// stands up a real http.Server and constructs SSEServerTransport with the request's ServerResponse
// (the earlier `SSEServerTransport("/mcp", {port})` crashed with "this.res.writeHead is not a
// function"). The http case below asserts a real listening/connected boot, not just reaching main().

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

// Spawn a server with LLM credentials scrubbed. Resolve with accumulated stderr once the process
// logs a startup marker, exits, or the timeout fires. Always kills the child. Never rejects — the
// caller asserts on stderr content (so a pre-existing non-credential crash is still observable).
function runServer(relPath, extraEnv = {}) {
  return new Promise((resolveP) => {
    const env = { ...process.env, ...extraEnv };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.ROUTEKIT_LLM_PROVIDER;

    const child = spawn("node", [resolve(ROOT, relPath)], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolveP(stderr);
    };
    const timer = setTimeout(settle, 15000);
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (/Available tools|Server connected|connected on http/i.test(stderr)) settle();
    });
    child.on("exit", settle);
    child.on("error", settle);
  });
}

const NO_CREDENTIAL_ERROR = /ANTHROPIC_API_KEY|OPENAI_API_KEY|missing credential|no api key/i;

describe("standalone RAG MCP servers — key-free startup (real subprocess, timeout-guarded)", () => {
  it("stdio rag-server.mjs boots to its tool list with no LLM credential", async () => {
    const stderr = await runServer("scripts/mcp/rag-server.mjs");
    expect(stderr).toMatch(/Available tools|connected/i);
    expect(stderr).not.toMatch(NO_CREDENTIAL_ERROR);
  }, 20000);

  it("http rag-server-http.mjs boots and listens over HTTP/SSE with no LLM credential", async () => {
    const stderr = await runServer("scripts/mcp/rag-server-http.mjs", { PORT: "39217" });
    // A real boot: the http.Server listens and logs the connected marker — no SSE writeHead crash,
    // no exit(1). Key-free preserved.
    expect(stderr).toMatch(/connected on http|Available tools/i);
    expect(stderr).not.toMatch(/writeHead is not a function/);
    expect(stderr).not.toMatch(NO_CREDENTIAL_ERROR);
  }, 20000);
});
