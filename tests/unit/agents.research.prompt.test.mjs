import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';

const promptPath = resolve(process.cwd(), '.rks/prompts/agent-research.md');
const content = readFileSync(promptPath, 'utf8');

describe('agent-research.md — prompt repair', () => {
  it('declares all 7 tools', () => {
    expect(content).toContain('rag_query');
    expect(content).toContain('read_file');
    expect(content).toContain('read_git');
    expect(content).toContain('dendron_create_note');
    expect(content).toContain('dendron_edit_note');
    expect(content).toContain('dendron_update_field');
    // Numbered-list membership: a bare exhaustive_search toContain is vacuous, because the
    // CITATION FORMAT section already names rks_exhaustive_search.
    expect(content).toMatch(/^7\. exhaustive_search /m);
  });

  it('hard limit for rag_query is max 2 (not max 1)', () => {
    expect(content).toContain('Maximum 2 rag_query');
    expect(content).not.toContain('Maximum 1 rag_query');
  });

  it('hard limit for read_file is max 3 (not max 2)', () => {
    expect(content).toContain('Maximum 3 read_file');
    expect(content).not.toContain('Maximum 2 read_file');
  });

  it('declares read_git with hard limit max 3', () => {
    expect(content).toContain('Maximum 3 read_git');
  });

  // backlog.feat.research-agent-exhaustive-search-tool: every pin below is absent from the prompt
  // as it stood before the tool was added, so none of them is vacuous.
  it('declares exhaustive_search as numbered tool 7', () => {
    expect(content).toContain('7. exhaustive_search');
  });

  it('states an exhaustive_search budget in HARD LIMITS', () => {
    const hardLimits = content.slice(content.indexOf('HARD LIMITS:'), content.indexOf('WHEN A LIMIT IS SPENT:'));
    expect(hardLimits).toMatch(/Maximum \d+ exhaustive_search/);
    expect(hardLimits).toContain('Maximum 6 exhaustive_search calls');
  });

  it('carries a separate WHEN TO USE exhaustive_search heading', () => {
    expect(content).toMatch(/^WHEN TO USE exhaustive_search:$/m);
    expect(content).toMatch(/^WHEN TO USE read_git:$/m);
  });

  it('states the absence contract with a positive control', () => {
    expect(content).toContain('positive control');
    expect(content).toMatch(/does not exist[^\n]*ONLY when an exhaustive_search returned matchCount 0 with exhaustive: true AND a positive control[^\n]*on the same path/);
    expect(content).toContain('say only that you did not find it and that absence was not established');
  });

  it('requires an absence claim to name the path and both patterns', () => {
    expect(content).toContain('must name the path and both patterns');
  });

  it('requires exhaustive and skipped to be read before a zero is believed', () => {
    expect(content).toContain('Read BOTH exhaustive and skipped before a zero is believed');
    expect(content).toContain('A zero at exhaustive: false establishes nothing');
    // The refuted claim (a pruned directory reports exhaustive true) is never taught.
    expect(content).not.toMatch(/prun[^\n]*exhaustive: ?true/i);
    expect(content).not.toMatch(/exhaustive: ?true[^\n]*fileCount: ?0/);
  });

  it('states that matchCount counts lines containing the pattern', () => {
    expect(content).toContain('matchCount counts lines containing the pattern, not lines equal to it');
  });

  it('contains WHEN TO USE read_git workflow guidance', () => {
    expect(content).toContain('WHEN TO USE read_git');
  });

  it('contains NOTE AUTHORITY HIERARCHY section', () => {
    expect(content.toUpperCase()).toContain('NOTE AUTHORITY HIERARCHY');
  });

  it('names backlog.z_implemented.* as authoritative ground truth', () => {
    expect(content).toContain('backlog.z_implemented.*');
    expect(content.toLowerCase()).toContain('authoritative');
  });

  it('describes research.* notes as point-in-time snapshots', () => {
    expect(content).toContain('research.*');
    expect(content.toLowerCase()).toContain('point-in-time');
  });

  it('states z_implemented wins on conflicts', () => {
    expect(content).toMatch(/z_implemented.*wins|z_implemented.*takes precedence|z_implemented.*overrides/);
  });

  it('contains HARD LIMITS section', () => {
    expect(content).toContain('HARD LIMITS:');
  });

  // backlog.fix.research-agent-budget-observed-not-asserted: a spent limit is reported as not read /
  // not searched with the budget count, never as a failed open or locate.
  it('states the not-read-by-budget wording rule and forbids could not open/locate for quota exhaustion', () => {
    expect(content).toContain('not read (read_file budget 3/3)');
    expect(content).toContain('not searched (rag_query budget 2/2)');
    expect(content).toContain('NEVER phrase quota exhaustion as "could not open" or "could not locate"');
    // The HARD LIMITS lines stay byte-identical.
    expect(content).toContain([
      'HARD LIMITS:',
      '- Maximum 2 rag_query calls',
      '- Maximum 3 read_file calls',
      '- Maximum 3 read_git calls (separate budget, does not share with rag_query or read_file)',
      '- After hitting limits, you MUST return the JSON answer — do NOT call more tools',
    ].join('\n'));
  });

  it('contains GUIDELINES section', () => {
    expect(content).toContain('GUIDELINES:');
    expect(content).toContain('Start with rag_query to discover relevant files');
  });

  // backlog.fix.research-agent-named-path-read: a path or note slug named in the question is read
  // directly first, and an absence claim about it cites that read.
  it('states the named-path direct-read-first rule and the cited-read absence rule', () => {
    expect(content).not.toContain('use after RAG identifies the file');
    expect(content).toMatch(/path or note slug named in the question is read directly first/);
    expect(content).toMatch(/read it directly with read_file first, before rag_query/);
    expect(content).toMatch(/absence claim about a named path[^\n]*MUST cite the result of your read_file on that path/);
  });

  // backlog.fix.research-agent-output-contract (D6): the retrieval index carries no line data, so
  // the prompt must not ask for line citations — every one it produced was generated, not grounded.
  it('keeps the CITATION FORMAT section but no longer asks for line-number citations', () => {
    expect(content).toContain('CITATION FORMAT');
    expect(content).not.toContain('[filename:lineNumber]');
    expect(content).not.toContain('[filename:startLine-endLine]');
    expect(content).not.toContain('file.mjs:187');
  });

  it('instructs that sources[] entries are objects and never a bare line number', () => {
    // Durable-phrase assertions (non-brittle substrings) — hardening against a bare
    // line number leaking into sources[] (backlog.fix.research-agent-sources-primitive-sanitization).
    expect(content.toUpperCase()).toContain('SOURCES ARRAY SHAPE');
    expect(content.toLowerCase()).toContain('never a bare line number');
    expect(content.toLowerCase()).toContain('line and location info goes inside the object');
  });
});
