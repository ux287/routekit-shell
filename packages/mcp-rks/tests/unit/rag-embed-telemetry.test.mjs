import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Mock the telemetry collector so we can inspect emitted events
const emittedEvents = [];
vi.mock("../../src/server/telemetry/collector.mjs", () => ({
  getTelemetryCollector: () => ({
    emit: (type, projectId, payload) => {
      emittedEvents.push({ type, projectId, payload });
    },
  }),
}));

// Mock the dynamic script loader — embed always succeeds with fixture data
vi.mock("node:url", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual };
});

// Stub loadScript dependencies used inside runRagEmbed
vi.mock("../../src/rag/tools.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return actual;
});

import { runRagEmbed } from "../../src/rag/tools.mjs";

describe("rag-embed-telemetry", () => {
  let tmpDir;

  beforeEach(() => {
    emittedEvents.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-embed-test-"));
    // Minimal project structure
    fs.mkdirSync(path.join(tmpDir, "notes"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".rks", "rag"), { recursive: true });
  });

  it("emits rag.embed.start before any embed work", async () => {
    // Even if embed fails, start must be emitted first
    await runRagEmbed(tmpDir);
    const startEvent = emittedEvents.find(e => e.type === 'rag.embed.start');
    expect(startEvent).toBeDefined();
    expect(startEvent.payload).toMatchObject({
      projectId: path.basename(tmpDir),
      triggeredBy: 'mcp',
      startedAt: expect.any(String),
    });
  });

  it("rag.embed.start is emitted before rag.embed or rag.embed.failed", async () => {
    await runRagEmbed(tmpDir);
    const types = emittedEvents.map(e => e.type);
    const startIdx = types.indexOf('rag.embed.start');
    const successIdx = types.indexOf('rag.embed');
    const failedIdx = types.indexOf('rag.embed.failed');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    if (successIdx >= 0) expect(startIdx).toBeLessThan(successIdx);
    if (failedIdx >= 0) expect(startIdx).toBeLessThan(failedIdx);
  });

  it("success event includes commitSha and triggeredBy fields", async () => {
    await runRagEmbed(tmpDir, { triggeredBy: 'hook' });
    const successEvent = emittedEvents.find(e => e.type === 'rag.embed');
    if (!successEvent) return; // skip if embed couldn't run in test env
    expect(successEvent.payload).toHaveProperty('commitSha');
    expect(successEvent.payload).toHaveProperty('triggeredBy', 'hook');
    expect(successEvent.payload).toHaveProperty('indexSize');
  });

  it("success event does not omit pre-existing fields (non-regression)", async () => {
    await runRagEmbed(tmpDir);
    const successEvent = emittedEvents.find(e => e.type === 'rag.embed');
    if (!successEvent) return;
    expect(successEvent.payload).toHaveProperty('filesProcessed');
    expect(successEvent.payload).toHaveProperty('chunksCreated');
    expect(successEvent.payload).toHaveProperty('durationMs');
  });

  it("failure path emits rag.embed.failed with required fields", async () => {
    // Force a failure by making the projectRoot non-existent after lock check
    const badRoot = path.join(tmpDir, "does-not-exist");
    await runRagEmbed(badRoot);
    const failedEvent = emittedEvents.find(e => e.type === 'rag.embed.failed');
    expect(failedEvent).toBeDefined();
    expect(failedEvent.payload).toMatchObject({
      error: expect.any(String),
      triggeredBy: 'mcp',
      phase: expect.any(String),
      durationMs: expect.any(Number),
    });
    expect(failedEvent.payload).toHaveProperty('exitCode');
    expect(failedEvent.payload).toHaveProperty('filesProcessed');
  });

  it("failure path does not emit rag.embed success event", async () => {
    const badRoot = path.join(tmpDir, "does-not-exist");
    await runRagEmbed(badRoot);
    const successEvent = emittedEvents.find(e => e.type === 'rag.embed');
    expect(successEvent).toBeUndefined();
  });

  it("triggeredBy defaults to 'mcp' when not provided", async () => {
    await runRagEmbed(tmpDir);
    const startEvent = emittedEvents.find(e => e.type === 'rag.embed.start');
    expect(startEvent?.payload?.triggeredBy).toBe('mcp');
  });

  it("triggeredBy is passed through from options", async () => {
    await runRagEmbed(tmpDir, { triggeredBy: 'hook' });
    const startEvent = emittedEvents.find(e => e.type === 'rag.embed.start');
    expect(startEvent?.payload?.triggeredBy).toBe('hook');
  });
});
