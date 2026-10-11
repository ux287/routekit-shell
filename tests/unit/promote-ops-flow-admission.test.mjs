import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkStateAllowed,
  getNextState,
  getStates,
} from '../../packages/mcp-rks/src/shared/governor-state.mjs';
import {
  OPS_FLOW_TOOLS,
  STORY_FLOW_TOOLS,
  OPEN_FLOW_TOOLS,
  UNPROTECTED_TOOLS,
  isProtectedTool,
  createSession,
  getSession,
  advanceState,
  assertToolAllowed,
  resetToken,
  setProjectRoot,
} from '../../packages/mcp-rks/src/shared/governor-token.mjs';
import {
  CHILD_RKS_ALLOW_TOOLS,
  CHILD_RKS_PROMPT_TOOLS,
  CHILD_RKS_ASK_RULES,
  mergeRksPermissionAllow,
} from '../../packages/cli/src/project/child-permissions.mjs';
import { assertNotProtectedBranch } from '../../packages/mcp-rks/src/server/branch-protection.mjs';

// backlog.fix.rks-promote-unreachable-under-governance
// Option (a): rks_promote is admitted in the ops flow from init, mirroring rks_release,
// and is a child permission checkpoint (ask) directly after rks_release.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const PROMOTE = 'mcp__rks__rks_promote';
const RELEASE = 'mcp__rks__rks_release';
const PROJECT_ID = 'promote-ops-admission-test';

let tmpRoot;
const childDirs = [];

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-promote-ops-'));
  setProjectRoot(tmpRoot);
});

afterEach(() => {
  resetToken();
  for (const d of childDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('ops flow admits rks_promote like rks_release (Layer 3 state machine)', () => {
  it('is allowed in ops init and ops executing', () => {
    expect(checkStateAllowed('ops', 'init', 'rks_promote').allowed).toBe(true);
    expect(checkStateAllowed('ops', 'executing', 'rks_promote').allowed).toBe(true);
  });

  it('transitions init -> executing and self-loops in executing, identical to rks_release', () => {
    expect(getNextState('ops', 'init', 'rks_promote')).toBe('executing');
    expect(getNextState('ops', 'executing', 'rks_promote')).toBe('executing');
    expect(getNextState('ops', 'init', 'rks_promote')).toBe(getNextState('ops', 'init', 'rks_release'));
    expect(getNextState('ops', 'executing', 'rks_promote')).toBe(getNextState('ops', 'executing', 'rks_release'));
  });

  it('is admitted in no state of the story, open, qa or ship flows', () => {
    for (const flow of ['story', 'open', 'qa', 'ship']) {
      const states = Object.keys(getStates(flow));
      expect(states.length, flow).toBeGreaterThan(0);
      for (const state of states) {
        expect(checkStateAllowed(flow, state, 'rks_promote').allowed, `${flow}.${state}`).toBe(false);
      }
    }
  });
});

describe('flow-level allowlist and protection (Layer 2)', () => {
  it('OPS_FLOW_TOOLS has it; story/open flow tools do not', () => {
    expect(OPS_FLOW_TOOLS.has('rks_promote')).toBe(true);
    expect(STORY_FLOW_TOOLS.has('rks_promote')).toBe(false);
    expect(OPEN_FLOW_TOOLS.has('rks_promote')).toBe(false);
  });

  it('stays token-protected: not in UNPROTECTED_TOOLS', () => {
    expect(UNPROTECTED_TOOLS.has('rks_promote')).toBe(false);
    expect(isProtectedTool('rks_promote')).toBe(true);
  });
});

describe('runtime chain through assertToolAllowed', () => {
  it('an ops session reaches rks_promote from init and stays in executing', () => {
    const { token } = createSession({ projectId: PROJECT_ID, flowType: 'ops' });
    expect(getSession(token).state).toBe('init');
    // assertToolAllowed returns null when the call is allowed (its success contract),
    // and a { ok: false, error } object when it is blocked.
    expect(assertToolAllowed(token, 'rks_promote', { projectId: PROJECT_ID })).toBeNull();
    advanceState(token, 'rks_promote');
    expect(getSession(token).state).toBe('executing');
    expect(assertToolAllowed(token, 'rks_promote', { projectId: PROJECT_ID })).toBeNull();
    advanceState(token, 'rks_promote');
    expect(getSession(token).state).toBe('executing');
  });

  it('negative controls: a ship session is refused with chain_violation, no token is unauthorized', () => {
    const { token } = createSession({ projectId: PROJECT_ID, flowType: 'ship' });
    const ship = assertToolAllowed(token, 'rks_promote', { projectId: PROJECT_ID });
    expect(ship.ok).toBe(false);
    expect(ship.error).toBe('chain_violation');
    const none = assertToolAllowed(null, 'rks_promote');
    expect(none.ok).toBe(false);
    expect(none.error).toBe('unauthorized');
  });
});

describe('guidance names the governed route, not the bare tool', () => {
  it('every rks_preflight workflowInfo note naming rks_promote names the ops route', () => {
    const lines = src('packages/mcp-rks/src/server.mjs')
      .split('\n')
      .filter((l) => l.includes('workflowInfo.notes.push') && l.includes('rks_promote'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/\bops\b/);
  });

  it('every guardrails-audit line naming rks_promote names the ops route', () => {
    const lines = src('packages/mcp-rks/src/server/guardrails-audit.mjs')
      .split('\n')
      .filter((l) => l.includes('rks_promote'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/\bops\b/);
  });

  it('the ops skill documents an rks_promote call with the sentinel in a projectId value position', () => {
    const lines = src('.claude/skills/ops/SKILL.md')
      .split('\n')
      .filter((l) => l.includes('rks_promote('));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toContain("projectId: '__RKS_SOURCE_PROJECT__'");
      expect(l).toContain('_governorToken: TOKEN');
    }
  });

  it('the branch-protection integration-branch hint names the ops route and keeps rks_promote', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-promote-bp-'));
    childDirs.push(root);
    fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.rks', 'project.json'),
      JSON.stringify({ id: 'bp-test', root, branches: { working: 'dev', integration: 'staging', production: 'main' } }),
    );
    let message = '';
    try {
      assertNotProtectedBranch(root, 'staging', 'checkout');
    } catch (e) {
      message = e.message;
    }
    expect(message).toContain('BLOCKED');
    expect(message).toContain('rks_promote');
    expect(message).toMatch(/\bops\b/);
  });

  it('the guardrails-audit guardrailsOn slice gains no severity or .findings wording', () => {
    const audit = src('packages/mcp-rks/src/server/guardrails-audit.mjs');
    const slice = audit.slice(audit.indexOf('export async function guardrailsOn'));
    for (const l of slice.split('\n').filter((x) => x.includes('rks_promote'))) {
      expect(l).not.toMatch(/severity/);
      expect(l).not.toMatch(/\.findings\b/);
    }
  });

  it('the governor subagent tool list is unchanged (no rks_promote)', () => {
    expect(src('.claude/agents/governor.md')).not.toContain('rks_promote');
  });
});

describe('child permission checkpoint parity with rks_release', () => {
  it('rks_promote is a prompt checkpoint directly after rks_release, and not an allow tool', () => {
    const keys = Object.keys(CHILD_RKS_PROMPT_TOOLS);
    expect(keys).toContain(PROMOTE);
    expect(keys.indexOf(PROMOTE)).toBe(keys.indexOf(RELEASE) + 1);
    expect(CHILD_RKS_ALLOW_TOOLS).not.toContain(PROMOTE);
    expect(CHILD_RKS_ASK_RULES.indexOf(PROMOTE)).toBe(CHILD_RKS_ASK_RULES.indexOf(RELEASE) + 1);
  });

  it('the base template ask list equals CHILD_RKS_ASK_RULES in order; allow is only the wildcard', () => {
    const t = JSON.parse(src('templates/base/.claude/settings.json'));
    const rksOnly = (list) => (list || []).filter((e) => e.startsWith('mcp__rks__'));
    expect(rksOnly(t.permissions.ask)).toEqual([...CHILD_RKS_ASK_RULES]);
    expect(rksOnly(t.permissions.allow)).toEqual(['mcp__rks__*']);
  });

  const child = (permissions) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-promote-child-'));
    childDirs.push(root);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const localSettingsPath = path.join(root, '.claude', 'settings.local.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions }, null, 2) + '\n');
    return { root, settingsPath, localSettingsPath };
  };
  const PRE_CHANGE_ASK = [
    'mcp__rks__rks_guardrails_off',
    RELEASE,
    'mcp__rks__rks_publish',
    'mcp__rks__rks_publish_profiles',
  ];

  it('an existing child holding only the four pre-change checkpoints gains rks_promote in ask', () => {
    const c = child({ allow: ['mcp__rks__*'], ask: [...PRE_CHANGE_ASK] });
    const r = mergeRksPermissionAllow(c);
    expect(r.addedAsk).toContain(PROMOTE);
    const s = JSON.parse(fs.readFileSync(c.settingsPath, 'utf8'));
    expect(s.permissions.ask).toContain(PROMOTE);
  });

  it('a child that already allows, asks for or denies rks_promote is not given it again', () => {
    for (const key of ['allow', 'ask', 'deny']) {
      const perms = { allow: ['mcp__rks__*'], ask: [...PRE_CHANGE_ASK] };
      perms[key] = [...(perms[key] || []), PROMOTE];
      const r = mergeRksPermissionAllow(child(perms));
      expect(r.addedAsk, key).not.toContain(PROMOTE);
    }
  });

  it('the child CLAUDE.md template Permission mode section names every checkpoint', () => {
    const md = src('templates/base/CLAUDE.md');
    const start = md.indexOf('## Permission mode');
    expect(start).toBeGreaterThan(-1);
    const rest = md.slice(start + 1);
    const next = rest.search(/^## /m);
    const section = md.slice(start, next === -1 ? undefined : start + 1 + next);
    for (const rule of CHILD_RKS_ASK_RULES) {
      expect(section, rule).toContain('`' + rule.replace('mcp__rks__', '') + '`');
    }
  });
});
