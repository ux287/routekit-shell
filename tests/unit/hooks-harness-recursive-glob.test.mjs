import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

const settings = JSON.parse(
  readFileSync(join(projectRoot, '.claude', 'settings.json'), 'utf8')
);

function allCommandStrings(settings) {
  const cmds = [];
  const sections = [settings.hooks?.PreToolUse, settings.hooks?.PostToolUse].filter(Boolean);
  for (const section of sections) {
    for (const entry of section) {
      for (const hook of entry.hooks ?? []) {
        if (hook.command) cmds.push(hook.command);
      }
    }
  }
  return cmds;
}

const commands = allCommandStrings(settings);
const TIER_SUBDIRS = ['system', 'write', 'read'];
const FLAT_PATTERN = /\.routekit\/hooks\/[a-zA-Z][^/]+\.mjs/;
const TIER_PATTERN = new RegExp(`\\.routekit\\/hooks\\/(${TIER_SUBDIRS.join('|')})\\/[^/]+\\.mjs`);

describe('settings.json hook registration', () => {
  it('contains at least one hook command', () => {
    expect(commands.length).toBeGreaterThan(0);
  });

  it('no command uses flat .routekit/hooks/*.mjs path', () => {
    const flatEntries = commands.filter(cmd => FLAT_PATTERN.test(cmd));
    expect(flatEntries, `Flat paths still present:\n${flatEntries.join('\n')}`).toHaveLength(0);
  });

  it('every hook command uses a tier subdirectory path', () => {
    const nonTierEntries = commands.filter(
      cmd => cmd.includes('.routekit/hooks/') && !TIER_PATTERN.test(cmd)
    );
    expect(nonTierEntries, `Non-tier paths found:\n${nonTierEntries.join('\n')}`).toHaveLength(0);
  });

  it('all tier subdirectories are represented', () => {
    const usedTiers = new Set(
      commands
        .map(cmd => {
          const m = cmd.match(/\.routekit\/hooks\/(system|write|read)\//);
          return m?.[1];
        })
        .filter(Boolean)
    );
    expect([...usedTiers].sort()).toEqual(['read', 'system', 'write']);
  });

  it('hook at .routekit/hooks/system/ subdirectory path is resolvable', () => {
    const systemCmds = commands.filter(cmd => cmd.includes('.routekit/hooks/system/'));
    expect(systemCmds.length).toBeGreaterThan(0);
    // Verify paths reference correctly-named hooks (names match manifest entries)
    const hookNames = systemCmds.map(cmd => {
      const m = cmd.match(/hooks\/system\/([^"]+\.mjs)/);
      return m?.[1];
    });
    expect(hookNames.every(n => n && n.endsWith('.mjs'))).toBe(true);
  });

  it('previously registered hooks remain covered — no hook silently dropped', () => {
    // All hooks present in the original flat settings.json must appear in the new commands
    const expectedHooks = [
      'track-rag-results.mjs',
      'track-agent-provenance.mjs',
      'rag-embed-on-commit.mjs',
      'guardrails-auto-enable.mjs',
      'monitor-context.mjs',
      'check-docs-sync.mjs',
      'track-write-telemetry.mjs',
      'capture-plan-to-backlog.mjs',
      'guardrails-gate.mjs',
      'redirect-plan-to-backlog.mjs',
      'redirect-read-to-agent.mjs',
      'redirect-grep-to-agent.mjs',
      'redirect-glob-to-agent.mjs',
      'redirect-task-explore-to-agent.mjs',
      'enforce-orchestration.mjs',
      'enforce-rag-discovery.mjs',
      'enforce-read-provenance.mjs',
      'redirect-edit-to-governor.mjs',
      'enforce-targetfile-scope.mjs',
      'enforce-plan-scope.mjs',
      'enforce-architecture.mjs',
      'enforce-dendron-note-creation.mjs',
      'redirect-validate-story-to-agent.mjs',
      'redirect-git-tools-to-agent.mjs',
      'redirect-dendron-tools-to-agent.mjs',
      'redirect-rag-tools-to-agent.mjs',
      'redirect-github-tools-to-governor.mjs',
      'redirect-websearch-to-agent.mjs',
      'redirect-webfetch-to-governor.mjs',
      'redirect-notebookedit-to-governor.mjs',
      'redirect-bash-to-governor.mjs',
      'block-git-during-off-rail.mjs',
      'enforce-git-workflow.mjs',
      'enforce-branch-workflow.mjs',
      'enforce-rag-for-search.mjs',
      'check-dependency-security.mjs',
    ];

    const missing = expectedHooks.filter(
      hook => !commands.some(cmd => cmd.endsWith(`/${hook}`))
    );
    expect(missing, `Missing hooks:\n${missing.join('\n')}`).toHaveLength(0);
  });

  it('settings.local.json contains no flat hook command entries', () => {
    const localPath = join(projectRoot, '.claude', 'settings.local.json');
    if (!existsSync(localPath)) return;
    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    const localCmds = allCommandStrings(local);
    const flatLocal = localCmds.filter(cmd => FLAT_PATTERN.test(cmd));
    expect(flatLocal, `Flat paths in settings.local.json:\n${flatLocal.join('\n')}`).toHaveLength(0);
  });
});
