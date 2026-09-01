import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';


// Use importOriginal to preserve real spawnSync — only mock execSync to prevent gh repo create network calls
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execSync: vi.fn() };
});

vi.mock('../../packages/cli/src/project/bootstrap.mjs', () => ({
  attachProject: vi.fn(),
}));

vi.mock('../../packages/cli/src/project/index.js', () => ({
  upsertProject: vi.fn(),
  getProjectById: vi.fn(),
}));

const { runInitTool } = await import('../../packages/mcp-rks/src/server/init.mjs');
const { attachProject } = await import('../../packages/cli/src/project/bootstrap.mjs');
const { upsertProject, getProjectById } = await import('../../packages/cli/src/project/index.js');

afterEach(() => {
  vi.clearAllMocks();
});


function uniqueProjectName() {
  return `test-init-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanup(...paths) {
  for (const p of paths) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

describe('init-warnings', () => {
  it('returns an empty warnings array on successful init', async () => {
    const name = uniqueProjectName();
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'rks-init-test-'));

    try {
      attachProject.mockResolvedValue(undefined);
      getProjectById.mockReturnValue({ id: name }); // registry round-trips → verified success
      const result = await runInitTool({ projectName: name, parentDir: tmpDir });
      expect(result.success).toBe(true);
      expect(result.warnings).toEqual([]);
    } finally {
      cleanup(path.join(tmpDir, name), tmpDir);
    }
  });

  it('calls upsertProject as fallback when attachProject throws', async () => {
    const name = uniqueProjectName();
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'rks-init-test-'));

    try {
      attachProject.mockRejectedValue(new Error('bootstrap exploded'));
      getProjectById.mockReturnValue({ id: name }); // fallback registration round-trips
      const result = await runInitTool({ projectName: name, parentDir: tmpDir });
      expect(upsertProject).toHaveBeenCalledWith(
        expect.objectContaining({ id: name }),
        expect.any(String)
      );
      expect(result.success).toBe(true);
    } finally {
      cleanup(path.join(tmpDir, name), tmpDir);
    }
  });

  it('includes attachProject warning when fallback succeeds', async () => {
    const name = uniqueProjectName();
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'rks-init-test-'));

    try {
      attachProject.mockRejectedValue(new Error('bootstrap exploded'));
      upsertProject.mockReturnValue({ id: name });
      getProjectById.mockReturnValue({ id: name }); // fallback entry round-trips
      const result = await runInitTool({ projectName: name, parentDir: tmpDir });
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('attachProject failed'),
          expect.stringContaining('recovered via upsertProject'),
        ])
      );
      expect(result.registrationOk).toBe(true);
    } finally {
      cleanup(path.join(tmpDir, name), tmpDir);
    }
  });

  it('includes compound error when both attachProject and upsertProject fail', async () => {
    const name = uniqueProjectName();
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'rks-init-test-'));

    try {
      attachProject.mockRejectedValue(new Error('bootstrap exploded'));
      upsertProject.mockImplementation(() => { throw new Error('registry write failed'); });
      getProjectById.mockReturnValue(null); // nothing landed → no round-trip
      const result = await runInitTool({ projectName: name, parentDir: tmpDir });
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('attachProject failed'),
          expect.stringContaining('Registration fallback also failed'),
        ])
      );
      expect(result.registrationOk).toBe(false);
    } finally {
      cleanup(path.join(tmpDir, name), tmpDir);
    }
  });

  it('demotes success to false when registration does not round-trip (no false success)', async () => {
    // REGRESSION PIN (inverted): the pre-fix code returned success:true while registrationOk:false —
    // reporting false success. Under verified-outcome semantics, a registration that does not
    // round-trip via getProjectById must demote success to false with a real error.
    const name = uniqueProjectName();
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'rks-init-test-'));

    try {
      attachProject.mockRejectedValue(new Error('bootstrap exploded'));
      upsertProject.mockImplementation(() => { throw new Error('registry write failed'); });
      getProjectById.mockReturnValue(null); // registry readback finds nothing
      const result = await runInitTool({ projectName: name, parentDir: tmpDir });
      expect(result.success).toBe(false);
      expect(result.registrationOk).toBe(false);
      expect(result.error).toMatch(/did not round-trip|verification failed/i);
    } finally {
      cleanup(path.join(tmpDir, name), tmpDir);
    }
  });

  it('handles GitHub repo name conflict gracefully in source', () => {
    const initSrc = fs.readFileSync(
      path.resolve('packages/mcp-rks/src/server/init.mjs'),
      'utf8'
    );
    expect(initSrc).toContain("Name already exists");
    expect(initSrc).toContain("already exists — skipped");
  });

  it('pushes all console.warn paths to warnings array', () => {
    const initSrc = fs.readFileSync(
      path.resolve('packages/mcp-rks/src/server/init.mjs'),
      'utf8'
    );
    const warnMatches = initSrc.match(/console\.warn\(/g) || [];
    const pushMatches = initSrc.match(/warnings\.push\(/g) || [];
    expect(pushMatches.length).toBeGreaterThanOrEqual(warnMatches.length);
  });
});
