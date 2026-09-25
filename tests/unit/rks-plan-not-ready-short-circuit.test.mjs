/**
 * Tests for the rks_plan pre-spawn readiness gate
 * (backlog.fix.rks-plan.not-ready-short-circuit).
 *
 * The rks_plan handler used to spawn a detached worker unconditionally; a not-ready story made
 * that worker die with worker_crashed. The fix adds a PRE-SPAWN gate that reuses runPlanReadyTool
 * (the same predicate rks_plan_ready uses) and returns a structured `not_ready` result instead of
 * spawning. The handler lives inside the MCP dispatch (not independently exported and importing
 * server.mjs pulls heavy top-level side effects), so the gate WIRING is pinned by source
 * introspection — the same pattern used for the rks_init handler tests — while the PREDICATE it
 * reuses is covered behaviourally against runPlanReadyTool.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runPlanReadyTool } from '../../packages/mcp-rks/src/server/plan-ready.mjs';
import { resolveNotesDir } from '../../packages/mcp-rks/src/dendron.mjs';

// ─── Predicate behaviour: runPlanReadyTool is the single source of truth the gate reuses ──────

describe('runPlanReadyTool — not-ready predicate (reused by the pre-spawn gate)', () => {
  let projectRoot;
  let notesDir;
  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-plan-notready-'));
    notesDir = resolveNotesDir(projectRoot);
    fs.mkdirSync(notesDir, { recursive: true });
  });
  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('a draft-phase story is NOT ready (phase_status), so the gate would short-circuit', async () => {
    fs.writeFileSync(
      path.join(notesDir, 'backlog.feat.draft-x.md'),
      `---\nid: "backlog.feat.draft-x"\nphase: "draft"\n---\n\n## Problem\n\nx\n`,
    );
    const r = await runPlanReadyTool({ projectId: 'test', problemId: 'backlog.feat.draft-x', projectRoot });
    expect(r.ready).toBe(false);
    expect(r.issues.some((i) => i.check === 'phase_status')).toBe(true);
  });

  it('a missing story is NOT ready (story_exists) — a structured result, never a crash', async () => {
    const r = await runPlanReadyTool({ projectId: 'test', problemId: 'nope.does.not.exist', projectRoot });
    expect(r.ready).toBe(false);
    expect(r.issues.some((i) => i.check === 'story_exists')).toBe(true);
  });
});

// ─── Gate wiring: the rks_plan handler short-circuits BEFORE spawning the worker ──────

describe('rks_plan handler — pre-spawn not_ready gate [source witness]', () => {
  const serverSrc = fs.readFileSync(path.resolve('packages/mcp-rks/src/server.mjs'), 'utf8');
  // Isolate the rks_plan handler region (up to the next handler) so assertions don't match
  // the separate rks_plan_ready handler's runPlanReadyTool call.
  const planIdx = serverSrc.indexOf('if (tool === "rks_plan")');
  const planReviewIdx = serverSrc.indexOf('if (tool === "rks_plan_review")');
  const region = serverSrc.slice(planIdx, planReviewIdx);

  it('the handler region was located', () => {
    expect(planIdx).toBeGreaterThan(-1);
    expect(planReviewIdx).toBeGreaterThan(planIdx);
  });

  it('the gate reuses runPlanReadyTool and returns a structured not_ready result', () => {
    expect(region).toContain('runPlanReadyTool');
    expect(region).toContain('status: "not_ready"');
    expect(region).toContain('issues: readiness.issues'); // parity: issues come from the predicate
  });

  it('the gate is guarded on problemId and honours the RKS_SKIP_READINESS bypass', () => {
    expect(region).toMatch(/input\.problemId\s*&&/);
    expect(region).toContain('RKS_SKIP_READINESS');
  });

  it('the readiness check runs BEFORE the worker is spawned (no worker_crashed on not-ready)', () => {
    const gateIdx = region.indexOf('runPlanReadyTool');
    const spawnIdx = region.indexOf("spawn('node'");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(spawnIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(spawnIdx);
  });
});
