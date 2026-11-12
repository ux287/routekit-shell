// backlog.fix.test-suite-deletes-live-governor-sessions
// Every case that points governor-token at the live repository root first replaces fs.rmSync and
// fs.unlinkSync with recording no-ops, so even a broken guard deletes nothing on disk. Each case
// drains globalThis.__RKS_LIVE_STATE_VIOLATIONS__ itself so the tests/setup.mjs afterEach stays green.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const h = vi.hoisted(() => ({ skipResetLeases: false, aliasLiveRoot: null }));

// Spread mock: resetLeases passes through unless a case bypasses it to reach removeAllPersistedSessions.
vi.mock("../../packages/mcp-rks/src/shared/project-lease.mjs", async (io) => {
  const actual = await io();
  return { ...actual, resetLeases: (args) => (h.skipResetLeases ? undefined : actual.resetLeases(args)) };
});

// Passthrough mock (backlog.fix.live-root-guard-test-vitest-unset-targets-live-root): while
// h.aliasLiveRoot is null every call goes to the real guard. When a case sets it to a temp root,
// that root receives exactly the decision the real guard makes for SHELL_REPO_ROOT, so the
// VITEST-unset production path can be exercised on a temp root instead of the live one.
// governor-token.mjs and project-lease.mjs both import the guard, so both see this wrapper.
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

import { SHELL_REPO_ROOT, isLiveRootUnderTest, refuseLiveRootDeletion } from "../../packages/mcp-rks/src/shared/live-root-guard.mjs";
import * as tokNs from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { setProjectRoot, getSessionProjectRoot, resetToken } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { resetLeases, getLeaseDir } from "../../packages/mcp-rks/src/shared/project-lease.mjs";
import { checkLiveStateViolations } from "../_helpers/live-state-violations.mjs";

const SETUP_SRC = fs.readFileSync(new URL("../setup.mjs", import.meta.url), "utf8");
const END_TOOL_SRC = fs.readFileSync(new URL("./governor-end-tool.test.mjs", import.meta.url), "utf8");

let priorRoot;
let tmp;
let removed;

function drain() {
  const v = globalThis.__RKS_LIVE_STATE_VIOLATIONS__;
  return Array.isArray(v) ? v.splice(0) : [];
}

function guardDisk() {
  vi.spyOn(fs, "rmSync").mockImplementation((p) => { removed.push(String(p)); });
  vi.spyOn(fs, "unlinkSync").mockImplementation((p) => { removed.push(String(p)); });
  // Prove the recording stubs, not the real APIs, now answer fs.rmSync/fs.unlinkSync on the default
  // node:fs export. The sentinel calls through this test's own default import, so it covers only
  // calls made through that default export: it cannot detect governor-token.mjs or project-lease.mjs
  // switching to named or namespace imports. In the VITEST-set live-root cases the primary protection
  // is the guard throwing before any removal (governor-token.mjs removeAllPersistedSessions,
  // project-lease.mjs resetLeases); these stubs are defense in depth. No VITEST-unset case targets
  // the live root: withoutVitest() refuses it.
  expect(vi.isMockFunction(fs.rmSync)).toBe(true);
  expect(vi.isMockFunction(fs.unlinkSync)).toBe(true);
  const sentinel = path.join(tmp, "stub-sentinel-never-created");
  fs.rmSync(sentinel, { recursive: true, force: true });
  fs.unlinkSync(sentinel);
  expect(removed).toEqual([sentinel, sentinel]);
  removed.length = 0;
  liveBefore = liveDirState();
}

// Existence of the live directories and slot this guard protects; asserted unchanged after every
// live-root case, so a deletion that slipped past the stubs fails the test.
const LIVE_PATHS = () => [
  path.join(SHELL_REPO_ROOT, ".rks", "session", "governor"),
  path.join(SHELL_REPO_ROOT, ".rks", "session", "lease"),
  path.join(SHELL_REPO_ROOT, ".rks", "governor-session.json"),
];
let liveBefore = null;
function liveDirState() {
  return LIVE_PATHS().map((p) => fs.existsSync(p));
}
function expectLiveStateIntact() {
  expect(liveDirState()).toEqual(liveBefore);
}

const underRepoRks = (p) => path.resolve(p).startsWith(path.join(SHELL_REPO_ROOT, ".rks"));

function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// Structural backstop: with VITEST unset the guards stand down, so refuse before fn runs whenever the
// session project root is the live repository root. A null root is not live.
function withoutVitest(fn) {
  const root = getSessionProjectRoot();
  if (root && realOrResolved(root) === realOrResolved(SHELL_REPO_ROOT)) {
    throw new Error(
      `withoutVitest refused: the session project root ${root} is the live repository root ` +
      `${SHELL_REPO_ROOT}. Call setProjectRoot(<temp dir>) first.`,
    );
  }
  const saved = process.env.VITEST;
  delete process.env.VITEST;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.VITEST;
    else process.env.VITEST = saved;
  }
}

beforeEach(() => {
  priorRoot = getSessionProjectRoot();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-live-root-guard-"));
  removed = [];
  liveBefore = null;
  h.skipResetLeases = false;
  h.aliasLiveRoot = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  h.skipResetLeases = false;
  h.aliasLiveRoot = null;
  setProjectRoot(tmp);
  try { resetToken(); } catch { /* temp root: never refused */ }
  setProjectRoot(priorRoot);
  drain();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("isLiveRootUnderTest", () => {
  it("resolves SHELL_REPO_ROOT to the repository that contains live-root-guard.mjs", () => {
    expect(fs.existsSync(path.join(SHELL_REPO_ROOT, "packages", "mcp-rks", "src", "shared", "live-root-guard.mjs"))).toBe(true);
  });

  it("is true for the repository root while VITEST is set", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(isLiveRootUnderTest(SHELL_REPO_ROOT)).toBe(true);
  });

  it("is false for a temp root and for a null root", () => {
    expect(isLiveRootUnderTest(tmp)).toBe(false);
    expect(isLiveRootUnderTest(null)).toBe(false);
  });

  it("is false for the repository root when VITEST is unset", () => {
    setProjectRoot(tmp);
    expect(withoutVitest(() => isLiveRootUnderTest(SHELL_REPO_ROOT))).toBe(false);
  });

  it("compares realpaths, so a symlink to the repository root and a non-normalised path are both refused", () => {
    const link = path.join(tmp, "repo-link");
    fs.symlinkSync(SHELL_REPO_ROOT, link, "dir");
    expect(isLiveRootUnderTest(link)).toBe(true);
    expect(isLiveRootUnderTest(path.join(SHELL_REPO_ROOT, "packages", ".."))).toBe(true);
  });
});

describe("refuseLiveRootDeletion", () => {
  it("records the message in __RKS_LIVE_STATE_VIOLATIONS__ and throws it", () => {
    expect(() => refuseLiveRootDeletion("probe records", "/probe/target")).toThrow(/refused to delete probe records at \/probe\/target/);
    const v = drain();
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("setProjectRoot(<temp dir>)");
  });
});

describe("resetToken on the live repository root under VITEST", () => {
  it("deletes no lease record and throws naming the lease path and the temp-root remedy", () => {
    guardDisk();
    setProjectRoot(SHELL_REPO_ROOT);
    let err = null;
    try { resetToken(); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.message).toContain(getLeaseDir(SHELL_REPO_ROOT));
    expect(err.message).toContain("setProjectRoot(<temp dir>)");
    expect(removed.filter(underRepoRks)).toEqual([]);
    expectLiveStateIntact();
    drain();
  });

  it("deletes neither the session directory nor the legacy slot when the lease step is bypassed", () => {
    h.skipResetLeases = true;
    guardDisk();
    setProjectRoot(SHELL_REPO_ROOT);
    let err = null;
    try { resetToken(); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.message).toContain("governor session records");
    expect(err.message).toContain(path.join(SHELL_REPO_ROOT, ".rks", "session", "governor"));
    expect(removed.filter(underRepoRks)).toEqual([]);
    expectLiveStateIntact();
    drain();
  });

  it("records the violation even when the caller swallows the throw", () => {
    guardDisk();
    setProjectRoot(SHELL_REPO_ROOT);
    try { resetToken(); } catch { /* swallowed, as eight existing call sites do */ }
    const v = drain();
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]).toContain(getLeaseDir(SHELL_REPO_ROOT));
    expect(removed.filter(underRepoRks)).toEqual([]);
    expectLiveStateIntact();
  });

  it("resetLeases refuses the lease-dir removal for the live root", () => {
    guardDisk();
    expect(() => resetLeases({ projectRoot: SHELL_REPO_ROOT })).toThrow(/project lease records/);
    expect(removed.filter(underRepoRks)).toEqual([]);
    expectLiveStateIntact();
    drain();
  });
});

describe("resetToken on a temp root (behaviour unchanged)", () => {
  it("still removes that root's session directory, legacy slot and lease directory", () => {
    const sessionDir = path.join(tmp, ".rks", "session", "governor");
    const leaseDir = path.join(tmp, ".rks", "session", "lease");
    const legacy = path.join(tmp, ".rks", "governor-session.json");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(leaseDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "probe.json"), "{}");
    fs.writeFileSync(path.join(leaseDir, "probe.json"), "{}");
    fs.writeFileSync(legacy, "{}");
    setProjectRoot(tmp);
    expect(() => resetToken()).not.toThrow();
    expect(fs.existsSync(sessionDir)).toBe(false);
    expect(fs.existsSync(leaseDir)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(drain()).toEqual([]);
  });
});

// The production (VITEST-unset) path runs only on a temp root that the hoisted guard mock aliases to
// the live-root decision; the real fs performs the removals, and guardDisk() is deliberately unused.
function seedTempRoot() {
  const sessionDir = path.join(tmp, ".rks", "session", "governor");
  const leaseDir = path.join(tmp, ".rks", "session", "lease");
  const legacy = path.join(tmp, ".rks", "governor-session.json");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(leaseDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "probe.json"), "{}");
  fs.writeFileSync(path.join(leaseDir, "probe.json"), "{}");
  fs.writeFileSync(legacy, "{}");
  return { sessionDir, leaseDir, legacy };
}

describe("resetToken with VITEST unset on a temp root aliased to the live-root decision", () => {
  it("does not refuse and removes the aliased root's session dir, lease dir and legacy slot", () => {
    const { sessionDir, leaseDir, legacy } = seedTempRoot();
    h.aliasLiveRoot = tmp;
    setProjectRoot(tmp);
    withoutVitest(() => { expect(() => resetToken()).not.toThrow(); });
    expect(fs.existsSync(sessionDir)).toBe(false);
    expect(fs.existsSync(leaseDir)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(drain()).toEqual([]);
  });
});

describe("positive control: VITEST set, same alias", () => {
  it("resetToken refuses the aliased root at the lease step and removes nothing", () => {
    const { sessionDir, leaseDir } = seedTempRoot();
    h.aliasLiveRoot = tmp;
    setProjectRoot(tmp);
    expect(process.env.VITEST).toBeTruthy();
    let err = null;
    try { resetToken(); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.message).toContain(getLeaseDir(tmp));
    expect(fs.existsSync(leaseDir)).toBe(true);
    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(drain().length).toBeGreaterThanOrEqual(1);
  });

  it("with the lease step bypassed, resetToken refuses the session records and removes nothing", () => {
    const { sessionDir, legacy } = seedTempRoot();
    h.aliasLiveRoot = tmp;
    h.skipResetLeases = true;
    setProjectRoot(tmp);
    let err = null;
    try { resetToken(); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.message).toContain("governor session records");
    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(true);
    drain();
  });
});

describe("hoisted live-root-guard mock", () => {
  it("is a passthrough while h.aliasLiveRoot is null", () => {
    expect(h.aliasLiveRoot).toBeNull();
    expect(process.env.VITEST).toBeTruthy();
    expect(isLiveRootUnderTest(tmp)).toBe(false);
    expect(isLiveRootUnderTest(SHELL_REPO_ROOT)).toBe(true);
  });
});

describe("withoutVitest", () => {
  it("throws without invoking fn when the session project root is the live repository root", () => {
    const fn = vi.fn();
    setProjectRoot(SHELL_REPO_ROOT);
    try {
      expect(() => withoutVitest(fn)).toThrow(/live repository root/);
    } finally {
      setProjectRoot(tmp);
    }
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it("treats a null session project root as not live and invokes fn once", () => {
    const fn = vi.fn();
    setProjectRoot(null);
    try {
      expect(() => withoutVitest(fn)).not.toThrow();
    } finally {
      setProjectRoot(tmp);
    }
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("restores VITEST by deleting it when it was undefined before, and restores a prior value", () => {
    const original = process.env.VITEST;
    setProjectRoot(tmp);
    try {
      delete process.env.VITEST;
      withoutVitest(() => {});
      expect(process.env.VITEST).toBeUndefined();
      expect("VITEST" in process.env).toBe(false);
      process.env.VITEST = "probe-value";
      withoutVitest(() => { expect(process.env.VITEST).toBeUndefined(); });
      expect(process.env.VITEST).toBe("probe-value");
    } finally {
      if (original === undefined) delete process.env.VITEST;
      else process.env.VITEST = original;
    }
  });
});

describe("guardDisk comment", () => {
  it("no longer claims the sentinel detects a switch to named imports", () => {
    const self = fs.readFileSync(new URL(import.meta.url), "utf8");
    const needle = "the case fails here " + "instead of " + "deleting";
    expect(self).not.toContain(needle);
  });
});

describe("checkLiveStateViolations (tests/setup.mjs afterEach)", () => {
  it("throws listing every recorded message and empties the array", () => {
    globalThis.__RKS_LIVE_STATE_VIOLATIONS__ = ["first refusal", "second refusal"];
    expect(() => checkLiveStateViolations()).toThrow(/first refusal\nsecond refusal/);
    expect(globalThis.__RKS_LIVE_STATE_VIOLATIONS__).toEqual([]);
  });

  it("is a no-op when the array is empty or absent", () => {
    delete globalThis.__RKS_LIVE_STATE_VIOLATIONS__;
    expect(() => checkLiveStateViolations()).not.toThrow();
    globalThis.__RKS_LIVE_STATE_VIOLATIONS__ = [];
    expect(() => checkLiveStateViolations()).not.toThrow();
  });

  it("tests/setup.mjs registers it as an afterEach", () => {
    expect(SETUP_SRC).toContain("afterEach(checkLiveStateViolations);");
  });
});

describe("governor-token.mjs surface and callers", () => {
  it("gains no new export", () => {
    expect(Object.keys(tokNs)).not.toContain("isLiveRootUnderTest");
    expect(Object.keys(tokNs)).not.toContain("refuseLiveRootDeletion");
  });

  it("governor-end-tool.test.mjs sets its temp root before resetToken in beforeEach", () => {
    const setAt = END_TOOL_SRC.indexOf("setProjectRoot(root);");
    const resetAt = END_TOOL_SRC.indexOf("try { resetToken(); setToken(null); }");
    expect(setAt).toBeGreaterThan(-1);
    expect(resetAt).toBeGreaterThan(setAt);
  });
});
