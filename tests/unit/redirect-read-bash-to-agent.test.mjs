import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { classifyBashCommand, denyReasonFor, ALLOWLIST } from '../../packages/hooks/read/redirect-read-bash-to-agent.mjs';

// backlog.fix.child-bash-read-boundary-bypass — Part 4 (secondary).
// Allowlist-first / deny-by-default classifier for the child Bash read-redirect
// hook. Allowlisted toolchain runs directly; recognized reads hand off to the
// Research Agent; anything else — including shell chaining/obfuscation — denies.

describe('classifyBashCommand — allowlist pass-through', () => {
  for (const cmd of ['npm install', 'npm run build', 'node script.mjs', 'npx vitest run', 'git status']) {
    it(`allows: ${cmd}`, () => {
      expect(classifyBashCommand(cmd).action).toBe('allow');
    });
  }
});

describe('classifyBashCommand — reads redirect to the Research Agent', () => {
  for (const cmd of ['cat secrets.txt', 'grep token .env', 'find . -name "*.mjs"', 'rg apiKey', 'head -n5 x', 'ls -la']) {
    it(`redirects: ${cmd}`, () => {
      const r = classifyBashCommand(cmd);
      expect(r.action).toBe('redirect');
      expect(r.kind).toBe('read');
    });
  }
});

describe('classifyBashCommand — deny-by-default + chaining defense', () => {
  it('denies an unknown, non-allowlisted command', () => {
    const r = classifyBashCommand('somerandombinary --flag');
    expect(r.action).toBe('deny');
    expect(r.kind).toBe('unknown');
  });

  it('denies mkdir (mutation not on the allowlist)', () => {
    expect(classifyBashCommand('mkdir build').action).toBe('deny');
  });

  it('denies an allowlisted prefix chained to a read (no smuggling)', () => {
    const r = classifyBashCommand('npm run foo && cat secrets');
    expect(r.action).toBe('deny');
    expect(r.kind).toBe('metacharacter');
  });

  it('denies a pipe to a read', () => {
    expect(classifyBashCommand('cat a | grep b').action).toBe('deny');
  });

  it('denies command substitution', () => {
    expect(classifyBashCommand('echo $(cat /etc/passwd)').action).toBe('deny');
  });

  it('denies an env-prefixed read (leading token not allowlisted)', () => {
    // FOO=bar is the leading token, not "cat" — not allowlisted → deny.
    expect(classifyBashCommand('FOO=bar cat secrets').action).toBe('deny');
  });

  it('classification anchors on the leading token, not a substring', () => {
    // "node" appears in an arg but the command is a read → must redirect, not allow.
    expect(classifyBashCommand('grep node package.json').action).toBe('redirect');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backlog.fix.child-bash-hook-deny-message-misstates-allowlist
// A metacharacter denial used to reuse "not on the child allowlist", so `node --version 2>&1`
// read as "node is not allowed" — the reporters (ux287-bpm, routekit-growth) chased the wrong cause.
// ─────────────────────────────────────────────────────────────────────────────
describe('deny reasons name the rule that actually fired', () => {
  it('bare `node --version` is allowed (the retracted repro)', () => {
    expect(classifyBashCommand('node --version')).toEqual({ action: 'allow', kind: 'allowlisted' });
  });

  it.each([
    'node --version 2>&1',
    `node -e 'import("./packages/mcp-rks/src/shared/commit-and-embed-note.mjs").then(m => m.commitAndEmbedNote({ projectRoot: process.cwd(), slug: "x", content: "..." })).then(r => console.log(JSON.stringify(r)))'`,
    'head -3 notes/backlog.md 2>&1',
    ['cd /tmp/repo &&', 'git', 'clean -f -- notes/x.md'].join(' '),
  ])('the reported command %s is denied as a metacharacter', (cmd) => {
    expect(classifyBashCommand(cmd)).toEqual({ action: 'deny', kind: 'metacharacter' });
  });

  it('exports ALLOWLIST as a Set and a pure denyReasonFor', () => {
    expect(ALLOWLIST).toBeInstanceOf(Set);
    expect(typeof denyReasonFor).toBe('function');
  });

  it('a metacharacter denial says so, and does not blame the allowlist', () => {
    const r = denyReasonFor(classifyBashCommand('node --version 2>&1'));
    expect(r).toMatch(/metacharacter/i);
    expect(r).not.toContain('not on the child allowlist');
    expect(r).not.toContain('run directly');
  });

  it('an unknown verb lists the whole allowlist, generated, with no ellipsis', () => {
    const r = denyReasonFor(classifyBashCommand('somerandombinary --flag'));
    expect(r).toContain('not on the child allowlist');
    for (const tok of ALLOWLIST) expect(r).toContain(tok);
    expect(r).not.toContain('…');
  });

  it('the unknown text is generated from the allowlist argument (extension seam)', () => {
    const custom = new Set([...ALLOWLIST, 'customtool']);
    const r = denyReasonFor({ action: 'deny', kind: 'unknown' }, custom);
    for (const tok of custom) expect(r).toContain(tok);
  });

  it('metacharacter and unknown reasons differ', () => {
    expect(denyReasonFor({ action: 'deny', kind: 'metacharacter' })).not.toBe(
      denyReasonFor({ action: 'deny', kind: 'unknown' }),
    );
  });

  it('the read-redirect text is unchanged', () => {
    const prefix = 'File reads/searches must go through the Research Agent';
    expect(denyReasonFor({ action: 'redirect', kind: 'read' }).startsWith(prefix)).toBe(true);
    expect(denyReasonFor(classifyBashCommand('cat notes/x.md')).startsWith(prefix)).toBe(true);
  });
});

describe('hook copies stay byte-identical to canonical', () => {
  const canonical = new URL('../../packages/hooks/read/redirect-read-bash-to-agent.mjs', import.meta.url);
  const template = new URL('../../templates/generic/.routekit/hooks/read/redirect-read-bash-to-agent.mjs', import.meta.url);
  const deployed = new URL('../../.routekit/hooks/read/redirect-read-bash-to-agent.mjs', import.meta.url);

  it('the template copy matches canonical', () => {
    expect(fs.readFileSync(template).equals(fs.readFileSync(canonical))).toBe(true);
  });

  it.skipIf(!fs.existsSync(deployed))(
    'the deployed copy matches canonical (skipped while the read tier is relocated to .routekit/hooks.bak during guardrails-off)',
    () => {
      expect(fs.readFileSync(deployed).equals(fs.readFileSync(canonical))).toBe(true);
    },
  );
});
