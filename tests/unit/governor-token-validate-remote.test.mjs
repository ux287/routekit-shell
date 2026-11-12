// backlog.feat.remote-surface-lane-isolation — Decision 3: validateRemoteToken accepts only a session
// whose record carries via === "remote", and checks via BEFORE validateToken so a non-remote persisted
// record is never rehydrated and the legacy _activeToken slot is never moved by a remote-lane check.
// Persistence is rooted in a temp dir per case (setProjectRoot), never this repo.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const gt = await import("../../packages/mcp-rks/src/shared/governor-token.mjs");
const { REMOTE_IDLE_MS } = await import("../../packages/mcp-rks/src/shared/project-lease.mjs");

const PROJECT_ID = "validate-remote-fixture";
let root;

function recordPath(token) {
  return path.join(root, ".rks", "session", "governor", `${token}.json`);
}

/** Write a persisted session record that is NOT in this process's memory. */
function writePersisted(via, { idle = false, dead = false } = {}) {
  const token = crypto.randomUUID();
  const now = Date.now();
  const last = dead ? now - 2 * 60 * 60 * 1000 : idle ? now - REMOTE_IDLE_MS - 60_000 : now;
  fs.mkdirSync(path.dirname(recordPath(token)), { recursive: true });
  fs.writeFileSync(recordPath(token), JSON.stringify({
    token, projectId: PROJECT_ID, flowType: "open", sessionType: "open", problemId: null,
    state: "init", guardrailsDisabled: false, createdAt: last, lastActivity: last,
    toolCallCounts: {}, consecutiveNoopCounts: {}, actor: null, via, client: null, runId: null,
  }, null, 2));
  return token;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "validate-remote-token-")));
  gt.setProjectRoot(root);
});

afterEach(() => {
  try { gt.resetToken(); } catch { /* best-effort */ }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("validateRemoteToken (backlog.feat.remote-surface-lane-isolation, Decision 3)", () => {
  it("is exported and refuses an empty or unknown token", () => {
    expect(typeof gt.validateRemoteToken).toBe("function");
    expect(gt.validateRemoteToken("")).toBe(false);
    expect(gt.validateRemoteToken(undefined)).toBe(false);
    expect(gt.validateRemoteToken("00000000-not-a-live-token")).toBe(false);
  });

  it("refuses a live in-memory session with via ide even though validateToken accepts it", () => {
    const { token } = gt.createSession({ projectId: PROJECT_ID, flowType: "open", via: "ide" });
    expect(gt.getToken()).toBe(token); // it also holds the legacy _activeToken slot
    expect(gt.validateRemoteToken(token)).toBe(false);
    expect(gt.validateToken(token)).toBe(true); // positive control: the session is live
  });

  it("refuses a live in-memory session with no via (unattributed)", () => {
    const { token } = gt.createSession({ projectId: PROJECT_ID, flowType: "open" });
    expect(gt.validateRemoteToken(token)).toBe(false);
    expect(gt.validateToken(token)).toBe(true);
  });

  it("accepts a live in-memory session with via remote", () => {
    const { token } = gt.createSession({ projectId: PROJECT_ID, flowType: "open", via: "remote" });
    expect(gt.validateRemoteToken(token)).toBe(true);
  });

  it("refuses an in-memory remote session idle past REMOTE_IDLE_MS", () => {
    const { token } = gt.createSession({ projectId: PROJECT_ID, flowType: "open", via: "remote" });
    gt.getSession(token).lastActivity = Date.now() - REMOTE_IDLE_MS - 60_000;
    expect(gt.validateRemoteToken(token)).toBe(false);
  });

  it("refuses a live persisted via-ide record without rehydrating it or moving _activeToken", () => {
    const { token: remoteToken } = gt.createSession({ projectId: PROJECT_ID, flowType: "open", via: "remote" });
    expect(gt.getToken()).toBe(remoteToken);
    const ideToken = writePersisted("ide");
    expect(gt.getSession(ideToken)).toBeNull();

    expect(gt.validateRemoteToken(ideToken)).toBe(false);
    expect(gt.getSession(ideToken)).toBeNull(); // not rehydrated into memory
    expect(gt.getToken()).toBe(remoteToken); // legacy slot untouched
    expect(fs.existsSync(recordPath(ideToken))).toBe(true); // a live record is not deleted

    // Positive control: the record IS live and validateToken (unchanged) rehydrates it.
    expect(gt.validateToken(ideToken)).toBe(true);
    expect(gt.getSession(ideToken)?.via).toBe("ide");
    expect(gt.getToken()).toBe(ideToken);
  });

  it("refuses a DEAD persisted via-ide record and leaves it on disk (no loadPersistedSession delete or lease release)", () => {
    const ideToken = writePersisted("ide", { dead: true });
    expect(gt.validateRemoteToken(ideToken)).toBe(false);
    expect(fs.existsSync(recordPath(ideToken))).toBe(true); // a remote-lane check never deletes another lane's record
    expect(gt.getSession(ideToken)).toBeNull();
    // Positive control: validateToken (unchanged) DOES judge it dead and delete it.
    expect(gt.validateToken(ideToken)).toBe(false);
    expect(fs.existsSync(recordPath(ideToken))).toBe(false);
  });

  it("accepts a live persisted via-remote record (restart recovery still works for remote sessions)", () => {
    const token = writePersisted("remote");
    expect(gt.validateRemoteToken(token)).toBe(true);
    expect(gt.getSession(token)?.via).toBe("remote");
  });

  it("refuses a persisted via-remote record idle past REMOTE_IDLE_MS", () => {
    const token = writePersisted("remote", { idle: true });
    expect(gt.validateRemoteToken(token)).toBe(false);
    expect(gt.getSession(token)).toBeNull();
  });
});
