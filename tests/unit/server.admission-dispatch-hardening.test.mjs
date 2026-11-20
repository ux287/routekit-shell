// backlog.feat.admission-table-review-hardening: dispatch-level guards for the session-stage
// supplied-invalid branch and for lease-over-chain precedence on a single call.
//
// Unit tier, real createServer tools/call path over an InMemoryTransport client, in the style of
// tests/unit/server.lease-loss-dispatch.test.mjs: STATIC imports only (no vi.resetModules, no
// dynamic import of server.mjs), so server.mjs, governor-token, governor-init and project-lease
// share one module instance. Only Date is faked. runAgent is mocked so an auto-route (the
// behaviour the supplied-invalid branch must NOT take) is observable without an LLM call.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The no-chain-violation requirement spies on getTelemetryCollector().emit, the seat
// emitChainViolation calls, so this file needs the REAL collector rather than the suite-wide stub
// (tests/setup.mjs). vi.unmock is one of the sanctioned escapes, hoisted above the imports; escaping
// both specifiers keeps this file classified UN-SHADOWED by
// tests/unit/telemetry-global-mock-triage.test.mjs. The spy replaces emit for the whole test, so the
// real collector buffers nothing and writes nothing.
vi.unmock("@routekit/telemetry");
vi.unmock("@routekit/telemetry/collector");
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  runAgent: vi.fn(async () => ({ ok: true, summary: "auto-routed agent answer" })),
}));

import { getTelemetryCollector, resetTelemetryCollector } from "@routekit/telemetry";
import { createServer } from "../../packages/mcp-rks/src/server.mjs";
import { runAgent } from "../../packages/mcp-rks/src/agents/runner.mjs";
import { checkStateAllowed } from "../../packages/mcp-rks/src/shared/governor-state.mjs";
import * as tok from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import * as lease from "../../packages/mcp-rks/src/shared/project-lease.mjs";
import { handleGovernorInit } from "../../packages/mcp-rks/src/tools/governor-init.mjs";

const PROJECT_ID = "admission-dispatch-hardening-fixture";
const QA = { projectId: PROJECT_ID, flowType: "qa", problemId: "backlog.fix.lease-peer" };
// Protected, git-agent mapped: a tokenless call auto-routes, so a supplied-invalid one that did
// would be visible.
const ROUTED_TOOL = "rks_git_state";
// Protected and named by no admission row, so no open-flow state admits it (asserted per test).
const CHAIN_REFUSED_TOOL = "rks_kg_query";
// The token gate is bypassed under any of these; armedCall clears all three for one call.
const GATE_ENV = ["NODE_ENV", "RKS_SKIP_PREFLIGHT", "RKS_TEST_MODE"];

let dir, server, client, emitSpy, saved;

const callRaw = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return res?.content?.[0]?.text ?? "";
};
const call = async (name, token, extra = {}) => JSON.parse(await callRaw(name, { projectId: PROJECT_ID, ...extra, _governorToken: token }));
const armedCall = async (name, args) => {
  const prev = Object.fromEntries(GATE_ENV.map((k) => [k, process.env[k]]));
  process.env.NODE_ENV = "production";
  delete process.env.RKS_SKIP_PREFLIGHT;
  delete process.env.RKS_TEST_MODE;
  try {
    return await callRaw(name, args);
  } finally {
    for (const k of GATE_ENV) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
};
const chainViolations = () => emitSpy.mock.calls.filter((c) => c[0] === "chain.violation").map((c) => c[2]);
const age = () => vi.setSystemTime(Date.now() + lease.LEASE_MAX_AGE_MS + 60_000);

// A session whose lease a QA peer reclaimed; returns both tokens.
function reclaimedSession() {
  const a = handleGovernorInit({ projectId: PROJECT_ID });
  expect(a.ok).toBe(true);
  age();
  const peer = handleGovernorInit(QA);
  expect(peer.ok).toBe(true);
  return { a, peer };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "admission-dispatch-hardening-"));
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "routekit"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".rks", "project.json"), JSON.stringify({ id: PROJECT_ID, root: dir, kgFile: "routekit/kg.yaml" }, null, 2));
  fs.writeFileSync(path.join(dir, "routekit", "kg.yaml"), "project: fixture\n");
  saved = { root: process.env.ROUTEKIT_PROJECT_ROOT, id: process.env.ROUTEKIT_PROJECT_ID, run: process.env.RKS_DISPATCH_RUN_ID };
  process.env.ROUTEKIT_PROJECT_ROOT = dir;
  process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;
  delete process.env.RKS_DISPATCH_RUN_ID;
  tok.resetToken();
  tok.setProjectRoot(dir);
  vi.mocked(runAgent).mockClear();
  resetTelemetryCollector();
  emitSpy = vi.spyOn(getTelemetryCollector(), "emit").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = createServer();
  client = new Client({ name: "admission-dispatch-hardening", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  vi.useRealTimers();
  try { await client.close(); } catch { /* ignore */ }
  try { await server.close(); } catch { /* ignore */ }
  emitSpy.mockRestore();
  resetTelemetryCollector();
  try { tok.resetToken(); } catch { /* ignore */ }
  try { tok.setProjectRoot(null); } catch { /* ignore */ }
  for (const [k, v] of [["ROUTEKIT_PROJECT_ROOT", saved.root], ["ROUTEKIT_PROJECT_ID", saved.id], ["RKS_DISPATCH_RUN_ID", saved.run]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("admission dispatch hardening", () => {
  it("a supplied-invalid token is refused, not auto-routed", async () => {
    // Positive control: a tokenless call to the same tool auto-routes, so the mock intercepts and
    // the zero below is not vacuous.
    const tokenless = await armedCall(ROUTED_TOOL, { projectId: PROJECT_ID });
    expect(tokenless).toContain("_autoRouted");
    expect(runAgent).toHaveBeenCalledTimes(1);
    vi.mocked(runAgent).mockClear();

    const body = await armedCall(ROUTED_TOOL, { projectId: PROJECT_ID, _governorToken: randomUUID() });
    const out = JSON.parse(body);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("unauthorized");
    expect(out.tokenStatus).toBe("not_found_or_expired");
    expect(out).not.toHaveProperty("_autoRouted");
    expect(body).not.toContain("auto-routed agent answer");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("lease loss outranks a chain refusal on the same call", async () => {
    const { a, peer } = reclaimedSession();
    const session = tok.getSession(a.token);
    expect(checkStateAllowed(session.flowType, session.state, CHAIN_REFUSED_TOOL).allowed).toBe(false);

    const out = await call(CHAIN_REFUSED_TOOL, a.token);
    expect(out.reason).toBe("lease_lost");
    expect(out.error).not.toBe("chain_violation");
    expect(out.holder).toEqual(expect.objectContaining({ holderKey: `session:${peer.token}`, flowType: "qa" }));
  });

  it("a lease-lost chain-refused call leaves chain state unchanged and records no chain violation", async () => {
    const a = handleGovernorInit({ projectId: PROJECT_ID });
    expect(a.ok).toBe(true);
    const stateBefore = tok.getSession(a.token).state;
    // Positive control, lease intact: the same call is a chain refusal and records one violation.
    emitSpy.mockClear();
    const refused = await call(CHAIN_REFUSED_TOOL, a.token);
    expect(refused.error).toBe("chain_violation");
    expect(chainViolations()).toEqual([expect.objectContaining({ blockedTool: CHAIN_REFUSED_TOOL, violationKind: "state_machine" })]);
    expect(tok.getSession(a.token).state).toBe(stateBefore);

    age();
    expect(handleGovernorInit(QA).ok).toBe(true);
    emitSpy.mockClear();
    const out = await call(CHAIN_REFUSED_TOOL, a.token);
    expect(out.reason).toBe("lease_lost");
    expect(tok.getSession(a.token).state).toBe(stateBefore);
    expect(chainViolations()).toEqual([]);
  });
});
