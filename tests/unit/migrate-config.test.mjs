/**
 * Tests for migrateConfig() in packages/cli/src/project/migrate-config.mjs.
 *
 * Verifies: baseline=1 semantics, registry-walk behavior, idempotency,
 * canonical-I/O contract (loadProjectMetadata + saveProjectMetadata, never
 * raw fs), and error paths.
 *
 * Uses vi.mock for both the metadata module and the migrations registry so
 * each test can declare its own scenario without polluting siblings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock the migrations registry — each test replaces `migrations` as needed.
let mockMigrations = [];
vi.mock('../../packages/cli/src/project/migrations/index.mjs', () => ({
  get migrations() { return mockMigrations; },
}));

const META_LOAD = vi.fn();
const META_SAVE = vi.fn((projectRoot, meta) => ({
  ...meta,
  updatedAt: Date.now(),
}));

vi.mock('../../packages/cli/src/project/metadata.js', () => ({
  loadProjectMetadata: (...args) => META_LOAD(...args),
  saveProjectMetadata: (...args) => META_SAVE(...args),
  validateProjectMetadata: vi.fn(),
}));

const { migrateConfig } = await import('../../packages/cli/src/project/migrate-config.mjs');

function makeMeta(overrides = {}) {
  return {
    id: 'child-x',
    root: '/tmp/child-x',
    schemaVersion: 1,
    notes: { vaultPath: 'notes', dendronConfig: 'dendron.yml' },
    rag: { indexPath: 'routekit/rag/index.lance', enabled: true },
    kg: { configPath: 'routekit/kg.yaml' },
    llm: { providerEnvVar: 'ROUTEKIT_LLM_PROVIDER' },
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

describe('migrateConfig — baseline & registry walk', () => {
  beforeEach(() => {
    META_LOAD.mockReset();
    META_SAVE.mockReset();
    META_SAVE.mockImplementation((projectRoot, meta) => ({ ...meta, updatedAt: Date.now() }));
    mockMigrations = [];
  });

  it('absent schemaVersion is treated as 1 (baseline)', () => {
    const meta = makeMeta();
    delete meta.schemaVersion;
    META_LOAD.mockReturnValue(meta);

    const result = migrateConfig({ projectRoot: '/tmp/child-x' });
    expect(result.fromVersion).toBe(1);
  });

  it('explicit schemaVersion: 1 baseline', () => {
    META_LOAD.mockReturnValue(makeMeta({ schemaVersion: 1 }));
    const result = migrateConfig({ projectRoot: '/tmp/child-x' });
    expect(result.fromVersion).toBe(1);
  });

  it('empty registry → no-op summary, saveProjectMetadata never called', () => {
    META_LOAD.mockReturnValue(makeMeta());
    const result = migrateConfig({ projectRoot: '/tmp/child-x' });
    expect(result.noOp).toBe(true);
    expect(result.applied).toEqual([]);
    expect(META_SAVE).not.toHaveBeenCalled();
  });

  it('already-at-latest → no-op, no save', () => {
    mockMigrations = [
      { fromVersion: 1, toVersion: 2, apply: (m) => ({ ...m, newField: 'x' }) },
    ];
    // Project already at v2.
    META_LOAD.mockReturnValue(makeMeta({ schemaVersion: 2 }));
    const result = migrateConfig({ projectRoot: '/tmp/child-x' });
    expect(result.noOp).toBe(true);
    expect(META_SAVE).not.toHaveBeenCalled();
  });

  it('walks registry in order, applies each migration sequentially', () => {
    const apply1 = vi.fn((m) => ({ ...m, fieldA: 'added' }));
    const apply2 = vi.fn((m) => ({ ...m, fieldB: 'added' }));
    mockMigrations = [
      { fromVersion: 1, toVersion: 2, apply: apply1 },
      { fromVersion: 2, toVersion: 3, apply: apply2 },
    ];
    META_LOAD.mockReturnValue(makeMeta({ schemaVersion: 1 }));

    const result = migrateConfig({ projectRoot: '/tmp/child-x' });
    expect(apply1).toHaveBeenCalledTimes(1);
    expect(apply2).toHaveBeenCalledTimes(1);
    expect(result.applied).toEqual(['1→2', '2→3']);
    expect(result.currentVersion).toBe(3);
  });

  it('saves only once after walk; final saved object has currentVersion as schemaVersion', () => {
    mockMigrations = [
      { fromVersion: 1, toVersion: 2, apply: (m) => ({ ...m, fieldA: 'x' }) },
    ];
    META_LOAD.mockReturnValue(makeMeta({ schemaVersion: 1 }));
    migrateConfig({ projectRoot: '/tmp/child-x' });
    expect(META_SAVE).toHaveBeenCalledTimes(1);
    const savedArgs = META_SAVE.mock.calls[0][1];
    expect(savedArgs.schemaVersion).toBe(2);
    expect(savedArgs.fieldA).toBe('x');
  });
});

describe('migrateConfig — I/O contract', () => {
  beforeEach(() => {
    META_LOAD.mockReset();
    META_SAVE.mockReset();
    META_SAVE.mockImplementation((projectRoot, meta) => ({ ...meta, updatedAt: Date.now() }));
    mockMigrations = [];
  });

  it('reads via loadProjectMetadata (never raw fs.readFileSync)', () => {
    mockMigrations = [];
    META_LOAD.mockReturnValue(makeMeta());
    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      migrateConfig({ projectRoot: '/tmp/child-x' });
      expect(META_LOAD).toHaveBeenCalledWith('/tmp/child-x');
      // No direct fs.readFileSync calls for project.json — all I/O goes through the metadata module.
      const projectJsonReads = readSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('project.json'));
      expect(projectJsonReads.length).toBe(0);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('writes via saveProjectMetadata (never raw fs.writeFileSync)', () => {
    mockMigrations = [
      { fromVersion: 1, toVersion: 2, apply: (m) => ({ ...m, x: 1 }) },
    ];
    META_LOAD.mockReturnValue(makeMeta({ schemaVersion: 1 }));
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    try {
      migrateConfig({ projectRoot: '/tmp/child-x' });
      expect(META_SAVE).toHaveBeenCalledTimes(1);
      // No raw writes of project.json.
      const projectJsonWrites = writeSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('project.json'));
      expect(projectJsonWrites.length).toBe(0);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('saveProjectMetadata receives a fresh shape; updatedAt is stamped by metadata module', () => {
    // The mock save returns { ...meta, updatedAt: Date.now() } so we verify
    // the call happens; the actual stamping is metadata.js's responsibility.
    mockMigrations = [{ fromVersion: 1, toVersion: 2, apply: (m) => ({ ...m, q: 1 }) }];
    META_LOAD.mockReturnValue(makeMeta({ schemaVersion: 1 }));
    migrateConfig({ projectRoot: '/tmp/child-x' });
    expect(META_SAVE).toHaveBeenCalled();
  });
});

describe('migrateConfig — idempotency & error paths', () => {
  beforeEach(() => {
    META_LOAD.mockReset();
    META_SAVE.mockReset();
    META_SAVE.mockImplementation((projectRoot, meta) => ({ ...meta, updatedAt: Date.now() }));
    mockMigrations = [];
  });

  it('idempotent: second invocation after first run is a no-op (load returns post-migration version)', () => {
    mockMigrations = [{ fromVersion: 1, toVersion: 2, apply: (m) => ({ ...m, applied: true }) }];
    // First call returns v1, gets migrated to v2.
    META_LOAD.mockReturnValueOnce(makeMeta({ schemaVersion: 1 }));
    const first = migrateConfig({ projectRoot: '/tmp/child-x' });
    expect(first.noOp).toBe(false);

    // Second call: meta is now at v2.
    META_LOAD.mockReturnValueOnce(makeMeta({ schemaVersion: 2 }));
    const second = migrateConfig({ projectRoot: '/tmp/child-x' });
    expect(second.noOp).toBe(true);
    // Only ONE saveProjectMetadata call across both invocations.
    expect(META_SAVE).toHaveBeenCalledTimes(1);
  });

  it('throws when projectRoot is missing', () => {
    expect(() => migrateConfig({})).toThrow(/projectRoot/);
  });

  it('throws a clear error when project metadata is absent (does NOT create one)', () => {
    META_LOAD.mockReturnValue(null);
    expect(() => migrateConfig({ projectRoot: '/tmp/child-x' })).toThrow(/No project metadata|attach/i);
    expect(META_SAVE).not.toHaveBeenCalled();
  });

  it('surfaces malformed-JSON errors from loadProjectMetadata (does NOT overwrite the file)', () => {
    META_LOAD.mockImplementation(() => { throw new Error('Failed to parse project metadata'); });
    expect(() => migrateConfig({ projectRoot: '/tmp/child-x' })).toThrow(/parse/i);
    expect(META_SAVE).not.toHaveBeenCalled();
  });
});
