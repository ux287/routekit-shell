import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureClaudeSettings,
  migrateChildSettingsHookPaths,
  ensureHookRegistration,
  buildHookRegistration,
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
    // broken fixture exactly there so the existing-settings (repair) path runs.
    const claudeSettings = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(claudeSettings, JSON.stringify(brokenChildSettings(), null, 2));
    // backlog.fix.child-hook-registration-repair-and-audit — this branch now ADDS the
    // full canonical block, not only rewrites path strings. The fixture registered three
    // hooks; it comes out with the whole canonical set.
    ensureClaudeSettings({ projectRoot: dir, shellRoot: REPO_ROOT });
    const cmds = allCommands(JSON.parse(fs.readFileSync(claudeSettings, 'utf8')));
    expect(cmds.some((c) => /\.routekit\/hooks\/[^/"]+\.mjs/.test(c))).toBe(false);
    expect(cmds).toContain(tieredCmd('guardrails-gate.mjs'));
    expect(cmds.length).toBeGreaterThan(20);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// backlog.fix.child-hook-registration-repair-and-audit
// ══════════════════════════════════════════════════════════════════════════════════
//
// The bug in one sentence: `.claude/settings.json` is the only place hooks are ever
// registered, the only code that produced that block returned early whenever the file
// already existed, and migrateChildSettingsHookPaths only rewrites commands INSIDE an
// existing hooks block — so a child born with a settings.json and no hooks key had
// nothing to migrate, nothing to generate, and no check that could see it. Verified in
// routekit-growth: all 48 hook scripts current, ZERO registered, every guardrail inert,
// preflight/upgrade/doctor all green.

const CANONICAL = buildHookRegistration(manifest);

/** The routekit-growth shape: full tiered payload on disk, settings.json with ONLY mcpServers. */
function makeGrowthChild(root) {
  const rels = [...new Set(Object.values(manifest).map((e) => e.path).filter(Boolean))];
  for (const rel of rels) {
    const p = path.join(root, '.routekit', 'hooks', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '// stub hook\n');
  }
  expect(rels.length).toBeGreaterThan(20); // it is the full payload, not a token one
  const sp = path.join(root, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify({ mcpServers: { rks: { command: 'node', args: [] } } }, null, 2));
  return sp;
}

const backupsFor = (p) =>
  fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith(path.basename(p) + '.bak.'));

describe('ensureHookRegistration — repair (the routekit-growth fixture)', () => {
  it('turns a hooks-less settings.json into one carrying PreToolUse AND PostToolUse', () => {
    const sp = makeGrowthChild(dir);
    const result = ensureHookRegistration({ settingsPath: sp, manifest });
    expect(result.changed).toBe(true);

    const out = JSON.parse(fs.readFileSync(sp, 'utf8'));
    expect(Object.keys(out.hooks)).toEqual(['PreToolUse', 'PostToolUse']);
    expect(out.hooks.PreToolUse.length).toBeGreaterThan(0);
    expect(out.hooks.PostToolUse.length).toBeGreaterThan(0);
    expect(allCommands(out).length).toBeGreaterThan(20);
  });

  it('ensureClaudeSettings against the same fixture also produces the canonical block', () => {
    // The pre-existing-file branch no longer suppresses generation.
    const sp = makeGrowthChild(dir);
    ensureClaudeSettings({ projectRoot: dir, shellRoot: REPO_ROOT });
    const out = JSON.parse(fs.readFileSync(sp, 'utf8'));
    expect(allCommands(out).length).toBeGreaterThan(20);
    expect(out.mcpServers).toEqual({ rks: { command: 'node', args: [] } });
  });

  it('creates a settings.json carrying the registration when none exists', () => {
    const sp = path.join(dir, '.claude', 'settings.json');
    const result = ensureHookRegistration({ settingsPath: sp, manifest });
    expect(result).toEqual({ changed: true, reason: 'created' });
    expect(JSON.parse(fs.readFileSync(sp, 'utf8')).hooks).toEqual(CANONICAL);
  });
});

describe('ensureHookRegistration — merge, do not clobber', () => {
  // Every merge case runs against the EXISTING brokenChildSettings() fixture, which
  // already carries env, permissions (with a user-added allow entry) and an unknown
  // top-level key rks does not author.
  function seedBroken() {
    fs.writeFileSync(settingsPath, JSON.stringify(brokenChildSettings(), null, 2));
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }

  it('preserves mcpServers, env, permissions and unknown keys deep-equal', () => {
    const sp = makeGrowthChild(dir);
    const withExtras = { ...brokenChildSettings(), mcpServers: { rks: { command: 'node', args: ['x'] } } };
    delete withExtras.hooks;
    fs.writeFileSync(sp, JSON.stringify(withExtras, null, 2));

    ensureHookRegistration({ settingsPath: sp, manifest });
    const out = JSON.parse(fs.readFileSync(sp, 'utf8'));
    expect(out.mcpServers).toEqual({ rks: { command: 'node', args: ['x'] } });
    expect(out.env).toEqual({ RKS_GUARDRAILS: 'on' });
    expect(out.permissions).toEqual({ allow: ['mcp__rks__rks_preflight'], deny: [] });
    expect(out.customField).toEqual({ keepMe: true, nested: [1, 2, 3] });
  });

  it('the top-level key-set difference is EXACTLY {hooks} — nothing added, removed or reordered', () => {
    const sp = makeGrowthChild(dir);
    const before = Object.keys(JSON.parse(fs.readFileSync(sp, 'utf8')));
    ensureHookRegistration({ settingsPath: sp, manifest });
    const after = Object.keys(JSON.parse(fs.readFileSync(sp, 'utf8')));

    expect(after.filter((k) => !before.includes(k))).toEqual(['hooks']);
    expect(before.filter((k) => !after.includes(k))).toEqual([]);
    // Order of the pre-existing keys is untouched; `hooks` is appended.
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('leaves .claude/settings.local.json byte-identical', () => {
    const sp = makeGrowthChild(dir);
    const localPath = path.join(dir, '.claude', 'settings.local.json');
    fs.writeFileSync(localPath, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2));
    const before = fs.readFileSync(localPath, 'utf8');

    ensureHookRegistration({ settingsPath: sp, manifest });
    ensureClaudeSettings({ projectRoot: dir, shellRoot: REPO_ROOT });
    expect(fs.readFileSync(localPath, 'utf8')).toBe(before);
  });

  it('writes a backup sibling before mutating', () => {
    const sp = makeGrowthChild(dir);
    const original = fs.readFileSync(sp, 'utf8');
    expect(backupsFor(sp)).toEqual([]);

    ensureHookRegistration({ settingsPath: sp, manifest });
    const baks = backupsFor(sp);
    expect(baks.length).toBe(1);
    // The backup holds the PRE-mutation content — a real rollback, not a copy of the result.
    expect(fs.readFileSync(path.join(path.dirname(sp), baks[0]), 'utf8')).toBe(original);
  });

  it('is idempotent — a second run reports changed:false and is byte-stable', () => {
    const sp = makeGrowthChild(dir);
    ensureHookRegistration({ settingsPath: sp, manifest });
    const first = fs.readFileSync(sp, 'utf8');
    const backupsAfterFirst = backupsFor(sp).length;

    const again = ensureHookRegistration({ settingsPath: sp, manifest });
    expect(again).toEqual({ changed: false, reason: 'unchanged' });
    expect(fs.readFileSync(sp, 'utf8')).toBe(first);
    expect(backupsFor(sp).length).toBe(backupsAfterFirst); // no backup churn either
    // No duplicated entries: the block still deep-equals the single canonical one.
    expect(JSON.parse(first).hooks).toEqual(CANONICAL);
  });

  it('REFUSES an unparseable settings.json — no clobber, no backup-then-write', () => {
    const sp = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, '{ this is not json');
    const before = fs.readFileSync(sp, 'utf8');

    const result = ensureHookRegistration({ settingsPath: sp, manifest });
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('unparseable');
    expect(fs.readFileSync(sp, 'utf8')).toBe(before);
    expect(backupsFor(sp)).toEqual([]);
  });

  it('replaces a partial hooks block wholesale — rks owns the `hooks` key', () => {
    seedBroken();
    const result = ensureHookRegistration({ settingsPath, manifest });
    expect(result.changed).toBe(true);
    const out = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(out.hooks).toEqual(CANONICAL);
    expect(out.customField).toEqual({ keepMe: true, nested: [1, 2, 3] });
  });
});
