/**
 * backlog.fix.invalid-token-autoroutes-release-to-ship
 *
 * A supplied-but-invalid _governorToken (superseded, expired, or unknown) is refused at the
 * protected-tool gate with a typed token refusal and is NEVER auto-routed to an agent. Before
 * the fix, rks_release with a superseded token returned the ship agent's "Nothing to ship"
 * with an `_autoRouted` block, disguising an authorization failure as an ok-shaped answer.
 * Tokenless calls keep the documented auto-route.
 *
 * The gate is armed per call: `_skipTokenValidation` is true under NODE_ENV=test,
 * RKS_SKIP_PREFLIGHT=1 or RKS_TEST_MODE=1, so callArmed sets NODE_ENV=production and clears
 * BOTH of the others, restoring all three in `finally`.
 *
 * runAgent is mocked to RESOLVE with a ship-like "Nothing to ship" answer, so a pre-fix
 * auto-route would be observable (spy fires, summary in body). The tokenless rks_git_state case
 * is the positive control proving the mock intercepts.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { emitted } = vi.hoisted(() => ({ emitted: [] }));

// UN-SHADOWED (tests/unit/telemetry-global-mock-triage.test.mjs): this per-file mock is built on
// the REAL collector via vi.importActual, not on the tests/setup.mjs shared stub; only `emit` is
// intercepted, so the refusal and auto-route events can be read per call.
vi.mock("@routekit/telemetry/collector", async () => {
  const actual = await vi.importActual("@routekit/telemetry/collector");
  return {
    ...actual,
    getTelemetryCollector: (...a) => {
      const real = actual.getTelemetryCollector(...a);
      return new Proxy(real, {
        get(target, prop) {
          if (prop === "emit") return (name, projectId, payload) => { emitted.push({ name, projectId, payload }); };
          return Reflect.get(target, prop);
        },
      });
    },
  };
});

vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runAgent: vi.fn(async () => ({ ok: true, summary: "Nothing to ship" })) };
});

const PROJECT_ID = "routekit-shell-core";
const SPAWN_MS = 5000;
const GATE_ENV = ["NODE_ENV", "RKS_SKIP_PREFLIGHT", "RKS_TEST_MODE"];
const FIXTURE_ENV = ["ROUTEKIT_PROJECT_ROOT", "ROUTEKIT_PROJECT_ID", "DENDRON_VAULT_PATH", "ROUTEKIT_NOTES_DIR"];

// Fixture root with no `lanes` block (ARCH Item 11). Env is set BEFORE server.mjs is imported so
// loadProjectContext's self-project override resolves to this root, not the registry.
const prevFixtureEnv = Object.fromEntries(FIXTURE_ENV.map((k) => [k, process.env[k]]));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "supplied-invalid-token-"));
const notesDir = path.join(fixtureRoot, "notes");
process.env.ROUTEKIT_PROJECT_ROOT = fixtureRoot;
process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;
delete process.env.DENDRON_VAULT_PATH;
delete process.env.ROUTEKIT_NOTES_DIR;

const { runAgent } = await import("../../packages/mcp-rks/src/agents/runner.mjs");
const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
const { createSession, endSession } = await import("../../packages/mcp-rks/src/shared/governor-token.mjs");

async function callArmed(name, args, { createServerFn = createServer } = {}) {
  const prev = Object.fromEntries(GATE_ENV.map((k) => [k, process.env[k]]));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createServerFn();
  const client = new Client({ name: "supplied-invalid-token-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  process.env.NODE_ENV = "production";
  delete process.env.RKS_SKIP_PREFLIGHT;
  delete process.env.RKS_TEST_MODE;
  try {
    const res = await client.callTool({ name, arguments: args });
    return res?.content?.[0]?.text ?? "";
  } finally {
    for (const k of GATE_ENV) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    await client.close().catch(() => {});
  }
}

const parse = (body) => { try { return JSON.parse(body); } catch { return null; } };
const notesOnDisk = () => (fs.existsSync(notesDir) ? fs.readdirSync(notesDir) : []);

beforeAll(() => {
  fs.mkdirSync(path.join(fixtureRoot, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, "routekit"), { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureRoot, ".rks", "project.json"),
    JSON.stringify({ id: PROJECT_ID, root: fixtureRoot, kgFile: "routekit/kg.yaml" }, null, 2),
  );
  fs.writeFileSync(path.join(fixtureRoot, "routekit", "kg.yaml"), "project: fixture\n");
  const init = spawnSync("git", ["init", "-b", "feature/test", fixtureRoot], { encoding: "utf8", timeout: SPAWN_MS });
  expect(init.status, `git init failed: ${init.stderr}`).toBe(0);
});

afterAll(() => {
  for (const k of FIXTURE_ENV) { if (prevFixtureEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevFixtureEnv[k]; }
  try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(() => {
  vi.mocked(runAgent).mockClear();
  emitted.length = 0;
});

describe("supplied-but-invalid governor token is refused, not auto-routed", () => {
  it("rks_release with an unknown token returns ok false, error unauthorized, tokenStatus not_found_or_expired", async () => {
    const body = await callArmed("rks_release", { projectId: PROJECT_ID, _governorToken: randomUUID() });
    const p = parse(body);
    expect(p, `response is not JSON: ${body}`).not.toBeNull();
    expect(p.ok).toBe(false);
    expect(p.error).toBe("unauthorized");
    expect(p.tokenStatus).toBe("not_found_or_expired");
  });

  it("rks_release supplied-invalid response has no _autoRouted, no ship-agent summary, and runAgent is never called", async () => {
    const body = await callArmed("rks_release", { projectId: PROJECT_ID, _governorToken: randomUUID() });
    expect(body).not.toContain("_autoRouted");
    expect(body).not.toContain("Nothing to ship");
    expect(runAgent).toHaveBeenCalledTimes(0);
  });

  it("rks_release supplied-invalid response carries a remedy naming rks_governor_init", async () => {
    const body = await callArmed("rks_release", { projectId: PROJECT_ID, _governorToken: randomUUID() });
    const p = parse(body);
    expect(typeof p?.remedy).toBe("string");
    expect(p.remedy).toContain("rks_governor_init");
  });

  it("rks_git_state (git-agent-mapped) with a supplied-invalid token is refused with no auto-route", async () => {
    const body = await callArmed("rks_git_state", { projectId: PROJECT_ID, _governorToken: randomUUID() });
    const p = parse(body);
    expect(p?.ok).toBe(false);
    expect(p?.tokenStatus).toBe("not_found_or_expired");
    expect(body).not.toContain("_autoRouted");
    expect(runAgent).toHaveBeenCalledTimes(0);
  });

  it("dendron_create_note with a supplied-invalid token is refused and writes no note (directHandler not taken)", async () => {
    const filename = `scratch.supplied-invalid-${randomUUID().slice(0, 8)}`;
    const before = notesOnDisk();
    const body = await callArmed("dendron_create_note", {
      projectId: PROJECT_ID, filename, title: "x", content: "body", _governorToken: randomUUID(),
    });
    const p = parse(body);
    expect(p?.ok).toBe(false);
    expect(p?.tokenStatus).toBe("not_found_or_expired");
    expect(body).not.toContain("_autoRouted");
    expect(fs.existsSync(path.join(notesDir, `${filename}.md`))).toBe(false);
    expect(notesOnDisk()).toEqual(before);
  });
});

describe("tokenless and valid-token behaviour is preserved", () => {
  it("rks_git_state with NO _governorToken still auto-routes (_autoRouted present, runAgent called once)", async () => {
    const body = await callArmed("rks_git_state", { projectId: PROJECT_ID });
    expect(body).toContain("_autoRouted");
    expect(runAgent, "the runAgent mock did not intercept; every zero in this file would be vacuous").toHaveBeenCalledTimes(1);
  });

  it("rks_git_state with a valid createSession token is not refused by the gate", async () => {
    const { token } = createSession({ projectId: PROJECT_ID, flowType: "ship" });
    try {
      const body = await callArmed("rks_git_state", { projectId: PROJECT_ID, _governorToken: token });
      const p = parse(body);
      expect(p && "tokenStatus" in p, `gate refused a valid token: ${body}`).toBe(false);
      expect(body).not.toContain("tokenStatus");
      expect(body).not.toContain("_autoRouted");
      expect(runAgent).toHaveBeenCalledTimes(0);
    } finally {
      try { endSession(token); } catch { /* best-effort */ }
    }
  });

  it("a token persisted only in .rks/governor-session.json (fresh module graph) is accepted by the gate", async () => {
    // A token that was never created in any in-memory session store: it exists ONLY on disk.
    const token = randomUUID();
    const now = Date.now();
    const sessionFile = path.join(fixtureRoot, ".rks", "governor-session.json");
    fs.writeFileSync(sessionFile, JSON.stringify({
      token, projectId: PROJECT_ID, flowType: "ship", sessionType: "ship", problemId: null,
      state: "init", guardrailsDisabled: false, createdAt: now, lastActivity: now,
    }, null, 2));

    // Fresh in-memory session store: reset the module graph and re-import server.mjs (and with it
    // shared/governor-token.mjs). vi.mock registrations are re-applied to the fresh graph.
    vi.resetModules();
    const fresh = await import("../../packages/mcp-rks/src/server.mjs");
    const freshRunner = await import("../../packages/mcp-rks/src/agents/runner.mjs");
    const freshToken = await import("../../packages/mcp-rks/src/shared/governor-token.mjs");
    try {
      // Control: the fresh graph's gate is armed — an unpersisted token is refused.
      const control = parse(await callArmed("rks_git_state", { projectId: PROJECT_ID, _governorToken: randomUUID() },
        { createServerFn: fresh.createServer }));
      expect(control?.tokenStatus, "fresh-graph gate is not armed; the rehydration assertion would be vacuous").toBe("not_found_or_expired");

      const body = await callArmed("rks_git_state", { projectId: PROJECT_ID, _governorToken: token },
        { createServerFn: fresh.createServer });
      const p = parse(body);
      expect(p?.tokenStatus, `persisted token was refused by the gate: ${body}`).toBeUndefined();
      expect(body).not.toContain("not_found_or_expired");
      expect(body).not.toContain("_autoRouted");
      expect(vi.mocked(freshRunner.runAgent)).toHaveBeenCalledTimes(0);
    } finally {
      try { freshToken.endSession(token); } catch { /* best-effort */ }
      try { fs.rmSync(sessionFile, { force: true }); } catch { /* best-effort */ }
    }
  });
});

describe("telemetry distinguishes the supplied-invalid refusal from auth.auto_route.started", () => {
  for (const tool of ["rks_release", "rks_git_state"]) {
    it(`${tool}: supplied-invalid emits a distinct event naming the tool and no auth.auto_route.started`, async () => {
      await callArmed(tool, { projectId: PROJECT_ID, _governorToken: randomUUID() });
      const refusal = emitted.filter((e) => e.payload?.tool === tool && e.name === "auth.token.supplied_invalid");
      expect(refusal.length, `${tool}: no supplied-invalid telemetry event; emitted=${JSON.stringify(emitted.map((e) => e.name))}`).toBe(1);
      expect(refusal[0].name, `${tool}: refusal event must not be auth.auto_route.started`).not.toBe("auth.auto_route.started");
      expect(refusal[0].payload.tool, `${tool}: refusal payload must name the tool`).toBe(tool);
      const started = emitted.filter((e) => e.name === "auth.auto_route.started");
      expect(started.length, `${tool}: auth.auto_route.started was emitted for a supplied-invalid call`).toBe(0);
    });
  }

  it("a tokenless mapped call (rks_git_state) still emits auth.auto_route.started", async () => {
    await callArmed("rks_git_state", { projectId: PROJECT_ID });
    const started = emitted.filter((e) => e.name === "auth.auto_route.started" && e.payload?.tool === "rks_git_state");
    expect(started.length, `emitted=${JSON.stringify(emitted.map((e) => e.name))}`).toBe(1);
    expect(emitted.some((e) => e.name === "auth.token.supplied_invalid")).toBe(false);
  });
});
