import { describe, it, expect } from 'vitest';
import { classifyBashCommand } from '../../packages/hooks/read/redirect-read-bash-to-agent.mjs';

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
