/**
 * backlog.fix.agent-stash-create-containment — end-to-end.
 *
 * Two halves, and both are needed:
 *   1. An UNTOKENED rks_stash is refused rather than diverted to the LLM git agent. Before this
 *      story TOOL_TO_AGENT_MAP routed it there, flattening `action`/`includeUntracked` into
 *      prose, onto the one branch that cannot register an auto-pop.
 *   2. A TOKENED rks_stash with a live Governor session reaches the inline handler, registers a
 *      pending stash, and endSession restores the working tree.
 *
 * WHY THIS ASSERTS ON DISK CONTENT. tests/unit/exec-no-actions-state-rollback.test.mjs already
 * pins setPendingStash/clearPendingStash bookkeeping against a vi.fn() mock. Those four tests
 * pass whether or not any real stash is ever popped — they would stay green with the whole
 * stash path deleted. The only thing that distinguishes a working guarantee from a working
 * ledger is reading the file back.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const PROJECT_ID = "routekit-shell-core";
const SPAWN_MS = 3000;
let repo;
const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
const prevId = process.env.ROUTEKIT_PROJECT_ID;

repo = fs.mkdtempSync(path.join(os.tmpdir(), "stash-containment-"));
process.env.ROUTEKIT_PROJECT_ROOT = repo;
process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;

const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
const { createSession, endSession, getSession, setToken, flushPendingStashPops, setPendingStash } =
  await import("../../packages/mcp-rks/src/shared/governor-token.mjs");

const TRACKED = "tracked.txt";
const COMMITTED = "committed content\n";
const DIRTY = "uncommitted work that must not be abandoned\n";

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
  fs.writeFileSync(path.join(repo, ".rks", "project.json"),
    JSON.stringify({ id: PROJECT_ID, root: repo, kgFile: "routekit/kg.yaml" }, null, 2));
  fs.writeFileSync(path.join(repo, "routekit", "kg.yaml"), "project: fixture\n");

  spawnSync("git", ["init", "--initial-branch=main", repo], { timeout: SPAWN_MS });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: repo, timeout: SPAWN_MS });
  spawnSync("git", ["config", "user.name", "T"], { cwd: repo, timeout: SPAWN_MS });
  fs.writeFileSync(path.join(repo, TRACKED), COMMITTED);
  spawnSync("git", ["add", "."], { cwd: repo, timeout: SPAWN_MS });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: repo, timeout: SPAWN_MS });
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT; else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
  if (prevId === undefined) delete process.env.ROUTEKIT_PROJECT_ID; else process.env.ROUTEKIT_PROJECT_ID = prevId;
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("an untokened rks_stash is refused, never diverted to the agent", () => {
  it("returns an unauthorized refusal, not an agent summary", async () => {
    const body = textOf(await callTool("rks_stash", { projectId: PROJECT_ID, action: "save" }));
    expect(body).toMatch(/"ok":\s*false/);
    expect(body).toMatch(/unauthorized/i);
    // _autoRouted is the marker the auto-route path stamps on a substituted response.
    expect(body, "an untokened stash was handed to the LLM git agent").not.toContain("_autoRouted");
  });
});

describe("a tokened rks_stash registers an auto-pop that endSession fires", () => {
  it("restores the working tree — asserted on DISK, not on a spy", async () => {
    fs.writeFileSync(path.join(repo, TRACKED), DIRTY);
    expect(fs.readFileSync(path.join(repo, TRACKED), "utf8")).toBe(DIRTY);

    const { token } = createSession({ projectId: PROJECT_ID, flowType: "ops", problemId: "stash-test" });
    const stateBefore = getSession(token)?.state;
    setToken(token);
    expect(getSession(token), "no live session — the admission precondition is not met").toBeTruthy();

    const res = await callTool("rks_stash", { projectId: PROJECT_ID, action: "save", _governorToken: token });
    const body = textOf(res);
    expect(body, `rks_stash was refused for a tokened caller: ${body}`).not.toMatch(/chain_violation/);

    // Admission via STATE_BYPASS_TOOLS is consulted INSIDE checkStateAllowed, downstream of the
    // session lookup — so unlike a COMMON_TOOLS admission the call is still counted, and still
    // does not move the chain.
    expect(getSession(token)?.toolCallCounts?.rks_stash,
      "the call bypassed telemetry — that is the COMMON_TOOLS shape, not STATE_BYPASS_TOOLS").toBeGreaterThan(0);
    expect(getSession(token)?.state,
      "a stash must not advance the chain").toBe(stateBefore);

    // The stash actually happened — otherwise the restore below proves nothing.
    expect(fs.readFileSync(path.join(repo, TRACKED), "utf8"),
      "ANTI-VACUITY: nothing was stashed, so the restore cannot be meaningful").toBe(COMMITTED);

    // Registration is the guarantee; assert it BEFORE ending, so a failure below is
    // legible as 'the pop did not happen' rather than 'nothing was ever registered'.
    expect(getSession(token)?.pendingStash,
      "no pending stash registered — the auto-pop guarantee was never armed").toBe(true);

    endSession(token);

    // COMPENSATION REMOVED by backlog.fix.endsession-stash-autopop-unawaited.
    //
    // This used to poll a 200-iteration loop yielding on setImmediate, because
    // endSession fired the cleanup as a floating promise and returned before the
    // pop completed. That loop is what made this assertion pass — it stood in for
    // the missing await, so the suite was green against the defect. Production has
    // no such loop: a process exiting after endSession simply lost the restore.
    //
    // endSession now RETAINS the pop promise, and this awaits it directly. No
    // polling and no scheduler yield: if the retention were removed, the
    // assertions below would fail rather than spin.
    //
    // WHAT THIS DOES NOT PROVE (corrected by
    // backlog.fix.post-ship-review-findings-batch, Finding 2). This comment used
    // to claim the await happened "exactly the way the MCP wire layer does". It
    // does not. The wire layer awaits the flush in a `finally` around the tool
    // handler; this line calls the flush from the TEST BODY. That is a simulation
    // of the wire layer, not the wire layer, so deleting the wire-layer await
    // leaves this case green. That witness is no longer owed: it is the test
    // named WIRE-LAYER WITNESS in this same file, added by
    // backlog.fix.post-ship-review-findings-batch. Why the literal
    // ends-inside-a-handler variant is unreachable is set out there under
    // WHAT THIS DOES NOT DO.
    //
    // Referenced by NAME, never by line number — this comment sits ABOVE that
    // test, so any change to its own length would move a cited line and make the
    // citation wrong the moment it was written.
    await flushPendingStashPops();

    expect(
      (spawnSync("git", ["stash", "list"], { cwd: repo, encoding: "utf8", timeout: SPAWN_MS }).stdout || "").trim(),
      "the stash was never consumed — the auto-pop did not run at all",
    ).toBe("");

    expect(fs.readFileSync(path.join(repo, TRACKED), "utf8"),
      "endSession did not restore the stashed work — this is the abandonment defect").toBe(DIRTY);
  });
});

describe("THE WIRE LAYER awaits the pop — not the test body", () => {
  it("WIRE-LAYER WITNESS: a tool call cannot return with a pop still outstanding", async () => {
    // backlog.fix.post-ship-review-findings-batch, Finding 2.
    //
    // WHAT WAS MISSING. The case above awaits flushPendingStashPops() from the
    // TEST BODY, which is a simulation of the wire layer, not the wire layer. So
    // deleting `await flushPendingStashPops();` from
    // packages/mcp-rks/src/server.mjs left the entire suite green and the
    // acceptance criterion had no witness at all.
    //
    // WHY THE CLEANUP IS A TIMER AND NOT A REAL POP. A first attempt armed a real
    // stash and asserted the working tree after one tool call. It PASSED with the
    // wire-layer await deleted: endSession starts the pop immediately and retains
    // the promise, and a real pop settles on its own inside the few milliseconds
    // an MCP round trip takes. That version measured scheduling luck, not
    // causation, and only a mutation run exposed it. A 250ms timer cannot be
    // crossed by a round trip, so only a genuine await of the retained promise
    // can satisfy the assertion below.
    //
    // WHAT THIS DOES NOT DO, stated plainly. The criterion asked for a session
    // that ENDS INSIDE a tool handler. That path is unreachable today: for an ops
    // session the only terminal edge is resultTransitions['cycle_complete.ok'] ->
    // 'done', and `rks_cycle_complete` is absent from OPS_FLOW_TOOLS and from
    // both ops states' `allowed` sets, so both admission gates refuse it before
    // the handler runs. The session is therefore ended out of band, and what is
    // witnessed is the half that was actually broken: a pop that is registered
    // and still outstanding must be settled before the wire returns a tool result.
    const { token } = createSession({
      projectId: PROJECT_ID, flowType: "ops", problemId: "wire-layer-witness",
    });

    // A GATE, NOT A TIMER. The earlier form armed a 250ms timer and asserted, as
    // a PREMISE it never measured, that a tool round trip could not outlast it.
    // That premise is load-bearing and untested: `callTool` builds a whole MCP
    // server and client pair per call, so on a loaded runner the trip can cross
    // 250ms — and when it does, the pop settles on its own and the test passes
    // whether or not the wire layer awaited anything. A false GREEN, which is the
    // one failure mode a witness may not have.
    //
    // The gate removes the race instead of widening it. The pop cannot complete
    // until this test releases it, so there is no duration to outlast and no
    // runner speed that changes the outcome.
    let popped = false;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    setPendingStash(token, () => gate.then(() => { popped = true; }));
    expect(getSession(token)?.pendingStash,
      "no pending stash armed — the auto-pop guarantee was never registered").toBe(true);

    endSession(token);

    // ANTI-VACUITY CONTROL. If this were already true the assertions below would
    // pass whether or not anything was awaited. The gate guarantees it is false.
    expect(popped, "the pop completed synchronously — this test cannot see the wire layer").toBe(false);

    // ONE tool call over the real in-process transport. This test never calls
    // flushPendingStashPops. The server dispatch `finally` is the only thing that
    // can settle the retained promise.
    let settled = false;
    const call = callTool("rks_project_get", { id: PROJECT_ID }).then((r) => { settled = true; return r; });

    // THE WITNESS. While the pop is gated the tool call MUST NOT return. The
    // delay is non-zero deliberately: a zero-delay timer would trip the
    // source-text guard in tests/unit/endsession-stash-flush.test.mjs, and it
    // only has to outlast a round trip that is NOT waiting on anything — it is
    // not the thing being measured, because the gate never opens on its own.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled,
      "the tool call returned while the stash pop was still gated — the wire layer did not await it")
      .toBe(false);
    expect(popped).toBe(false);

    // Release, and only now may the call complete.
    release();
    await call;

    expect(popped,
      "the wire layer returned a tool result with the restore still outstanding — the await in server.mjs is missing")
      .toBe(true);
    expect(settled).toBe(true);
  });
});
