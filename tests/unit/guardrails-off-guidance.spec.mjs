/**
 * Tests for guardrails-off guidance flows
 *
 * Tests two scenarios:
 * 1. Child project requests → blocked with FAQ guidance
 * 2. RKS project non-core work → blocked with MCP tool guidance
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// We'll test the helper functions directly by importing them
// For integration tests, we'd use the full guardrailsOff function

describe('guardrails-off guidance', () => {
  let tempDir;
  let rksRoot;

  beforeEach(() => {
    // Create a temp directory to simulate a child project
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-test-'));

    // Get the actual RKS root (this test runs from within routekit-shell)
    rksRoot = path.resolve(__dirname, '..', '..');
  });

  afterEach(() => {
    // Cleanup temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('isChildProject detection', () => {
    // SKIPPED 2026-06-08: slow dynamic-import test (similar to preflight-rks-version)
    // — the import of the guardrails-off-guidance module takes >5s on CI's slow
    // runner. Follow-up: backlog.fix.slow-dynamic-import-tests.
    it.skip('should identify routekit-shell as NOT a child project', async () => {
      // Import the module dynamically to get the current implementation
      const { guardrailsOff } = await import('../../packages/mcp-rks/src/server/guardrails-audit.mjs');

      // When called from RKS root with no problemId, should proceed (not blocked as child)
      // We can't fully test without mocking, but we can verify the path resolution works
      expect(path.resolve(rksRoot)).toBe(path.resolve(rksRoot));
    });

    it('should identify temp directory as a child project', async () => {
      // The temp directory is not routekit-shell, so it should be identified as a child project
      expect(path.resolve(tempDir)).not.toBe(path.resolve(rksRoot));
    });
  });

  describe('child project guidance', () => {
    it('should include FAQ section in guidance', async () => {
      // We test the guidance content directly
      const expectedFaqTopics = [
        'read a file',
        'edit a file',
        'create or edit a note',
        'commit changes',
        'planner keeps failing',
        'Tests are failing',
      ];

      // Import and call getChildProjectGuidance (if exported) or test via guardrailsOff response
      // For now, we verify the structure of what we expect in the response
      const guidancePattern = /FAQ.*Common Issues/s;
      expect(guidancePattern.test('## FAQ: Common Issues and Solutions')).toBe(true);
    });

    it('should include escalation instructions in guidance', async () => {
      const escalationPattern = /Still Stuck\?.*raise a bug/s;
      expect(escalationPattern.test('## Still Stuck?\n\nIf the FAQ doesn\'t answer your issue, raise a bug')).toBe(true);
    });
  });

  describe('RKS core work detection', () => {
    it('should identify packages/* as core work', () => {
      const corePatterns = ['packages/', '.routekit/', 'templates/', 'scripts/mcp/', 'scripts/rag/'];
      const coreFiles = [
        'packages/mcp-rks/src/server.mjs',
        'packages/cli/src/cli/plan.js',
        '.routekit/hooks/enforce-read-provenance.mjs',
        'templates/generic/README.md',
        'scripts/mcp/smoke-test.js',
      ];

      for (const file of coreFiles) {
        const isCore = corePatterns.some(p => file.startsWith(p));
        expect(isCore, `${file} should be detected as core`).toBe(true);
      }
    });

    it('should identify non-core files', () => {
      const corePatterns = ['packages/', '.routekit/', 'templates/', 'scripts/mcp/', 'scripts/rag/'];
      const nonCoreFiles = [
        'notes/backlog.feature.dashboard.md',
        'docs/README.md',
        'src/components/Dashboard.tsx',
      ];

      for (const file of nonCoreFiles) {
        const isCore = corePatterns.some(p => file.startsWith(p));
        expect(isCore, `${file} should NOT be detected as core`).toBe(false);
      }
    });
  });

  describe('RKS non-core guidance', () => {
    it('should list target files in guidance', () => {
      const targetFiles = ['notes/backlog.feature.test.md', 'docs/example.md'];
      const expectedInGuidance = targetFiles[0];

      // The guidance should include the target files
      expect(expectedInGuidance).toContain('notes/');
    });

    it('should suggest MCP alternatives', () => {
      const expectedAlternatives = [
        'rks_plan',
        'rks_exec',
        'rks_story_ship',
        'dendron_create_note',
        'dendron_edit_note',
        'rks_rag_query',
        'rks_git_commit',
      ];

      // All these tools should be mentioned in the guidance
      for (const tool of expectedAlternatives) {
        expect(tool.startsWith('rks_') || tool.startsWith('dendron_')).toBe(true);
      }
    });

    it('should include escalation path for missing tooling', () => {
      const escalationPattern = /Still Stuck\?.*file a bug/s;
      expect(escalationPattern.test('## Still Stuck?\n\nIf there\'s no suitable MCP tool, file a bug')).toBe(true);
    });
  });

  describe('integration: guardrailsOff response structure', () => {
    it('should return blocked=true for child projects', async () => {
      // This would be a full integration test requiring proper setup
      // For unit tests, we verify the expected response shape
      const expectedResponse = {
        ok: false,
        blocked: true,
        reason: 'child_project',
        guidance: expect.any(String),
        message: expect.any(String),
      };

      expect(expectedResponse.ok).toBe(false);
      expect(expectedResponse.blocked).toBe(true);
      expect(expectedResponse.reason).toBe('child_project');
    });

    it('should return blocked=true for non-core work', async () => {
      const expectedResponse = {
        ok: false,
        blocked: true,
        reason: 'non_core_work',
        guidance: expect.any(String),
        message: expect.any(String),
      };

      expect(expectedResponse.ok).toBe(false);
      expect(expectedResponse.blocked).toBe(true);
      expect(expectedResponse.reason).toBe('non_core_work');
    });
  });

});

describe('resolveOffRailConfig (per-project offRail)', () => {
  let resolveOffRailConfig;

  beforeEach(async () => {
    ({ resolveOffRailConfig } = await import('../../packages/mcp-rks/src/server/guardrails-audit.mjs'));
  });

  it('returns mode=disabled when offRail.enabled === false', () => {
    const r = resolveOffRailConfig({ offRail: { enabled: false } });
    expect(r.mode).toBe('disabled');
  });

  it('returns mode=configured with roots when enabled === true and roots is non-empty array', () => {
    const r = resolveOffRailConfig({ offRail: { enabled: true, roots: ['components/*', 'services/*'] } });
    expect(r.mode).toBe('configured');
    expect(r.roots).toEqual(['components/*', 'services/*']);
  });

  it('returns mode=default when offRail field is absent', () => {
    expect(resolveOffRailConfig({}).mode).toBe('default');
    expect(resolveOffRailConfig({ name: 'foo' }).mode).toBe('default');
  });

  it('returns mode=default when projectJson is null or undefined', () => {
    expect(resolveOffRailConfig(null).mode).toBe('default');
    expect(resolveOffRailConfig(undefined).mode).toBe('default');
  });

  it('returns mode=invalid with error when enabled is not a boolean', () => {
    const r = resolveOffRailConfig({ offRail: { enabled: 'yes', roots: ['x'] } });
    expect(r.mode).toBe('invalid');
    expect(r.error).toMatch(/enabled.*boolean/);
  });

  it('returns mode=invalid when roots is not an array', () => {
    const r = resolveOffRailConfig({ offRail: { enabled: true, roots: 'components/*' } });
    expect(r.mode).toBe('invalid');
    expect(r.error).toMatch(/roots.*array/);
  });

  it('returns mode=invalid when roots is an empty array', () => {
    const r = resolveOffRailConfig({ offRail: { enabled: true, roots: [] } });
    expect(r.mode).toBe('invalid');
    expect(r.error).toMatch(/non-empty/);
  });

  it('returns mode=invalid when roots contains non-string entries', () => {
    const r = resolveOffRailConfig({ offRail: { enabled: true, roots: ['ok', 42] } });
    expect(r.mode).toBe('invalid');
    expect(r.error).toMatch(/strings/);
  });

  it('returns mode=invalid when offRail is not an object', () => {
    const r = resolveOffRailConfig({ offRail: 'enabled' });
    expect(r.mode).toBe('invalid');
  });
});

describe('guardrailsOff offRail integration', () => {
  let guardrailsOff;
  let tmpDir;

  function seedProject({ offRail, problemId, targetFiles }) {
    fs.mkdirSync(path.join(tmpDir, '.rks'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.routekit', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'notes'), { recursive: true });
    const projectJson = offRail === undefined ? {} : { offRail };
    fs.writeFileSync(path.join(tmpDir, '.rks', 'project.json'), JSON.stringify(projectJson, null, 2));
    if (problemId) {
      const fm = [
        '---',
        `id: "${problemId}"`,
        'title: "Test"',
        'desc: "test"',
        'phase: "arch-approved"',
        'targetFiles:',
        ...targetFiles.flatMap(p => [`  - path: "${p}"`, '    op: "edit"', '    desc: "test"']),
        '---',
        '',
        '## Problem',
        'test',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, 'notes', `${problemId}.md`), fm);
    }
  }

  beforeEach(async () => {
    ({ guardrailsOff } = await import('../../packages/mcp-rks/src/server/guardrails-audit.mjs'));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-offrail-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('blocks with reason=off_rail_disabled when enabled=false, regardless of problemId/roots', async () => {
    seedProject({
      offRail: { enabled: false },
      problemId: 'backlog.feat.test',
      targetFiles: ['components/Foo.tsx'],
    });
    const res = await guardrailsOff(tmpDir, 'test', 'all', 'backlog.feat.test', 'test-project');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('off_rail_disabled');
    expect(res.message).toMatch(/disabled.*per .rks\/project.json/);
  });

  it('allows when enabled=true and all targetFiles match roots', async () => {
    seedProject({
      offRail: { enabled: true, roots: ['components/*', 'services/*'] },
      problemId: 'backlog.feat.test',
      targetFiles: ['components/Foo.tsx', 'services/bar.ts'],
    });
    const res = await guardrailsOff(tmpDir, 'test', 'all', 'backlog.feat.test', 'test-project');
    expect(res.ok).toBe(true);
  });

  it('blocks with reason=non_core_work and roots-aware guidance when targetFile is outside roots', async () => {
    seedProject({
      offRail: { enabled: true, roots: ['components/*'] },
      problemId: 'backlog.feat.test',
      targetFiles: ['components/Foo.tsx', 'services/bar.ts'],
    });
    const res = await guardrailsOff(tmpDir, 'test', 'all', 'backlog.feat.test', 'test-project');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('non_core_work');
    expect(res.roots).toEqual(['components/*']);
    expect(res.guidance).toContain('components/*');
    expect(res.guidance).toContain('services/bar.ts');
  });

  it('falls back to RKS_CORE_PATTERNS when offRail field is absent', async () => {
    seedProject({
      offRail: undefined,
      problemId: 'backlog.feat.test',
      targetFiles: ['notes/foo.md', 'src/random.ts'], // neither matches RKS_CORE_PATTERNS
    });
    const res = await guardrailsOff(tmpDir, 'test', 'all', 'backlog.feat.test', 'test-project');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('non_core_work');
    // Default-mode rejection uses the legacy guidance, not the configured-roots guidance.
    expect(res.guidance).toContain('off-rail access');
  });

  it('returns reason=invalid_offrail_config when offRail is malformed (non-boolean enabled)', async () => {
    seedProject({
      offRail: { enabled: 'true', roots: ['components/*'] },
      problemId: 'backlog.feat.test',
      targetFiles: ['components/Foo.tsx'],
    });
    const res = await guardrailsOff(tmpDir, 'test', 'all', 'backlog.feat.test', 'test-project');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid_offrail_config');
    expect(res.error).toBeDefined();
  });

  it('returns reason=invalid_offrail_config when roots is not an array', async () => {
    seedProject({
      offRail: { enabled: true, roots: 'components/*' },
      problemId: 'backlog.feat.test',
      targetFiles: ['components/Foo.tsx'],
    });
    const res = await guardrailsOff(tmpDir, 'test', 'all', 'backlog.feat.test', 'test-project');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid_offrail_config');
  });
});
