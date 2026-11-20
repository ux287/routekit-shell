import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * backlog.fix.concurrent-sessions-counts-returned-governors
 *
 * A Governor that returns without rks_governor_end (crashed, killed, returned before its end call,
 * or an unrefreshed prompt) leaves a non-terminal session that isLiveSession keeps live for
 * MAX_AGE_MS (30 minutes). concurrentSessions must not report such a peer as a concurrent live
 * session without qualification: it counts peers active within CONCURRENT_ACTIVITY_WINDOW_MS
 * (or executing in this process) and lists every unended live peer in otherSessions.
 *
 * Every case runs against an os.tmpdir() root set with tok.setProjectRoot(dir) right after the
 * module import and before any init; the prior root is restored in afterEach
 * (tok.setProjectRoot(null)), the same isolation as tests/unit/governor-session-multi-caller.test.mjs.
 * The clock is moved with vi.setSystemTime; no session record is edited by hand.
 *
 * RKS_DISPATCH_RUN_ID is stubbed so serial sessions on ONE project share a run holder in the project
 * lease (dispatch-run inheritance): an un-ended open session would otherwise make the lease refuse
 * the following exclusive qa init, which is the lease's behaviour and not what is under test here.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INIT_PATH = path.join(ROOT, "packages/mcp-rks/src/tools/governor-init.mjs");
const TOKEN_PATH = path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs");

const MIN = 60 * 1000;
const LIVE_PHRASE = "other live session(s) on this project";

let dir;
let init;
let tok;

// Fresh module instances against the same project root == an MCP server restart.
async function boot() {
  vi.resetModules();
  tok = await import(TOKEN_PATH);
  init = await import(INIT_PATH);
  tok.setProjectRoot(dir);
}

// One admitted tool call, the way server.mjs dispatches it: checkAllowedTool admits it (and
// touches activity), advanceState moves the chain, touchSession records the activity.
function admittedCall(token, tool = "rks_agent_research") {
  expect(tok.checkAllowedTool(token, tool), `${tool} must be admitted`).toBeNull();
  tok.advanceState(token, tool);
  tok.touchSession(token);
}

// Three Governors initialised serially (research = open, qa, po = open flow; governor-po.md inits
// the open flow), each making one admitted tool call, none ended.
function threeReturnedGovernors(projectId = "p") {
  const research = init.handleGovernorInit({ projectId });
  expect(research.ok, JSON.stringify(research)).toBe(true);
  admittedCall(research.token);
  const qa = init.handleGovernorInit({ projectId, flowType: "qa", problemId: "story-qa" });
  expect(qa.ok, JSON.stringify(qa)).toBe(true);
  admittedCall(qa.token);
  const po = init.handleGovernorInit({ projectId });
  expect(po.ok, JSON.stringify(po)).toBe(true);
  admittedCall(po.token);
  return [research, qa, po];
}

beforeEach(async () => {
  vi.stubEnv("RKS_DISPATCH_RUN_ID", "run-returned-not-concurrent");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-returned-"));
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  await boot();
});

afterEach(() => {
  try { tok.resetToken(); } catch { /* ignore */ }
  tok.setProjectRoot(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("concurrentSessions does not report returned Governors unqualified", () => {
  it("the activity window is 10 minutes", () => {
    expect(tok.CONCURRENT_ACTIVITY_WINDOW_MS).toBe(10 * MIN);
  });

  it("three serial Governors that returned without ending are not reported as unqualified concurrent live sessions", () => {
    const peers = threeReturnedGovernors();
    // Older than the 10-minute window, still within MAX_AGE_MS (30 minutes).
    vi.setSystemTime(Date.now() + 15 * MIN);
    const next = init.handleGovernorInit({ projectId: "p" });
    expect(next.ok, JSON.stringify(next)).toBe(true);
    expect(next.message).not.toContain(LIVE_PHRASE);
    expect(next.concurrentSessions ?? 0).toBe(0);
    // ...and they are volunteered, each with its flowType, state and idle age.
    expect(next.otherSessions).toHaveLength(3);
    expect(next.otherSessions.map((e) => e.flowType).sort()).toEqual(["open", "open", "qa"]);
    for (const e of next.otherSessions) {
      expect(e.counted).toBe(false);
      expect(typeof e.state).toBe("string");
      expect(e.idleMs).toBeGreaterThan(next.concurrentActivityWindowMinutes * MIN);
    }
    expect(next.otherSessions.find((e) => e.flowType === "qa").problemId).toBe("story-qa");
    // No peer token leaks into the report.
    const json = JSON.stringify(next.otherSessions);
    for (const p of peers) expect(json).not.toContain(p.token);
    // Restart/guardrails liveness is untouched: every peer is still a valid (live) session.
    for (const p of peers) expect(tok.validateToken(p.token)).toBe(true);
  });

  it("positive control: a recently active non-terminal peer is still reported", () => {
    const peer = init.handleGovernorInit({ projectId: "p" });
    admittedCall(peer.token);
    vi.setSystemTime(Date.now() + 5 * MIN); // inside the window
    const next = init.handleGovernorInit({ projectId: "p" });
    expect(next.ok).toBe(true);
    expect(next.concurrentSessions).toBe(1);
    expect(next.otherSessions).toHaveLength(1);
    expect(next.otherSessions[0]).toMatchObject({ flowType: "open", state: tok.getSession(peer.token).state, counted: true });
    expect(next.otherSessions[0].idleMs).toBe(5 * MIN);
  });

  it("an in-memory peer in executing is counted even when idle past the window", () => {
    const peer = init.handleGovernorInit({ projectId: "p", problemId: "story-exec" });
    tok.getSession(peer.token).state = "executing"; // a long rks_exec refreshes activity only at entry
    vi.setSystemTime(Date.now() + 15 * MIN);
    expect(tok.describeOtherSessions("p")).toEqual([
      { flowType: "story", state: "executing", problemId: "story-exec", idleMs: 15 * MIN, counted: true },
    ]);
    expect(tok.countConcurrentSessions("p")).toBe(1);
  });

  it("an ended session is not counted while a live peer is", () => {
    const live = init.handleGovernorInit({ projectId: "p" });
    const ended = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-ended" });
    expect(ended.ok, JSON.stringify(ended)).toBe(true);
    tok.endSession(ended.token);
    const next = init.handleGovernorInit({ projectId: "p" });
    expect(next.ok).toBe(true);
    expect(next.concurrentSessions).toBe(1);
    expect(next.otherSessions).toHaveLength(1);
    expect(next.otherSessions[0].flowType).toBe("open");
    expect(next.otherSessions.some((e) => e.problemId === "story-ended")).toBe(false);
    expect(tok.validateToken(live.token)).toBe(true);
  });

  it("the message states the measure behind the number, matching the response's own values", () => {
    threeReturnedGovernors(); // will be idle
    vi.setSystemTime(Date.now() + 15 * MIN);
    const fresh = init.handleGovernorInit({ projectId: "p" }); // active
    admittedCall(fresh.token);
    const next = init.handleGovernorInit({ projectId: "p" });
    expect(next.ok).toBe(true);
    const counted = next.otherSessions.filter((e) => e.counted).length;
    const idle = next.otherSessions.length - counted;
    expect(next.concurrentSessions).toBe(counted);
    expect(counted).toBeGreaterThan(0);
    expect(idle).toBeGreaterThan(0);
    expect(next.message).toContain(
      `${next.concurrentSessions} other session(s) with activity in the last ${next.concurrentActivityWindowMinutes} minutes`,
    );
    expect(next.message).toContain(`${idle} more unended session(s) idle longer than that (not counted; see otherSessions)`);
    expect(next.message).not.toContain(LIVE_PHRASE);

    // Only idle peers: the message still names the window and the idle count, not "live".
    tok.endSession(fresh.token);
    tok.endSession(next.token);
    const onlyIdle = init.handleGovernorInit({ projectId: "p" });
    expect(onlyIdle.concurrentSessions ?? 0).toBe(0);
    const idleOnly = onlyIdle.otherSessions.filter((e) => !e.counted).length;
    expect(idleOnly).toBe(onlyIdle.otherSessions.length);
    expect(onlyIdle.message).toContain(`activity in the last ${onlyIdle.concurrentActivityWindowMinutes} minutes`);
    expect(onlyIdle.message).toContain(`${idleOnly} unended session(s) idle longer than that`);
    expect(onlyIdle.message).not.toContain(LIVE_PHRASE);
  });

  it("a lone init carries no other-session fields", () => {
    const lone = init.handleGovernorInit({ projectId: "p" });
    expect(lone.ok).toBe(true);
    expect(lone).not.toHaveProperty("concurrentSessions");
    expect(lone).not.toHaveProperty("otherSessions");
    expect(lone).not.toHaveProperty("concurrentActivityWindowMinutes");
    expect(lone.message).toBe("Governor session initialized (open flow)");
  });

  it("the resume path applies the same measure and never counts the resumed session", () => {
    threeReturnedGovernors();
    vi.setSystemTime(Date.now() + 15 * MIN);
    const own = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    expect(own.ok, JSON.stringify(own)).toBe(true);
    tok.advanceState(own.token, "rks_refine");

    const resumed = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    expect(resumed.mode).toBe("resumed");
    expect(resumed.token).toBe(own.token);
    expect(resumed.concurrentSessions ?? 0).toBe(0);
    expect(resumed.otherSessions).toHaveLength(3);
    expect(resumed.otherSessions.every((e) => e.counted === false)).toBe(true);
    expect(resumed.otherSessions.some((e) => e.problemId === "story-A")).toBe(false);
    expect(resumed.message).not.toContain(LIVE_PHRASE);
    expect(resumed.message).toContain(`activity in the last ${resumed.concurrentActivityWindowMinutes} minutes`);
    expect(resumed.message).toContain("3 unended session(s) idle longer than that (not counted; see otherSessions)");

    // Positive control on the resume path: an active peer is counted there too.
    const peer = init.handleGovernorInit({ projectId: "p" });
    expect(peer.ok, JSON.stringify(peer)).toBe(true);
    const again = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    expect(again.mode).toBe("resumed");
    expect(again.concurrentSessions).toBe(1);
    expect(again.otherSessions).toHaveLength(4);
    expect(again.otherSessions.some((e) => e.problemId === "story-A")).toBe(false);
    expect(again.message).toContain(`${again.concurrentSessions} other session(s) with activity in the last ${again.concurrentActivityWindowMinutes} minutes`);
  });

  it("restart recovery still treats a record within MAX_AGE_MS but outside the measure as live", async () => {
    const a = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    tok.advanceState(a.token, "rks_refine");
    vi.setSystemTime(Date.now() + 15 * MIN);
    await boot(); // memory empty, record on disk
    // Outside the measure: listed, not counted.
    expect(tok.describeOtherSessions("p")).toEqual([
      expect.objectContaining({ flowType: "story", problemId: "story-A", counted: false }),
    ]);
    expect(tok.countConcurrentSessions("p")).toBe(0);
    // ...yet restart recovery resumes it.
    const r = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    expect(r.mode).toBe("resumed");
    expect(r.token).toBe(a.token);
    expect(r.state).toBe("refining");
  });

  it("detectOrphanedGuardrails does not restore hooks.bak while such a record exists", async () => {
    const owner = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    tok.setGuardrailsDisabled(owner.token, true);
    const bak = path.join(dir, ".routekit", "hooks.bak");
    fs.mkdirSync(bak, { recursive: true });
    vi.setSystemTime(Date.now() + 15 * MIN);
    await boot();
    expect(tok.countConcurrentSessions("p")).toBe(0); // outside the measure
    expect(tok.describeOtherSessions("p")).toHaveLength(1); // still live
    expect(tok.detectOrphanedGuardrails()).toBe(false);
    expect(fs.existsSync(bak)).toBe(true);
    // Control: past MAX_AGE_MS the same record no longer holds hooks.bak.
    vi.setSystemTime(Date.now() + 20 * MIN);
    await boot();
    expect(tok.detectOrphanedGuardrails()).toBe(true);
    expect(fs.existsSync(bak)).toBe(false);
  });
});
