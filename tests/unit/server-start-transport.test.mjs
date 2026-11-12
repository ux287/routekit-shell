// backlog.feat.remote-surface-http-entry: startServer transport injection.
// backlog.feat.remote-http-entry-multi-session: bootServer idempotence and connectServer distinct
// servers. The bootServer describe runs FIRST in this file, before any startServer call, so the
// first bootServer() call in it is the process's first boot.
// server.mjs is imported ONCE (no vi.resetModules; unit-tier-purity rule B). The stdio module is
// mocked so the no-argument case never binds the worker's real stdio.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    async start() {}
    async close() {}
    async send() {}
  },
}));

const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { startServer, bootServer, connectServer } = await import("../../packages/mcp-rks/src/server.mjs");
const { getTelemetryCollector } = await import("@routekit/telemetry/collector");

const ENV_KEYS = ["ROUTEKIT_PROJECT_ROOT", "RKS_PROJECT_ROOT"];
let savedEnv;
let tmp;
const running = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // A hermetic boot root: startServer seeds the governor-token root and inits project agents from it.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "server-start-transport-"));
  fs.mkdirSync(path.join(tmp, ".rks"), { recursive: true });
  delete process.env.RKS_PROJECT_ROOT;
  process.env.ROUTEKIT_PROJECT_ROOT = tmp;
});

afterEach(async () => {
  for (const c of running.splice(0)) {
    try { await c.close(); } catch { /* ignore */ }
  }
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("bootServer", () => {
  it("runs the boot side effects once: one mcp.server.start and one token-gate-bypass report across two calls", () => {
    const collector = getTelemetryCollector();
    const emitSpy = vi.spyOn(collector, "emit");
    const writeSpy = vi.spyOn(process.stderr, "write");
    // The bypass report only fires while a bypass variable is set; make that explicit.
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const first = bootServer();
      const startsAfterFirst = emitSpy.mock.calls.filter((c) => c[0] === "mcp.server.start").length;
      const reportsAfterFirst = writeSpy.mock.calls.filter((c) => String(c[0]).includes("token gate disabled")).length;
      const second = bootServer();
      const startsAfterSecond = emitSpy.mock.calls.filter((c) => c[0] === "mcp.server.start").length;
      const reportsAfterSecond = writeSpy.mock.calls.filter((c) => String(c[0]).includes("token gate disabled")).length;
      // Positive control: the first call is observed running both side effects.
      expect(first).toBe(true);
      expect(startsAfterFirst).toBe(1);
      expect(reportsAfterFirst).toBe(1);
      // The second call runs neither.
      expect(second).toBe(false);
      expect(startsAfterSecond).toBe(1);
      expect(reportsAfterSecond).toBe(1);
    } finally {
      process.env.NODE_ENV = savedNodeEnv;
      emitSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });
});

describe("connectServer", () => {
  it("returns a distinct connected server per call; a Client on each pair lists rks_governor_init", async () => {
    const [clientA, serverA] = InMemoryTransport.createLinkedPair();
    const [clientB, serverB] = InMemoryTransport.createLinkedPair();
    const a = await connectServer(serverA);
    running.push(a);
    const b = await connectServer(serverB);
    running.push(b);
    expect(a).not.toBe(b);
    expect(a.transport).toBe(serverA);
    expect(b.transport).toBe(serverB);
    for (const clientT of [clientA, clientB]) {
      const client = new Client({ name: "server-start-transport-test", version: "0.0.0" }, { capabilities: {} });
      await client.connect(clientT);
      running.push(client);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("rks_governor_init");
    }
  });
});

describe("startServer transport", () => {
  it("with no argument connects a StdioServerTransport", async () => {
    const server = await startServer();
    running.push(server);
    expect(server.transport).toBeInstanceOf(StdioServerTransport);
  });

  it("connects a caller-supplied InMemoryTransport and a linked Client can list tools", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = await startServer(serverT);
    running.push(server);
    expect(server.transport).toBe(serverT);
    expect(server.transport).not.toBeInstanceOf(StdioServerTransport);

    const client = new Client({ name: "server-start-transport-test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientT);
    running.push(client);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.name)).toContain("rks_governor_init");
  });

  it("connects the transport a caller-supplied factory returns", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const factory = vi.fn(() => serverT);
    const server = await startServer(factory);
    running.push(server);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(server.transport).toBe(serverT);
    const client = new Client({ name: "server-start-transport-test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientT);
    running.push(client);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });
});
