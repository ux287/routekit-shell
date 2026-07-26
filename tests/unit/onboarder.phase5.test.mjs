/**
 * Tests for rks_onboarder Phase 5 — rks_interview deprecation forwarding.
 * (backlog.feat.rks-onboarder-impl-phase5)
 *
 * These tests verify the forwarding behavior: that the rks_interview handler
 * now delegates to runOnboarder({ stage: 'welcome' }) and prepends the
 * deprecation warning to the display field.
 *
 * The actual forwarding runs in server.mjs. Here we verify:
 * 1. runOnboarder({ stage: 'welcome' }) returns Stage 1 content (the forwarding target).
 * 2. The deprecation warning string matches what server.mjs prepends.
 * 3. interview.mjs still exports a working runInterview (unchanged — legacy tests cover this).
 * 4. interview.mjs contains the TODO(v0.21.0) comment.
 * 5. The ListTools description in server.mjs contains [DEPRECATED, /rks-onboard, v0.21.0.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../packages/mcp-rks/src/server/telemetry.mjs", () => ({
  recordTelemetry: vi.fn(),
}));

import { runOnboarder } from "../../packages/mcp-rks/src/server/onboarder.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_MJS = path.resolve(__dirname, "../../packages/mcp-rks/src/server.mjs");
const INTERVIEW_MJS = path.resolve(__dirname, "../../packages/mcp-rks/src/server/interview.mjs");

const DEPRECATION_WARNING =
  "⚠️ `rks_interview` is deprecated and will be removed in v0.21.0. Use `/rks-onboard` instead. Forwarding you to the new onboarding experience now.";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboarder-p5-test-"));
  fs.mkdirSync(path.join(tmpDir, ".rks"), { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Forwarding target produces Stage 1 content ───────────────────────────────

describe("rks_interview forwarding target (runOnboarder stage:welcome)", () => {
  it("returns display containing 'routekit-shell' — confirmed Stage 1 content", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "welcome" });
    expect(result.display).toContain("routekit-shell");
  });

  it("returns stage === 'welcome'", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "welcome" });
    expect(result.stage).toBe("welcome");
  });

  it("returns ok:true", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "welcome" });
    expect(result.ok).toBe(true);
  });
});

// ─── Deprecation warning format ───────────────────────────────────────────────

describe("deprecation warning string", () => {
  it("warning contains 'rks_interview' and 'is deprecated'", () => {
    expect(DEPRECATION_WARNING).toContain("rks_interview");
    expect(DEPRECATION_WARNING).toContain("is deprecated");
  });

  it("warning references v0.21.0", () => {
    expect(DEPRECATION_WARNING).toContain("v0.21.0");
  });

  it("warning references /rks-onboard", () => {
    expect(DEPRECATION_WARNING).toContain("/rks-onboard");
  });

  it("forwarding produces display beginning with warning prepended to Stage 1 content", async () => {
    const onboardResult = await runOnboarder({ projectRoot: tmpDir, stage: "welcome" });
    const combinedDisplay = DEPRECATION_WARNING + "\n\n" + (onboardResult.display || "");
    expect(combinedDisplay).toContain("rks_interview");
    expect(combinedDisplay).toContain("is deprecated");
    expect(combinedDisplay).toContain("routekit-shell");
  });
});

// ─── server.mjs source checks ────────────────────────────────────────────────

describe("server.mjs ListTools description contains deprecation notice", () => {
  let serverSrc;
  beforeEach(() => {
    serverSrc = fs.readFileSync(SERVER_MJS, "utf8");
  });

  it("contains [DEPRECATED in rks_interview description", () => {
    expect(serverSrc).toContain("[DEPRECATED");
  });

  it("contains reference to /rks-onboard in rks_interview description", () => {
    // Check within the rks_interview block
    const interviewBlockStart = serverSrc.indexOf('"rks_interview"');
    const interviewBlockEnd = serverSrc.indexOf('name: "rks_guardrails_off"', interviewBlockStart);
    const interviewBlock = serverSrc.slice(interviewBlockStart, interviewBlockEnd);
    expect(interviewBlock).toContain("/rks-onboard");
  });

  it("contains v0.21.0 in rks_interview description", () => {
    const interviewBlockStart = serverSrc.indexOf('"rks_interview"');
    const interviewBlockEnd = serverSrc.indexOf('name: "rks_guardrails_off"', interviewBlockStart);
    const interviewBlock = serverSrc.slice(interviewBlockStart, interviewBlockEnd);
    expect(interviewBlock).toContain("v0.21.0");
  });

  it("rks_interview dispatch calls runOnboarder (not runInterview) with stage: 'welcome'", () => {
    const dispatchStart = serverSrc.indexOf('if (tool === "rks_interview")');
    const dispatchEnd = serverSrc.indexOf('if (tool === "rks_guardrails_off")', dispatchStart);
    const dispatchBlock = serverSrc.slice(dispatchStart, dispatchEnd);
    expect(dispatchBlock).toContain("runOnboarder");
    expect(dispatchBlock).toContain("stage: \"welcome\"");
    expect(dispatchBlock).not.toContain("runInterview(");
  });
});

// ─── interview.mjs source checks ─────────────────────────────────────────────

describe("interview.mjs TODO(v0.21.0) comment", () => {
  it("contains TODO(v0.21.0): remove rks_interview comment", () => {
    const src = fs.readFileSync(INTERVIEW_MJS, "utf8");
    expect(src).toContain("TODO(v0.21.0): remove rks_interview");
  });
});
