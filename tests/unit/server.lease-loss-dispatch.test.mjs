/**
 * backlog.fix.project-lease-post-init-verification-and-conversion-window, D3 at the tool-dispatch output.
 *
 * Unit tier. STATIC imports only: no vi.resetModules() anywhere in this file and no dynamic
 * import() of server.mjs (unit-tier-purity Rule B). server.mjs, governor-token, governor-init and
 * project-lease therefore share ONE module instance, so A's token is admitted by validateToken's
 * in-memory branch whatever its age, and the lease check (not a plain unauthorized) decides.
 * The peer is a second session in this same instance; lease records live on disk under the fixture.
 * Only Date is faked, so the MCP transport's timers and promises run normally.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("../../packages/mcp-rks/src/agents/fetch-raw.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchRaw: vi.fn(async () => ({ ok: false, reason: "host_not_allowlisted", url: "https://blocked.example.com/x" })),
}));
// AC6 witness tool. A refused call never reaches the handler; the mock only keeps a wrong build from
// making a network/LLM call and lets the test assert the work was not performed. Same mock shape as
// tests/unit/server-handler-agent-bootstrap.test.mjs.
vi.mock("../../packages/mcp-rks/src/agents/external-research.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  runExternalResearch: vi.fn(async () => ({ ok: true, answer: "mocked", sources: [] })),
}));

import { createServer } from "../../packages/mcp-rks/src/server.mjs";
import { fetchRaw as fetchRawSpy } from "../../packages/mcp-rks/src/agents/fetch-raw.mjs";
import { runExternalResearch as runExternalResearchSpy } from "../../packages/mcp-rks/src/agents/external-research.mjs";
import { getNextState } from "../../packages/mcp-rks/src/shared/governor-state.mjs";
import * as tok from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import * as lease from "../../packages/mcp-rks/src/shared/project-lease.mjs";
import { handleGovernorInit } from "../../packages/mcp-rks/src/tools/governor-init.mjs";

const PROJECT_ID = "lease-loss-dispatch-fixture";
const LEASE_LOST = "lease_lost";
const FETCH = { url: "https://blocked.example.com/x" };
const EXT = { query: "lease loss state witness" };
const QA = { projectId: PROJECT_ID, flowType: "qa", problemId: "backlog.fix.lease-peer" };

let dir, server, client, emitSpy, saved;

const leaseRecords = () => {
  const d = path.join(dir, ".rks", "session", "lease");
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => n.endsWith(".json") && !n.startsWith(".")).map((n) => JSON.parse(fs.readFileSync(path.join(d, n), "utf8")));
};
const events = (name) => emitSpy.mock.calls.filter((c) => c[0] === name).map((c) => c[2]);
const call = async (name, token, extra = {}) => {
  const res = await client.callTool({ name, arguments: { projectId: PROJECT_ID, ...extra, _governorToken: token } });
  return JSON.parse(res.content[0].text);
};
const age = () => vi.setSystemTime(Date.now() + lease.LEASE_MAX_AGE_MS + 60_000);

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-loss-dispatch-"));
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
  fetchRawSpy.mockClear();
  runExternalResearchSpy.mockClear();
  emitSpy = vi.spyOn(lease.leaseTelemetry, "emit");
  vi.useFakeTimers({ toFake: ["Date"] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = createServer();
  client = new Client({ name: "lease-loss-dispatch", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  vi.useRealTimers();
  emitSpy.mockRestore();
  try { await client.close(); } catch { /* ignore */ }
  try { await server.close(); } catch { /* ignore */ }
  try { tok.resetToken(); } catch { /* ignore */ }
  try { tok.setProjectRoot(null); } catch { /* ignore */ }
  for (const [k, v] of [["ROUTEKIT_PROJECT_ROOT", saved.root], ["ROUTEKIT_PROJECT_ID", saved.id], ["RKS_DISPATCH_RUN_ID", saved.run]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("lease loss at the tool-dispatch output (D3)", () => {
  it("AC1/AC5: a reclaimed session is refused lease_lost with the live holder; no work, no auto-route, no lease write", async () => {
    const a = handleGovernorInit({ projectId: PROJECT_ID });
    expect(a.ok).toBe(true);
    age();
    const peer = handleGovernorInit(QA);
    expect(peer.ok).toBe(true);
    expect(events("lease.released")).toContainEqual({ projectId: PROJECT_ID, holderKey: `session:${a.token}`, reason: "expired" });

    const out = await call("rks_fetch_raw", a.token, FETCH);
    expect(out.reason).toBe(LEASE_LOST);
    expect(out.holder).toEqual(expect.objectContaining({ holderKey: `session:${peer.token}`, flowType: "qa" }));
    expect(out.error).not.toBe("unauthorized");
    expect(out).not.toHaveProperty("_autoRouted");
    expect(fetchRawSpy).not.toHaveBeenCalled();
    expect(leaseRecords().map((r) => r.holderKey)).toEqual([`session:${peer.token}`]);
  });

  // AC6 uses rks_agent_external_research, NOT rks_fetch_raw: OPEN_STATES.init admits rks_fetch_raw but has
  // no transition for it, so getNextState self-loops and an unchanged state would pass even with the lease
  // check placed after advanceState. rks_agent_external_research is protected and moves init -> researching.
  it("AC6: a refused call leaves the chain state unchanged (the refused tool has an init transition)", async () => {
    const a = handleGovernorInit({ projectId: PROJECT_ID });
    expect(a.ok).toBe(true);
    const stateBefore = tok.getSession(a.token).state;
    expect(stateBefore).toBe("init");
    // Positive control: had advanceState run for this call, the chain WOULD have moved.
    expect(getNextState("open", stateBefore, "rks_agent_external_research")).toBe("researching");
    age();
    const peer = handleGovernorInit(QA);
    expect(peer.ok).toBe(true);

    const out = await call("rks_agent_external_research", a.token, EXT);
    expect(out.reason).toBe(LEASE_LOST);
    expect(runExternalResearchSpy).not.toHaveBeenCalled();
    expect(tok.getSession(a.token).state).toBe(stateBefore);
  });

  it("AC8: unprotected tools are not refused for lease loss; rks_governor_end still ends the session", async () => {
    const a = handleGovernorInit({ projectId: PROJECT_ID });
    age();
    expect(handleGovernorInit(QA).ok).toBe(true);
    const ended = await call("rks_governor_end", a.token);
    expect(ended.reason).not.toBe(LEASE_LOST);
    expect(ended.ok).toBe(true);
  });

  it("AC2: a reclaimed session with no conflicting holder is re-admitted with a fresh holder record", async () => {
    const a = handleGovernorInit({ projectId: PROJECT_ID });
    age();
    const b = handleGovernorInit({ projectId: PROJECT_ID }); // shared peer: reclaims A (expired), conflicts with nothing
    expect(b.ok).toBe(true);
    expect(events("lease.released")).toContainEqual({ projectId: PROJECT_ID, holderKey: `session:${a.token}`, reason: "expired" });
    tok.endSession(b.token);
    emitSpy.mockClear();

    const out = await call("rks_fetch_raw", a.token, FETCH);
    expect(out.reason).not.toBe(LEASE_LOST);
    expect(fetchRawSpy).toHaveBeenCalledTimes(1);
    expect(leaseRecords().map((r) => r.holderKey)).toContain(`session:${a.token}`);
    expect(events("lease.acquired")).toContainEqual(expect.objectContaining({ holderKey: `session:${a.token}` }));
    const later = handleGovernorInit(QA);
    expect(later.ok).toBe(false);
    expect(later.reason).toBe("project_leased");
    expect(later.holder.holderKey).toBe(`session:${a.token}`);
  });

  it("AC7 (dispatch half): after releaseOffRail removes a converted holder, the caller neither re-acquires nor is refused; a later exclusive init is admitted", async () => {
    const a = handleGovernorInit({ projectId: PROJECT_ID });
    expect(lease.convertToOffRail({ projectRoot: dir, projectId: PROJECT_ID, token: a.token }).converted).toBe(true);
    lease.releaseOffRail({ projectRoot: dir, projectId: PROJECT_ID, reason: "guardrails_on" });
    expect(leaseRecords()).toEqual([]);
    emitSpy.mockClear();
    vi.setSystemTime(Date.now() + 2 * lease.LEASE_REFRESH_INTERVAL_MS);

    const out = await call("rks_fetch_raw", a.token, FETCH);
    expect(out.reason).not.toBe(LEASE_LOST);
    expect(fetchRawSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(leaseRecords())).not.toContain(a.token);
    expect(events("lease.acquired").filter((e) => e.holderKey === `session:${a.token}`)).toEqual([]);
    expect(handleGovernorInit(QA).ok).toBe(true);
  });

  it("AC7 (revertOffRail created): a holder removed by revertOffRail with created is a deliberate release for its caller", async () => {
    const a = handleGovernorInit({ projectId: PROJECT_ID });
    lease.convertToOffRail({ projectRoot: dir, projectId: PROJECT_ID, token: a.token });
    lease.releaseOffRail({ projectRoot: dir, projectId: PROJECT_ID, reason: "guardrails_on" });
    const conv = lease.convertToOffRail({ projectRoot: dir, projectId: PROJECT_ID, token: a.token });
    expect(conv.created).toBe(true);
    lease.revertOffRail({ projectRoot: dir, projectId: PROJECT_ID, holderKey: conv.holderKey, created: true });
    expect(leaseRecords()).toEqual([]);
    emitSpy.mockClear();
    vi.setSystemTime(Date.now() + 2 * lease.LEASE_REFRESH_INTERVAL_MS);

    const out = await call("rks_fetch_raw", a.token, FETCH);
    expect(out.reason).not.toBe(LEASE_LOST);
    expect(fetchRawSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(leaseRecords())).not.toContain(a.token);
    expect(events("lease.acquired").filter((e) => e.holderKey === `session:${a.token}`)).toEqual([]);
    expect(handleGovernorInit(QA).ok).toBe(true);
  });
});
