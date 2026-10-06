import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const shipMock = vi.fn();
vi.mock("../../packages/mcp-rks/src/server/story-ship.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runStoryShipTool: (...args) => shipMock(...args) };
});

const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
const { createSession, getSession } = await import("../../packages/mcp-rks/src/shared/governor-token.mjs");

const PROJECT_ID = "routekit-shell-core";
const STORY_ID = "backlog.fix.story-ship-chain-result-fixture";

async function callStoryShip(args) {
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await client.callTool({ name: "rks_story_ship", arguments: args });
  } finally {
    await client.close();
  }
}

function executedSession() {
  const { token } = createSession({ projectId: PROJECT_ID, problemId: STORY_ID });
  getSession(token).state = "executed";
  return token;
}

describe("rks_story_ship applies its observed result to the governor chain", () => {
  // Block body on purpose: mockReset() returns the mock itself, and vitest calls a function
  // returned from beforeEach as a cleanup hook after the test — invoking shipMock once more.
  beforeEach(() => { shipMock.mockReset(); });

  it("ok:false returns the chain to executed and a retry on the same token is admitted", async () => {
    const failed = { ok: false, failedStep: "preflight_dirty_tree", error: "dirty" };
    shipMock.mockResolvedValue(failed);
    const token = executedSession();
    const r1 = await callStoryShip({ projectId: PROJECT_ID, problemId: STORY_ID, _governorToken: token });
    expect(JSON.parse(r1.content[0].text)).toEqual(failed);
    expect(getSession(token).state).toBe("executed");
    const r2 = await callStoryShip({ projectId: PROJECT_ID, problemId: STORY_ID, _governorToken: token });
    expect(r2.content[0].text).not.toContain("chain_violation");
    expect(shipMock).toHaveBeenCalledTimes(2);
  });

  it("ok:true advances the chain to shipped, which is terminal and ends the session", async () => {
    const shipped = { ok: true, steps: [] };
    shipMock.mockResolvedValue(shipped);
    const token = executedSession();
    // shipped is terminal for the story flow: advanceStateOnResult ends the session,
    // so capture the reference before the call and read state from it afterwards.
    const session = getSession(token);
    const r = await callStoryShip({ projectId: PROJECT_ID, problemId: STORY_ID, _governorToken: token });
    expect(JSON.parse(r.content[0].text)).toEqual(shipped);
    expect(session.state).toBe("shipped");
    expect(getSession(token)).toBeNull();
  });

  it("an idempotent ok:true result is not evidence of delivery and leaves the chain at executed", async () => {
    const idempotent = { ok: true, idempotent: true, stepsCompleted: 0, stepsSkipped: 3, workingBranch: "staging" };
    shipMock.mockResolvedValue(idempotent);
    const token = executedSession();
    const r = await callStoryShip({ projectId: PROJECT_ID, problemId: STORY_ID, _governorToken: token });
    expect(JSON.parse(r.content[0].text)).toEqual(idempotent);
    expect(getSession(token).state).toBe("executed");
  });

  it("a thrown runStoryShipTool error returns the chain to executed and still reaches the caller", async () => {
    shipMock.mockImplementation(() => { throw new Error("boom-story-ship"); });
    const token = executedSession();
    await expect(
      callStoryShip({ projectId: PROJECT_ID, problemId: STORY_ID, _governorToken: token })
    ).rejects.toThrow(/boom-story-ship/);
    expect(getSession(token).state).toBe("executed");
  });

  it("an untokened call leaves an unrelated executed session untouched and returns the payload verbatim", async () => {
    const failed = { ok: false, failedStep: "preflight_dirty_tree" };
    shipMock.mockResolvedValue(failed);
    const token = executedSession();
    const r = await callStoryShip({ projectId: PROJECT_ID, problemId: STORY_ID });
    expect(JSON.parse(r.content[0].text)).toEqual(failed);
    expect(getSession(token).state).toBe("executed");
  });
});
