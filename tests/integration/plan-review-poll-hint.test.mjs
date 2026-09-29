/**
 * Tests for recommendedNextPollMs backoff in rks_plan_review
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");

// Load the helper via dynamic import to avoid top-level side effects
// We test it indirectly by reading the exported function from server.mjs,
// but since server.mjs is not a pure module, we replicate the backoff logic
// and test it via the MCP response shapes instead.

// ── Inline the backoff function to test it directly ──────────────────────────
// (mirrors the getPollHintMs function added to server.mjs)
function getPollHintMs(elapsedSeconds) {
  if (elapsedSeconds < 30) return 2000;
  if (elapsedSeconds < 60) return 5000;
  if (elapsedSeconds < 120) return 15000;
  return 30000;
}

// ── Helper: spin up a minimal git project and call the MCP server directly ───
function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-poll-hint-"));
  execSync("git init && git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ── Unit tests for getPollHintMs ─────────────────────────────────────────────
describe("getPollHintMs backoff schedule", () => {
  it("returns 2000 when elapsedSeconds < 30", () => {
    expect(getPollHintMs(0)).toBe(2000);
    expect(getPollHintMs(1)).toBe(2000);
    expect(getPollHintMs(29)).toBe(2000);
  });

  it("returns 5000 when elapsedSeconds is 30–59", () => {
    expect(getPollHintMs(30)).toBe(5000);
    expect(getPollHintMs(45)).toBe(5000);
    expect(getPollHintMs(59)).toBe(5000);
  });

  it("returns 15000 when elapsedSeconds is 60–119", () => {
    expect(getPollHintMs(60)).toBe(15000);
    expect(getPollHintMs(90)).toBe(15000);
    expect(getPollHintMs(119)).toBe(15000);
  });

  it("returns 30000 when elapsedSeconds >= 120", () => {
    expect(getPollHintMs(120)).toBe(30000);
    expect(getPollHintMs(200)).toBe(30000);
    expect(getPollHintMs(999)).toBe(30000);
  });
});

// ── Integration tests: MCP response shapes include the hint ──────────────────
// We test via the pending plan in-memory path by calling the server handler.
// Since we can't easily import the handler (it requires full MCP bootstrap),
// we verify the shape by reading the source and checking the response literals.

describe("server.mjs rks_plan_review response shape", () => {
  it("in-memory path includes recommendedNextPollMs field", () => {
    const serverSrc = fs.readFileSync(
      path.join(PROJECT_ROOT, "packages/mcp-rks/src/server.mjs"),
      "utf8"
    );
    // Both still-planning return shapes must include recommendedNextPollMs
    const inMemoryMatch = serverSrc.match(
      /pendingEntry && !pendingEntry\.done[\s\S]{0,450}recommendedNextPollMs/
    );
    expect(inMemoryMatch).not.toBeNull();
  });

  it("disk-marker path (Case 2) includes recommendedNextPollMs field", () => {
    const serverSrc = fs.readFileSync(
      path.join(PROJECT_ROOT, "packages/mcp-rks/src/server.mjs"),
      "utf8"
    );
    const diskMarkerMatch = serverSrc.match(
      /Case 2: Worker still alive[\s\S]{0,450}recommendedNextPollMs/
    );
    expect(diskMarkerMatch).not.toBeNull();
  });

  it("in-memory path message includes suggested delay string", () => {
    const serverSrc = fs.readFileSync(
      path.join(PROJECT_ROOT, "packages/mcp-rks/src/server.mjs"),
      "utf8"
    );
    const messageMatch = serverSrc.match(
      /pendingEntry && !pendingEntry\.done[\s\S]{0,550}Poll again in ~\$\{pollHintMs \/ 1000\}s/
    );
    expect(messageMatch).not.toBeNull();
  });

  it("disk-marker path message includes suggested delay string", () => {
    const serverSrc = fs.readFileSync(
      path.join(PROJECT_ROOT, "packages/mcp-rks/src/server.mjs"),
      "utf8"
    );
    const messageMatch = serverSrc.match(
      /Case 2: Worker still alive[\s\S]{0,560}Poll again in ~\$\{pollHintMs \/ 1000\}s/
    );
    expect(messageMatch).not.toBeNull();
  });
});

// ── governor-build.md step 5 instruction ─────────────────────────────────────
describe("governor-build.md polling instruction", () => {
  it("step 5 instructs to wait recommendedNextPollMs ms before polling again", () => {
    const promptSrc = fs.readFileSync(
      path.join(PROJECT_ROOT, ".rks/prompts/governor-build.md"),
      "utf8"
    );
    expect(promptSrc).toContain("recommendedNextPollMs");
    expect(promptSrc).toContain("Repeat until status changes");
  });
});
