/**
 * backlog.feat.research-governor-decompose-and-merge
 *
 * The Research Governor decomposes a multi-part task into self-contained sub-questions,
 * makes one rks_agent_research call per sub-question (at most 2 in flight, matching the
 * claude-cli gate), routes enumeration/coordinates to rks_exhaustive_search, re-asks a
 * partial sub-answer once, and merges per-sub-question sections with a union partial marker.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/research-governor-decompose-and-merge.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  createSession,
  advanceState,
  checkAllowedTool,
  endSession,
  setProjectRoot,
  getSession,
} from '../../packages/mcp-rks/src/shared/governor-token.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const PROMPT = fs.readFileSync(path.join(REPO_ROOT, '.rks', 'prompts', 'governor-research.md'), 'utf8');
const SKILL = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'skills', 'research', 'SKILL.md'), 'utf8');

/** Text from a line-initial heading to the next line-initial '## ' heading. */
function section(src, heading) {
  const start = src.indexOf(`\n${heading}\n`);
  if (start < 0) return '';
  const rest = src.slice(start + heading.length + 2);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

const CHAIN = section(PROMPT, '## Chain');
const QUERY_MODE = SKILL.slice(SKILL.indexOf('## Query Mode Instructions'), SKILL.indexOf('## Document Mode Instructions'));
const DOC_MODE = section(SKILL, '## Document Mode Instructions');

let tmpRoot;
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'research-decompose-'));
  setProjectRoot(tmpRoot);
});
afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('research-governor-decompose-and-merge', () => {
  it('Chain instructs self-contained sub-question decomposition before the first agent call', () => {
    expect(CHAIN.length).toBeGreaterThan(0);
    const decomp = CHAIN.search(/self-contained sub-question/i);
    const firstCall = CHAIN.indexOf('mcp__rks__rks_agent_research(');
    expect(decomp).toBeGreaterThan(-1);
    expect(firstCall).toBeGreaterThan(decomp);
    expect(CHAIN).toMatch(/names the files, paths or note slugs/);
  });

  it('Chain keeps a single call for a single-part task', () => {
    expect(CHAIN).toMatch(/single-part task[^\n]*one[^\n]*call/i);
  });

  it('Chain caps in-flight agent calls at 2 and names the claude-cli gate', () => {
    expect(CHAIN).toMatch(/at most 2 in flight[^\n]*claude-cli gate/i);
    expect(CHAIN).toMatch(/one rks_agent_research call per sub-question/i);
  });

  it('Chain routes enumeration and coordinates to rks_exhaustive_search', () => {
    expect(CHAIN).toMatch(/Enumeration and coordinate questions[\s\S]*?go to rks_exhaustive_search[\s\S]*?not to rks_agent_research/);
    expect(CHAIN).toContain('file:line');
  });

  it('Chain re-asks a partial sub-answer once and no more', () => {
    expect(CHAIN).toContain('budget.exhausted');
    expect(CHAIN).toMatch(/Re-ask a PARTIAL sub-answer once, with a query narrowed/);
    expect(CHAIN).toMatch(/No\s+sub-question is re-asked more than once/);
    expect(CHAIN).toMatch(/answer says it is partial/);
  });

  it('Chain merges per-sub-question sections with own sources and a union partial marker', () => {
    expect(CHAIN).toMatch(/one section per sub-question[^\n]*\n[^\n]*own `sources`/i);
    expect(CHAIN).toMatch(/partial marker is the union/i);
    expect(CHAIN).toMatch(/plus every sub-question never\s+asked/i);
  });

  it('sub-question cap and max_turns agree between governor-research.md and SKILL.md', () => {
    const capP = PROMPT.match(/at most (\d+) sub-questions/i);
    const capS = DOC_MODE.match(/at most (\d+) sub-questions/i);
    expect(capP).not.toBeNull();
    expect(capS).not.toBeNull();
    expect(capS[1]).toBe(capP[1]);
    // The launch block's own max_turns line, not a prose mention of it.
    const turnsS = DOC_MODE.match(/^ {2}max_turns: (\d+)$/m);
    const turnsP = PROMPT.match(/max_turns: (\d+)/);
    expect(turnsS).not.toBeNull();
    expect(turnsP).not.toBeNull();
    expect(turnsP[1]).toBe(turnsS[1]);
    // Every max_turns value either file names is the same one.
    const all = [...PROMPT.matchAll(/max_turns: (\d+)/g), ...DOC_MODE.matchAll(/max_turns: (\d+)/g)].map((m) => m[1]);
    expect(new Set(all).size).toBe(1);
  });

  it('Query mode sends one call per enumerated part, at most 2 in flight', () => {
    expect(QUERY_MODE.length).toBeGreaterThan(0);
    expect(QUERY_MODE).toMatch(/explicitly enumerated parts/i);
    expect(QUERY_MODE).toMatch(/one `?rks_agent_research`? call per (enumerated )?part/i);
    expect(QUERY_MODE).toMatch(/at most 2 in flight/i);
    expect(QUERY_MODE).toMatch(/Answer per part/i);
  });

  it('Query mode caps enumerated parts at the Governor sub-question cap of 4', () => {
    const capQ = QUERY_MODE.match(/at most (\d+) (enumerated )?parts/i);
    const capP = PROMPT.match(/at most (\d+) sub-questions/i);
    expect(capQ).not.toBeNull();
    expect(capP).not.toBeNull();
    expect(capQ[1]).toBe('4');
    expect(capQ[1]).toBe(capP[1]);
  });

  it('Query mode names every part over the cap as unasked or routes the question to Document Mode', () => {
    const capQ = QUERY_MODE.match(/at most (\d+) (enumerated )?parts/i);
    const over = QUERY_MODE.match(/more than (\d+)/i);
    expect(capQ).not.toBeNull();
    expect(over).not.toBeNull();
    expect(over[1]).toBe(capQ[1]);
    const routed = /Document Mode/.test(QUERY_MODE);
    const named = /unasked/i.test(QUERY_MODE);
    expect(routed || named).toBe(true);
  });

  it('Query mode re-asks a partial part at most once and reports it partial by name', () => {
    expect(QUERY_MODE).toMatch(/partial/i);
    expect(QUERY_MODE).toMatch(/re-ask(ed)?[^.]*(at most )?once/i);
    expect(QUERY_MODE).toMatch(/nam(e|es|ing) the part/i);
  });

  it('Query mode treats an unobserved or missing budget as partial', () => {
    // The partial rule: from the bullet that opens on a partial part to its naming clause.
    const rule = QUERY_MODE.match(/A part whose answer is partial[\s\S]*?nam(e|es|ing) the part/i);
    expect(rule).not.toBeNull();
    expect(rule[0]).toMatch(/unobserved/i);
    expect(rule[0]).toMatch(/missing/i);
  });

  it('Query mode keeps the 2-in-flight limit and the single-call rule for a non-enumerated question', () => {
    expect(QUERY_MODE).toMatch(/at most 2 in flight/i);
    expect(QUERY_MODE).toMatch(/not explicitly enumerated stays one call/i);
  });

  it('Query mode part cap, Document Mode cap and governor-research.md cap are one number', () => {
    const capQ = QUERY_MODE.match(/at most (\d+) (enumerated )?parts/i);
    const capS = DOC_MODE.match(/at most (\d+) sub-questions/i);
    const capP = PROMPT.match(/at most (\d+) sub-questions/i);
    expect(capQ).not.toBeNull();
    expect(capS).not.toBeNull();
    expect(capP).not.toBeNull();
    expect(new Set([capQ[1], capS[1], capP[1]]).size).toBe(1);
  });

  it('Chain treats an unobserved or missing budget as partial', () => {
    expect(CHAIN).toContain('budget.observed === false');
    expect(CHAIN).toMatch(/no `?budget`?|missing `?budget`?|`?budget`? is (missing|absent)/i);
    expect(CHAIN).toMatch(/never read as[^\n]*nothing exhausted/i);
  });

  it('Chain keeps step 2 and step 3 numbering and the step-2 filename reference', () => {
    expect(CHAIN).toContain('\n2. mcp__rks__dendron_create_note(');
    expect(CHAIN).toContain('\n3. mcp__rks__rks_rag_embed(');
    expect(CHAIN).toContain('notes/<filename from step 2>.md');
    expect(CHAIN).not.toMatch(/^4\. /m);
  });

  it('Chain keeps the backlog.* prohibition', () => {
    expect(CHAIN).toContain('NEVER create backlog.* or z_archive.* notes.');
  });

  it('a six-call open-flow chain still admits research.* note writes and exhaustive search', () => {
    const token = createSession({ projectId: 'research-decompose-test', flowType: 'open' }).token;
    try {
      const seen = [];
      for (let i = 0; i < 6; i++) {
        advanceState(token, 'rks_agent_research');
        seen.push(getSession(token).state);
        expect(checkAllowedTool(token, 'rks_exhaustive_search', {})).toBeNull();
      }
      expect(seen).toContain('writing');
      expect(checkAllowedTool(token, 'dendron_create_note', { filename: 'research.2026.11.19.decompose-test' })).toBeNull();
      expect(checkAllowedTool(token, 'dendron_edit_note', { filename: 'research.2026.11.19.decompose-test' })).toBeNull();
    } finally {
      endSession(token);
    }
  });
});
