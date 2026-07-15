import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// backlog.fix.child-hook-dependency-vendoring — the durable backstop.
// Deployed child hooks must LOAD without the workspace @routekit/mcp-rks package
// (children never install it). Prior scans repeatedly undercounted which hooks
// imported it; this test removes the question entirely: it stands up a fresh
// child's hook tree (a verbatim copy of packages/hooks/ with NO node_modules/
// @routekit symlink — the condition that masks the bug in the shell) and spawns
// EVERY deployed hook, asserting none die with ERR_MODULE_NOT_FOUND at load.
// It FAILS against the old code (the broken node_modules/@routekit imports) and
// PASSES once every such import is repointed at the vendored ../lib/.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

let tmp;
let hooks;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-childhooks-'));
  const childHooks = path.join(tmp, '.routekit', 'hooks');
  // Verbatim deploy of the canonical hook tree (incl. the vendored lib/), exactly
  // what ensureHooksDir copies into a child — but deliberately NO node_modules.
  copyDir(path.join(REPO, 'packages', 'hooks'), childHooks);
  hooks = [];
  for (const tier of ['read', 'write', 'system']) {
    const dir = path.join(childHooks, tier);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.mjs')) hooks.push(path.join(dir, f));
    }
  }
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('child hook loadability — no @routekit/mcp-rks in node_modules', () => {
  it('enumerates the deployed hook set', () => {
    expect(hooks.length).toBeGreaterThan(20);
  });

  it('every deployed hook loads without ERR_MODULE_NOT_FOUND', () => {
    const failures = [];
    for (const hook of hooks) {
      const res = spawnSync('node', [hook], {
        input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x' } }),
        timeout: 5000,
        encoding: 'utf8',
        env: { ...process.env, RKS_GUARDRAILS: 'on' },
      });
      const err = res.stderr || '';
      if (/ERR_MODULE_NOT_FOUND|Cannot find module/.test(err)) {
        const line = err.split('\n').find((l) => /Cannot find module/.test(l)) || err.slice(0, 160);
        failures.push(`${path.basename(hook)} — ${line.trim()}`);
      }
    }
    expect(failures, `hooks that fail to load in a fresh child:\n${failures.join('\n')}`).toEqual([]);
  });
});
