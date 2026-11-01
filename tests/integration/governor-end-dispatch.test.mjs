/**
 * backlog.feat.governor-session-end — rks_governor_end through the real server CallTool path.
 *
 * The server runs over stdio via createTestClient on a temp copy of the contract fixture. The
 * helper's default env (NODE_ENV=test, RKS_TEST_MODE=1, RKS_SKIP_PREFLIGHT=1) makes server.mjs skip
 * token validation, so this suite overrides those three to keep the token gate LIVE: a protected
 * tool with a bogus token is refused (positive control), while rks_governor_end, which is
 * UNPROTECTED (D15), reaches its handler and answers session_not_live.
 *
 * Out of test mode the boot-time hooks check runs, so the fixture copy gets an empty
 * .routekit/hooks directory.
 *
 * RKS_TELEMETRY_BUFFER_SIZE=1 makes every emit flush at once, so rks_telemetry_query sees it.
 * The server subprocess is bounded by the vitest hook/test timeouts and closed in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createTestClient,
  closeTestClient,
  createTempFixture,
  cleanupTempFixture,
} from "../../packages/mcp-rks/__tests__/mcp-contract-helpers.mjs";

const PROJECT = "test-project";
const LIVE_TOKEN_GATE_ENV = {
  NODE_ENV: "production",
  RKS_TEST_MODE: "0",
  RKS_SKIP_PREFLIGHT: "0",
  RKS_TELEMETRY_BUFFER_SIZE: "1",
};
let session;
let fixture;

const call = async (name, args) => {
  const r = await session.client.callTool({ name, arguments: args });
  return JSON.parse(r.content[0].text);
};

const countEnded = async () => {
  const q = await call("rks_telemetry_query", { projectId: PROJECT, type: "governor.session.ended", limit: 1000 });
  return (q.events || []).length;
};

// Telemetry flushes asynchronously (setTimeout 0, then an fs append); poll briefly, bounded.
async function settledCount(expected, { tries = 40, delayMs = 50 } = {}) {
  let n = await countEnded();
  for (let i = 0; i < tries && n !== expected; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    n = await countEnded();
  }
  return n;
}

beforeAll(async () => {
  fixture = createTempFixture();
  // Out of test mode the server's boot verifies <CLAUDE_PROJECT_DIR>/.routekit/hooks exists
  // (server/hooks-health.mjs verifyHooksPresent); the temp fixture gets an empty one.
  fs.mkdirSync(path.join(fixture, ".routekit", "hooks"), { recursive: true });
  session = await createTestClient({ projectRoot: fixture, env: LIVE_TOKEN_GATE_ENV });
}, 30_000);

afterAll(async () => {
  if (session) await closeTestClient(session);
  if (fixture) cleanupTempFixture(fixture);
});

describe("rks_governor_end through server dispatch", { timeout: 30_000 }, () => {
  it("is advertised with projectId (required) and _governorToken", async () => {
    const { tools } = await session.client.listTools();
    const t = tools.find((x) => x.name === "rks_governor_end");
    expect(t).toBeTruthy();
    expect(t.inputSchema.required).toEqual(["projectId"]);
    expect(Object.keys(t.inputSchema.properties).sort()).toEqual(["_governorToken", "projectId"]);
  });

  it("positive control: the token gate is live (a protected tool with a bogus token is refused)", async () => {
    const r = await call("rks_git_state", { projectId: PROJECT, _governorToken: "expired-or-unknown" });
    expect(r.ok).not.toBe(true);
    expect(JSON.stringify(r)).toMatch(/unauthori[sz]ed|not_found_or_expired/i);
  });

  it("a not-live token reaches the handler: session_not_live, not unauthorized", async () => {
    const r = await call("rks_governor_end", { projectId: PROJECT, _governorToken: "expired-or-unknown" });
    expect(r).toMatchObject({ ok: true, ended: false, reason: "session_not_live" });
    expect(JSON.stringify(r)).not.toMatch(/unauthori[sz]ed|not_found_or_expired/i);
  });

  it("init then end: ended true with flowType open and the init state; second end is session_not_live", async () => {
    const init = await call("rks_governor_init", { projectId: PROJECT });
    expect(init.ok).toBe(true);
    expect(init.flowType).toBe("open");
    const end = await call("rks_governor_end", { projectId: PROJECT, _governorToken: init.token });
    expect(end).toMatchObject({ ok: true, ended: true, flowType: "open", state: init.state });
    const again = await call("rks_governor_end", { projectId: PROJECT, _governorToken: init.token });
    expect(again).toMatchObject({ ok: true, ended: false, reason: "session_not_live" });
  });

  it("emits exactly one governor.session.ended for an ended session and none for a not-live end", async () => {
    const before = await settledCount(await countEnded());
    const init = await call("rks_governor_init", { projectId: PROJECT });
    const end = await call("rks_governor_end", { projectId: PROJECT, _governorToken: init.token });
    expect(end.ended).toBe(true);
    expect(await settledCount(before + 1)).toBe(before + 1);
    const notLive = await call("rks_governor_end", { projectId: PROJECT, _governorToken: init.token });
    expect(notLive.reason).toBe("session_not_live");
    // Give a wrongly emitted event the same window to land before asserting none did.
    await new Promise((r) => setTimeout(r, 300));
    expect(await countEnded()).toBe(before + 1);
  });
});
