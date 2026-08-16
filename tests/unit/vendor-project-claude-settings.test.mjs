/**
 * backlog.fix.child-hook-registration-repair-and-audit — Part 5: close the rogue writer.
 *
 * scripts/vendor-project.mjs carried a SECOND, non-authoritative writer of
 * .claude/settings.json: it copied templates/generic/.claude/settings.json.template — a
 * stale artifact with pre-tier FLAT hook paths and a fraction of the current matcher set —
 * and it ABSTAINED when the file already existed, printing manual-registration advice and
 * writing nothing. That is the same abstain-on-exists bug this story fixes in
 * ensureClaudeSettings, in a script that is still in the tree and can undo the fix.
 *
 * vendor-project.mjs:118 was the ONLY code reference to that template anywhere in the
 * repo, so this file is the entire remaining exposure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupClaudeSettings } from '../../scripts/vendor-project.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VENDOR_SRC = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'vendor-project.mjs'), 'utf8');
const manifest = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, '.routekit', 'hooks-manifest.json'), 'utf8'),
);

function allCommands(settings) {
  const out = [];
  for (const ev of Object.keys(settings.hooks || {})) {
    for (const g of settings.hooks[ev] || []) {
      for (const h of g.hooks || []) out.push(h.command);
    }
  }
  return out;
}

let projectRoot;
beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-vendor-'));
});
afterEach(() => {
  if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('vendor-project setupClaudeSettings — source structure', () => {
  it('no longer references the stale settings.json template', () => {
    expect(VENDOR_SRC).not.toContain('settings.json.template');
  });

  it('delegates to the shared writer in packages/cli/src/project/bootstrap.mjs', () => {
    expect(VENDOR_SRC).toContain('ensureHookRegistration');
    expect(VENDOR_SRC).toMatch(/from\s+["']\.\.\/packages\/cli\/src\/project\/bootstrap\.mjs["']/);
  });

  it('the abstain-on-exists branch and its manual-registration advice text are gone', () => {
    expect(VENDOR_SRC).not.toContain('Add hooks config manually if needed');
    // The advice printed a FLAT hook path — the dead-path shape this story exists to stop.
    expect(VENDOR_SRC).not.toContain('.routekit/hooks/enforce-orchestration.mjs');
  });

  it('guards the top-level main() call behind an entrypoint check', () => {
    expect(VENDOR_SRC).toMatch(/import\.meta\.url|process\.argv\[1\]/);
    expect(VENDOR_SRC).not.toMatch(/^main\(\)\.catch/m);
  });
});

describe('vendor-project setupClaudeSettings — behavior', () => {
  it('importing the module has no side effects (no vendor workflow ran)', () => {
    // If the import had executed main(), it would have exited on the missing projectId
    // argument long before this assertion — reaching here at all is the proof.
    expect(typeof setupClaudeSettings).toBe('function');
    expect(fs.existsSync(path.join(projectRoot, 'tools', 'routekit-shell'))).toBe(false);
  });

  it('does NOT abstain over an existing settings.json — mcpServers preserved, hooks written', async () => {
    const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ mcpServers: { rks: { command: 'node', args: ['x'] } } }, null, 2),
    );

    await setupClaudeSettings(projectRoot);

    const out = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(out.mcpServers).toEqual({ rks: { command: 'node', args: ['x'] } });
    expect(Object.keys(out.hooks)).toEqual(['PreToolUse', 'PostToolUse']);
    expect(allCommands(out).length).toBeGreaterThan(20);
  });

  it('registers TIERED manifest paths, not the template\'s flat ones', async () => {
    await setupClaudeSettings(projectRoot);
    const out = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'settings.json'), 'utf8'));
    const rels = allCommands(out)
      .map((c) => /\.routekit\/hooks\/(\S+\.mjs)/.exec(c)?.[1])
      .filter(Boolean);
    expect(rels.length).toBeGreaterThan(20);
    expect(rels.filter((p) => !p.includes('/'))).toEqual([]);
    for (const rel of rels) {
      const name = rel.split('/').pop().replace(/\.mjs$/, '');
      expect(manifest[name]?.path, `hook "${name}" not registered at its manifest path`).toBe(rel);
    }
  });

  it('refuses an unparseable settings.json rather than clobbering it', async () => {
    const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ not valid json');

    await setupClaudeSettings(projectRoot);

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ not valid json');
  });
});
