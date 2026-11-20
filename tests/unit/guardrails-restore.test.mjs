import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createSession, endSession, setGuardrailsDisabled, restoreGuardrails, detectOrphanedGuardrails, setProjectRoot, resetToken } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { makeTempDir } from "../helpers/tmp.mjs";
import { getTelemetryCollector } from "@routekit/telemetry";

describe("guardrails-restore-gap", () => {
  let projectRoot;

  beforeEach(() => {
    resetToken(); // Clear all sessions for test isolation
    projectRoot = makeTempDir("guardrails-restore-test");
    fs.mkdirSync(path.join(projectRoot, ".routekit"), { recursive: true });
    setProjectRoot(projectRoot);
  });

  describe("createSession guardrailsDisabled flag", () => {
    it("initializes session with guardrailsDisabled: false", () => {
      const { session } = createSession({ projectId: "test" });
      expect(session.guardrailsDisabled).toBe(false);
    });
  });

  describe("setGuardrailsDisabled", () => {
    it("sets guardrailsDisabled to true on the session", () => {
      const { token, session } = createSession({ projectId: "test" });
      setGuardrailsDisabled(token);
      expect(session.guardrailsDisabled).toBe(true);
    });
  });

  describe("endSession auto-restore", () => {
    it("calls restoreGuardrails when guardrailsDisabled is true", () => {
      // Create hooks.bak to simulate disabled guardrails
      const bakDir = path.join(projectRoot, ".routekit", "hooks.bak");
      fs.mkdirSync(bakDir, { recursive: true });
      fs.writeFileSync(path.join(bakDir, "test-hook.mjs"), "// hook");

      const { token } = createSession({ projectId: "test" });
      setGuardrailsDisabled(token);
      endSession(token);

      // hooks.bak should be gone, hooks should exist
      expect(fs.existsSync(bakDir)).toBe(false);
      expect(fs.existsSync(path.join(projectRoot, ".routekit", "hooks", "test-hook.mjs"))).toBe(true);
    });

    it("does NOT call restoreGuardrails when guardrailsDisabled is false", () => {
      const bakDir = path.join(projectRoot, ".routekit", "hooks.bak");
      fs.mkdirSync(bakDir, { recursive: true });
      fs.writeFileSync(path.join(bakDir, "test-hook.mjs"), "// hook");

      const { token } = createSession({ projectId: "test" });
      // Don't set guardrailsDisabled
      endSession(token);

      // hooks.bak should still exist
      expect(fs.existsSync(bakDir)).toBe(true);
    });
  });

  describe("restoreGuardrails", () => {
    it("moves hooks.bak back to hooks", () => {
      const bakDir = path.join(projectRoot, ".routekit", "hooks.bak");
      fs.mkdirSync(bakDir, { recursive: true });
      fs.writeFileSync(path.join(bakDir, "my-hook.mjs"), "// hook content");

      const result = restoreGuardrails();
      expect(result).toBe(true);
      expect(fs.existsSync(bakDir)).toBe(false);
      expect(fs.existsSync(path.join(projectRoot, ".routekit", "hooks", "my-hook.mjs"))).toBe(true);
    });

    it("returns false when hooks.bak does not exist", () => {
      const result = restoreGuardrails();
      expect(result).toBe(false);
    });
  });

  describe("detectOrphanedGuardrails", () => {
    it("restores hooks.bak when no active session exists", () => {
      const bakDir = path.join(projectRoot, ".routekit", "hooks.bak");
      fs.mkdirSync(bakDir, { recursive: true });
      fs.writeFileSync(path.join(bakDir, "orphaned-hook.mjs"), "// orphaned");

      const result = detectOrphanedGuardrails();
      expect(result).toBe(true);
      expect(fs.existsSync(bakDir)).toBe(false);
      expect(fs.existsSync(path.join(projectRoot, ".routekit", "hooks", "orphaned-hook.mjs"))).toBe(true);
    });

    it("does NOT restore when an active session exists", () => {
      const bakDir = path.join(projectRoot, ".routekit", "hooks.bak");
      fs.mkdirSync(bakDir, { recursive: true });
      fs.writeFileSync(path.join(bakDir, "hook.mjs"), "// hook");

      const { token } = createSession({ projectId: "test" });
      const result = detectOrphanedGuardrails();
      expect(result).toBe(false);
      expect(fs.existsSync(bakDir)).toBe(true);

      // Cleanup
      endSession(token);
    });

    it("is a no-op when hooks.bak does not exist", () => {
      const result = detectOrphanedGuardrails();
      expect(result).toBe(false);
    });
  });

  // backlog.fix.offrail-hooks-bak-orphan-restore-fail-closed
  describe("detectOrphanedGuardrails consults the off-rail record (AC1, AC2, AC9, AC3, AC10)", () => {
    const rks = () => path.join(projectRoot, ".rks");
    const bakDir = () => path.join(projectRoot, ".routekit", "hooks.bak");
    const hooksDir = () => path.join(projectRoot, ".routekit", "hooks");
    const logPath = () => path.join(rks(), "guardrails-off-sessions.jsonl");
    const OPEN = { sessionId: "s-open", startedAt: "2026-10-07T14:26:08.000Z", reason: "off-rail" };
    function seedBak() {
      fs.mkdirSync(bakDir(), { recursive: true });
      fs.writeFileSync(path.join(bakDir(), "kept-hook.mjs"), "// kept");
      fs.mkdirSync(path.join(hooksDir(), "system"), { recursive: true });
      fs.writeFileSync(path.join(hooksDir(), "system", "live.mjs"), "// live");
    }
    function guardState(content) {
      fs.mkdirSync(rks(), { recursive: true });
      fs.writeFileSync(path.join(rks(), "guardrails-state.json"), typeof content === "string" ? content : JSON.stringify(content));
    }
    function logLines(...entries) {
      fs.mkdirSync(rks(), { recursive: true });
      fs.writeFileSync(logPath(), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
    function listTree(root) {
      const out = [];
      const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          out.push(r);
          if (e.isDirectory()) walk(path.join(d, e.name), r);
        }
      };
      walk(root, "");
      return out.sort();
    }
    function expectKept(call) {
      const before = listTree(hooksDir());
      expect(call()).toBe(false);
      expect(fs.existsSync(path.join(bakDir(), "kept-hook.mjs"))).toBe(true);
      expect(listTree(hooksDir())).toEqual(before);
    }

    it("AC1 - guard state active=false with an open session keeps hooks.bak", () => {
      seedBak(); guardState({ active: false, sessionId: "s-open" }); logLines(OPEN);
      expectKept(() => detectOrphanedGuardrails());
    });
    it("AC1 - guard state active=false with no session log keeps hooks.bak", () => {
      seedBak(); guardState({ active: false, sessionId: "s-1" });
      expectKept(() => detectOrphanedGuardrails());
    });
    it("AC1 - guard state active=false whose only session is closed keeps hooks.bak", () => {
      seedBak(); guardState({ active: false, sessionId: "s-open" });
      logLines(OPEN, { sessionId: "s-open", endedAt: "2026-10-07T16:09:01.000Z" });
      expectKept(() => detectOrphanedGuardrails());
    });
    it("AC2 - an unparseable guard state keeps hooks.bak", () => {
      seedBak(); guardState("not-json");
      expectKept(() => detectOrphanedGuardrails());
    });
    it("AC9 - guard state absent with an open session keeps hooks.bak", () => {
      seedBak(); logLines(OPEN);
      expectKept(() => detectOrphanedGuardrails());
    });
    it("merge safety - a provenance-shaped line carrying the open session's sessionId does not close it", () => {
      seedBak();
      logLines(OPEN, { sessionId: "s-open", component: "test", timestamp: new Date().toISOString(), reason: "provenance" });
      expectKept(() => detectOrphanedGuardrails());
    });
    it("AC10 - the outcome option names what kept hooks.bak", () => {
      seedBak(); guardState({ active: false, sessionId: "s-1" });
      const byGuard = detectOrphanedGuardrails({ outcome: true });
      expect(byGuard.restored).toBe(false);
      expect(byGuard.reason).toMatch(/guard/i);
      guardState("not-json");
      const byUnparseable = detectOrphanedGuardrails({ outcome: true });
      expect(byUnparseable.restored).toBe(false);
      expect(byUnparseable.reason).toMatch(/guard/i);
      expect(byUnparseable.reason).toMatch(/guardrails-state\.json/);
      expect(byUnparseable.reason).toMatch(/pars/i);
      expect(byUnparseable.reason).toMatch(/rks_guardrails_on/);
      fs.rmSync(path.join(rks(), "guardrails-state.json"));
      logLines(OPEN);
      const bySession = detectOrphanedGuardrails({ outcome: true });
      expect(bySession.restored).toBe(false);
      expect(bySession.reason).toMatch(/session/i);
      expect(fs.existsSync(path.join(bakDir(), "kept-hook.mjs"))).toBe(true);
    });
    it("AC3/AC4/AC10 - a genuine orphan (no guard state, no open session) is restored and the outcome carries the logged provenance record", () => {
      seedBak();
      const outcome = detectOrphanedGuardrails({ outcome: true });
      expect(outcome.restored).toBe(true);
      expect(fs.existsSync(bakDir())).toBe(false);
      expect(fs.existsSync(path.join(hooksDir(), "kept-hook.mjs"))).toBe(true);
      const records = fs.readFileSync(logPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const last = records[records.length - 1];
      expect(outcome.provenance).toEqual(last);
      expect(typeof last.component).toBe("string");
      expect(last.component.length).toBeGreaterThan(0);
      expect(Object.prototype.hasOwnProperty.call(last, "sessionId")).toBe(true);
      expect(last.sessionId === null || typeof last.sessionId === "string").toBe(true);
      expect(new Date(last.timestamp).toISOString()).toBe(last.timestamp);
      expect(typeof last.reason).toBe("string");
      expect(last.reason.length).toBeGreaterThan(0);
    });
    it("AC3 - guard state active=true with no open session is restored (bare call returns true)", () => {
      seedBak(); guardState({ active: true });
      expect(detectOrphanedGuardrails()).toBe(true);
      expect(fs.existsSync(bakDir())).toBe(false);
      expect(fs.existsSync(path.join(hooksDir(), "kept-hook.mjs"))).toBe(true);
    });
    it("merge safety - a marked provenance record carrying the open session's sessionId does not close it (guard state absent)", () => {
      seedBak();
      logLines(OPEN, { kind: "hooks_bak_provenance", component: "test", sessionId: "s-open", pid: 1, timestamp: new Date().toISOString(), reason: "provenance" });
      expectKept(() => detectOrphanedGuardrails());
    });
    it("AC4 - the genuine-orphan restore emits a telemetry event carrying the same component, sessionId, timestamp and reason", () => {
      seedBak();
      const emit = vi.spyOn(getTelemetryCollector(), "emit");
      try {
        const outcome = detectOrphanedGuardrails({ outcome: true, projectId: "p" });
        expect(outcome.restored).toBe(true);
        const calls = emit.mock.calls.filter((c) => c[0] === "guardrails.hooks_bak_removed");
        expect(calls).toHaveLength(1);
        const payload = calls[0][2];
        expect(payload.component).toBe(outcome.provenance.component);
        expect(payload.sessionId).toBe(outcome.provenance.sessionId);
        expect(payload.timestamp).toBe(outcome.provenance.timestamp);
        expect(payload.reason).toBe(outcome.provenance.reason);
      } finally {
        emit.mockRestore();
      }
    });
    it("AC4 - restoreGuardrails creates .rks and appends a provenance record carrying the caller context", () => {
      seedBak();
      expect(fs.existsSync(rks())).toBe(false);
      expect(restoreGuardrails({ component: "endSession", sessionId: "tok-1" })).toBe(true);
      const records = fs.readFileSync(logPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(records).toHaveLength(1);
      expect(records[0].kind).toBe("hooks_bak_provenance");
      expect(records[0].component).toBe("endSession");
      expect(records[0].sessionId).toBe("tok-1");
      for (const k of ["problemId", "startedAt", "endedAt", "aborted"]) {
        expect(Object.prototype.hasOwnProperty.call(records[0], k)).toBe(false);
      }
    });
  });
});
