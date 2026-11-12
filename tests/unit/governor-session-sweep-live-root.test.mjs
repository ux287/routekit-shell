/**
 * backlog.fix.session-sweep-refuse-live-root-under-test
 *
 * sweepDeadSessionRecords refuses (non-throwing, live_root_under_test) when the project root is
 * the live repository root under VITEST. No case here may delete, write or append under
 * SHELL_REPO_ROOT/.rks: sweep cases use a temp root aliased to the live-root decision, and the
 * one real-root case stubs fs deletions and appends first.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const h = vi.hoisted(() => ({ aliasLiveRoot: null }));

vi.mock("../../packages/mcp-rks/src/shared/live-root-guard.mjs", async (io) => {
  const actual = await io();
  const { realpathSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return {
    ...actual,
    isLiveRootUnderTest: (root) => {
      if (h.aliasLiveRoot && root && real(root) === real(h.aliasLiveRoot)) {
        return actual.isLiveRootUnderTest(actual.SHELL_REPO_ROOT);
      }
      return actual.isLiveRootUnderTest(root);
    },
  };
});

import {
  setProjectRoot,
  getSessionProjectRoot,
  resetToken,
  setToken,
  sweepDeadSessionRecords,
} from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { SHELL_REPO_ROOT } from "../../packages/mcp-rks/src/shared/live-root-guard.mjs";
import { handleGovernorInit } from "../../packages/mcp-rks/src/tools/governor-init.mjs";

let root;
let priorRoot;

const sessionDir = () => path.join(root, ".rks", "session", "governor");
const auditPath = () => path.join(root, ".rks", "session", "governor-sweep.jsonl");
const recordPath = (token) => path.join(sessionDir(), `${token}.json`);
const AGED = () => Date.now() - 5 * 30 * 60 * 1000; // past SESSION_SWEEP_THRESHOLD_MS (4 x MAX_AGE_MS)

function seed(token, fields = {}) {
  fs.mkdirSync(sessionDir(), { recursive: true });
  const now = Date.now();
  const rec = { token, projectId: "p", flowType: "story", state: "init", problemId: "story-A", createdAt: now, lastActivity: now, ...fields };
  fs.writeFileSync(recordPath(token), JSON.stringify(rec, null, 2));
  return rec;
}

function violations() {
  const v = globalThis.__RKS_LIVE_STATE_VIOLATIONS__;
  return Array.isArray(v) ? v.length : 0;
}

beforeEach(() => {
  priorRoot = getSessionProjectRoot();
  h.aliasLiveRoot = null;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-sweep-live-root-"));
  setProjectRoot(root); // BEFORE resetToken: resetToken deletes under the CURRENT root
  resetToken();
  setToken(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  h.aliasLiveRoot = null; // BEFORE resetToken: an aliased root would be refused as live
  setProjectRoot(root);
  try { resetToken(); } catch { /* temp root: never refused */ }
  setProjectRoot(priorRoot);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("sweepDeadSessionRecords live-root refusal", () => {
  it("refuses live_root_under_test on the aliased root and keeps terminal and aged records", () => {
    expect(process.env.VITEST).toBeTruthy();
    seed("tok-terminal", { state: "shipped" });
    seed("tok-aged", { createdAt: AGED(), lastActivity: AGED() });
    h.aliasLiveRoot = root;
    const r = sweepDeadSessionRecords();
    expect(r).toMatchObject({ ran: false, refused: "live_root_under_test", removed: 0 });
    expect(typeof r.reason).toBe("string");
    expect(r.reason.length).toBeGreaterThan(0);
    expect(fs.existsSync(recordPath("tok-terminal"))).toBe(true);
    expect(fs.existsSync(recordPath("tok-aged"))).toBe(true);
    expect(fs.existsSync(auditPath())).toBe(false);
  });

  it("positive control: with the alias cleared the same root sweeps the terminal record", () => {
    seed("tok-terminal", { state: "shipped" });
    expect(sweepDeadSessionRecords()).toMatchObject({ ran: true, refused: null, removed: 1 });
    expect(fs.existsSync(recordPath("tok-terminal"))).toBe(false);
  });

  it("is evaluated before the hooks_bak, guard_state and open_offrail_session checks", () => {
    seed("tok-terminal", { state: "shipped" });
    fs.mkdirSync(path.join(root, ".routekit", "hooks.bak"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rks", "guardrails-state.json"), JSON.stringify({ active: false }));
    fs.writeFileSync(
      path.join(root, ".rks", "guardrails-off-sessions.jsonl"),
      JSON.stringify({ sessionId: "s-1", problemId: "story-A", startedAt: new Date().toISOString() }) + "\n",
    );
    h.aliasLiveRoot = root;
    expect(sweepDeadSessionRecords()).toMatchObject({ ran: false, refused: "live_root_under_test", removed: 0 });
    h.aliasLiveRoot = null;
    expect(sweepDeadSessionRecords()).toMatchObject({ ran: false, refused: "hooks_bak", removed: 0 });
    expect(fs.existsSync(recordPath("tok-terminal"))).toBe(true);
  });

  it("does not throw and records no live-state violation", () => {
    seed("tok-terminal", { state: "shipped" });
    h.aliasLiveRoot = root;
    const before = violations();
    let r;
    expect(() => { r = sweepDeadSessionRecords(); }).not.toThrow();
    expect(r.refused).toBe("live_root_under_test");
    expect(violations()).toBe(before);
  });

  it("refuses on the real live root with fs deletions and appends stubbed first", () => {
    const calls = [];
    vi.spyOn(fs, "unlinkSync").mockImplementation((p) => { calls.push(String(p)); });
    vi.spyOn(fs, "rmSync").mockImplementation((p) => { calls.push(String(p)); });
    vi.spyOn(fs, "appendFileSync").mockImplementation((p) => { calls.push(String(p)); });
    const sentinel = path.join(root, "stub-sentinel-never-created");
    fs.unlinkSync(sentinel);
    fs.rmSync(sentinel);
    fs.appendFileSync(sentinel, "x");
    expect(calls).toEqual([sentinel, sentinel, sentinel]); // stubs, not the real APIs, are live
    calls.length = 0;
    let r;
    setProjectRoot(SHELL_REPO_ROOT);
    try {
      r = sweepDeadSessionRecords();
    } finally {
      setProjectRoot(root); // back to the temp root before afterEach's resetToken
    }
    expect(r).toMatchObject({ ran: false, refused: "live_root_under_test", removed: 0 });
    const liveRks = path.join(SHELL_REPO_ROOT, ".rks") + path.sep;
    expect(calls.filter((p) => p.startsWith(liveRks))).toEqual([]);
  });
});

describe("handleGovernorInit reports the live-root sweep refusal", () => {
  it("returns sessionSweep refused live_root_under_test on the aliased root", () => {
    seed("tok-terminal", { state: "shipped" });
    h.aliasLiveRoot = root;
    const out = handleGovernorInit({ projectId: "p" });
    expect(out.ok).toBe(true);
    expect(out.sessionSweep).toMatchObject({ ran: false, refused: "live_root_under_test", removed: 0 });
    expect(fs.existsSync(recordPath("tok-terminal"))).toBe(true);
  });
});

describe("sweepDeadSessionRecords JSDoc", () => {
  it("names live_root_under_test in the comment block preceding the function", () => {
    const src = fs.readFileSync(new URL("../../packages/mcp-rks/src/shared/governor-token.mjs", import.meta.url), "utf8");
    const fnAt = src.indexOf("\nfunction sweepDeadSessionRecords(");
    expect(fnAt).toBeGreaterThan(0);
    const open = src.lastIndexOf("/**", fnAt);
    const close = src.indexOf("*/", open);
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeLessThan(fnAt);
    expect(src.slice(open, close)).toContain("live_root_under_test");
  });
});
