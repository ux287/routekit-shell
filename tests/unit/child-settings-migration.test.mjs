import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureClaudeSettings,
  migrateChildSettingsHookPaths,
} from '../../packages/cli/src/project/bootstrap.mjs';

// backlog.fix.child-bash-read-boundary-bypass — Part 3.
// ensureClaudeSettings never overwrites an existing child's settings.json, so the
// generator fix alone cannot repair children already scaffolded with flat hook
// paths (the broken June cohort). The attach-time migration rewrites flat hook
// registrations to their tiered manifest paths, idempotently, preserving the rest.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, '.routekit', 'hooks-manifest.json'), 'utf8')
);

const flatCmd = (name) => `node "$CLAUDE_PROJECT_DIR"/.routekit/hooks/${name}`;
const tieredCmd = (name) =>
  `node "$CLAUDE_PROJECT_DIR"/.routekit/hooks/${manifest[name.replace(/\.mjs$/, '')].path}`;

function brokenChildSettings() {
  return {
    env: { RKS_GUARDRAILS: 'on' },
    permissions: { allow: ['mcp__rks__rks_preflight'], deny: [] },
    customField: { keepMe: true, nested: [1, 2, 3] },
    hooks: {
      PreToolUse: [
        { matcher: 'Read', hooks: [{ type: 'command', command: flatCmd('redirect-read-to-agent.mjs') }] },
        { matcher: '*', hooks: [{ type: 'command', command: flatCmd('guardrails-gate.mjs') }] },
        {
          matcher: 'Edit|Write',
          hooks: [{ type: 'command', command: flatCmd('enforce-targetfile-scope.mjs') }],
        },
      ],
    },
  };
}

function allCommands(settings) {
  const out = [];
  for (const ev of Object.keys(settings.hooks || {})) {
    for (const g of settings.hooks[ev] || []) {
      for (const h of g.hooks || []) out.push(h.command);
    }
  }
  return out;
}

let dir;
let settingsPath;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-migrate-'));
  settingsPath = path.join(dir, 'settings.json');
});
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('existing-child hook-path migration (Part 3)', () => {
  it('rewrites flat hook paths to their tiered manifest paths', () => {
    fs.writeFileSync(settingsPath, JSON.stringify(brokenChildSettings(), null, 2));
    const changed = migrateChildSettingsHookPaths({ settingsPath, manifest });
    expect(changed).toBe(true);

    const out = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const cmds = allCommands(out);
    // zero flat paths remain
    expect(cmds.some((c) => /\.routekit\/hooks\/[^/"]+\.mjs/.test(c))).toBe(false);
    expect(cmds).toContain(tieredCmd('redirect-read-to-agent.mjs'));
    expect(cmds).toContain(tieredCmd('guardrails-gate.mjs'));
    expect(cmds).toContain(tieredCmd('enforce-targetfile-scope.mjs'));
  });

  it('preserves env, permissions, and non-hook customizations', () => {
    fs.writeFileSync(settingsPath, JSON.stringify(brokenChildSettings(), null, 2));
    migrateChildSettingsHookPaths({ settingsPath, manifest });
    const out = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(out.env).toEqual({ RKS_GUARDRAILS: 'on' });
    expect(out.permissions).toEqual({ allow: ['mcp__rks__rks_preflight'], deny: [] });
    expect(out.customField).toEqual({ keepMe: true, nested: [1, 2, 3] });
  });

  it('is idempotent — a second run makes no change and is byte-stable', () => {
    fs.writeFileSync(settingsPath, JSON.stringify(brokenChildSettings(), null, 2));
    migrateChildSettingsHookPaths({ settingsPath, manifest });
    const first = fs.readFileSync(settingsPath, 'utf8');
    const changedAgain = migrateChildSettingsHookPaths({ settingsPath, manifest });
    expect(changedAgain).toBe(false);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(first);
  });

  it('leaves an already-tiered settings file unchanged (no-op)', () => {
    const tiered = brokenChildSettings();
    for (const g of tiered.hooks.PreToolUse) {
      for (const h of g.hooks) {
        const name = h.command.match(/hooks\/([^/"]+\.mjs)/)[1];
        h.command = tieredCmd(name);
      }
    }
    fs.writeFileSync(settingsPath, JSON.stringify(tiered, null, 2));
    const changed = migrateChildSettingsHookPaths({ settingsPath, manifest });
    expect(changed).toBe(false);
  });

  it('ensureClaudeSettings repairs an existing broken child on the attach path', () => {
    // ensureClaudeSettings reads <projectRoot>/.claude/settings.json — seed the
    // broken fixture exactly there so the existing-settings (migrate) path runs.
    const claudeSettings = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(claudeSettings, JSON.stringify(brokenChildSettings(), null, 2));
    // existing settings → migrates (does not overwrite wholesale)
    ensureClaudeSettings({ projectRoot: dir, shellRoot: REPO_ROOT });
    const cmds = allCommands(JSON.parse(fs.readFileSync(claudeSettings, 'utf8')));
    expect(cmds.some((c) => /\.routekit\/hooks\/[^/"]+\.mjs/.test(c))).toBe(false);
    expect(cmds).toContain(tieredCmd('guardrails-gate.mjs'));
  });
});
