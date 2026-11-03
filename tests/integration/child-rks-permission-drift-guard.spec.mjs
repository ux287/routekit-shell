// backlog.fix.child-rks-permission-allow-list — live registry pin for the child permission
// classification. Mirrors tests/integration/mcp-schema-drift-guard.spec.mjs: the advertised
// side is ALWAYS read from a live listTools(), never by parsing server source.
//
// Every advertised rks tool must be classified into exactly one of CHILD_RKS_ALLOW_TOOLS
// (runs unprompted under the child's mcp__rks__* wildcard) or CHILD_RKS_PROMPT_TOOLS (a
// human checkpoint, written to the child's permissions.ask). A new server tool fails here
// until someone decides which it is.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestClient, closeTestClient } from "../../packages/mcp-rks/__tests__/mcp-contract-helpers.mjs";
import { CHILD_RKS_ALLOW_TOOLS, CHILD_RKS_PROMPT_TOOLS } from "../../packages/cli/src/project/child-permissions.mjs";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe("child rks permission classification — no drift from the live server", () => {
  let session = null;
  let advertised = [];

  beforeAll(async () => {
    session = await createTestClient();
    const listed = await session.client.listTools();
    advertised = listed.tools.map((t) => `mcp__rks__${t.name}`);
  });

  afterAll(async () => {
    if (session) await closeTestClient(session);
    session = null;
  });

  it("advertises tools at all (guards against a vacuous pass)", () => {
    expect(advertised.length).toBeGreaterThan(50);
  });

  it("every advertised tool is classified exactly once; no stale entries; sets disjoint", () => {
    const allow = new Set(CHILD_RKS_ALLOW_TOOLS);
    const prompt = new Set(Object.keys(CHILD_RKS_PROMPT_TOOLS));
    const live = new Set(advertised);
    expect({
      unclassified: advertised.filter((t) => allow.has(t) === prompt.has(t)),
      stale: [...allow, ...prompt].filter((t) => !live.has(t)),
      overlap: [...allow].filter((t) => prompt.has(t)),
    }).toEqual({ unclassified: [], stale: [], overlap: [] });
  });
});
