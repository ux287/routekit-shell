/**
 * backlog.fix.autoroute-substitutes-llm-for-deterministic-retrieval — behavioural witness.
 *
 * An untokened call to a protected tool used to be handed to an LLM agent, whose prose was
 * returned as the tool's own result with `ok: true`. For `rks_exhaustive_search` that means a
 * caller asking "does this literal exist" gets an invented answer in the shape of a search
 * result — the failure that produced a symbol reported absent that exists, a return statement
 * placed 90 lines off, and an invented CLI subcommand in the field.
 *
 * WHY THE OBVIOUS TEST WOULD BE GREEN ON THE DEFECT
 * -------------------------------------------------
 * `autoRouteUnauthorized` wraps the agent call in try/catch and returns null on ANY error,
 * falling through to the same `unauthorizedResponse`. So in a keyless CI, or with a fixture
 * whose loadContext throws, an untokened search ALREADY returns `ok: false, error: unauthorized`
 * today — for entirely the wrong reason. Asserting only "the call is refused" therefore proves
 * nothing.
 *
 * So `runAgent` is mocked to RESOLVE with a plausible research answer. Pre-fix that answer is
 * returned and the spy fires; post-fix the tool is unmapped, never reaches the agent, and is
 * refused. The load-bearing assertion is the spy count, not the refusal.
 *
 * THE POSITIVE CONTROL IS NOT OPTIONAL
 * ------------------------------------
 * `toHaveBeenCalledTimes(0)` passes vacuously whenever the mock simply fails to intercept —
 * a bad specifier, a module-graph change, getAgent returning undefined. A second case drives a
 * tool that REMAINS mapped through the identical path and asserts the spy DID fire, so a zero
 * from a broken harness is distinguishable from a zero from a correct fix.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Specifier written out in full: vi.mock is hoisted above every const, so referencing a
// module-level binding inside the factory is a TDZ error. Spread the original so the rest of
// the module graph survives — server.mjs imports more than runAgent from here.
vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runAgent: vi.fn(async () => ({
      ok: true,
      answer: "The symbol does not appear anywhere in the codebase.",
      sources: [{ file: "packages/cli/bin/growth.mjs" }],
      confidence: 0.72,
    })),
  };
});

import { runAgent } from "../../packages/mcp-rks/src/agents/runner.mjs";
import { createServer } from "../../packages/mcp-rks/src/server.mjs";
import { loadProjectContext } from "../../packages/mcp-rks/src/project-context.mjs";
import { repoRoot } from "../../packages/mcp-rks/src/server/project.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Drive one untokened CallTool round trip with the token gate ACTUALLY ARMED.
 *
 * The gate is `if (!_skipTokenValidation && isProtectedTool(tool))`, and
 * `_skipTokenValidation` is true whenever `NODE_ENV === "test"` or `RKS_SKIP_PREFLIGHT === "1"`.
 * Under vitest both would normally hold, so the gate never runs, the call falls through to the
 * handler, and the test observes argument validation instead of the path under test — a third
 * way this suite could have been green while proving nothing.
 *
 * `_skipTokenValidation` is recomputed per request inside the handler, so overriding the env
 * around the call is sufficient and is restored immediately afterwards.
 */
async function callUntokened(toolName, args) {
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const prevNodeEnv = process.env.NODE_ENV;
  const prevSkip = process.env.RKS_SKIP_PREFLIGHT;
  process.env.NODE_ENV = "production";
  delete process.env.RKS_SKIP_PREFLIGHT;
  try {
    // No _governorToken — this is the unauthorized path under test.
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevSkip === undefined) delete process.env.RKS_SKIP_PREFLIGHT;
    else process.env.RKS_SKIP_PREFLIGHT = prevSkip;
    await client.close().catch(() => {});
  }
}

const textOf = (res) => res?.content?.[0]?.text ?? "";

/**
 * WHY THIS FIXTURE EXISTS — the suite was a vacuous gate in CI without it.
 *
 * `autoRouteUnauthorized` must call `loadContext(projectId)` before it can build an agent
 * config, and `loadContext` resolves against `repoRoot` — fixed at module load to the checkout
 * root. It consults the registry at `projects/index.jsonl`, which a fresh CI checkout does not
 * have, so `loadProjectContext` throws `Project not found`. That throw lands in the same blanket
 * catch described above, which returns null and falls through to `unauthorizedResponse`.
 *
 * The consequence is not merely a red positive control: `runAgent` is unreachable for ANY input
 * in CI, so the `toHaveBeenCalledTimes(0)` assertions below read identically whether or not the
 * defect they pin is present. They would pass against pre-fix source that DOES substitute an LLM
 * answer, because the substitution never gets far enough to happen.
 *
 * `loadProjectContext` has a self-project override that skips the registry entirely when
 * ROUTEKIT_PROJECT_ROOT is set AND the requested projectId equals ROUTEKIT_PROJECT_ID. Pointing
 * that at a throwaway temp dir makes CI resolve exactly as a developer's machine does.
 *
 * Both files are load-bearing: after the override builds the record, loadProjectContext still
 * reads `.rks/project.json` off that root and then the KG at `kgFile`, throwing if the KG is
 * absent. A fixture with only project.json swaps one swallowed throw for another.
 */
const FIXTURE_PROJECT_ID = "routekit-shell-core";
let fixtureRoot;
let prevProjectRoot;
let prevProjectId;

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autoroute-refusal-fixture-"));
  fs.mkdirSync(path.join(fixtureRoot, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, "routekit"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureRoot, ".rks", "project.json"),
    JSON.stringify({ id: FIXTURE_PROJECT_ID, root: fixtureRoot, kgFile: "routekit/kg.yaml" }, null, 2),
  );
  fs.writeFileSync(path.join(fixtureRoot, "routekit", "kg.yaml"), "project: fixture\n");

  prevProjectRoot = process.env.ROUTEKIT_PROJECT_ROOT;
  prevProjectId = process.env.ROUTEKIT_PROJECT_ID;
  process.env.ROUTEKIT_PROJECT_ROOT = fixtureRoot;
  process.env.ROUTEKIT_PROJECT_ID = FIXTURE_PROJECT_ID;
});

afterAll(() => {
  if (prevProjectRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = prevProjectRoot;
  if (prevProjectId === undefined) delete process.env.ROUTEKIT_PROJECT_ID;
  else process.env.ROUTEKIT_PROJECT_ID = prevProjectId;
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("an untokened deterministic search is REFUSED, never substituted", () => {
  beforeEach(() => {
    // runAgent has three call sites; reset between cases so counts are per-test.
    runAgent.mockClear();
  });

  it("rks_exhaustive_search never reaches the LLM agent", async () => {
    const res = await callUntokened("rks_exhaustive_search", {
      projectId: "routekit-shell-core",
      pattern: "someLiteralThatWouldBeSearchedFor",
    });

    // THE assertion. Pre-fix this is 1 and the caller receives invented prose.
    expect(runAgent).toHaveBeenCalledTimes(0);

    const body = textOf(res);
    expect(body).not.toContain("does not appear anywhere");
    expect(body).not.toContain("_autoRouted");
  });

  it("the refusal is an honest refusal, not a success", async () => {
    const res = await callUntokened("rks_exhaustive_search", {
      projectId: "routekit-shell-core",
      pattern: "someLiteralThatWouldBeSearchedFor",
    });
    const body = textOf(res);
    // A caller that checks only `ok` must be able to tell. Pre-fix, ok was true.
    expect(body).toMatch(/"ok":\s*false/);
    expect(body).toMatch(/unauthorized/i);
  });

  it("rks_kg_query is likewise refused rather than answered", async () => {
    const res = await callUntokened("rks_kg_query", { projectId: "routekit-shell-core", key: "root" });
    expect(runAgent).toHaveBeenCalledTimes(0);
    expect(textOf(res)).toMatch(/"ok":\s*false/);
  });

  // NOT tested behaviourally: rks_rag_query. It is a member of UNPROTECTED_TOOLS, so the
  // auto-route gate never runs for it and an untokened call returns real RAG results both
  // before and after this change. A refusal assertion here would be RED after a correct fix.
  // Its map entry was dead misleading routing; removal is covered structurally instead, in
  // tests/unit/autoroute-retrieval-tools-unmapped.test.mjs.
});

describe("POSITIVE CONTROL — the harness can observe the agent path", () => {
  beforeEach(() => {
    runAgent.mockClear();
  });

  it("a tool that REMAINS mapped still routes to the agent", async () => {
    // Without this, every zero above is indistinguishable from a mock that never intercepted.
    // Deliberately not dendron_create_note — that entry takes the directHandler bypass and
    // never reaches runAgent, so it would produce a zero for an unrelated reason.
    const res = await callUntokened("rks_git_state", { projectId: "routekit-shell-core" });
    expect(
      runAgent,
      "the mock did not intercept — every zero in this file is therefore meaningless",
    ).toHaveBeenCalledTimes(1);

    // A fired spy alone does not prove the route COMPLETED — it could still have thrown
    // downstream and been swallowed by the blanket catch. `_autoRouted` in the body is the
    // exact inverse of the negative cases' `not.toContain("_autoRouted")`, so both halves of
    // the file read the same quantity.
    const body = textOf(res);
    expect(body).toContain("_autoRouted");
    expect(body).not.toMatch(/"ok":\s*false/);
  });

  it("loadProjectContext resolves against the fixture, not the registry", async () => {
    // Without this, the CI failure surfaces only as an unexplained spy zero: the blanket catch
    // in autoRouteUnauthorized converts the infrastructure error into an authorization refusal
    // indistinguishable from a correct one. Calling loadProjectContext directly makes the real
    // cause fail BY NAME — "Project not found: routekit-shell-core".
    const context = await loadProjectContext(FIXTURE_PROJECT_ID, repoRoot);
    expect(context.record.root).toBe(fixtureRoot);
  });
});
