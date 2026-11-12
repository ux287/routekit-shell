import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const shipMock = vi.fn();
vi.mock("../../packages/mcp-rks/src/server/story-ship.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runStoryShipTool: (...args) => shipMock(...args) };
});

const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
const { createSession, getSession } = await import("../../packages/mcp-rks/src/shared/governor-token.mjs");
const { endSession, setProjectRoot, getSessionProjectRoot, countConcurrentSessions } = await import(
  "../../packages/mcp-rks/src/shared/governor-token.mjs"
);

const PROJECT_ID = "routekit-shell-core";
const STORY_ID = "backlog.fix.story-ship-chain-result-fixture";

// backlog.fix.story-ship-chain-result-test-ci-root-unpinned: the real repository root, resolved
// from this file's location (never from the registry), so the guard can prove no record this file
// creates lands there.
const REAL_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Suite-scoped temp self-project fixture. Without it the persistence root depends on machine
// state: server.mjs re-sets it from loadContext(projectId), which on a developer machine resolves
// routekit-shell-core through the gitignored registry and on a fresh CI checkout throws (root stays
// null). Pinning ROUTEKIT_PROJECT_ROOT + ROUTEKIT_PROJECT_ID makes loadContext take its env-override
// branch, so every dispatch resolves to the fixture in both environments. Same shape as
// tests/integration/autoroute-unauthorized-retrieval-refusal.test.mjs.
let fixtureRoot;
let prevProjectRoot;
let prevProjectId;
let prevSessionRoot;

function same(a, b) {
  return fs.realpathSync(a) === fs.realpathSync(b);
}

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

// backlog.fix.story-ship-chain-result-test-leaks-session-records: rks_story_ship calls carry
// projectId, so the server points session persistence at the real repository root and every
// session this file creates is written to <root>/.rks/session/governor/<token>.json. Track every
// token (and every root it may have been written under) so afterEach can end it and the guard
// case can prove nothing was left behind.
const createdTokens = new Set();
const pendingTokens = new Set();
const observedRoots = new Set();

function noteRoot() {
  const root = getSessionProjectRoot();
  if (root) observedRoots.add(root);
  return root;
}

function recordPath(root, token) {
  return path.join(root, ".rks", "session", "governor", `${token}.json`);
}

function executedSession() {
  noteRoot();
  const { token } = createSession({ projectId: PROJECT_ID, problemId: STORY_ID });
  createdTokens.add(token);
  pendingTokens.add(token);
  getSession(token).state = "executed";
  return token;
}

describe("rks_story_ship applies its observed result to the governor chain", () => {
  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "story-ship-chain-result-root-"));
    fs.mkdirSync(path.join(fixtureRoot, ".rks"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "routekit"), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureRoot, ".rks", "project.json"),
      JSON.stringify({ id: PROJECT_ID, root: fixtureRoot, kgFile: "routekit/kg.yaml" }, null, 2),
    );
    fs.writeFileSync(path.join(fixtureRoot, "routekit", "kg.yaml"), "project: fixture\n");

    prevProjectRoot = process.env.ROUTEKIT_PROJECT_ROOT;
    prevProjectId = process.env.ROUTEKIT_PROJECT_ID;
    prevSessionRoot = getSessionProjectRoot();
    process.env.ROUTEKIT_PROJECT_ROOT = fixtureRoot;
    process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;
    // Sessions created by executedSession() before the first server call persist here too.
    setProjectRoot(fixtureRoot);
  });

  afterAll(() => {
    if (prevProjectRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
    else process.env.ROUTEKIT_PROJECT_ROOT = prevProjectRoot;
    if (prevProjectId === undefined) delete process.env.ROUTEKIT_PROJECT_ID;
    else process.env.ROUTEKIT_PROJECT_ID = prevProjectId;
    setProjectRoot(prevSessionRoot);
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  // Block body on purpose: mockReset() returns the mock itself, and vitest calls a function
  // returned from beforeEach as a cleanup hook after the test — invoking shipMock once more.
  beforeEach(() => { shipMock.mockReset(); });

  // Runs after each case's own state assertions: end every session the case created, at the root
  // the server resolved, so no record outlives the case and none counts as a live session.
  afterEach(() => {
    noteRoot();
    for (const token of pendingTokens) endSession(token);
    pendingTokens.clear();
  });

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
  it("positive control: an ok:false session's record exists under the resolved root until endSession removes it", async () => {
    shipMock.mockResolvedValue({ ok: false, failedStep: "preflight_dirty_tree" });
    const token = executedSession();
    await callStoryShip({ projectId: PROJECT_ID, problemId: STORY_ID, _governorToken: token });
    const root = noteRoot();
    expect(root).toBeTruthy();
    // The dispatch path resolved routekit-shell-core to the pinned fixture, not merely some root.
    expect(fs.realpathSync(root)).toBe(fs.realpathSync(fixtureRoot));
    const file = recordPath(fixtureRoot, token);
    expect(fs.existsSync(file)).toBe(true);
    expect(getSession(token).state).toBe("executed");
    endSession(token);
    pendingTokens.delete(token);
    expect(fs.existsSync(file)).toBe(false);
    expect(getSession(token)).toBeNull();
  });

  it("under a temp root, countConcurrentSessions counts a live executed session and drops it once ended", () => {
    // Valid only because afterEach has ended every earlier case's token: countConcurrentSessions
    // also counts live in-memory sessions, not only records under the current root.
    const previousRoot = getSessionProjectRoot();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-ship-chain-result-"));
    try {
      setProjectRoot(tmp);
      const { token } = createSession({ projectId: PROJECT_ID, problemId: STORY_ID });
      createdTokens.add(token);
      getSession(token).state = "executed";
      expect(countConcurrentSessions(PROJECT_ID)).toBe(1);
      endSession(token);
      expect(countConcurrentSessions(PROJECT_ID)).toBe(0);
      expect(fs.existsSync(recordPath(tmp, token))).toBe(false);
      const dir = path.join(tmp, ".rks", "session", "governor");
      expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    } finally {
      setProjectRoot(previousRoot);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    // previousRoot is the suite fixture root, and the finally restored it.
    expect(same(getSessionProjectRoot(), fixtureRoot)).toBe(true);
  });

  it("guard: no session record created by this file survives under the resolved root", () => {
    // The temp-root case must not leave its root in effect: the current root is the one the
    // server resolved for routekit-shell-core under the pinned env, i.e. the suite fixture root.
    const root = getSessionProjectRoot();
    expect(root).toBeTruthy();
    expect(observedRoots.has(root)).toBe(true);
    expect(fs.realpathSync(root)).toBe(fs.realpathSync(fixtureRoot));
    expect(createdTokens.size).toBeGreaterThanOrEqual(7);
    const leaked = [];
    for (const r of observedRoots) {
      for (const token of createdTokens) {
        if (fs.existsSync(recordPath(r, token))) leaked.push(recordPath(r, token));
      }
    }
    expect(leaked).toEqual([]);
    // Nothing this file creates may land in the real repository either.
    const realLeaked = [...createdTokens]
      .map((token) => recordPath(REAL_REPO_ROOT, token))
      .filter((file) => fs.existsSync(file));
    expect(realLeaked).toEqual([]);
  });
});
