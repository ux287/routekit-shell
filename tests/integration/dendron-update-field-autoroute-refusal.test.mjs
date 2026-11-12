/**
 * backlog.fix.autoroute-untokened-dendron-update-field
 *
 *   1. An UNTOKENED dendron_update_field is refused (unauthorizedResponse) rather than
 *      diverted to the LLM dendron agent, and never resolves projectId to 'unknown'.
 *   2. A supplied-but-unknown token is refused distinguishably from no token.
 *   3. A TOKENED dendron_update_field still reaches the deterministic handler.
 *
 * Mirrors tests/integration/git-commit-autoroute-refusal.test.mjs: token validation is
 * skipped under NODE_ENV=test / RKS_TEST_MODE=1, so each call forces NODE_ENV=production
 * and deletes RKS_SKIP_PREFLIGHT, restoring both in finally. Asserted on the note on disk.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

// runAgent is stubbed (never a real LLM run) and spied, so "no LLM agent is invoked" is asserted
// directly rather than inferred from the missing _autoRouted marker.
const runAgentSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, output: { stub: true } })));
vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  runAgent: runAgentSpy,
}));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const PROJECT_ID = "routekit-shell-core";
const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
const prevId = process.env.ROUTEKIT_PROJECT_ID;

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dendron-update-field-autoroute-"));
process.env.ROUTEKIT_PROJECT_ROOT = repo;
process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;

const { createServer, TOOL_TO_AGENT_MAP } = await import("../../packages/mcp-rks/src/server.mjs");
const { createSession, endSession } = await import("../../packages/mcp-rks/src/shared/governor-token.mjs");

const NOTE_NAME = "fixture.update-field";
const notePath = () => path.join(repo, "notes", `${NOTE_NAME}.md`);
const NOTE = '---\nid: "fixture.update-field"\ntitle: "Fixture"\nphase: "draft"\n---\n\n## Body\n';

async function callTool(name, args) {
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const prevNodeEnv = process.env.NODE_ENV;
  const prevSkip = process.env.RKS_SKIP_PREFLIGHT;
  process.env.NODE_ENV = "production";
  delete process.env.RKS_SKIP_PREFLIGHT;
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
    if (prevSkip === undefined) delete process.env.RKS_SKIP_PREFLIGHT; else process.env.RKS_SKIP_PREFLIGHT = prevSkip;
    await client.close().catch(() => {});
  }
}

const textOf = (r) => r?.content?.[0]?.text ?? "";

beforeAll(() => {
  fs.mkdirSync(path.join(repo, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(repo, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(repo, "notes"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".rks", "project.json"),
    JSON.stringify({ id: PROJECT_ID, root: repo, kgFile: "routekit/kg.yaml", notes: { vaultPath: "notes" } }, null, 2));
  fs.writeFileSync(path.join(repo, "routekit", "kg.yaml"), "project: fixture\n");
  fs.writeFileSync(notePath(), NOTE);
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT; else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
  if (prevId === undefined) delete process.env.ROUTEKIT_PROJECT_ID; else process.env.ROUTEKIT_PROJECT_ID = prevId;
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("dendron_update_field autoroute refusal", () => {
  it("dendron_update_field has no TOOL_TO_AGENT_MAP entry", () => {
    expect(TOOL_TO_AGENT_MAP.dendron_update_field).toBeUndefined();
  });

  it("an untokened call with no projectId is refused, names the remedy, never 'unknown', note unchanged", async () => {
    const before = fs.readFileSync(notePath(), "utf8");
    const body = textOf(await callTool("dendron_update_field", { filename: NOTE_NAME, field: "status", value: "x" }));
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("unauthorized");
    expect(parsed.tokenStatus).toBe("missing");
    expect(body).toContain("dendron_update_field");
    expect(body).toContain("rks_governor_init");
    expect(body).toContain("_governorToken");
    // _autoRouted is the marker the auto-route path stamps on a substituted response.
    expect(body, "an untokened write was handed to the LLM dendron agent").not.toContain("_autoRouted");
    expect(body).not.toContain('"unknown"');
    expect(body).not.toContain("Project not found");
    expect(fs.readFileSync(notePath(), "utf8")).toBe(before);
  });

  it("no LLM agent is invoked for an untokened dendron_update_field (spy positive-controlled)", async () => {
    runAgentSpy.mockClear();
    await callTool("dendron_update_field", { filename: NOTE_NAME, field: "status", value: "x" });
    expect(runAgentSpy).not.toHaveBeenCalled();
    // Positive control: a still-mapped tool called untokened DOES reach runAgent, so the spy is
    // wired to the path the refusal must avoid.
    await callTool("dendron_read_note", { projectId: PROJECT_ID, filename: NOTE_NAME });
    expect(runAgentSpy).toHaveBeenCalledTimes(1);
  });

  it("a supplied token that matches no session is refused distinguishably from no token", async () => {
    const before = fs.readFileSync(notePath(), "utf8");
    const none = JSON.parse(textOf(await callTool("dendron_update_field", { filename: NOTE_NAME, field: "status", value: "x" })));
    const bad = JSON.parse(textOf(await callTool("dendron_update_field", {
      filename: NOTE_NAME, field: "status", value: "x", _governorToken: randomUUID(),
    })));
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("unauthorized");
    expect(bad.tokenStatus).toBe("not_found_or_expired");
    expect(bad.tokenStatus).not.toBe(none.tokenStatus);
    expect(bad.message).toMatch(/not found or expired/i);
    expect(bad.remedy).toContain("rks_governor_init");
    expect(fs.readFileSync(notePath(), "utf8")).toBe(before);
  });

  it("a tokened call reaches the deterministic handler and writes the field", async () => {
    const { token } = createSession({ projectId: PROJECT_ID, flowType: "open" });
    let body;
    try {
      body = textOf(await callTool("dendron_update_field", {
        projectId: PROJECT_ID, filename: NOTE_NAME, field: "status", value: "written", skipCommit: true, _governorToken: token,
      }));
    } finally {
      endSession(token);
    }
    expect(body, body).not.toMatch(/unauthorized/i);
    expect(body).not.toContain("_autoRouted");
    expect(JSON.parse(body).ok, body).toBe(true);
    expect(fs.readFileSync(notePath(), "utf8")).toMatch(/^status: "written"$/m);
  });
});

describe("autoRouteUnauthorized with an unresolvable self project id (behavioural)", () => {
  it("an untokened mapped tool with no projectId reports project_unresolved naming the identity source, never 'unknown'", async () => {
    const prevEnvId = process.env.ROUTEKIT_PROJECT_ID;
    delete process.env.ROUTEKIT_PROJECT_ID;
    const real = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((p, ...rest) => {
      if (typeof p === "string" && p.endsWith(path.join(".rks", "project.json"))) {
        throw new Error("ENOENT (simulated)");
      }
      return real(p, ...rest);
    });
    runAgentSpy.mockClear();
    try {
      vi.resetModules();
      const fresh = await import("../../packages/mcp-rks/src/server.mjs");
      expect(() => fresh.getSelfProjectId()).toThrow(/ROUTEKIT_PROJECT_ID/);
      const server = fresh.createServer();
      const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);
      const prevNodeEnv = process.env.NODE_ENV;
      const prevSkip = process.env.RKS_SKIP_PREFLIGHT;
      process.env.NODE_ENV = "production";
      delete process.env.RKS_SKIP_PREFLIGHT;
      let body;
      try {
        body = textOf(await client.callTool({ name: "dendron_read_note", arguments: { filename: NOTE_NAME } }));
      } finally {
        if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
        if (prevSkip === undefined) delete process.env.RKS_SKIP_PREFLIGHT; else process.env.RKS_SKIP_PREFLIGHT = prevSkip;
        await client.close().catch(() => {});
      }
      const parsed = JSON.parse(body);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBe("project_unresolved");
      expect(parsed.message).toContain("ROUTEKIT_PROJECT_ID");
      expect(parsed.message).toContain(".rks/project.json");
      expect(body).not.toContain('"unknown"');
      expect(body).not.toContain("Project not found: unknown");
      expect(runAgentSpy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      if (prevEnvId === undefined) delete process.env.ROUTEKIT_PROJECT_ID; else process.env.ROUTEKIT_PROJECT_ID = prevEnvId;
    }
  });
});

describe("autoRouteUnauthorized project-id resolution (source structure)", () => {
  const SRC = fs.readFileSync(new URL("../../packages/mcp-rks/src/server.mjs", import.meta.url), "utf8");

  it("falls back to getSelfProjectId(), never the literal 'unknown'", () => {
    expect(SRC).not.toMatch(/cleanArgs\.projectId \|\| cleanArgs\.id \|\| 'unknown'/);
    expect(SRC).toMatch(/cleanArgs\.projectId \|\| cleanArgs\.id \|\| getSelfProjectId\(\)/);
  });

  it("an unresolvable self project id is reported by its cause, not as 'unknown'", () => {
    const start = SRC.indexOf("cleanArgs.projectId || cleanArgs.id || getSelfProjectId()");
    const block = SRC.slice(start, start + 900);
    expect(block).toContain("project_unresolved");
    expect(block).toContain("ROUTEKIT_PROJECT_ID");
    expect(block).toContain(".rks/project.json");
    expect(block).not.toContain("'unknown'");
  });
});
