import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(async () => ({ matches: [] })),
}));

vi.mock("../../packages/rag/src/query.mjs", () => ({
  query: (...args) => queryMock(...args),
}));

vi.mock("../../packages/rag/src/rag-config-loader.mjs", () => ({
  getRagPathsFor: vi.fn(async () => ({ notes: "/nonexistent/rag/notes" })),
}));

import { runRagQuery } from "../../packages/rag/src/tools.mjs";
import { createCapabilityToken } from "../../packages/rag/src/capability-token.mjs";
import { AGENT_ROLES, getProfile } from "../../packages/rag/src/capability-profiles.mjs";

function tokenFor(role) {
  return createCapabilityToken({ runId: "run-k-cap", role, projectId: "k-cap-test" });
}

function kPassedToQuery() {
  expect(queryMock).toHaveBeenCalledTimes(1);
  return queryMock.mock.calls[0][0].k;
}

describe("runRagQuery caps the caller's k by the role's maxResultsPerQuery", () => {
  let tmpDir;

  beforeEach(() => {
    queryMock.mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-k-cap-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("k 10 with an auditor token requests 10, not the auditor ceiling", async () => {
    expect(getProfile(AGENT_ROLES.AUDITOR).maxResultsPerQuery).toBeGreaterThan(10);
    await runRagQuery(tmpDir, { q: "x", k: 10, capabilityToken: tokenFor(AGENT_ROLES.AUDITOR) });
    expect(kPassedToQuery()).toBe(10);
  });

  it("k 100 with an executor token is capped to the executor ceiling", async () => {
    const ceiling = getProfile(AGENT_ROLES.EXECUTOR).maxResultsPerQuery;
    await runRagQuery(tmpDir, { q: "x", k: 100, capabilityToken: tokenFor(AGENT_ROLES.EXECUTOR) });
    expect(kPassedToQuery()).toBe(ceiling);
    expect(ceiling).toBe(6);
  });

  it("a token with no k requests the role's maxResultsPerQuery", async () => {
    const ceiling = getProfile(AGENT_ROLES.PLANNER).maxResultsPerQuery;
    await runRagQuery(tmpDir, { q: "x", capabilityToken: tokenFor(AGENT_ROLES.PLANNER) });
    expect(kPassedToQuery()).toBe(ceiling);
  });

  it("k with no token is passed through unchanged", async () => {
    await runRagQuery(tmpDir, { q: "x", k: 10 });
    expect(kPassedToQuery()).toBe(10);
  });

  it("no k and no token passes k undefined (query() default applies)", async () => {
    await runRagQuery(tmpDir, { q: "x" });
    expect(kPassedToQuery()).toBeUndefined();
  });

  it("an invalid token is treated as absent, so the caller's k is used", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = { ...tokenFor(AGENT_ROLES.AUDITOR), tokenId: undefined };
    await runRagQuery(tmpDir, { q: "x", k: 10, capabilityToken: bad });
    expect(kPassedToQuery()).toBe(10);
    warn.mockRestore();
  });
});
